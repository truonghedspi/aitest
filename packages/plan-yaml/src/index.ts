import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { checkExpression, interpolate, PlanError, z, type Context, type TestPlan } from '@aitest/core'

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
  check: z.object({ op: AssertOp, value: z.any(), expr: z.string() }),
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
  steps: z.array(z.string()).required(),
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
  vars: z.dict(z.any()).default({}),
  context: z.string(),
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
  rawCases.forEach((c, i) => c?.expect?.forEach((e, j) => {
    const check = e?.check as { op?: string; value?: unknown; expr?: unknown } | undefined
    const where = `cases[${i}].expect[${j}].check`
    if (check === undefined) return
    if (!check?.op) issues.push(`${where}: missing op`)
    if (check?.expr === undefined) return
    if (check.value !== undefined) issues.push(`${where}: use either value or expr, not both`)
    if (check.op && !NUMERIC_OPS.includes(check.op)) issues.push(`${where}: expr requires a numeric op (${NUMERIC_OPS.join(', ')})`)
    try {
      checkExpression(String(check.expr))
    } catch (error) {
      issues.push(`${where}.expr: ${(error as Error).message}`)
    }
  }))
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
    setup: fixtures(data.setup),
    teardown: fixtures(data.teardown),
    cases: data.cases.map((c) => ({
      id: c.id,
      title: c.title,
      tags: c.tags,
      timeoutMs: c.timeout ? c.timeout * 1000 : undefined,
      setup: fixtures(c.setup),
      teardown: fixtures(c.teardown),
      steps: c.steps,
      expect: c.expect.map((e) => ({
        id: e.id,
        desc: e.desc,
        check: e.check?.op ? { op: e.check.op, value: e.check.value, ...(e.check.expr ? { expr: e.check.expr } : {}) } : undefined,
      })),
    })),
  }
}
