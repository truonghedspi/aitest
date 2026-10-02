import {
  calculate, FUNCTIONS, ROUNDING_MODE_DESC, ROUNDING_MODES, roundDecimal,
  type ActionScope, type Context, type EvidenceRef, type RoundingModeName,
} from '@aitest/core'

/**
 * Tính toán chính xác cho agent, trên BigDecimal (cùng ngữ nghĩa `java.math.BigDecimal`).
 *
 * - `calc`: tính biểu thức; kết quả giữ đầy đủ phần thập phân, không làm tròn ngầm.
 * - `round_number`: làm tròn một giá trị theo cách làm tròn do test chỉ định.
 * Giá trị đầu vào là số, chuỗi số, hoặc tham chiếu evidence `{ evidenceId, path }` để nền tảng tự đọc
 * giá trị thật (agent không phải chép lại số). Kết quả được lưu thành evidence.
 */
export const name = 'action-math'
export const inject = ['actions']

type Input = number | string | EvidenceRef

const MODES = ROUNDING_MODES.map((m) => `${m} (${ROUNDING_MODE_DESC[m]})`).join('; ')
const INPUT_SCHEMA = {
  oneOf: [
    { type: 'number' },
    { type: 'string', description: 'Chuỗi số; dùng khi số có nhiều chữ số hơn kiểu number chứa được.' },
    { type: 'object', properties: { evidenceId: { type: 'string' }, path: { type: 'string' } }, required: ['evidenceId', 'path'] },
  ],
}

export function apply(ctx: Context) {
  /** Đọc giá trị: số và chuỗi giữ nguyên; tham chiếu evidence thì lấy giá trị thật. */
  const resolve = (scope: ActionScope, name: string, raw: Input, sources: Record<string, EvidenceRef>) => {
    if (!raw || typeof raw !== 'object') return raw
    const reader = ctx.get('evidence') as Context['evidence'] | undefined
    if (!reader) throw new Error('evidence references need the verdict plugin')
    const value = reader.read(scope, raw)
    if (value === undefined) throw new Error(`${name}: path ${raw.path} in ${raw.evidenceId} has no value`)
    sources[name] = { evidenceId: raw.evidenceId, path: raw.path }
    return value
  }

  ctx.actions.register({
    name: 'calc',
    namespace: 'math',
    scopes: ['case', 'explore', 'authoring'],
    always: true,
    readOnly: true,
    description: [
      'Tính một biểu thức trên BigDecimal. Luôn dùng tool này cho mọi phép tính (tổng, phần trăm, phí, làm tròn); không tự tính nhẩm.',
      '`+ - * %` chính xác và giữ đủ phần thập phân. `/` chỉ dùng khi chia hết; chia không hết dùng div(a, b, scale, MODE).',
      'Không có làm tròn mặc định: làm tròn phải ghi rõ cách làm tròn theo yêu cầu của test.',
      'Hàm:', Object.values(FUNCTIONS).map((f) => f.desc).join('; ') + '.',
      'Cách làm tròn (MODE):', MODES + '.',
      'Biến: số, chuỗi số, hoặc { evidenceId, path }. Kết quả: `result` (đầy đủ phần thập phân), `normalized` (bỏ số 0 thừa ở cuối), `scale`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Ví dụ `round(qty * price / 1000 * 0.0015, 2, HALF_UP)`, `div(total, n, 4, HALF_EVEN)`.' },
        variables: { type: 'object', description: 'Tên biến → số, chuỗi số, hoặc { evidenceId, path }.', additionalProperties: INPUT_SCHEMA },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    async execute(args: { expression: string; variables?: Record<string, Input> }, { scope }) {
      const sources: Record<string, EvidenceRef> = {}
      const inputs = Object.fromEntries(Object.entries(args.variables ?? {}).map(([n, raw]) => [n, resolve(scope, n, raw, sources)]))
      const result = calculate(args.expression, inputs)
      return { expression: args.expression, inputs, sources, result: result.text, normalized: result.normalized, scale: result.scale, value: result.value }
    },
    present: (args, outcome) => {
      const value = outcome.value as { result?: string; inputs?: Record<string, unknown> } | undefined
      return {
        kind: 'calc',
        title: outcome.status === 'ok' ? `Tính ${args.expression} = ${value?.result}` : `Tính ${args.expression} lỗi`,
        expression: args.expression,
        inputs: value?.inputs ?? {},
        result: value?.result,
      }
    },
  })

  ctx.actions.register({
    name: 'round_number',
    namespace: 'math',
    scopes: ['case', 'explore', 'authoring'],
    always: true,
    readOnly: true,
    description: [
      'Làm tròn một số theo đúng quy tắc test yêu cầu, trên BigDecimal.',
      'Chọn đúng một trong: `scale` (số chữ số thập phân; âm để làm tròn tới hàng chục, trăm),',
      '`step` (bội số của bước, ví dụ bước giá 50, lô 100), `significant` (số chữ số có nghĩa).',
      'Cách làm tròn (`mode`) là bắt buộc:', MODES + '.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        value: INPUT_SCHEMA,
        mode: { type: 'string', enum: [...ROUNDING_MODES] },
        scale: { type: 'integer' },
        step: { type: ['number', 'string'] },
        significant: { type: 'integer', minimum: 1 },
      },
      required: ['value', 'mode'],
      additionalProperties: false,
    },
    async execute(args: { value: Input; mode: RoundingModeName; scale?: number; step?: number | string; significant?: number }, { scope }) {
      const sources: Record<string, EvidenceRef> = {}
      const input = resolve(scope, 'value', args.value, sources)
      const result = roundDecimal(input, { mode: args.mode, scale: args.scale, step: args.step, significant: args.significant })
      return {
        input, sources, mode: args.mode,
        rule: args.scale !== undefined ? { scale: args.scale } : args.step !== undefined ? { step: args.step } : { significant: args.significant },
        result: result.text, normalized: result.normalized, scale: result.scale, value: result.value,
      }
    },
    present: (args, outcome) => {
      const value = outcome.value as { input?: unknown; result?: string } | undefined
      const rule = args.scale !== undefined ? `${args.scale} chữ số thập phân` : args.step !== undefined ? `bước ${args.step}` : `${args.significant} chữ số có nghĩa`
      return {
        kind: 'calc',
        title: outcome.status === 'ok' ? `Làm tròn ${JSON.stringify(value?.input)} (${rule}, ${args.mode}) = ${value?.result}` : 'Làm tròn lỗi',
        expression: `${args.mode}, ${rule}`,
        inputs: { value: value?.input },
        result: value?.result,
      }
    },
  })
}
