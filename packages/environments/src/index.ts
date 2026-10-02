import type {} from '@aitest/authoring'
import {
  errorMessage, listEnvironments, loadEnvironment, Service, z,
  type Context, type EnvironmentIssue, type EnvironmentSpec, type Kernel,
} from '@aitest/core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    envs: EnvironmentService
  }
}

export interface Config {
  dir: string
  default: string
  internalNamespaces: string[]
}

export interface EnvironmentSummary {
  name: string
  label?: string
  description?: string
  default: boolean
  readOnly: boolean
  file?: string
  /** Row được ghi đè ở môi trường này. */
  tools: Array<{ row: string; enabled: boolean }>
  /** Bản tool của môi trường đã được nạp. */
  active: boolean
  issues: EnvironmentIssue[]
}

/**
 * Service `envs`: chạy plan trên nhiều môi trường trong cùng một Host.
 *
 * - Mỗi môi trường ghi đè cấu hình row (`tools` trong `envs/<tên>.yml`). Lần đầu dùng, service nạp bản sao
 *   `<row>@<môi trường>` qua `kernel.spawn`; action của bản sao chỉ dùng cho scope cùng môi trường, nên
 *   các lượt chạy trên môi trường khác nhau chạy song song, mỗi lượt kết nối đúng DB, broker, server.
 * - `enabled: false` ẩn tool của row ở môi trường đó; `enabled: true` bật ở môi trường đó row đang tắt mặc định.
 * - `policy.readOnly` chặn mọi lời gọi có thể ghi dữ liệu vào hệ thống, kể cả fixture và agent chuẩn bị dữ liệu;
 *   tool nội bộ của nền tảng (`internalNamespaces`) và tool soạn plan không bị chặn.
 * - Plan khai báo `envs` để giới hạn môi trường được chạy; `vars` của môi trường thành biến dùng chung.
 * Cấu hình đổi thì bản sao được nạp lại ở lần dùng kế tiếp.
 */
export class EnvironmentService extends Service {
  static inject = ['kernel', 'actions']
  static Config = z.object({
    dir: z.string().default('envs').description('Thư mục chứa `<tên>.yml`, tương đối với thư mục làm việc.'),
    default: z.string().default('local').description('Môi trường khi lượt chạy không chọn; thường đặt `${env.AITEST_ENV:-local}`.'),
    internalNamespaces: z.array(z.string()).default(['verdict', 'wait', 'webhook', 'math', 'inputs', 'knowledge', 'authoring'])
      .description('Namespace của tool nội bộ, không ghi vào hệ thống dưới kiểm thử; không bị `policy.readOnly` chặn.'),
  })

  /** Cấu hình đã nạp gần nhất của mỗi môi trường; dùng cho bộ lọc và chính sách (hàm đồng bộ). */
  private readonly specs = new Map<string, EnvironmentSpec>()
  /** Row đã nạp theo môi trường và khoá cấu hình tương ứng. */
  private readonly spawned = new Map<string, { key: string; rows: string[] }>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'envs')

    // Ẩn tool của row bị tắt ở môi trường của scope.
    ctx.actions.filter((_def, owner, scope) => {
      const spec = scope.env ? this.specs.get(scope.env) : undefined
      if (!spec) return true
      const row = this.kernel.ownerOf(owner)
      return !(row && spec.tools[row]?.enabled === false)
    })

    // Môi trường chỉ đọc: chặn lời gọi có thể ghi dữ liệu.
    ctx.on('action/before', async (call, next) => {
      const spec = call.scope.env ? this.specs.get(call.scope.env) : undefined
      if (!spec?.policy.readOnly || call.scope.kind === 'authoring' || this.config.internalNamespaces.includes(call.namespace)) return next()
      const readOnly = call.definition.readOnly === true || call.definition.isReadOnlyCall?.(call.args) === true
      if (readOnly) return next()
      return { type: 'deny' as const, reason: `environment ${spec.name} is read-only; ${call.name} may modify data` }
    })

    // Đầu lượt chạy: kiểm tra plan được chạy trên môi trường, nạp tool của môi trường, đưa biến của môi trường vào lượt chạy.
    ctx.on('run/start', async (run) => {
      run.env ||= this.config.default
      const env = run.env
      if (run.plan.envs?.length && !run.plan.envs.includes(env)) {
        run.blocked.push(`plan ${run.plan.id} is limited to environments ${run.plan.envs.join(', ')}; not ${env}`)
        return
      }
      try {
        const spec = await this.ensure(env)
        // Biến của môi trường ghi đè biến cùng tên trong plan (giá trị trong plan là mặc định).
        for (const [key, value] of Object.entries(spec.vars)) if (!(key in run.vars)) run.vars[key] = value
        run.log('env/resolved', {
          env, label: spec.label, readOnly: spec.policy.readOnly, file: spec.file,
          rows: this.spawned.get(env)?.rows ?? [], vars: Object.keys(spec.vars),
        })
      } catch (error) {
        run.blocked.push(`environment ${env}: ${errorMessage(error)}`)
      }
    })

    // Kiểm tra khi soạn plan: tên môi trường trong `envs` phải có thật.
    ctx.on('authoring/lint', async (plan, issues) => {
      if (!plan.envs?.length) return
      const known = new Set([...await listEnvironments(this.config.dir), this.config.default])
      for (const env of plan.envs) {
        if (!known.has(env)) issues.push({ level: 'error', path: 'envs', message: `unknown environment ${env}; known: ${[...known].join(', ')}` })
      }
    })

    ctx.effect(() => () => { void this.disposeAll() }, 'envs.rows')
  }

  private get kernel() {
    return this.ctx.get('kernel') as Kernel
  }

  /** Mọi môi trường có file, cùng môi trường mặc định (có thể không có file). */
  async list(): Promise<EnvironmentSummary[]> {
    const names = [...new Set([this.config.default, ...await listEnvironments(this.config.dir)])].sort()
    return Promise.all(names.map(async (name) => {
      const { env, issues } = await loadEnvironment(this.config.dir, name)
      const ignorable = name === this.config.default && !env.file
      return {
        name,
        label: env.label,
        description: env.description,
        default: name === this.config.default,
        readOnly: env.policy.readOnly,
        file: env.file,
        tools: Object.entries(env.tools).map(([row, t]) => ({ row, enabled: t.enabled !== false })),
        active: this.spawned.has(name),
        issues: ignorable ? [] : [...issues, ...this.rowIssues(env)],
      }
    }))
  }

  /** Cấu hình hiện tại của môi trường; ném lỗi khi môi trường không có file (trừ môi trường mặc định). */
  async get(name: string): Promise<EnvironmentSpec> {
    const { env, issues } = await loadEnvironment(this.config.dir, name)
    if (issues.length && !(name === this.config.default && !env.file)) throw new Error(issues.map((i) => i.error).join('; '))
    this.specs.set(name, env)
    return env
  }

  /**
   * Nạp tool của môi trường. Gọi lại khi cấu hình không đổi thì không làm gì; cấu hình đổi thì nạp lại bản sao.
   * Row nạp lỗi được báo trong lỗi ném ra; row khác vẫn được nạp.
   */
  async ensure(name: string): Promise<EnvironmentSpec> {
    const previous = this.locks.get(name) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(() => this.apply(name))
    this.locks.set(name, task)
    return task
  }

  private async apply(name: string): Promise<EnvironmentSpec> {
    const spec = await this.get(name)
    const key = JSON.stringify(spec.tools)
    const current = this.spawned.get(name)
    if (current?.key === key) return spec
    if (current) for (const id of current.rows) await this.kernel.despawn(id).catch(() => {})
    const rows: string[] = []
    const errors = this.rowIssues(spec).map((i) => i.error)
    for (const [rowId, override] of Object.entries(spec.tools)) {
      const base = this.kernel.rows.get(rowId)
      if (!base || base.layer === 'env' || override.enabled === false) continue
      if (base.row.disabled && override.enabled !== true) continue
      const id = `${rowId}@${name}`
      try {
        await this.kernel.spawn({
          id, name: base.row.name, env: name, baseDir: base.row.baseDir,
          config: merge(base.row.config ?? {}, override.config ?? {}),
        })
        rows.push(id)
      } catch (error) {
        errors.push(`${rowId}: ${errorMessage(error)}`)
      }
    }
    this.spawned.set(name, { key: errors.length ? `${key}#failed` : key, rows })
    if (errors.length) throw new Error(errors.join('; '))
    return spec
  }

  /** Row ghi đè không tồn tại trong cấu hình. */
  private rowIssues(spec: EnvironmentSpec): EnvironmentIssue[] {
    return Object.keys(spec.tools)
      .filter((id) => { const row = this.kernel.rows.get(id); return !row || row.layer === 'env' })
      .map((id) => ({ file: spec.file ?? spec.name, error: `tools.${id}: no plugin row with id ${id}` }))
  }

  private async disposeAll() {
    for (const { rows } of this.spawned.values()) for (const id of rows) await this.kernel.despawn(id).catch(() => {})
    this.spawned.clear()
  }
}

export default EnvironmentService

/** Gộp cấu hình: object gộp đệ quy, giá trị khác (mảng, chuỗi) của môi trường thay hẳn giá trị mặc định. */
export function merge(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) out[key] = merge(base[key], value)
  return out
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
