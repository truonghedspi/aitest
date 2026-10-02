import { BUILTIN_VARS, PLACEHOLDER, z, type Context, type FixtureStep, type TestPlan } from '@aitest/core'
import type { LintIssue, ValidationResult } from './index.ts'

/**
 * Tool `validate_plan` và các quy tắc kiểm tra mặc định.
 *
 * Mỗi quy tắc là một listener của `authoring/lint`; plugin khác thêm quy tắc riêng theo cùng cách.
 */
export const name = 'authoring-validate'
export const inject = ['actions', 'authoring']

export interface Config {
  fixtureOnlyNamespaces: string[]
}

export const Config = z.object({
  fixtureOnlyNamespaces: z.array(z.string()).default([]).description(
    'Namespace chỉ dùng trong setup/teardown (ví dụ kết nối ghi DB). Khai báo trong `requires` là lỗi, '
    + 'vì agent chạy test sẽ thấy action có quyền ghi.',
  ),
})


export function apply(ctx: Context, config: Config) {
  ctx.actions.register({
    name: 'validate_plan',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Kiểm tra toàn bộ nội dung một plan. Trả về `valid`, danh sách lỗi (error) và cảnh báo (warning) kèm vị trí.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Toàn bộ nội dung plan.' },
        path: { type: 'string', description: 'Tên file dự kiến, quyết định định dạng. Mặc định `draft.plan.yaml`.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    async execute(args: { content: string; path?: string }) {
      const result = await ctx.authoring.validate(args.content, args.path ?? 'draft.plan.yaml')
      return summarize(result)
    },
    present: (args, outcome) => ({
      kind: 'plan-validation',
      title: 'Kiểm tra plan',
      content: args.content,
      ...(outcome.value as object | undefined),
    }),
  })

  // Đầu vào: namespace agent dùng khi chuẩn bị phải có tool; input bắt buộc nên có cách lấy giá trị.
  ctx.on('authoring/lint', async (plan, issues) => {
    const known = new Set(ctx.actions.list({ kind: 'prepare', namespaces: new Set(), phase: 'setup' }).map((a) => a.namespace))
    for (const input of plan.inputs ?? []) {
      const path = `inputs.${input.name}`
      if (input.prepare) {
        for (const ns of input.uses ?? plan.requires) {
          if (!known.has(ns)) issues.push({ level: 'error', path, message: `prepare uses namespace ${ns}, which has no registered action` })
        }
      }
      if (input.required && !input.fill.length && !input.prepare && input.default === undefined) {
        issues.push({ level: 'warning', path, message: `input ${input.name} has no fill, prepare or default; the run is blocked unless the runner provides it` })
      }
      if (input.cleanup.length && !input.fill.length) {
        issues.push({ level: 'warning', path, message: `cleanup of ${input.name} only runs when the value comes from fill` })
      }
    }
  })

  ctx.on('authoring/lint', async (plan, issues) => {
    const known = new Set(ctx.actions.list({ kind: 'case', namespaces: new Set(), phase: 'setup' }).map((a) => a.namespace))
    for (const ns of plan.requires) {
      if (!known.has(ns)) issues.push({ level: 'error', path: 'requires', message: `namespace ${ns} has no registered action; add a tool for it (list_tool_catalog, propose_tool) or remove it from requires` })
    }
  })

  ctx.on('authoring/lint', async (plan, issues) => {
    for (const ns of plan.requires) {
      if (config.fixtureOnlyNamespaces.includes(ns)) {
        issues.push({
          level: 'error', path: 'requires',
          message: `namespace ${ns} is fixture-only; fixtures can use it without requires, and listing it exposes it to the test agent`,
        })
      }
    }
  })

  ctx.on('authoring/lint', async (plan, issues) => {
    const actions = new Set(ctx.actions.list({ kind: 'case', namespaces: new Set(), phase: 'setup' }).map((a) => a.name))
    const check = (steps: FixtureStep[], path: string) => steps.forEach((step, i) => {
      if (!actions.has(step.action)) issues.push({ level: 'error', path: `${path}[${i}]`, message: `unknown action ${step.action}` })
    })
    check(plan.setup, 'setup')
    check(plan.teardown, 'teardown')
    plan.cases.forEach((c, i) => {
      check(c.setup, `cases[${i}].setup`)
      check(c.teardown, `cases[${i}].teardown`)
    })
  })

  ctx.on('authoring/lint', async (plan, issues) => {
    plan.cases.forEach((c, i) => {
      if (!c.expect.length) {
        issues.push({ level: 'warning', path: `cases[${i}]`, message: `case ${c.id} has no expectations; it will always be inconclusive` })
      }
      c.expect.forEach((e, j) => {
        const path = `cases[${i}].expect[${j}]`
        if (!e.check) {
          issues.push({ level: 'warning', path, message: `expectation ${e.id} has no check; the test agent will choose the criteria` })
        } else if ((e.check.op === 'exists' || e.check.op === 'not_exists') && e.check.value !== undefined) {
          issues.push({ level: 'warning', path, message: `op ${e.check.op} ignores value` })
        } else if (e.check.op !== 'exists' && e.check.op !== 'not_exists' && e.check.value === undefined && !e.check.expr) {
          issues.push({ level: 'error', path, message: `op ${e.check.op} requires value` })
        }
      })
    })
  })

  // Biến `{{tên}}` phải có trong `vars`, được `save` bởi fixture chạy trước bước đó, hoặc do catalog hệ thống cung cấp.
  ctx.on('authoring/lint', async (plan, issues) => {
    plan.cases.forEach((c, i) => {
      const known = new Set([...Object.keys(plan.vars), ...(plan.inputs ?? []).map((i) => i.name), ...BUILTIN_VARS])
      for (const step of [...plan.setup, ...c.setup]) for (const name of Object.keys(step.save ?? {})) known.add(name)
      const texts: Array<[string, unknown]> = [
        ...c.steps.map((s, j) => [`cases[${i}].steps[${j}]`, s] as [string, unknown]),
        ...c.expect.map((e, j) => [`cases[${i}].expect[${j}]`, [e.desc, e.check?.value]] as [string, unknown]),
        ...c.teardown.map((t, j) => [`cases[${i}].teardown[${j}]`, t.args] as [string, unknown]),
      ]
      for (const [path, value] of texts) {
        for (const name of placeholders(value)) {
          // Biến `{{<system>.<khoá>}}` do catalog hệ thống cung cấp; quy tắc của catalog kiểm tra khoá.
          if (plan.systems?.some((id) => name.startsWith(`${id}.`))) continue
          if (!known.has(name)) issues.push({ level: 'error', path, message: `undefined variable {{${name}}}` })
        }
      }
    })
  })

  ctx.on('authoring/lint', async (plan, issues) => {
    plan.cases.forEach((c, i) => {
      if (c.steps.length > 12) {
        issues.push({ level: 'warning', path: `cases[${i}]`, message: `case ${c.id} has ${c.steps.length} steps; split it into smaller cases` })
      }
    })
  })

  ctx.authoring.guideSection({
    id: 'authoring/validate',
    order: 50,
    render: () => [
      '## Kiểm tra plan',
      '- Gọi `validate_plan` sau mỗi lần sửa bản nháp. Sửa hết lỗi (`error`) trước khi đưa người dùng xem.',
      '- Cảnh báo (`warning`) thì giải thích cho người dùng và để họ quyết định.',
      ...(config.fixtureOnlyNamespaces.length
        ? [`- Namespace ${config.fixtureOnlyNamespaces.map((n) => `\`${n}\``).join(', ')} chỉ dùng trong setup/teardown; không khai báo trong \`requires\`.`]
        : []),
    ].join('\n'),
  })
}

function placeholders(value: unknown): string[] {
  if (typeof value === 'string') return [...value.matchAll(PLACEHOLDER)].map((m) => m[1])
  if (Array.isArray(value)) return value.flatMap(placeholders)
  if (value && typeof value === 'object') return Object.values(value).flatMap(placeholders)
  return []
}

/** Rút gọn kết quả cho agent: lỗi, cảnh báo và tóm tắt cấu trúc plan. */
export function summarize(result: ValidationResult) {
  const plan: TestPlan | undefined = result.plan
  return {
    valid: result.valid,
    errors: result.issues.filter((i: LintIssue) => i.level === 'error'),
    warnings: result.issues.filter((i: LintIssue) => i.level === 'warning'),
    summary: plan && {
      id: plan.id,
      name: plan.name,
      requires: plan.requires,
      inputs: (plan.inputs ?? []).map((i) => ({
        name: i.name, desc: i.desc, default: i.default, required: i.required,
        mode: i.fill.length ? 'fill' : i.prepare ? 'prepare' : 'user',
      })),
      cases: plan.cases.map((c) => ({ id: c.id, title: c.title, steps: c.steps.length, expectations: c.expect.length })),
    },
  }
}
