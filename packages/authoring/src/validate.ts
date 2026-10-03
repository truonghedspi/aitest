import { BUILTIN_VARS, checkExpression, knownVarRoot, coerceJson, errorMessage, evaluateFormula, formulaVariables, PLACEHOLDER, z, type Context, type FixtureStep, type TestPlan } from '@aitest/core'
import type { LintIssue, ValidationResult } from './index.ts'

/**
 * Tool `validate_plan` và các quy tắc kiểm tra mặc định.
 *
 * Mỗi quy tắc là một listener của `authoring/lint`; plugin khác thêm quy tắc riêng theo cùng cách.
 */
export const name = 'authoring-validate'
export const inject = ['actions', 'authoring', 'formulas']

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

  // Công thức: ví dụ kiểm chứng của công thức (plan và service) phải đúng; expectation chỉ gọi hàm có thật.
  ctx.on('authoring/lint', async (plan, issues) => {
    for (const message of await ctx.formulas.check(plan)) issues.push({ level: 'error', path: 'formulas', message })
    const formulas = await ctx.formulas.for(plan)
    plan.cases.forEach((c, i) => c.expect.forEach((e, j) => {
      if (!e.check?.expr) return
      try {
        checkExpression(e.check.expr, { let: e.check.let, formulas })
      } catch (error) {
        issues.push({ level: 'error', path: `cases[${i}].expect[${j}].check`, message: (error as Error).message })
      }
    }))
  })

  // Biến của công thức: biết trước biến nào nền tảng tự gắn, biến nào agent chạy test phải lấy từ evidence; tính thử với
  // giá trị có sẵn trong plan để bắt lỗi (sai tên trường, sai kiểu) ngay khi soạn, không phải đợi chạy thử.
  ctx.on('authoring/lint', async (plan, issues) => {
    const formulas = await ctx.formulas.for(plan)
    const known: Record<string, unknown> = { ...plan.vars }
    for (const input of plan.inputs ?? []) if (input.default !== undefined) known[input.name] = input.default
    plan.cases.forEach((c, i) => c.expect.forEach((e, j) => {
      if (!e.check?.expr) return
      const path = `cases[${i}].expect[${j}].check`
      try {
        checkExpression(e.check.expr, { let: e.check.let, formulas })
      } catch {
        return // lỗi cú pháp đã được quy tắc công thức báo
      }
      const vars = formulaVariables(plan, c, e.check)
      // Trường của biến có giá trị object trong plan: sai tên trường báo rõ, thay vì công thức nhận `null`.
      let fieldError = false
      for (const { name } of vars.fromRun) {
        const value = coerceJson(known[name])
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        for (const [, field] of e.check.expr.matchAll(new RegExp(`(?<![\\w.])${name}\\.([A-Za-z_]\\w*)`, 'g'))) {
          if (Object.hasOwn(value, field)) continue
          fieldError = true
          issues.push({ level: 'error', path, message: `expectation ${e.id}: ${name} has no field ${field}; fields: ${Object.keys(value).join(', ')}` })
        }
      }
      if (fieldError) return
      // Tính thử khi mọi biến đều có giá trị trong plan (vars, mặc định của đầu vào).
      const names = [...vars.fromRun.map((v) => v.name), ...vars.fromEvidence]
      if (names.length && names.every((n) => n in known)) {
        try {
          evaluateFormula(e.check.expr, Object.fromEntries(names.map((n) => [n, coerceJson(known[n])])), { let: e.check.let, formulas })
        } catch (error) {
          issues.push({ level: 'error', path, message: `expectation ${e.id}: formula fails with the plan's values (vars, input defaults): ${errorMessage(error)}` })
        }
      }
      // Biến phải lấy từ evidence mà không bước nào nhắc tới: agent chạy test dễ không thu thập.
      const text = [...c.steps, e.desc].join('\n').toLowerCase()
      const unmentioned = vars.fromEvidence.filter((n) => !new RegExp(`(^|[^\\w])${n.toLowerCase()}([^\\w]|$)`).test(text))
      if (unmentioned.length) {
        issues.push({
          level: 'warning', path,
          message: `expectation ${e.id}: formula variables ${unmentioned.join(', ')} must come from evidence the test agent collects, but no step mentions them; `
            + 'add a step that reads them (which table or API field), or define them in vars, inputs or a fixture save',
        })
      }
    }))
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
          if (!knownVarRoot(known, name)) issues.push({ level: 'error', path, message: `undefined variable {{${name}}}` })
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
      '- `summary.formulas` cho biết với mỗi công thức: biến nền tảng tự gắn từ dữ liệu lượt chạy (`fromRun`: vars, input, fixture)',
      '  và biến agent chạy test phải chỉ ra từ evidence (`fromEvidence`). Mỗi biến `fromEvidence` phải có bước thu thập rõ bảng hoặc trường API chứa nó.',
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
      // Nguồn biến của từng công thức: agent soạn plan biết trước điều agent chạy test sẽ làm khi assert.
      formulas: plan.cases.flatMap((c) => c.expect.filter((e) => e.check?.expr).map((e) => {
        const vars = formulaVariables(plan, c, e.check!)
        return {
          case: c.id, expect: e.id, expr: e.check!.expr,
          fromRun: vars.fromRun.map((v) => `${v.name} (${v.source})`),
          fromEvidence: vars.fromEvidence,
        }
      })),
    },
  }
}
