import { formulaVariables } from './formula-vars.ts'
import type { TestPlan } from './types.ts'

/**
 * Plan dưới dạng dữ liệu cho giao diện (bản xem trước cho người đọc nghiệp vụ, trang chi tiết plan): case kèm bước,
 * lời gọi có cấu trúc, chuẩn bị và dọn dẹp, tiêu chí đạt, nguồn biến của công thức; đầu vào kèm cách lấy giá trị.
 */
export interface PlanDescription {
  id: string
  name: string
  description?: string
  context?: string
  requires: string[]
  systems: string[]
  /** Môi trường được chạy plan; rỗng là mọi môi trường. */
  envs: string[]
  inputs: Array<{ name: string; desc?: string; default?: unknown; required: boolean; mode: 'fill' | 'prepare' | 'user' }>
  /** Tài liệu nghiệp vụ dùng chung mà plan tham chiếu. */
  contextRefs: string[]
  /** Bước chuẩn bị, dọn dẹp chung cho mọi case: mô tả, hoặc tên action khi không có mô tả. */
  setup: string[]
  teardown: string[]
  cases: Array<{
    id: string
    title: string
    tags: string[]
    /** Câu chỉ dẫn cho agent; bước có cấu trúc đã được chuyển thành câu. */
    steps: string[]
    /** Lời gọi gốc của bước có cấu trúc, cùng chỉ số với `steps`. */
    calls: Array<{ call: string; desc?: string; path?: unknown; query?: unknown; body?: unknown } | null>
    setup: string[]
    teardown: string[]
    /** Kết quả mong đợi kèm tiêu chí: toán tử, giá trị hoặc công thức. */
    expect: Array<{ id: string; desc: string; op?: string; value?: unknown; expr?: string; fromRun?: string[]; fromEvidence?: string[] }>
  }>
}

function fixtureText(step: { action: string; desc?: string }) {
  return step.desc?.trim() || `Chạy \`${step.action}\``
}

export function describePlan(plan: TestPlan): PlanDescription {
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
    contextRefs: plan.contextRefs ?? [],
    setup: plan.setup.map(fixtureText),
    teardown: plan.teardown.map(fixtureText),
    cases: plan.cases.map((c) => ({
      id: c.id, title: c.title, tags: c.tags, steps: c.steps,
      calls: c.steps.map((_, i) => {
        const call = c.calls?.[i]
        return call ? { call: call.call, desc: call.desc, path: call.path, query: call.query, body: call.body } : null
      }),
      setup: c.setup.map(fixtureText),
      teardown: c.teardown.map(fixtureText),
      expect: c.expect.map((e) => {
        const vars = e.check?.expr ? formulaVariables(plan, c, e.check) : undefined
        return {
          id: e.id, desc: e.desc,
          ...(e.check ? { op: e.check.op, ...(e.check.expr ? { expr: e.check.expr } : { value: e.check.value }) } : {}),
          ...(vars ? { fromRun: vars.fromRun.map((v) => v.name), fromEvidence: vars.fromEvidence } : {}),
        }
      }),
    })),
  }
}
