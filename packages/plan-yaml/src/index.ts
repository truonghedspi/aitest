import { parse as parseYaml } from 'yaml'
import { interpolate, PlanError, z, type Context, type TestPlan } from '@aitest/core'

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
  check: z.object({ op: AssertOp.required(), value: z.any() }),
})

const FixtureSchema = z.object({
  action: z.string().required(),
  args: z.dict(z.any()).default({}),
  save: z.dict(z.string()),
  desc: z.string(),
})

const Fixtures = z.array(FixtureSchema).default([])

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
  vars: z.dict(z.any()).default({}),
  context: z.string(),
  setup: Fixtures,
  teardown: Fixtures,
  cases: z.array(CaseSchema).required(),
})

export const name = 'plan-yaml'
export const inject = ['plans']

export function apply(ctx: Context) {
  ctx.plans.registerFormat({
    name: 'yaml',
    extensions: ['.plan.yaml', '.plan.yml'],
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
  if (issues.length) throw new PlanError(source, issues)

  const vars = interpolate(data.vars) as Record<string, unknown>
  // Biến chưa biết được giữ nguyên `{{tên}}`; runner thay tiếp bằng biến lưu từ fixture khi chạy.
  const fill = (s: string) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m))
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
    vars,
    context: data.context && fill(data.context),
    setup: fixtures(data.setup),
    teardown: fixtures(data.teardown),
    cases: data.cases.map((c) => ({
      id: c.id,
      title: c.title,
      tags: c.tags,
      timeoutMs: c.timeout ? c.timeout * 1000 : undefined,
      setup: fixtures(c.setup),
      teardown: fixtures(c.teardown),
      steps: c.steps.map(fill),
      expect: c.expect.map((e) => ({
        id: e.id,
        desc: fill(e.desc),
        check: e.check?.op ? { op: e.check.op, value: e.check.value } : undefined,
      })),
    })),
  }
}
