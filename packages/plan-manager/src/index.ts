import { resolve } from 'node:path'
import type {} from '@aitest/authoring'
import type {} from '@aitest/runner'
import type {} from '@aitest/web-host'
import { describePlan, errorMessage, z, type ActionScope, type Context, type PlanDescription } from '@aitest/core'

/**
 * Quản lý plan trên giao diện: danh sách, chi tiết và chạy plan.
 *
 * - Danh sách và nội dung đọc qua tool `list_plans`, `read_plan` của `authoring-catalog`, nên dùng chung
 *   thư mục plan và giới hạn đường dẫn với agent soạn plan.
 * - Chạy plan gọi `ctx.runner.run` ở nền và trả mã lượt chạy ngay; giao diện theo dõi lượt chạy qua `run-viewer`.
 * - Sửa plan cùng agent đi qua cuộc chat (`chats.openPlan`), không có method riêng ở đây.
 */
export interface Config {
  maxConcurrent: number
}

export const name = 'plan-manager'
export const inject = ['web', 'actions', 'authoring', 'runner', 'agents']

export const Config = z.object({
  maxConcurrent: z.natural().default(2).description('Số lượt chạy plan đồng thời tối đa khởi động từ giao diện.'),
})

export interface PlanDetail {
  path: string
  content: string
  valid: boolean
  errors: Array<{ message: string; path?: string }>
  warnings: Array<{ message: string; path?: string }>
  plan?: PlanDescription
}

export interface ModelList {
  agent: string
  /** Model mặc định khi chạy (đã áp cấu hình runner và driver); `fallbackFrom`: model cấu hình mà agent không có. */
  current?: string
  fallbackFrom?: string
  available: Array<{ id: string; name: string; description?: string }>
  error?: string
}

export function apply(ctx: Context, config: Config) {
  /** Lượt chạy đang chạy do trang Plan khởi động, kèm controller để dừng. */
  const running = new Map<string, AbortController>()
  // Danh sách model của agent chạy test: mở một phiên tạm để hỏi agent, lưu 10 phút.
  let models: { at: number; value: Promise<ModelList> } | undefined
  const loadModels = async (): Promise<ModelList> => {
    const agent = ctx.runner.config.agent
    try {
      const connection = await ctx.agents.get(agent).connect({ cwd: ctx.runner.config.cwd ?? process.cwd() })
      try {
        const session = await connection.newSession({
          cwd: ctx.runner.config.cwd ?? process.cwd(), mcpServers: [], onUpdate: () => {}, model: ctx.runner.config.model || undefined,
        })
        await session.close().catch(() => {})
        return { agent, current: session.models?.current, fallbackFrom: session.models?.fallbackFrom, available: session.models?.available ?? [] }
      } finally {
        await connection.close().catch(() => {})
      }
    } catch (error) {
      return { agent, available: [], error: errorMessage(error) }
    }
  }

  /** Scope soạn plan không ghi log: đọc danh sách, nội dung plan là thao tác duyệt của giao diện. */
  const scope = (): ActionScope => ({
    kind: 'authoring', id: 'plan-manager', namespaces: new Set(['authoring']), phase: 'user',
    signal: AbortSignal.timeout(30_000), log: () => {},
  })
  const call = async (tool: string, args: Record<string, unknown>) => {
    const outcome = await ctx.actions.invoke(scope(), tool, args)
    if (outcome.status !== 'ok') throw new Error(outcome.error)
    return outcome.value
  }

  ctx.web.method('plans.models', (params: { refresh?: boolean } = {}) => {
    if (!models || params.refresh || Date.now() - models.at > 600_000) {
      const value = loadModels()
      models = { at: Date.now(), value }
      // Lỗi (agent chưa đăng nhập...) không được lưu lâu: lần gọi sau thử lại.
      void value.then((v) => { if (v.error && models?.value === value) models = undefined })
    }
    return models.value
  })

  ctx.web.method('plans.list', async () => (await call('list_plans', {}) as { plans: unknown[] }).plans)

  ctx.web.method('plans.get', async (params: { path: string }): Promise<PlanDetail> => {
    const { content } = await call('read_plan', { path: params.path }) as { content: string }
    const result = await ctx.authoring.validate(content, resolve(params.path))
    return {
      path: params.path,
      content,
      valid: result.valid,
      errors: result.issues.filter((i) => i.level === 'error'),
      warnings: result.issues.filter((i) => i.level === 'warning'),
      plan: result.plan && describePlan(result.plan),
    }
  })

  /** Bản nháp chưa lưu dưới dạng dễ đọc (bảng "Xem trước" của cuộc chat): parse và kiểm tra, không đọc file. */
  ctx.web.method('plans.preview', async (params: { content: string }): Promise<Omit<PlanDetail, 'path'>> => {
    const result = await ctx.authoring.validate(params.content)
    return {
      content: params.content,
      valid: result.valid,
      errors: result.issues.filter((i) => i.level === 'error'),
      warnings: result.issues.filter((i) => i.level === 'warning'),
      plan: result.plan && describePlan(result.plan),
    }
  })

  ctx.web.method('plans.run', async (params: { path: string; cases?: string[]; inputs?: Record<string, unknown>; env?: string; model?: string }) => {
    // Đọc qua `read_plan` để dùng chung giới hạn thư mục plan với agent soạn plan.
    const { content } = await call('read_plan', { path: params.path }) as { content: string }
    const result = await ctx.authoring.validate(content, resolve(params.path))
    if (!result.valid || !result.plan) {
      throw new Error(`plan is invalid: ${result.issues.filter((i) => i.level === 'error').map((i) => i.message).join('; ')}`)
    }
    if (running.size >= config.maxConcurrent) throw new Error(`${running.size} runs are in progress; wait for one to finish`)
    const plan = result.plan
    const unknown = (params.cases ?? []).filter((id) => !plan.cases.some((c) => c.id === id))
    if (unknown.length) throw new Error(`unknown case: ${unknown.join(', ')}`)
    if (params.env && plan.envs?.length && !plan.envs.includes(params.env)) {
      throw new Error(`plan ${plan.id} is limited to environments ${plan.envs.join(', ')}`)
    }
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${plan.id}`.replace(/[^\w.-]/g, '_')
    const inputs = Object.fromEntries(Object.entries(params.inputs ?? {}).filter(([, v]) => v !== '' && v !== undefined))
    const controller = new AbortController()
    running.set(runId, controller)
    ctx.runner.run({
      plan, cases: params.cases?.length ? params.cases : undefined, runId, inputs, env: params.env || undefined, model: params.model || undefined,
      signal: controller.signal,
    })
      .catch((error) => ctx.logger('plan-manager').warn('run %s failed: %s', runId, errorMessage(error)))
      .finally(() => running.delete(runId))
    return { runId }
  })

  /** Dừng lượt chạy do trang Plan khởi động: case đang chạy dừng (vẫn dọn dẹp), case chưa chạy ghi `error`. */
  ctx.web.method('plans.cancel', (params: { runId: string }) => {
    const controller = running.get(params.runId)
    if (!controller) throw new Error(`run ${params.runId} is not running from this host`)
    controller.abort('cancelled by the user')
    return { cancelled: true }
  })

  ctx.effect(() => () => { for (const controller of running.values()) controller.abort('plan-manager unloaded') })
}

/** Mô tả plan cho giao diện; dùng chung với bản xem trước của cuộc chat (`describePlan` của core). */
export { describePlan } from '@aitest/core'
