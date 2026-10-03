import { Context, Service, z, type CaseScope } from '@aitest/core'
import { registerStepRunner } from './steps.ts'
import { channelIn, describeKnowledge, loadEnv, loadSystems, systemVars, type Catalog, type EventChannel, type SystemSpec } from './model.ts'

export * from './model.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    systems: SystemCatalogService
  }
}

export interface Config {
  dirs: string[]
  envDir: string
  env: string
}

/**
 * Service `systems`: catalog hệ thống dưới kiểm thử cho môi trường đang chọn.
 *
 * Plan khai báo `systems: [order-service]` để nhận:
 * - biến `{{order-service.url}}` theo môi trường, có trước fixture và trước khi thay biến trong bước;
 * - section prompt mô tả operation, kênh sự kiện, consumer, dữ liệu của các system đó.
 * Catalog được đọc lại ở đầu mỗi case, nên sửa file có hiệu lực ngay ở case kế tiếp.
 */
export class SystemCatalogService extends Service {
  static inject = ['prompt', 'formulas', 'actions']
  static Config = z.object({
    dirs: z.array(z.string()).default(['systems']).description('Thư mục chứa `<id>/service.yml`, tương đối với thư mục làm việc.'),
    envDir: z.string().default('envs').description('Thư mục chứa `<tên môi trường>.yml`.'),
    env: z.string().default('local').description('Môi trường mặc định khi lượt chạy không chọn môi trường; service `envs` có thì dùng mặc định của service đó.'),
  })

  /** Catalog đã nạp cho từng case, để section prompt (hàm đồng bộ) đọc được. */
  private readonly resolved = new WeakMap<CaseScope, Catalog>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'systems')

    // Biến của catalog có trước bước chuẩn bị dữ liệu, để `fill` của input gọi được `{{<system>.url}}`.
    ctx.on('run/start', async (run) => {
      const ids = run.plan.systems ?? []
      if (!ids.length) return
      const vars = systemVars(await this.load(run.env), ids)
      for (const [key, value] of Object.entries(vars)) if (!(key in run.vars) && !(key in run.plan.vars)) run.vars[key] = value
    })

    ctx.on('case/start', async (scope) => {
      const ids = scope.plan.systems ?? []
      if (!ids.length) return
      const catalog = await this.load(scope.env)
      this.resolved.set(scope, catalog)
      const missing = ids.filter((id) => !catalog.systems.some((s) => s.id === id))
      const vars = systemVars(catalog, ids)
      // Biến của plan được ưu tiên, để plan vẫn ghi đè được địa chỉ khi cần.
      for (const [key, value] of Object.entries(vars)) if (!(key in scope.vars)) scope.vars[key] = value
      scope.log('systems/resolved', { env: catalog.env.name, systems: ids, vars, ...(missing.length ? { missing } : {}) })
    })

    // Bước `call:` đầu case do nền tảng chạy, dùng catalog đã nạp ở `case/start`.
    registerStepRunner(ctx, async (scope) => this.resolved.get(scope) ?? this.load(scope.env))

    // Công thức của các service mà plan khai báo trong `systems`.
    ctx.formulas.provide(async (plan) => {
      const ids = plan.systems ?? []
      if (!ids.length) return {}
      const { systems } = await loadSystems(this.config.dirs)
      return Object.assign({}, ...systems.filter((s) => ids.includes(s.id)).map((s) => s.formulas))
    })

    ctx.prompt.section({
      id: 'systems/context',
      order: 15,
      render: (scope) => {
        const catalog = this.resolved.get(scope)
        if (!catalog) return undefined
        const systems = (scope.plan.systems ?? []).map((id) => catalog.systems.find((s) => s.id === id)).filter((s): s is SystemSpec => !!s)
        if (!systems.length) return undefined
        return [
          `## Hệ thống liên quan (môi trường ${catalog.env.name})`,
          'Bước có dạng `<system>.<operation>` hoặc `<system>.<kênh sự kiện>` tham chiếu tới mục cùng tên dưới đây.',
          ...systems.map((s) => renderSystem(s, catalog)),
        ].join('\n\n')
      },
    })
  }

  /** Môi trường mặc định: của service `envs` nếu có, nếu không thì theo cấu hình của catalog. */
  get defaultEnv(): string {
    return (this.ctx.get('envs') as { config?: { default?: string } } | undefined)?.config?.default ?? this.config.env
  }

  /** Nạp catalog và một môi trường (mặc định: môi trường mặc định); đọc lại file mỗi lần gọi. */
  async load(env?: string): Promise<Catalog> {
    env ||= this.defaultEnv
    const [{ systems, issues }, loaded] = await Promise.all([loadSystems(this.config.dirs), loadEnv(this.config.envDir, env)])
    return { systems, env: loaded.env, issues: [...issues, ...loaded.issues] }
  }
}

export default SystemCatalogService

function renderSystem(system: SystemSpec, catalog: Catalog) {
  const url = catalog.env.systems[system.id]?.url
  const lines = [`### ${system.id}: ${system.title}`]
  if (system.description) lines.push(system.description)
  if (system.operations.length) {
    lines.push('', url ? `HTTP, base URL \`${url}\` (biến \`{{${system.id}.url}}\`):` : 'HTTP (môi trường chưa khai báo base URL):')
    for (const op of system.operations) lines.push(`- \`${op.id}\`: ${op.method} ${op.path}${op.summary ? `: ${op.summary}` : ''}`)
  }
  if (system.events.length) {
    lines.push('', 'Kênh sự kiện:')
    for (const channel of system.events) lines.push(`- ${renderChannel(channelIn(channel, system.id, catalog.env), catalog)}`)
  }
  if (system.consumers.length) {
    lines.push('', 'Consumer:')
    for (const c of system.consumers) {
      lines.push(`- \`${c.group}\`${c.description ? `: ${c.description}` : ''}${c.effects.length ? ` Hệ quả: ${c.effects.join('; ')}.` : ''}`)
    }
  }
  const formulas = Object.entries(system.formulas)
  if (formulas.length) {
    lines.push('', 'Công thức nghiệp vụ (dùng trong công thức của expectation và tool `calc`):')
    for (const [name, f] of formulas) lines.push(`- \`${name}(${f.params.join(', ')})\`${f.desc ? `: ${f.desc}` : ''}`)
  }
  const knowledge = describeKnowledge(system)
  if (knowledge.length) lines.push('', ...(system.data.length ? ['Dữ liệu:'] : []), ...knowledge)
  return lines.join('\n')
}

function renderChannel(channel: EventChannel, catalog: Catalog) {
  const namespace = catalog.env.brokers[channel.broker]?.namespace
  const where = channel.kind === 'kafka' ? `Kafka topic \`${channel.topic}\`` : `RabbitMQ exchange \`${channel.exchange}\``
  const parts = [`\`${channel.id}\`: ${where}`]
  parts.push(namespace ? `dùng tool namespace \`${namespace}\`` : `broker \`${channel.broker}\` chưa được ánh xạ trong môi trường`)
  if (channel.correlation) parts.push(`lọc theo \`${channel.correlation}\``)
  const messages = channel.messages.map((m) => m.routingKey && m.routingKey !== m.name ? `${m.name} (routing key ${m.routingKey})` : m.name)
  if (messages.length) parts.push(`bản tin: ${messages.join(', ')}`)
  return parts.join('; ') + (channel.description ? `. ${channel.description}` : '')
}
