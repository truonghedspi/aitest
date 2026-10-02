import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {} from '@aitest/authoring'
import { errorMessage, interpolate, toPosix, z, type Context, type RunLog } from '@aitest/core'

/**
 * Danh mục tool đã kiểm duyệt: agent đề xuất thêm tool trong cuộc chat, người dùng duyệt.
 *
 * - Mỗi mục trong `tool-catalog/*.yml` mô tả một plugin (hoặc MCP server qua `@aitest/action-mcp-proxy`)
 *   kèm tham số và mẫu cấu hình. Agent chỉ điền tham số, không viết cấu hình tự do.
 * - Tool mới mặc định chỉ đọc. Quyền ghi phải được đề xuất rõ ràng (`write: true`) và hiện nổi bật trên thẻ duyệt.
 * - Tham số bí mật chỉ nhận dạng `${env.TÊN}`; giá trị thật không đi qua cuộc chat.
 * - `propose_tool` luôn xin duyệt qua `scope.confirm` với cấu hình đầy đủ sẽ ghi. Scope không có người dùng
 *   trực tiếp thì tool từ chối chạy. Row mới do kernel ghi vào patch layer; mọi đề xuất được ghi log kiểm toán.
 */
export interface Config {
  dirs: string[]
  auditDir: string
}

export const name = 'tool-catalog'
export const inject = ['kernel', 'actions', 'authoring', 'runlog']

export const Config = z.object({
  dirs: z.array(z.string()).default(['tool-catalog']).description('Thư mục chứa các mục danh mục `*.yml`, tương đối với thư mục làm việc.'),
  auditDir: z.string().default('.aitest/tool-catalog').description('Thư mục log kiểm toán của các đề xuất.'),
})

type ParamType = 'string' | 'string[]' | 'number' | 'boolean'

export interface CatalogParam {
  name: string
  description: string
  type: ParamType
  required: boolean
  secret: boolean
  default?: unknown
  example?: unknown
}

export interface CatalogEntry {
  id: string
  title: string
  description: string
  plugin: string
  namespace: string
  tools: { read: string[]; write: string[] }
  params: CatalogParam[]
  /** Mẫu cấu hình ở chế độ chỉ đọc; chuỗi `{{tên}}` được thay bằng tham số. */
  config: Record<string, unknown>
  /** Phần cấu hình gộp thêm (ghi đè từng khoá) khi đề xuất có quyền ghi. */
  write?: Record<string, unknown>
  /** Hướng dẫn dùng tool cho agent sau khi thêm. */
  usage?: string
  file: string
}

const ENTRY = z.object({
  id: z.string().pattern(/^[a-z][a-z0-9-]*$/).required(),
  title: z.string().required(),
  description: z.string().required(),
  plugin: z.string().required(),
  namespace: z.string().pattern(/^[a-z][a-z0-9]*$/).required(),
  tools: z.object({ read: z.array(z.string()).default([]), write: z.array(z.string()).default([]) }),
  params: z.array(z.object({
    name: z.string().pattern(/^[a-zA-Z][a-zA-Z0-9]*$/).required(),
    description: z.string().default(''),
    type: z.union(['string', 'string[]', 'number', 'boolean'] as const).default('string'),
    required: z.boolean().default(false),
    secret: z.boolean().default(false),
    default: z.any(),
    example: z.any(),
  })).default([]),
  config: z.dict(z.any()).default({}),
  write: z.dict(z.any()),
  usage: z.string(),
})

const SECRET_VALUE = /^\$\{env\.[A-Za-z_][A-Za-z0-9_]*\}$/
const ENV_REF = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g

export async function loadCatalog(dirs: string[]): Promise<{ entries: CatalogEntry[]; errors: Array<{ file: string; error: string }> }> {
  const entries: CatalogEntry[] = []
  const errors: Array<{ file: string; error: string }> = []
  for (const dir of dirs) {
    const full = resolve(dir)
    const files = (await readdir(full).catch(() => [] as string[])).filter((f) => /\.ya?ml$/.test(f)).sort()
    for (const name of files) {
      const file = toPosix(relative(process.cwd(), join(full, name)))
      try {
        const entry = ENTRY(parseYaml(await readFile(join(full, name), 'utf8'))) as Omit<CatalogEntry, 'file'>
        if (entries.some((e) => e.id === entry.id)) throw new Error(`duplicate catalog id ${entry.id}`)
        entries.push({ ...entry, file })
      } catch (error) {
        errors.push({ file, error: errorMessage(error).split('\n')[0] })
      }
    }
  }
  return { entries, errors }
}

/**
 * Thay `{{tên}}` trong mẫu cấu hình. Chuỗi chỉ gồm đúng một placeholder nhận nguyên giá trị (giữ kiểu);
 * placeholder không có giá trị làm khoá (hoặc phần tử mảng) đó bị bỏ.
 */
export function renderTemplate(template: unknown, values: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(template)
    if (whole) return values[whole[1]]
    let missing = false
    const text = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (values[key] === undefined) missing = true
      return String(values[key] ?? '')
    })
    return missing ? undefined : text
  }
  if (Array.isArray(template)) return template.map((t) => renderTemplate(t, values)).filter((v) => v !== undefined)
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(template)) {
      const rendered = renderTemplate(value, values)
      if (rendered !== undefined && !(isPlainObject(rendered) && !Object.keys(rendered).length)) out[key] = rendered
    }
    return out
  }
  return template
}

/** Kiểm tra và chuẩn hoá tham số theo khai báo của mục danh mục. */
export function resolveParams(entry: CatalogEntry, given: Record<string, unknown> = {}): Record<string, unknown> {
  const known = new Set(['namespace', ...entry.params.map((p) => p.name)])
  const unknown = Object.keys(given).filter((k) => !known.has(k))
  if (unknown.length) throw new Error(`unknown params for ${entry.id}: ${unknown.join(', ')}`)
  const values: Record<string, unknown> = { namespace: given.namespace ?? entry.namespace }
  if (typeof values.namespace !== 'string' || !/^[a-z][a-z0-9]*$/.test(values.namespace)) {
    throw new Error('namespace must match ^[a-z][a-z0-9]*$')
  }
  for (const param of entry.params) {
    let value = given[param.name] ?? param.default
    if (value === undefined || value === '') {
      if (param.required) throw new Error(`missing required param ${param.name}: ${param.description}`)
      continue
    }
    if (param.type === 'string[]' && typeof value === 'string') value = value.split(',').map((s) => s.trim()).filter(Boolean)
    const ok = param.type === 'string[]' ? Array.isArray(value) && value.every((v) => typeof v === 'string')
      : param.type === 'number' ? typeof value === 'number' || (typeof value === 'string' && SECRET_VALUE.test(value))
      : param.type === 'boolean' ? typeof value === 'boolean'
      : typeof value === 'string'
    if (!ok) throw new Error(`param ${param.name} must be ${param.type}`)
    if (param.secret && !(typeof value === 'string' && SECRET_VALUE.test(value))) {
      throw new Error(`param ${param.name} is secret: pass an environment reference like \${env.NAME}, never the value itself`)
    }
    values[param.name] = value
  }
  return values
}

/** Tên biến môi trường được tham chiếu trong cấu hình, kèm trạng thái đã đặt hay chưa (không lộ giá trị). */
function envRefs(config: unknown) {
  const refs = new Map<string, { set: boolean; hasDefault: boolean }>()
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(ENV_REF)) refs.set(m[1], { set: process.env[m[1]] !== undefined, hasDefault: !!m[2] })
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(config)
  return [...refs].map(([name, state]) => ({ name, ...state }))
}

/** Che thông tin đăng nhập trong URL (`scheme://user:pass@host`) mà agent có thể chép vào văn bản tự do. */
export function redactCredentials(text: string): string {
  return text.replace(/(\w+:\/\/)[^\s/@]+@/g, '$1***@')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function apply(ctx: Context, config: Config) {
  const kernel = ctx.kernel

  let audit: Promise<RunLog> | undefined
  const log = async (type: string, data: unknown) => {
    audit ??= existsSync(join(resolve(config.auditDir), 'audit', 'events.jsonl'))
      ? ctx.runlog.open('audit', config.auditDir)
      : ctx.runlog.create('audit', config.auditDir)
    ;(await audit).append(type, data)
  }
  ctx.effect(() => () => { void audit?.then((l) => l.close()) }, 'tool-catalog.audit')

  /** Row đang dùng plugin của mục danh mục với cùng namespace. */
  const installedRow = (entry: CatalogEntry, namespace: string) => [...kernel.rows.entries()].find(([, state]) => {
    const rowConfig = (state.row.config ?? {}) as Record<string, unknown>
    return state.row.name === entry.plugin && (rowConfig.namespace ?? entry.namespace) === namespace
  })

  const toolsOf = (rowId: string) => ctx.actions.all()
    .filter((def) => kernel.ownerOf(ctx.actions.ownerOf(def.name)) === rowId)
    .map((def) => ({ name: def.name, readOnly: def.readOnly ?? false }))

  /** Dựng row và bản xem trước; ném lỗi khi đề xuất không hợp lệ, trước khi làm phiền người dùng. */
  const prepare = async (args: { catalogId: string; params?: Record<string, unknown>; write?: boolean; reason: string }) => {
    const { entries } = await loadCatalog(config.dirs)
    const entry = entries.find((e) => e.id === args.catalogId)
    if (!entry) throw new Error(`unknown catalog id ${args.catalogId}; use list_tool_catalog`)
    if (args.write && !entry.write) throw new Error(`${entry.id} has no write mode`)
    const values = resolveParams(entry, args.params)
    const namespace = values.namespace as string
    const existing = installedRow(entry, namespace)
    if (existing) {
      throw new Error(`${entry.id} with namespace ${namespace} is already installed as row ${existing[0]}${existing[1].row.disabled ? ' (disabled: ask the user to enable it on the Plugin page)' : ''}`)
    }
    const rowConfig = {
      ...renderTemplate(entry.config, values) as Record<string, unknown>,
      ...(args.write ? renderTemplate(entry.write, values) as Record<string, unknown> : {}),
    }
    const env = envRefs(rowConfig)
    const missingEnv = env.filter((e) => !e.set && !e.hasDefault).map((e) => e.name)
    if (missingEnv.length) {
      throw new Error(`environment variables not set: ${missingEnv.join(', ')}; ask the user to set them and restart aitest`)
    }
    // Kiểm tra cấu hình theo schema của plugin trước khi xin duyệt.
    const plugin = await kernel.resolve(entry.plugin).catch((error) => {
      throw new Error(`plugin ${entry.plugin} is not installed: ${errorMessage(error)}`)
    })
    const schema = (plugin as { Config?: (value: unknown) => unknown }).Config
    try {
      schema?.(interpolate(rowConfig))
    } catch (error) {
      throw new Error(`invalid config for ${entry.plugin}: ${errorMessage(error)}`)
    }
    const rowId = namespace === entry.namespace ? entry.id : `${entry.id}-${namespace}`
    if (kernel.rows.has(rowId)) throw new Error(`row id ${rowId} already exists; choose another namespace`)
    const prefix = (name: string) => namespace === entry.namespace ? name : name.replace(`${entry.namespace}_`, `${namespace}_`)
    const preview = {
      kind: 'tool-proposal',
      catalogId: entry.id,
      title: entry.title,
      reason: redactCredentials(args.reason),
      rowId,
      plugin: entry.plugin,
      namespace,
      access: args.write ? 'write' : 'read',
      tools: {
        read: entry.tools.read.map(prefix),
        write: args.write ? entry.tools.write.map(prefix) : [],
      },
      // Cấu hình nguyên văn sẽ ghi vào patch layer; biến môi trường chỉ được thay khi nạp plugin.
      config: rowConfig,
      env: env.map(({ name, set }) => ({ name, set })),
      patchFile: kernel.patchFile ? toPosix(relative(process.cwd(), kernel.patchFile)) : undefined,
    }
    return { entry, row: { id: rowId, name: entry.plugin, config: rowConfig }, preview }
  }

  ctx.actions.register({
    name: 'list_tool_catalog',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: [
      'Liệt kê các tool đã kiểm duyệt có thể thêm vào nền tảng (Kafka, RabbitMQ, cơ sở dữ liệu...), kèm tham số cần điền',
      'và trạng thái đã cài hay chưa. Dùng khi plan cần một namespace mà `list_actions` chưa có.',
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const { entries, errors } = await loadCatalog(config.dirs)
      return {
        entries: entries.map((entry) => {
          const installed = installedRow(entry, entry.namespace)
          return {
            id: entry.id,
            title: entry.title,
            description: entry.description,
            namespace: entry.namespace,
            installed: installed ? { rowId: installed[0], disabled: !!installed[1].row.disabled } : false,
            tools: entry.tools,
            hasWriteMode: !!entry.write,
            params: entry.params.map((p) => ({
              name: p.name, description: p.description, type: p.type, required: p.required, secret: p.secret,
              ...(p.default !== undefined ? { default: p.default } : {}),
              ...(p.example !== undefined ? { example: p.example } : {}),
            })),
          }
        }),
        ...(errors.length ? { errors } : {}),
      }
    },
    present: (_args, outcome) => {
      const value = outcome.value as { entries?: Array<{ id: string; title: string; installed: unknown }> } | undefined
      return {
        kind: 'tool-catalog',
        title: `Danh mục tool (${value?.entries?.length ?? 0})`,
        entries: value?.entries?.map((e) => ({ id: e.id, title: e.title, installed: !!e.installed })) ?? [],
      }
    },
  })

  ctx.actions.register({
    name: 'propose_tool',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    selfConfirm: true,
    evidence: false,
    description: [
      'Đề xuất thêm một tool từ `list_tool_catalog`. Người dùng thấy cấu hình đầy đủ và quyết định cho phép hay từ chối.',
      'Mặc định chỉ đọc; chỉ đặt `write: true` khi người dùng yêu cầu tool gửi hoặc ghi dữ liệu.',
      'Tham số bí mật truyền dạng `${env.TÊN}`; không bao giờ hỏi hoặc ghi giá trị bí mật.',
      'Trả về `added: false` khi người dùng từ chối.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        catalogId: { type: 'string', description: 'Mã mục trong danh mục, ví dụ `kafka`.' },
        params: { type: 'object', description: 'Tham số theo `params` của mục; có thể thêm `namespace` để cài thêm một bản khác.' },
        write: { type: 'boolean', default: false, description: 'Bật thêm tool ghi dữ liệu.' },
        reason: { type: 'string', description: 'Lý do cần tool này, hiển thị cho người dùng khi duyệt.' },
      },
      required: ['catalogId', 'reason'],
      additionalProperties: false,
    },
    async execute(args: { catalogId: string; params?: Record<string, unknown>; write?: boolean; reason: string }, { scope }) {
      if (!scope.confirm) throw new Error('propose_tool needs a user to approve it; use the chat interface')
      const { entry, row, preview } = await prepare(args)
      const approved = await scope.confirm({ tool: 'propose_tool', title: `Thêm tool ${entry.title}`, preview })
      await log(approved ? 'tool/approved' : 'tool/declined', { session: scope.id, row, access: preview.access, reason: preview.reason })
      if (!approved) return { added: false, reason: 'the user declined the proposal' }
      try {
        await kernel.add(row)
      } catch (error) {
        await log('tool/add-failed', { session: scope.id, rowId: row.id, error: errorMessage(error) })
        throw new Error(`could not load ${entry.plugin}: ${errorMessage(error)}`)
      }
      await log('tool/added', { session: scope.id, rowId: row.id })
      return {
        added: true,
        rowId: row.id,
        namespace: preview.namespace,
        access: preview.access,
        tools: toolsOf(row.id),
        next: 'Gọi một tool chỉ đọc qua `explore` để kiểm tra kết nối, rồi thêm namespace vào `requires` của plan.',
        ...(entry.usage ? { usage: entry.usage } : {}),
      }
    },
    present: (args, outcome) => {
      const value = outcome.value as { added?: boolean; rowId?: string; tools?: Array<{ name: string }> } | undefined
      return {
        kind: 'tool-added',
        title: outcome.status !== 'ok' ? `Đề xuất ${args.catalogId} thất bại`
          : value?.added ? `Đã thêm ${args.catalogId}` : `Người dùng từ chối ${args.catalogId}`,
        added: value?.added ?? false,
        rowId: value?.rowId,
        tools: value?.tools?.map((t) => t.name) ?? [],
      }
    },
  })

  ctx.authoring.guideSection({
    id: 'authoring/tool-catalog',
    order: 35,
    render: () => [
      '## Thêm tool từ danh mục',
      '- Khi plan cần kiểm tra hệ thống mà `list_actions` chưa có namespace phù hợp (Kafka, RabbitMQ...), gọi `list_tool_catalog`.',
      '- Hỏi người dùng các tham số còn thiếu (địa chỉ broker, URL). Tham số bí mật luôn truyền dạng `${env.TÊN}`; không hỏi giá trị bí mật.',
      '- Không chép mật khẩu hay URL có mật khẩu vào `reason` hoặc tin nhắn trả lời, kể cả khi người dùng đã gửi chúng.',
      '- Gọi `propose_tool` kèm `reason`. Người dùng duyệt trên giao diện. Chỉ đề xuất `write: true` khi người dùng yêu cầu.',
      '- Sau khi thêm, gọi một tool chỉ đọc qua `explore` để kiểm tra kết nối trước khi dùng trong plan.',
    ].join('\n'),
  })
}
