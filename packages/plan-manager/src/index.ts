import { resolve } from 'node:path'
import type {} from '@aitest/authoring'
import type {} from '@aitest/runner'
import type {} from '@aitest/web-host'
import { errorMessage, z, type ActionScope, type Context, type TestPlan } from '@aitest/core'

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
export const inject = ['web', 'actions', 'authoring', 'runner']

export const Config = z.object({
  maxConcurrent: z.natural().default(2).description('Số lượt chạy plan đồng thời tối đa khởi động từ giao diện.'),
})

export interface PlanDetail {
  path: string
  content: string
  valid: boolean
  errors: Array<{ message: string; path?: string }>
  warnings: Array<{ message: string; path?: string }>
  plan?: {
    id: string
    name: string
    description?: string
    context?: string
    requires: string[]
    systems: string[]
    /** Môi trường được chạy plan; rỗng là mọi môi trường. */
    envs: string[]
    inputs: Array<{ name: string; desc?: string; default?: unknown; required: boolean; mode: 'fill' | 'prepare' | 'user' }>
    cases: Array<{ id: string; title: string; tags: string[]; steps: string[]; expect: Array<{ id: string; desc: string }> }>
  }
}

export function apply(ctx: Context, config: Config) {
  const running = new Set<string>()

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

  ctx.web.method('plans.run', async (params: { path: string; cases?: string[]; inputs?: Record<string, unknown>; env?: string }) => {
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
    running.add(runId)
    ctx.runner.run({ plan, cases: params.cases?.length ? params.cases : undefined, runId, inputs, env: params.env || undefined })
      .catch((error) => ctx.logger('plan-manager').warn('run %s failed: %s', runId, errorMessage(error)))
      .finally(() => running.delete(runId))
    return { runId }
  })
}

/** Thông tin plan cho giao diện: case kèm bước và expectation, đầu vào kèm cách lấy giá trị. */
export function describePlan(plan: TestPlan): PlanDetail['plan'] {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    context: plan.context,
    requires: plan.requires,
    systems: plan.systems ?? [],
    envs: plan.envs ?? [],
    inputs: (plan.inputs ?? []).map((i) => ({
      name: i.name, desc: i.desc, default: i.default, required: i.required,
      mode: i.fill.length ? 'fill' as const : i.prepare ? 'prepare' as const : 'user' as const,
    })),
    cases: plan.cases.map((c) => ({
      id: c.id, title: c.title, tags: c.tags, steps: c.steps, expect: c.expect.map((e) => ({ id: e.id, desc: e.desc })),
    })),
  }
}
