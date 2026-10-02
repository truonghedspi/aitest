import { Context, Service } from '@deepseek-ai/cordis'
import { checkFormulas, type UserFormula } from './expr.ts'
import type { TestPlan } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    formulas: FormulaService
  }
}

/** Công thức kèm ví dụ kiểm chứng (lấy từ đặc tả) và nơi khai báo. */
export interface FormulaDefinition extends UserFormula {
  examples?: Array<{ args: Record<string, unknown>; result: unknown }>
  /** Nơi khai báo, để báo lỗi: `plan`, `systems/order-service/formulas.yml`… */
  source?: string
}

/** Nguồn công thức theo plan, ví dụ catalog hệ thống cung cấp công thức của các service mà plan dùng. */
export type FormulaProvider = (plan: TestPlan) => Record<string, FormulaDefinition> | Promise<Record<string, FormulaDefinition>>

/**
 * Service `formulas`: tập công thức dùng được trong biểu thức của một plan.
 * Thứ tự ưu tiên khi trùng tên: công thức trong plan, rồi các nguồn đăng ký (theo thứ tự đăng ký).
 */
export class FormulaService extends Service {
  private readonly providers = new Set<FormulaProvider>()

  constructor(ctx: Context) {
    super(ctx, 'formulas')
  }

  provide(provider: FormulaProvider) {
    return this.ctx.effect(() => {
      this.providers.add(provider)
      return () => { this.providers.delete(provider) }
    }, 'formulas.provide')
  }

  /** Mọi công thức dùng được trong plan. */
  async for(plan: TestPlan): Promise<Record<string, FormulaDefinition>> {
    const out: Record<string, FormulaDefinition> = {}
    for (const provider of this.providers) Object.assign(out, await provider(plan))
    for (const [name, f] of Object.entries(plan.formulas ?? {})) out[name] = { ...f, source: 'plan' }
    return out
  }

  /** Kiểm tra công thức của plan: cú pháp, tham số, gọi vòng, ví dụ kiểm chứng. */
  async check(plan: TestPlan): Promise<string[]> {
    const formulas = await this.for(plan)
    return checkFormulas(formulas).map((issue) => {
      const name = /^formula (\w+)/.exec(issue)?.[1]
      const source = name ? formulas[name]?.source : undefined
      return source && source !== 'plan' ? `${issue} (${source})` : issue
    })
  }
}
