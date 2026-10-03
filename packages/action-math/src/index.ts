import {
  coerceJson, evaluateFormula, FUNCTIONS, ROUNDING_MODE_DESC, ROUNDING_MODES, roundDecimal, variablesOf,
  type ActionScope, type Context, type EvidenceRef, type RoundingModeName, type TestPlan,
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
export const inject = ['actions', 'formulas']

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
      'Biểu thức còn có: chuỗi, true/false, null, danh sách `[a, b]`, trường `r.qty`, chỉ số `xs[0]`, so sánh `== != < <= > >=`,',
      '`and`/`or`/`not`, `c ? a : b`, hàm ẩn danh `r -> r.qty * r.price`; công thức nghiệp vụ của plan và service gọi như hàm.',
      'Biến: số, chuỗi số, hoặc { evidenceId, path }; path trỏ được tới cả danh sách (`$.rows`) hoặc một cột (`$.rows[*].qty`).',
      'Biến của lượt chạy (vars của plan, đầu vào, giá trị lưu từ bước chuẩn bị) không cần truyền: dùng thẳng tên trong biểu thức.',
      '`let`: các bước có tên, tính lần lượt; kết quả trả về giá trị từng bước.',
      'Kết quả: `result` (số giữ đầy đủ phần thập phân; hoặc danh sách, chuỗi…), `normalized`, `scale` khi kết quả là số.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Ví dụ `round(qty * price / 1000 * 0.0015, 2, HALF_UP)`, `div(total, n, 4, HALF_EVEN)`.' },
        variables: { type: 'object', description: 'Tên biến → số, chuỗi số, hoặc { evidenceId, path }.', additionalProperties: INPUT_SCHEMA },
        let: { type: 'object', description: 'Bước trung gian: tên → biểu thức, tính theo thứ tự khai báo.', additionalProperties: { type: 'string' } },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    async execute(args: { expression: string; variables?: Record<string, Input>; let?: Record<string, string> }, { scope }) {
      const sources: Record<string, EvidenceRef> = {}
      const inputs: Record<string, unknown> = Object.fromEntries(Object.entries(args.variables ?? {}).map(([n, raw]) => [n, coerceJson(resolve(scope, n, raw, sources))]))
      // Biến không truyền mà có trong dữ liệu của lượt chạy (vars của plan, đầu vào, save của fixture): lấy giá trị đó,
      // giống cách nền tảng gắn biến cho `check.expr`.
      const runVars = (scope as ActionScope & { vars?: Record<string, unknown> }).vars ?? {}
      const fromRun = variablesOf(args.expression, { let: args.let }).filter((n) => !(n in inputs) && n in runVars)
      for (const n of fromRun) inputs[n] = coerceJson(runVars[n])
      // Công thức của plan và của service mà plan dùng (chỉ có trong case, nơi có plan).
      const plan = (scope as ActionScope & { plan?: TestPlan }).plan
      const formulas = plan ? await ctx.formulas.for(plan) : {}
      const { value, steps } = evaluateFormula(args.expression, inputs, { let: args.let, formulas })
      const numeric = typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)
      return {
        expression: args.expression, inputs, sources, ...(fromRun.length ? { fromRun } : {}), result: value,
        ...(numeric ? { normalized: normalize(value as string), scale: (value as string).split('.')[1]?.length ?? 0, value: Number(value) } : {}),
        ...(args.let ? { steps } : {}),
      }
    },
    present: (args, outcome) => {
      const value = outcome.value as { result?: string; inputs?: Record<string, unknown> } | undefined
      return {
        kind: 'calc',
        title: outcome.status === 'ok' ? `Tính ${args.expression} = ${short(value?.result)}` : `Tính ${args.expression} lỗi`,
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

/** Bỏ số 0 thừa ở cuối phần thập phân: `1.500` thành `1.5`. */
function normalize(text: string) {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text
}

function short(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text && text.length > 60 ? `${text.slice(0, 57)}...` : text
}
