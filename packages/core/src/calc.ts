import { Big, BigDecimal, MathContext, RoundingMode } from 'bigdecimal.js'
import { BUILTINS, checkFormula, evaluateNumber, freeVariables, ROUNDING_MODES, type EvalOptions, type RoundingModeName } from './expr.ts'

/**
 * Bộ tính biểu thức trên BigDecimal (bigdecimal.js, cùng ngữ nghĩa với `java.math.BigDecimal`).
 *
 * - `+ - * %` luôn chính xác và giữ nguyên phần thập phân, ví dụ `1.50 * 1.0 = 1.500`.
 * - `/` chính xác khi chia hết; chia không hết (ví dụ `1 / 3`) là lỗi, phải dùng `div(a, b, scale, MODE)`.
 * - Không có cách làm tròn mặc định: mọi hàm làm tròn nhận cách làm tròn tường minh
 *   (`UP`, `DOWN`, `CEILING`, `FLOOR`, `HALF_UP`, `HALF_DOWN`, `HALF_EVEN`, `UNNECESSARY`), vì mỗi test có quy tắc riêng.
 * - Cú pháp riêng, không dùng `eval`: số, biến, cách làm tròn, `+ - * / % ^`, ngoặc, dấu âm, và các hàm trong `FUNCTIONS`.
 */

/** Mô tả từng cách làm tròn, hiển thị cho agent và người soạn plan. */
export const ROUNDING_MODE_DESC: Record<RoundingModeName, string> = {
  UP: 'xa số 0',
  DOWN: 'về phía số 0 (cắt bỏ)',
  CEILING: 'lên phía dương vô cùng',
  FLOOR: 'xuống phía âm vô cùng',
  HALF_UP: 'gần nhất, .5 làm tròn xa số 0',
  HALF_DOWN: 'gần nhất, .5 làm tròn về phía số 0',
  HALF_EVEN: 'gần nhất, .5 làm tròn về số chẵn (làm tròn ngân hàng)',
  UNNECESSARY: 'không được làm tròn; lỗi nếu kết quả cần làm tròn',
}

export interface CalcResult {
  /** Kết quả dạng chuỗi thập phân đầy đủ (giữ nguyên số chữ số thập phân, không ký hiệu mũ). */
  text: string
  /** Kết quả bỏ các số 0 thừa ở cuối, ví dụ `1.500` thành `1.5`. */
  normalized: string
  /** Số chữ số thập phân của `text`. */
  scale: number
  /** Giá trị gần đúng kiểu number, chỉ để hiển thị; không dùng để so sánh. */
  value: number
}

/**
 * Tính biểu thức số với các biến đã gán (số, chuỗi số, danh sách, bản ghi), các bước `let` và công thức tự định nghĩa.
 * Ngôn ngữ biểu thức đầy đủ ở `expr.ts`.
 */
export function calculate(expression: string, variables: Record<string, unknown> = {}, options: EvalOptions = {}): CalcResult {
  return describe(evaluateNumber(expression, variables, options))
}

/** Hàm dựng sẵn của biểu thức, kèm mô tả cho agent và người soạn plan. */
export const FUNCTIONS = BUILTINS

/** Làm tròn một giá trị theo đúng một trong ba cách: số chữ số thập phân, bước, hoặc số chữ số có nghĩa. */
export function roundDecimal(
  value: unknown,
  rule: { mode: RoundingModeName; scale?: number; step?: number | string; significant?: number },
): CalcResult {
  const kinds = [rule.scale, rule.step, rule.significant].filter((v) => v !== undefined).length
  if (kinds !== 1) throw new Error('specify exactly one of scale, step, significant')
  if (!ROUNDING_MODES.includes(rule.mode)) throw new Error(`unknown rounding mode ${rule.mode}; use ${ROUNDING_MODES.join(', ')}`)
  const x = toDecimal('value', value)
  const m = RoundingMode[rule.mode]
  if (rule.scale !== undefined) {
    if (!Number.isInteger(rule.scale) || Math.abs(rule.scale) > 1000) throw new Error(`scale must be an integer in -1000..1000`)
    return describe(x.setScale(rule.scale, m))
  }
  if (rule.step !== undefined) {
    const step = toDecimal('step', rule.step)
    if (step.signum() <= 0) throw new Error('step must be greater than 0')
    return describe(x.divide(step, 0, m).multiply(step))
  }
  if (!Number.isInteger(rule.significant) || rule.significant! < 1 || rule.significant! > 1000) throw new Error('significant must be an integer in 1..1000')
  return describe(x.round(new MathContext(rule.significant!, m)))
}

/** Đổi số hoặc chuỗi số sang BigDecimal; `undefined` khi không phải số. */
export function toBigDecimal(value: unknown): BigDecimal | undefined {
  if (value instanceof BigDecimal) return value
  if (typeof value === 'number' && Number.isFinite(value)) return Big(String(value))
  if (typeof value === 'bigint') return Big(value)
  if (typeof value === 'string' && NUMERIC.test(value)) return Big(value.trim())
  return undefined
}

/** Tên các biến mà biểu thức cần, theo thứ tự xuất hiện, không lặp (không tính tham số hàm ẩn danh và bước `let`). */
export function variablesOf(expression: string, options: EvalOptions = {}): string[] {
  return freeVariables(expression, options)
}

/** Ném lỗi nếu biểu thức sai cú pháp hoặc gọi hàm không tồn tại; không cần giá trị biến. */
export function checkExpression(expression: string, options: EvalOptions = {}) {
  checkFormula(expression, options)
}

const NUMERIC = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/

function describe(result: BigDecimal): CalcResult {
  const text = result.toPlainString()
  return { text, normalized: result.stripTrailingZeros().toPlainString(), scale: Math.max(result.scale(), 0), value: Number(text) }
}

function toDecimal(name: string, raw: unknown) {
  const value = toBigDecimal(raw)
  if (!value) throw new Error(`variable ${name} is not a number: ${JSON.stringify(raw)}`)
  return value
}
