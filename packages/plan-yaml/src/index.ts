import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { checkExpression, interpolate, parseExpression, PlanError, z, type Context, type TestPlan } from '@aitest/core'

/**
 * Định dạng test plan `*.plan.yaml`.
 *
 * - `steps` viết bằng ngôn ngữ tự nhiên, cho phép chèn biến `{{tên}}`.
 * - `expect[].check` là điều kiện cố định; agent chỉ chọn evidence để đối chiếu.
 * - `vars` hỗ trợ `${env.NAME:-mặc định}`.
 */
const AssertOp = z.union(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches', 'exists', 'not_exists'] as const)

const ExpectationSchema = z.object({
  id: z.string().required(),
  desc: z.string().required(),
  // `op` không đánh dấu required ở đây vì schemastery điền object rỗng khi thiếu `check`;
  // trường hợp có `check` mà thiếu `op` được kiểm tra riêng trong `parsePlan`.
  check: z.object({ op: AssertOp, value: z.any(), expr: z.string(), let: z.dict(z.string()) }),
  // Như `check`: trường bắt buộc của `from` kiểm tra riêng trong `parsePlan`.
  from: z.object({ step: z.natural(), path: z.string() }),
})

const FormulaSchema = z.object({
  params: z.array(z.string()).default([]),
  expr: z.string().required(),
  let: z.dict(z.string()),
  desc: z.string(),
  examples: z.array(z.object({ args: z.dict(z.any()).default({}), result: z.any() })).default([]),
})

const FixtureSchema = z.object({
  action: z.string().required(),
  args: z.dict(z.any()).default({}),
  save: z.dict(z.string()),
  desc: z.string(),
})

const Fixtures = z.array(FixtureSchema).default([])

const InputSchema = z.object({
  desc: z.string(),
  default: z.any(),
  required: z.boolean().default(true),
  fill: Fixtures.description('Bước lấy giá trị xác định; một bước phải `save` vào tên input.'),
  prepare: z.string().description('Mô tả bằng lời cách chuẩn bị; agent thực hiện.'),
  uses: z.array(z.string()).description('Namespace agent được dùng khi prepare; mặc định là `requires`.'),
  require: z.object({ op: AssertOp, value: z.any() }),
  cleanup: Fixtures.description('Bước dọn sau mọi case; chạy khi giá trị lấy bằng `fill`.'),
})

const CaseSchema = z.object({
  id: z.string().required(),
  title: z.string().required(),
  tags: z.array(z.string()).default([]),
  timeout: z.natural().description('Giới hạn thời gian của case, đơn vị giây.'),
  // Bước là câu chỉ dẫn, hoặc lời gọi có cấu trúc `{ call: <system>.<operation>, path, query, body, desc }`.
  steps: z.array(z.union([
    z.string(),
    z.object({
      call: z.string().required(),
      path: z.dict(z.any()),
      query: z.dict(z.any()),
      headers: z.dict(z.string()),
      body: z.any(),
      desc: z.string(),
      save: z.dict(z.string()).description('Lưu giá trị từ kết quả thành biến cho bước sau, khi runner chạy bước.'),
    }),
  ])).required(),
  expect: z.array(ExpectationSchema).default([]),
  setup: Fixtures,
  teardown: Fixtures,
})

export const PlanSchema = z.object({
  id: z.string().required(),
  name: z.string().required(),
  description: z.string(),
  requires: z.array(z.string()).default([]),
  systems: z.array(z.string()).default([]),
  envs: z.array(z.string()).default([]),
  inputs: z.dict(InputSchema).default({}),
  formulas: z.dict(FormulaSchema).default({}),
  vars: z.dict(z.any()).default({}),
  context: z.string(),
  contextRefs: z.array(z.string()).default([]),
  concurrency: z.natural().min(1),
  setup: Fixtures,
  teardown: Fixtures,
  cases: z.array(CaseSchema).required(),
})

export const name = 'plan-yaml'
export const inject = ['plans']

/** Hướng dẫn định dạng viết cho agent soạn plan. */
const GUIDE = readFileSync(new URL('./guide.md', import.meta.url), 'utf8')

export function apply(ctx: Context) {
  ctx.plans.registerFormat({
    name: 'yaml',
    extensions: ['.plan.yaml', '.plan.yml'],
    guide: GUIDE,
    parse: (text, source) => parsePlan(text, source),
  })
}

export function parsePlan(text: string, source: string): TestPlan {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    throw new PlanError(source, [`YAML syntax: ${(error as Error).message}`])
  }
  let data: ReturnType<typeof PlanSchema>
  try {
    data = PlanSchema(raw as any)
  } catch (error) {
    throw new PlanError(source, [(error as Error).message])
  }

  const issues: string[] = []
  const rawCases = (raw as { cases?: Array<{ expect?: Array<{ check?: unknown }> }> }).cases ?? []
  const NUMERIC_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte']
  const rawSystems = ((raw as { systems?: unknown }).systems as unknown[] | undefined) ?? []
  const rawFormulas = Object.fromEntries(Object.entries(((raw as { formulas?: unknown }).formulas ?? {}) as Record<string, { params?: string[]; expr?: string }>)
    .map(([name, f]) => [name, { params: f?.params ?? [], expr: String(f?.expr ?? '0') }]))
  rawCases.forEach((c, i) => c?.expect?.forEach((e, j) => {
    const check = e?.check as { op?: string; value?: unknown; expr?: unknown; let?: Record<string, unknown> } | undefined
    const where = `cases[${i}].expect[${j}].check`
    if (check === undefined) return
    if (!check?.op) issues.push(`${where}: missing op`)
    if (check?.let !== undefined && check?.expr === undefined) issues.push(`${where}: let requires expr`)
    if (check?.expr === undefined) return
    if (check.value !== undefined) issues.push(`${where}: use either value or expr, not both`)
    if (check.op && !NUMERIC_OPS.includes(check.op)) issues.push(`${where}: expr requires a numeric op (${NUMERIC_OPS.join(', ')})`)
    // Plan dùng catalog hệ thống có thể gọi công thức của service, chỉ biết khi soạn plan (`validate`):
    // khi đó chỉ kiểm tra cú pháp. Plan khác kiểm tra luôn tên hàm với hàm dựng sẵn và công thức trong plan.
    const known = rawSystems.length ? undefined : rawFormulas
    const verify = (expr: string, path: string) => {
      try {
        if (known) checkExpression(expr, { formulas: known })
        else parseExpression(expr)
      } catch (error) {
        issues.push(`${path}: ${(error as Error).message}`)
      }
    }
    for (const [step, expr] of Object.entries(check.let ?? {})) verify(String(expr), `${where}.let.${step}`)
    verify(String(check.expr), `${where}.expr`)
  }))
  // `from`: nền tảng tự đối chiếu từ kết quả bước `call:` mà runner chạy, tức các bước `call:` liền nhau ở đầu case.
  rawCases.forEach((c, i) => {
    const steps = ((c as { steps?: unknown[] }).steps ?? [])
    const leading = steps.findIndex((s) => typeof s !== 'object' || s === null || !('call' in s))
    const runnable = leading < 0 ? steps.length : leading
    steps.forEach((s, k) => {
      if (k >= runnable && typeof s === 'object' && s !== null && 'save' in s) {
        issues.push(`cases[${i}].steps[${k}].save: only the leading call steps run by the platform can save variables; the agent runs this step`)
      }
    })
    c?.expect?.forEach((e, j) => {
      const from = (e as { from?: { step?: unknown; path?: unknown } })?.from
      if (from === undefined) return
      const where = `cases[${i}].expect[${j}].from`
      if (!e.check) issues.push(`${where}: requires check (the platform compares against the plan's criteria)`)
      if (typeof from?.path !== 'string' || !from.path) issues.push(`${where}: missing path`)
      const step = Number(from?.step)
      if (!Number.isInteger(step) || step < 1) issues.push(`${where}: step must be a step number from 1`)
      else if (step > runnable) {
        issues.push(`${where}: step ${step} is not run by the platform; only the leading call steps (1..${runnable || 0}) are. Remove from and let the agent assert, or move the call before text steps`)
      }
    })
  })
  for (const [name, f] of Object.entries(data.formulas)) {
    for (const [step, expr] of Object.entries({ ...(f.let ?? {}), expr: f.expr })) {
      try {
        parseExpression(String(expr))
      } catch (error) {
        issues.push(`formulas.${name}.${step === 'expr' ? 'expr' : `let.${step}`}: ${(error as Error).message}`)
      }
    }
  }
  const caseIds = new Set<string>()
  for (const c of data.cases) {
    if (caseIds.has(c.id)) issues.push(`duplicate case id: ${c.id}`)
    caseIds.add(c.id)
    if (!c.steps.length) issues.push(`case ${c.id} has no steps`)
    const expectIds = new Set<string>()
    for (const e of c.expect) {
      if (expectIds.has(e.id)) issues.push(`case ${c.id}: duplicate expectation id ${e.id}`)
      expectIds.add(e.id)
    }
  }
  for (const [name, input] of Object.entries(data.inputs)) {
    if (!/^[A-Za-z_][\w-]*$/.test(name)) issues.push(`input ${name}: name must match ^[A-Za-z_][\w-]*$`)
    if (name in data.vars) issues.push(`input ${name}: a var with the same name exists`)
    if (input.fill.length && !input.fill.some((step) => step.save && name in step.save)) issues.push(`input ${name}: a fill step must save ${name}`)
    if (input.require?.value !== undefined && !input.require.op) issues.push(`input ${name}: require needs op`)
  }
  if (issues.length) throw new PlanError(source, issues)

  const vars = interpolate(data.vars) as Record<string, unknown>
  // `{{tên}}` giữ nguyên trong plan: runner thay lúc chạy, sau khi có biến của môi trường, đầu vào và fixture.
  const fixtures = (list: typeof data.setup) => list.map((f) => ({
    action: f.action, args: interpolate(f.args), save: f.save, desc: f.desc,
  }))

  return {
    id: data.id,
    name: data.name,
    description: data.description,
    source,
    format: 'yaml',
    requires: data.requires,
    systems: data.systems,
    envs: data.envs.length ? data.envs : undefined,
    formulas: Object.keys(data.formulas).length ? data.formulas : undefined,
    inputs: Object.entries(data.inputs).map(([name, i]) => ({
      name,
      desc: i.desc,
      default: interpolate(i.default),
      required: i.required,
      fill: fixtures(i.fill),
      prepare: i.prepare,
      uses: i.uses?.length ? i.uses : undefined,
      require: i.require?.op ? { op: i.require.op, value: i.require.value } : undefined,
      cleanup: fixtures(i.cleanup),
    })),
    vars,
    context: data.context,
    ...(data.contextRefs.length ? { contextRefs: data.contextRefs } : {}),
    ...(data.concurrency && data.concurrency > 1 ? { concurrency: data.concurrency } : {}),
    setup: fixtures(data.setup),
    teardown: fixtures(data.teardown),
    cases: data.cases.map((c) => ({
      id: c.id,
      title: c.title,
      tags: c.tags,
      timeoutMs: c.timeout ? c.timeout * 1000 : undefined,
      setup: fixtures(c.setup),
      teardown: fixtures(c.teardown),
      ...renderSteps(c.steps),
      expect: c.expect.map((e) => ({
        id: e.id,
        desc: e.desc,
        check: e.check?.op ? {
          op: e.check.op, value: e.check.value,
          ...(e.check.expr ? { expr: e.check.expr } : {}),
          ...(e.check.let && Object.keys(e.check.let).length ? { let: e.check.let } : {}),
        } : undefined,
        ...(e.from?.step && e.from.path ? { from: { step: e.from.step, path: e.from.path } } : {}),
      })),
    })),
  }
}

type RawStep = string | { call: string; path?: Record<string, unknown>; query?: Record<string, unknown>; headers?: Record<string, string>; body?: unknown; desc?: string; save?: Record<string, string> }

/**
 * Bước có cấu trúc thành câu chỉ dẫn cho agent; giữ lời gọi gốc trong `calls` (cùng chỉ số) để kiểm tra và hiển thị.
 * Ví dụ: `Gọi order-service.cancelOrder với path {"id":"{{order_id}}"} — huỷ lệnh vừa đặt`.
 */
function renderSteps(raw: RawStep[]): { steps: string[]; calls?: Array<import('@aitest/core').StepCall | undefined> } {
  if (raw.every((s) => typeof s === 'string')) return { steps: raw as string[] }
  const steps: string[] = []
  const calls: Array<import('@aitest/core').StepCall | undefined> = []
  for (const step of raw) {
    if (typeof step === 'string') {
      steps.push(step)
      calls.push(undefined)
      continue
    }
    const parts = [`Gọi ${step.call}`]
    const json = (v: unknown) => JSON.stringify(v)
    if (step.path && Object.keys(step.path).length) parts.push(`path ${json(step.path)}`)
    if (step.query && Object.keys(step.query).length) parts.push(`query ${json(step.query)}`)
    if (step.headers && Object.keys(step.headers).length) parts.push(`header ${json(step.headers)}`)
    if (step.body !== undefined) parts.push(`body ${json(step.body)}`)
    steps.push(`${parts[0]}${parts.length > 1 ? ` với ${parts.slice(1).join(', ')}` : ''}${step.desc ? ` — ${step.desc}` : ''}.`)
    calls.push({ ...step })
  }
  return { steps, calls }
}
