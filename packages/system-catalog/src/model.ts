import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { errorMessage, loadEnvironment, toPosix, z, type EnvironmentSpec, type FormulaDefinition } from '@aitest/core'

/**
 * Mô hình hệ thống dưới kiểm thử, tách thành hai phần:
 * - `systems/<id>/service.yml`: hợp đồng của service (HTTP, sự kiện, consumer, dữ liệu), giống nhau mọi môi trường.
 * - `envs/<tên>.yml`: địa chỉ của service và ánh xạ broker → namespace tool cho từng môi trường.
 * Hợp đồng HTTP lấy từ OpenAPI của service khi có, không chép tay.
 */

export interface HttpParam {
  name: string
  in: string
  required: boolean
  description?: string
  schema?: unknown
}

export interface HttpOperation {
  id: string
  method: string
  path: string
  summary?: string
  description?: string
  params: HttpParam[]
  requestBody?: unknown
  responses: Record<string, { description?: string; schema?: unknown }>
  source: 'openapi' | 'inline'
}

export interface EventMessage {
  name: string
  description?: string
  routingKey?: string
  example?: unknown
}

export interface EventChannel {
  id: string
  kind: 'kafka' | 'rabbitmq'
  broker: string
  topic?: string
  exchange?: string
  key?: string
  /** Path tới mã nghiệp vụ trong bản tin, dùng để lọc đúng bản tin của lượt chạy. */
  correlation?: string
  description?: string
  messages: EventMessage[]
}

export interface Consumer {
  group: string
  broker?: string
  description?: string
  consumes: string[]
  effects: string[]
}

/** Một cột: ý nghĩa nghiệp vụ và giá trị hợp lệ (ví dụ mã trạng thái) kèm nghĩa của từng giá trị. */
export interface DataColumn {
  name: string
  type?: string
  desc?: string
  values?: Record<string, string>
}

/** Một bảng: mô tả, cột đã được giải thích, quy tắc về dữ liệu của bảng. Cột không khai báo vẫn có thể tồn tại. */
export interface DataTable {
  name: string
  desc?: string
  columns: DataColumn[]
  rules: string[]
}

export interface DataStore {
  namespace: string
  description?: string
  tables: DataTable[]
  profile: boolean
}

export interface SystemSpec {
  id: string
  title: string
  description?: string
  owner?: string
  docs: string[]
  operations: HttpOperation[]
  events: EventChannel[]
  consumers: Consumer[]
  data: DataStore[]
  /**
   * Quy tắc nghiệp vụ của service, ví dụ "chỉ lệnh NEW được huỷ". Cùng mô tả bảng, cột, đây là ngữ cảnh dùng chung
   * cho mọi plan khai báo service trong `systems`: vào prompt của agent chạy test, không phải chép vào `context` của plan.
   */
  rules: string[]
  /** Tính năng liên quan, khớp `feature` của ghi chú trong `kb/`. */
  features: string[]
  /** Công thức nghiệp vụ của service (`formulas.yml` cạnh `service.yml`), dùng trong expectation của plan. */
  formulas: Record<string, FormulaDefinition>
  /** File `service.yml`, tương đối với thư mục làm việc. */
  file: string
}

/** Phần môi trường mà catalog dùng: địa chỉ service, tên topic hoặc exchange theo môi trường, ánh xạ broker. */
export type EnvSpec = Pick<EnvironmentSpec, 'name' | 'systems' | 'brokers'> & { file?: string }

export interface CatalogIssue {
  file: string
  error: string
}

export interface Catalog {
  systems: SystemSpec[]
  env: EnvSpec
  issues: CatalogIssue[]
}

const Message = z.object({
  name: z.string().required(),
  description: z.string(),
  routingKey: z.string(),
  example: z.any(),
})

const ServiceSchema = z.object({
  id: z.string().pattern(/^[a-z][a-z0-9-]*$/).required(),
  title: z.string().required(),
  description: z.string(),
  owner: z.string(),
  docs: z.array(z.string()).default([]),
  http: z.object({
    openapi: z.string().description('Đường dẫn OpenAPI 3 (YAML hoặc JSON), tương đối với service.yml.'),
    operations: z.dict(z.object({
      method: z.string(),
      path: z.string(),
      summary: z.string(),
      description: z.string(),
      requestBody: z.any(),
    })).default({}),
  }),
  events: z.array(z.object({
    id: z.string().pattern(/^[a-z][a-z0-9-]*$/).required(),
    kind: z.union(['kafka', 'rabbitmq'] as const).required(),
    broker: z.string().required(),
    topic: z.string(),
    exchange: z.string(),
    key: z.string(),
    correlation: z.string(),
    description: z.string(),
    messages: z.array(Message).default([]),
  })).default([]),
  consumers: z.array(z.object({
    group: z.string().required(),
    broker: z.string(),
    description: z.string(),
    consumes: z.array(z.string()).default([]),
    effects: z.array(z.string()).default([]),
  })).default([]),
  data: z.array(z.object({
    namespace: z.string().required(),
    description: z.string(),
    tables: z.array(z.union([z.string(), z.object({
      name: z.string().required(),
      desc: z.string(),
      columns: z.dict(z.union([z.string(), z.object({
        type: z.string(),
        desc: z.string(),
        values: z.union([z.array(z.union([z.string(), z.number()])), z.dict(z.string())]),
      })])).default({}),
      rules: z.array(z.string()).default([]),
    })])).default([]),
    profile: z.boolean().default(true).description('Lấy hồ sơ dữ liệu thật (cột, giá trị hay gặp, dòng mẫu) cho gói ngữ cảnh.'),
  })).default([]),
  rules: z.array(z.string()).default([]).description('Quy tắc nghiệp vụ dùng chung cho mọi plan của service.'),
  features: z.array(z.string()).default([]).description('Tính năng liên quan, khớp `feature` của ghi chú trong kb/.'),
})

/**
 * Ngữ cảnh dữ liệu và quy tắc đã khai báo của service, dạng dòng Markdown. Dùng chung cho prompt của agent chạy test
 * và gói ngữ cảnh khi soạn plan, để hai agent thấy cùng một nội dung.
 */
export function describeKnowledge(system: SystemSpec): string[] {
  const lines: string[] = []
  for (const store of system.data) {
    lines.push(`- namespace \`${store.namespace}\`${store.description ? ` (${store.description})` : ''}: bảng ${store.tables.map((t) => `\`${t.name}\``).join(', ')}`)
    for (const table of store.tables) {
      if (!table.desc && !table.columns.length && !table.rules.length) continue
      lines.push(`  - Bảng \`${table.name}\`${table.desc ? `: ${table.desc}` : ''}`)
      for (const c of table.columns) {
        const values = c.values && Object.keys(c.values).length
          ? `; giá trị: ${Object.entries(c.values).map(([v, meaning]) => meaning ? `\`${v}\` = ${meaning}` : `\`${v}\``).join(', ')}`
          : ''
        lines.push(`    - \`${c.name}\`${c.type ? ` (${c.type})` : ''}${c.desc ? `: ${c.desc}` : ''}${values}`)
      }
      for (const rule of table.rules) lines.push(`    - Quy tắc: ${rule}`)
    }
  }
  if (system.rules.length) {
    lines.push('', 'Quy tắc nghiệp vụ:', ...system.rules.map((r) => `- ${r}`))
  }
  return lines
}

const COLUMN_KEYS = new Set(['type', 'desc', 'values'])

/**
 * Cột viết dạng `{ type: text, desc: Mã lệnh, trùng id }` bị YAML tách tại dấu phẩy: phần sau dấu phẩy thành khoá lạ
 * và bị bỏ mà không báo. Báo lỗi để người viết đặt mô tả trong ngoặc kép hoặc viết nhiều dòng.
 */
function checkColumns(raw: unknown) {
  const data = (raw as { data?: Array<{ tables?: unknown[] }> } | undefined)?.data ?? []
  for (const store of Array.isArray(data) ? data : []) {
    for (const table of store?.tables ?? []) {
      const t = table as { name?: string; columns?: Record<string, unknown> }
      for (const [column, spec] of Object.entries(t?.columns ?? {})) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue
        const unknown = Object.keys(spec).filter((k) => !COLUMN_KEYS.has(k))
        if (unknown.length) {
          throw new Error(`table ${t.name} column ${column}: unknown key "${unknown[0]}"; quote text containing commas, e.g. desc: "a, b", or write the column on several lines`)
        }
        const values = (spec as { values?: unknown }).values
        if (values && typeof values === 'object' && !Array.isArray(values)) {
          const empty = Object.entries(values).find(([, v]) => v === null)
          if (empty) throw new Error(`table ${t.name} column ${column}: value "${empty[0]}" has no meaning; quote meanings containing commas, or write values on several lines`)
        }
      }
    }
  }
}

/** Bảng viết gọn (`tables: [orders]`) hoặc đầy đủ; cột viết gọn (`id: Mã lệnh`) hoặc đầy đủ; giá trị dạng danh sách hoặc map. */
function normalizeTable(raw: string | { name: string; desc?: string; columns?: Record<string, unknown>; rules?: string[] }): DataTable {
  if (typeof raw === 'string') return { name: raw, columns: [], rules: [] }
  const columns = Object.entries(raw.columns ?? {}).map(([name, c]): DataColumn => {
    if (typeof c === 'string') return { name, desc: c }
    const col = c as { type?: string; desc?: string; values?: Array<string | number> | Record<string, string> }
    const values = Array.isArray(col.values) ? Object.fromEntries(col.values.map((v) => [String(v), ''])) : col.values
    return { name, ...(col.type ? { type: col.type } : {}), ...(col.desc ? { desc: col.desc } : {}), ...(values && Object.keys(values).length ? { values } : {}) }
  })
  return { name: raw.name, ...(raw.desc ? { desc: raw.desc } : {}), columns, rules: raw.rules ?? [] }
}


const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

const display = (file: string) => toPosix(relative(process.cwd(), file))

/** Nạp mọi `<dir>/<id>/service.yml`. File lỗi được ghi vào `issues`, không làm hỏng cả catalog. */
export async function loadSystems(dirs: string[]): Promise<{ systems: SystemSpec[]; issues: CatalogIssue[] }> {
  const systems: SystemSpec[] = []
  const issues: CatalogIssue[] = []
  for (const dir of dirs) {
    const root = resolve(dir)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(root, entry.name, 'service.yml')
      if (!(await stat(file).then((s) => s.isFile(), () => false))) continue
      try {
        const system = await loadSystem(file)
        if (system.id !== entry.name) throw new Error(`id ${system.id} must match directory name ${entry.name}`)
        if (systems.some((s) => s.id === system.id)) throw new Error(`duplicate system id ${system.id}`)
        systems.push(system)
      } catch (error) {
        issues.push({ file: display(file), error: errorMessage(error).split('\n')[0] })
      }
    }
  }
  return { systems, issues }
}

export async function loadSystem(file: string): Promise<SystemSpec> {
  const raw = parseYaml(await readFile(file, 'utf8'))
  checkColumns(raw)
  const data = ServiceSchema(raw)
  const base = dirname(file)
  const operations = data.http?.openapi ? await loadOpenApi(resolve(base, data.http.openapi)) : []
  // Operation khai báo trực tiếp bổ sung hoặc ghi đè operation cùng id từ OpenAPI.
  for (const [id, op] of Object.entries(data.http?.operations ?? {})) {
    const existing = operations.find((o) => o.id === id)
    if (existing) Object.assign(existing, Object.fromEntries(Object.entries(op).filter(([, v]) => v !== undefined)))
    else {
      if (!op.method || !op.path) throw new Error(`operation ${id} needs method and path`)
      operations.push({ id, method: op.method.toUpperCase(), path: op.path, summary: op.summary, description: op.description, params: [], requestBody: op.requestBody, responses: {}, source: 'inline' })
    }
  }
  const ids = new Set<string>()
  for (const op of operations) {
    if (ids.has(op.id)) throw new Error(`duplicate operation id ${op.id}`)
    ids.add(op.id)
  }
  for (const channel of data.events) {
    if (ids.has(channel.id)) throw new Error(`event channel ${channel.id} has the same id as an operation`)
    if (channel.kind === 'kafka' && !channel.topic) throw new Error(`event channel ${channel.id}: kafka needs topic`)
    if (channel.kind === 'rabbitmq' && !channel.exchange) throw new Error(`event channel ${channel.id}: rabbitmq needs exchange`)
    ids.add(channel.id)
  }
  const formulas = await loadFormulas(join(base, 'formulas.yml'))
  return {
    id: data.id,
    title: data.title,
    formulas,
    description: data.description,
    owner: data.owner,
    docs: data.docs.map((d) => display(resolve(base, d))),
    operations,
    events: data.events as EventChannel[],
    consumers: data.consumers,
    data: data.data.map((d) => ({ ...d, tables: d.tables.map((t) => normalizeTable(t as Parameters<typeof normalizeTable>[0])) })),
    rules: data.rules,
    features: data.features,
    file: display(file),
  }
}

const FormulaFile = z.dict(z.object({
  params: z.array(z.string()).default([]),
  expr: z.string().required(),
  let: z.dict(z.string()),
  desc: z.string(),
  examples: z.array(z.object({ args: z.dict(z.any()).default({}), result: z.any() })).default([]),
}))

/** Công thức nghiệp vụ của service; không có file thì rỗng. */
export async function loadFormulas(file: string): Promise<Record<string, FormulaDefinition>> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return {}
  }
  const data = FormulaFile(parseYaml(raw) ?? {})
  return Object.fromEntries(Object.entries(data).map(([name, f]) => [name, { ...f, source: display(file) }]))
}

/** Đọc operation từ OpenAPI 3: id lấy từ `operationId`, `$ref` nội bộ được thay bằng nội dung. */
export async function loadOpenApi(file: string): Promise<HttpOperation[]> {
  let doc: any
  try {
    doc = parseYaml(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read OpenAPI ${display(file)}: ${errorMessage(error)}`)
  }
  if (!doc?.paths) throw new Error(`${display(file)} has no paths`)
  const deref = (value: unknown, depth = 0): unknown => {
    if (depth > 8 || !value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((v) => deref(v, depth + 1))
    const ref = (value as { $ref?: unknown }).$ref
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      const target = ref.slice(2).split('/').reduce<any>((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc)
      return deref(target, depth + 1)
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deref(v, depth + 1)]))
  }
  const operations: HttpOperation[] = []
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    const shared = (item.parameters ?? []) as unknown[]
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      const params = [...shared, ...(op.parameters ?? [])].map((p) => deref(p) as any).map((p) => ({
        name: p.name, in: p.in, required: !!p.required, description: p.description, schema: p.schema,
      }))
      const body = deref(op.requestBody) as any
      operations.push({
        id: op.operationId ?? `${method}${path.replace(/[^\w]+/g, '_')}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary,
        description: op.description,
        params,
        requestBody: body?.content?.['application/json']?.schema ?? (body?.content && Object.values<any>(body.content)[0]?.schema),
        responses: Object.fromEntries(Object.entries<any>(op.responses ?? {}).map(([code, r]) => {
          const response = deref(r) as any
          return [code, { description: response?.description, schema: response?.content?.['application/json']?.schema }]
        })),
        source: 'openapi',
      })
    }
  }
  return operations
}

/** Nạp `envs/<tên>.yml` qua loader chung của core. Thiếu file thì trả môi trường rỗng kèm issue. */
export async function loadEnv(dir: string, name: string): Promise<{ env: EnvSpec; issues: CatalogIssue[] }> {
  const { env, issues } = await loadEnvironment(dir, name)
  return { env: { name: env.name, systems: env.systems, brokers: env.brokers, file: env.file }, issues }
}

/** Kênh sự kiện theo môi trường: tên topic, exchange được ghi đè bởi `envs/<tên>.yml` nếu có. */
export function channelIn(channel: EventChannel, systemId: string, env: EnvSpec): EventChannel {
  const override = env.systems[systemId]?.events?.[channel.id]
  return override ? { ...channel, topic: override.topic ?? channel.topic, exchange: override.exchange ?? channel.exchange } : channel
}

/** Biến do catalog cung cấp cho plan: `<system>.url`. */
export function systemVars(catalog: Catalog, ids: string[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  for (const id of ids) {
    const url = catalog.env.systems[id]?.url
    if (url) vars[`${id}.url`] = url.replace(/\/+$/, '')
  }
  return vars
}

/** Tên biến mà catalog cung cấp cho mỗi system; dùng để kiểm tra `{{...}}` trong plan. */
export const SYSTEM_VAR_KEYS = ['url']
