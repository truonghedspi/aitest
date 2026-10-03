import { coerceJson, compare, evaluateFormula, isCaseScope, readPath, valuesEqual, variablesOf, z, type EvidenceRef, type EvidenceReader, type AssertionRecord, type AssertOp, type ActionScope, type CaseScope, type Context, type StepNote, type VerdictDecision } from '@aitest/core'

/**
 * Plugin verdict.
 *
 * Nguyên tắc: LLM không quyết định pass/fail.
 * 1. Mọi kết quả action được lưu thành evidence có mã `evN`; agent nhận mã này trong kết quả tool.
 * 2. Agent gọi `assert_expectation` với mã evidence và path; plugin tự đọc giá trị thật để so sánh.
 * 3. Verdict của case được tính từ assertion cuối cùng của mỗi expectation.
 */
export const name = 'verdict'
export const inject = ['actions', 'prompt', 'formulas']

export interface Config {
  allowRetry: boolean
}

export const Config = z.object({
  allowRetry: z.boolean().default(true).description(
    'true: assertion cuối cùng của mỗi expectation quyết định kết quả (agent được sửa path sai). '
    + 'false: assertion đầu tiên là kết quả cuối, mọi lần gọi sau bị từ chối.',
  ),
})

interface Evidence {
  id: string
  action: string
  args: Record<string, unknown>
  status: string
  value: unknown
}

interface CaseState {
  seq: number
  evidence: Map<string, Evidence>
  assertions: Map<string, AssertionRecord>
}

const OPS: AssertOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches', 'exists', 'not_exists']

/** Một expectation cần đối chiếu: phần tử của `assertions`, hoặc tham số cấp cao nhất khi chỉ đối chiếu một expectation. */
const ASSERTION_ITEM = {
  type: 'object',
  properties: {
    expectId: { type: 'string', description: 'Mã expectation trong test case.' },
    evidenceId: { type: 'string', description: 'Mã evidence (evN) trả về từ một action trước đó.' },
    path: {
      type: 'string',
      description: 'Đường dẫn tính từ trường `result` của evidence, ví dụ `$.status` hoặc `$.rows[0].qty` (viết `$.result.status` cũng được).',
    },
    op: { type: 'string', enum: OPS, description: 'Chỉ dùng khi plan không khai báo tiêu chí.' },
    expected: { description: 'Giá trị mong đợi; chỉ dùng khi plan không khai báo tiêu chí.' },
    inputs: {
      type: 'object',
      description: 'Chỉ dùng khi tiêu chí là công thức: tên biến → { evidenceId, path } chứa giá trị thật của biến đó. Bỏ qua biến của lượt chạy (nền tảng tự gắn).',
      additionalProperties: {
        type: 'object',
        properties: { evidenceId: { type: 'string' }, path: { type: 'string' } },
        required: ['evidenceId', 'path'],
      },
    },
  },
  required: ['expectId', 'evidenceId', 'path'],
  additionalProperties: false,
}

export function apply(ctx: Context, config: Config) {
  const states = new WeakMap<ActionScope, CaseState>()
  const stateOf = (scope: ActionScope) => {
    let state = states.get(scope)
    if (!state) states.set(scope, state = { seq: 0, evidence: new Map(), assertions: new Map() })
    return state
  }

  /** Đọc giá trị thật trong evidence; dùng chung cho assertion và cho plugin khác qua `ctx.evidence`. */
  const reader: EvidenceReader = {
    read(scope, ref) {
      const state = stateOf(scope)
      const evidence = state.evidence.get(ref.evidenceId)
      if (!evidence) throw new Error(`unknown evidenceId ${ref.evidenceId}; collected: ${[...state.evidence.keys()].join(', ') || '(none)'}`)
      return readPath(evidence.value, ref.path)
    },
  }
  ctx.effect(() => ctx.provide('evidence', reader), 'verdict.evidence')

  // Ghi evidence cho mọi action có kết quả, trừ action tự khai báo `evidence: false`.
  ctx.on('action/after', async (call, outcome, next) => {
    if (call.definition.evidence === false || outcome.status === 'denied') return next()
    const state = stateOf(call.scope)
    const id = `ev${++state.seq}`
    state.evidence.set(id, {
      id, action: call.name, args: call.args, status: outcome.status,
      value: outcome.status === 'ok' ? outcome.value : { error: outcome.error },
    })
    return { ...outcome, annotations: { ...outcome.annotations, evidenceId: id } }
  })

  type AssertArgs = { expectId: string; evidenceId: string; path: string; op?: AssertOp; expected?: unknown; inputs?: Record<string, EvidenceRef> }

  /** Đối chiếu một expectation; ném lỗi khi tham số sai (expectation, evidence không tồn tại, thiếu biến của công thức). */
  async function assertOne(scope: CaseScope, args: AssertArgs) {
    const expectation = scope.case.expect.find((e) => e.id === args.expectId)
    if (!expectation) throw new Error(`unknown expectId ${args.expectId}; valid: ${scope.case.expect.map((e) => e.id).join(', ')}`)
    const state = stateOf(scope)
    const evidence = state.evidence.get(args.evidenceId)
    if (!evidence) throw new Error(`unknown evidenceId ${args.evidenceId}; collected: ${[...state.evidence.keys()].join(', ') || '(none)'}`)

    if (!config.allowRetry && state.assertions.has(expectation.id)) {
      throw new Error(`expectation ${expectation.id} was already asserted; retries are disabled`)
    }
    const criteria = expectation.check ? 'plan' : 'agent'
    const op = expectation.check?.op ?? args.op
    let expected = expectation.check ? expectation.check.value : args.expected
    if (!op || !OPS.includes(op)) throw new Error(`expectation ${expectation.id} has no criteria in plan; provide a valid op`)

    // Tiêu chí dạng công thức: giá trị mong đợi được tính chính xác từ giá trị thật trong evidence.
    // Biến có thể là danh sách (path `$.rows` hoặc `$.rows[*].qty`); các bước `let` được ghi lại cho báo cáo.
    const expr = expectation.check?.expr
    const lets = expectation.check?.let
    let inputs: AssertionRecord['inputs']
    let steps: AssertionRecord['steps']
    /** Giá trị biến của lượt chạy đã dùng trong công thức, ghi vào báo cáo để người đọc thấy đủ đầu vào. */
    let runVars: AssertionRecord['runVars']
    if (expr) {
      const formulas = await ctx.formulas.for(scope.plan)
      const all = variablesOf(expr, { let: lets })
      const names = all.filter((n) => !(n in scope.vars) || args.inputs?.[n])
      const fromRun = all.filter((n) => n in scope.vars && !args.inputs?.[n])
      const missing = names.filter((n) => !args.inputs?.[n])
      if (missing.length) {
        throw new Error(`expectation ${expectation.id} uses formula ${expr}; provide inputs (evidenceId and path) for: ${missing.join(', ')}`
          + (fromRun.length ? `; ${fromRun.join(', ')} come from the run's variables automatically, do not pass them` : ''))
      }
      inputs = Object.fromEntries(names.map((n) => {
        const value = reader.read(scope, args.inputs![n])
        if (value === undefined) throw new Error(`input ${n}: path ${args.inputs![n].path} has no value in ${args.inputs![n].evidenceId}`)
        return [n, { ...args.inputs![n], value }]
      }))
      // Biến của lượt chạy (vars của plan, đầu vào, save của fixture) dùng được trong công thức mà agent không phải chỉ ra.
      // Biến dạng chuỗi JSON được đọc thành object để công thức truy cập trường.
      const runValues = Object.fromEntries(fromRun.map((n) => [n, coerceJson(scope.vars[n])]))
      if (fromRun.length) runVars = runValues
      const values = { ...scope.vars, ...runValues, ...Object.fromEntries(Object.entries(inputs).map(([n, i]) => [n, coerceJson(i.value)])) }
      try {
        const result = evaluateFormula(expr, values, { let: lets, formulas })
        expected = result.value
        if (lets) steps = result.steps
      } catch (error) {
        throw new Error(`expectation ${expectation.id}: formula failed: ${(error as Error).message}`)
      }
    }

    const actual = readPath(evidence.value, args.path)
    const { passed, message } = Array.isArray(expected) ? compareLists(op, actual, expected) : compare(op, actual, expected)
    const record: AssertionRecord = {
      expectId: expectation.id, evidenceId: evidence.id, path: args.path, op, expected, actual, passed, message, criteria,
      ...(expr ? { expr, inputs, ...(runVars ? { runVars } : {}), ...(steps ? { steps } : {}) } : {}),
    }
    state.assertions.set(expectation.id, record)
    scope.log('assert/result', record)
    return { expectId: record.expectId, passed, actual, expected, op, criteria, message, ...(expr ? { expr, inputs, ...(steps ? { steps } : {}) } : {}) }
  }

  ctx.actions.register({
    name: 'assert_expectation',
    namespace: 'verdict',
    always: true,
    scopes: ['case'],
    evidence: false,
    readOnly: true,
    description: [
      'Đối chiếu expectation của test case với evidence đã thu thập. Gộp mọi expectation đã có evidence vào MỘT lời gọi:',
      '`assertions: [{ expectId, evidenceId, path }, ...]`; mỗi lần gọi tool tốn một lượt suy nghĩ của bạn.',
      'Nền tảng tự đọc giá trị thật tại `path` trong evidence và so sánh; không tự báo giá trị.',
      'Nếu expectation đã có tiêu chí cố định trong plan, `op` và `expected` của bạn bị bỏ qua.',
      'Nếu tiêu chí là công thức, truyền `inputs` CHỈ cho các biến mà mục "Kết quả mong đợi" ghi cần gắn: mỗi biến trỏ tới evidence và path chứa giá trị thật.',
      'Biến của lượt chạy (vars của plan, đầu vào, giá trị lưu từ bước chuẩn bị) nền tảng tự gắn; không truyền chúng, không tìm evidence cho chúng.',
      'Biến dạng danh sách trỏ path tới cả danh sách (`$.rows`, mỗi phần tử là một bản ghi) hoặc một cột (`$.rows[*].qty`).',
      'Giá trị mong đợi dạng danh sách (ví dụ số dư cộng dồn) được so từng phần tử với `path` trỏ tới cột tương ứng, ví dụ `$.rows[*].balance`.',
      'Một expectation lỗi tham số không làm hỏng các expectation khác trong cùng lời gọi; sửa và gọi lại riêng expectation đó.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        assertions: { type: 'array', minItems: 1, items: ASSERTION_ITEM, description: 'Các expectation cần đối chiếu, một phần tử cho mỗi expectation.' },
        ...ASSERTION_ITEM.properties,
      },
      additionalProperties: false,
    },
    async execute(args: Partial<AssertArgs> & { assertions?: AssertArgs[] }, { scope }) {
      if (!isCaseScope(scope)) throw new Error('assert_expectation is only available inside a test case')
      const { assertions, ...single } = args
      const items = assertions?.length ? assertions : single.expectId ? [single as AssertArgs] : []
      if (!items.length) throw new Error('provide assertions: [{ expectId, evidenceId, path }] (or expectId, evidenceId, path for one expectation)')
      for (const item of items) {
        if (!item.expectId || !item.evidenceId || !item.path) throw new Error('each assertion needs expectId, evidenceId and path')
      }
      // Một expectation: trả kết quả như trước (lỗi ném ra). Nhiều expectation: lỗi của từng phần tử nằm trong kết quả.
      if (items.length === 1 && !assertions) return assertOne(scope, items[0])
      const results = []
      for (const item of items) {
        try {
          results.push(await assertOne(scope, item))
        } catch (error) {
          results.push({ expectId: item.expectId, error: (error as Error).message })
        }
      }
      const failed = results.filter((r) => 'error' in r).length
      return { results, ...(failed ? { note: `${failed} assertion(s) had invalid arguments; fix and assert them again` } : {}) }
    },
  })

  ctx.actions.register({
    name: 'note_step',
    namespace: 'verdict',
    always: true,
    scopes: ['case'],
    evidence: false,
    readOnly: true,
    description: 'Ghi chú một bước thất bại hoặc bị bỏ qua (đánh số từ 1) kèm lý do. Bước làm xong không cần ghi: nền tảng tự ghi bước của mọi lời gọi tool. Chỉ phục vụ báo cáo, không ảnh hưởng verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'integer', minimum: 1 },
        status: { type: 'string', enum: ['done', 'failed', 'skipped'] },
        note: { type: 'string' },
      },
      required: ['step', 'status'],
      additionalProperties: false,
    },
    async execute(args: StepNote, { scope }) {
      scope.log('step/note', args)
      return { recorded: true }
    },
  })

  ctx.on('case/verdict', async (scope, base, next) => {
    if (base.verdict === 'error' || base.verdict === 'skipped' || base.verdict === 'blocked') return next()
    return decide(scope, stateOf(scope))
  })

  ctx.prompt.section({
    id: 'verdict/protocol',
    order: 60,
    render: () => [
      '## Quy trình xác nhận kết quả',
      '- Mỗi kết quả action có trường `evidenceId` (ví dụ `ev3`).',
      '- Mọi expectation đều phải được đối chiếu bằng `assert_expectation` với `expectId`, `evidenceId` và `path` trỏ đúng vào giá trị cần kiểm tra.',
      '- Gộp các expectation đã có evidence vào MỘT lời gọi `assert_expectation` với `assertions: [...]`; thường chỉ cần một lời gọi ở cuối case.',
      '- Expectation có tiêu chí là công thức: mục "Kết quả mong đợi" ghi biến nào nền tảng tự gắn (từ dữ liệu lượt chạy) và biến nào bạn gắn bằng `inputs` (evidence và path chứa giá trị thật). Chỉ truyền `inputs` cho nhóm sau. Không tự tính giá trị mong đợi.',
      '- Cần tính toán (tổng, phần trăm, làm tròn): dùng tool `calc`, không tự tính nhẩm.',
      '- Không tự kết luận pass/fail bằng lời; chỉ assertion được tính.',
      '- Không gọi `note_step` cho bước làm xong. Chỉ gọi khi một bước không thực hiện được (`status: failed`) hoặc bị bỏ qua (`skipped`), kèm lý do.',
    ].join('\n'),
  })
}

function decide(scope: CaseScope, state: CaseState): VerdictDecision {
  const expectations = scope.case.expect
  if (!expectations.length) return { verdict: 'inconclusive', reasons: ['case has no expectations'] }
  const reasons: string[] = []
  let failed = false
  let missing = false
  for (const e of expectations) {
    const a = state.assertions.get(e.id)
    if (!a) {
      missing = true
      reasons.push(`${e.id}: not asserted`)
    } else if (!a.passed) {
      failed = true
      reasons.push(`${e.id}: ${a.message}`)
    }
  }
  if (failed) return { verdict: 'fail', reasons }
  if (missing) return { verdict: 'inconclusive', reasons }
  return { verdict: 'pass', reasons: [] }
}

/**
 * So sánh danh sách mong đợi với giá trị thật theo từng phần tử (ví dụ cột số dư cộng dồn):
 * cùng độ dài, phần tử thứ i thoả `op`; báo phần tử lệch đầu tiên.
 */
export function compareLists(op: AssertOp, actual: unknown, expected: unknown[]) {
  if (!Array.isArray(actual)) return { passed: false, message: `expected a list of ${expected.length} items, got ${JSON.stringify(actual)}` }
  if (op === 'eq' || op === 'ne') {
    if (actual.length !== expected.length) {
      return { passed: op === 'ne', message: `list length ${actual.length}, expected ${expected.length}` }
    }
    const index = expected.findIndex((e, i) => !valuesEqual(actual[i], e))
    const equal = index < 0
    if (op === 'ne') return { passed: !equal, message: equal ? 'lists are equal' : `lists differ at index ${index}` }
    return equal
      ? { passed: true, message: `all ${expected.length} items equal` }
      : { passed: false, message: `item ${index}: expected ${JSON.stringify(expected[index])}, got ${JSON.stringify(actual[index])} (first of ${expected.filter((e, i) => !valuesEqual(actual[i], e)).length} mismatches)` }
  }
  if (actual.length !== expected.length) return { passed: false, message: `list length ${actual.length}, expected ${expected.length}` }
  for (const [i, e] of expected.entries()) {
    const r = compare(op, actual[i], e)
    if (!r.passed) return { passed: false, message: `item ${i}: ${r.message}` }
  }
  return { passed: true, message: `all ${expected.length} items ${op}` }
}
