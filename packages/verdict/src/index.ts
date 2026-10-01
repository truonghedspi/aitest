import { compare, readPath, z, type AssertionRecord, type AssertOp, type CaseScope, type Context, type StepNote, type VerdictDecision } from '@aitest/core'

/**
 * Plugin verdict.
 *
 * Nguyên tắc: LLM không quyết định pass/fail.
 * 1. Mọi kết quả action được lưu thành evidence có mã `evN`; agent nhận mã này trong kết quả tool.
 * 2. Agent gọi `assert_expectation` với mã evidence và path; plugin tự đọc giá trị thật để so sánh.
 * 3. Verdict của case được tính từ assertion cuối cùng của mỗi expectation.
 */
export const name = 'verdict'
export const inject = ['actions', 'prompt']

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

export function apply(ctx: Context, config: Config) {
  const states = new WeakMap<CaseScope, CaseState>()
  const stateOf = (scope: CaseScope) => {
    let state = states.get(scope)
    if (!state) states.set(scope, state = { seq: 0, evidence: new Map(), assertions: new Map() })
    return state
  }

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

  ctx.actions.register({
    name: 'assert_expectation',
    namespace: 'verdict',
    always: true,
    evidence: false,
    readOnly: true,
    description: [
      'Đối chiếu một expectation của test case với evidence đã thu thập.',
      'Nền tảng tự đọc giá trị thật tại `path` trong evidence và so sánh; không tự báo giá trị.',
      'Nếu expectation đã có tiêu chí cố định trong plan, `op` và `expected` của bạn bị bỏ qua.',
    ].join(' '),
    inputSchema: {
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
      },
      required: ['expectId', 'evidenceId', 'path'],
      additionalProperties: false,
    },
    async execute(args: { expectId: string; evidenceId: string; path: string; op?: AssertOp; expected?: unknown }, { scope }) {
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
      const expected = expectation.check ? expectation.check.value : args.expected
      if (!op || !OPS.includes(op)) throw new Error(`expectation ${expectation.id} has no criteria in plan; provide a valid op`)

      const actual = readPath(evidence.value, args.path)
      const { passed, message } = compare(op, actual, expected)
      const record: AssertionRecord = {
        expectId: expectation.id, evidenceId: evidence.id, path: args.path, op, expected, actual, passed, message, criteria,
      }
      state.assertions.set(expectation.id, record)
      scope.log('assert/result', record)
      return { expectId: record.expectId, passed, actual, expected, op, criteria, message }
    },
  })

  ctx.actions.register({
    name: 'note_step',
    namespace: 'verdict',
    always: true,
    evidence: false,
    readOnly: true,
    description: 'Ghi nhận trạng thái của một bước trong test case (đánh số từ 1). Chỉ phục vụ báo cáo, không ảnh hưởng verdict.',
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
    if (base.verdict === 'error' || base.verdict === 'skipped') return next()
    return decide(scope, stateOf(scope))
  })

  ctx.prompt.section({
    id: 'verdict/protocol',
    order: 60,
    render: () => [
      '## Quy trình xác nhận kết quả',
      '- Mỗi kết quả action có trường `evidenceId` (ví dụ `ev3`).',
      '- Với MỖI expectation, gọi `assert_expectation` kèm `expectId`, `evidenceId` và `path` trỏ đúng vào giá trị cần kiểm tra.',
      '- Không tự kết luận pass/fail bằng lời; chỉ assertion được tính.',
      '- Nếu một bước không thực hiện được, vẫn gọi `note_step` với `status: failed` và giải thích.',
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
