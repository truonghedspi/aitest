import { Big, BigDecimal, MathContext, RoundingMode } from 'bigdecimal.js'

/**
 * Bộ tính biểu thức trên BigDecimal (bigdecimal.js, cùng ngữ nghĩa với `java.math.BigDecimal`).
 *
 * - `+ - * %` luôn chính xác và giữ nguyên phần thập phân, ví dụ `1.50 * 1.0 = 1.500`.
 * - `/` chính xác khi chia hết; chia không hết (ví dụ `1 / 3`) là lỗi, phải dùng `div(a, b, scale, MODE)`.
 * - Không có cách làm tròn mặc định: mọi hàm làm tròn nhận cách làm tròn tường minh
 *   (`UP`, `DOWN`, `CEILING`, `FLOOR`, `HALF_UP`, `HALF_DOWN`, `HALF_EVEN`, `UNNECESSARY`), vì mỗi test có quy tắc riêng.
 * - Cú pháp riêng, không dùng `eval`: số, biến, cách làm tròn, `+ - * / % ^`, ngoặc, dấu âm, và các hàm trong `FUNCTIONS`.
 */

export const ROUNDING_MODES = ['UP', 'DOWN', 'CEILING', 'FLOOR', 'HALF_UP', 'HALF_DOWN', 'HALF_EVEN', 'UNNECESSARY'] as const
export type RoundingModeName = typeof ROUNDING_MODES[number]

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

const MAX_LENGTH = 2000
const MAX_DEPTH = 64
const MAX_SCALE = 1000
const MAX_EXPONENT = 10000

type Value = BigDecimal | { mode: RoundingModeName }

type Node =
  | { type: 'num'; text: string }
  | { type: 'var'; name: string; pos: number }
  | { type: 'mode'; name: RoundingModeName; pos: number }
  | { type: 'unary'; op: '-' | '+'; arg: Node }
  | { type: 'binary'; op: string; left: Node; right: Node; pos: number }
  | { type: 'call'; name: string; args: Node[]; pos: number }

interface Token { kind: 'num' | 'id' | 'op' | 'end'; text: string; pos: number }

/** Kiểu tham số của hàm: số, số nguyên (scale, số chữ số), hoặc cách làm tròn. */
type Param = 'num' | 'int' | 'mode'

interface Fn {
  /** Tham số bắt buộc, theo thứ tự. */
  params: Param[]
  /** Tham số tuỳ chọn sau tham số bắt buộc. */
  optional?: Param[]
  /** Nhận thêm số lượng bất kỳ tham số kiểu số. */
  variadic?: boolean
  desc: string
  run(args: Value[]): BigDecimal
}

const num = (v: Value) => v as BigDecimal
const mode = (v: Value) => RoundingMode[(v as { mode: RoundingModeName }).mode]

/** Hàm được phép trong biểu thức. */
export const FUNCTIONS: Record<string, Fn> = {
  round: {
    params: ['num', 'int', 'mode'],
    desc: 'round(x, scale, MODE): làm tròn tới `scale` chữ số thập phân; scale âm làm tròn tới hàng chục, trăm…',
    run: ([x, s, m]) => num(x).setScale(int(s, -MAX_SCALE, MAX_SCALE), mode(m)),
  },
  roundStep: {
    params: ['num', 'num', 'mode'],
    desc: 'roundStep(x, step, MODE): làm tròn tới bội số của `step` (bước giá, lô giao dịch)',
    run: ([x, s, m]) => {
      if (num(s).signum() <= 0) throw new Error('step must be greater than 0')
      return num(x).divide(num(s), 0, mode(m)).multiply(num(s))
    },
  },
  roundSig: {
    params: ['num', 'int', 'mode'],
    desc: 'roundSig(x, digits, MODE): làm tròn tới `digits` chữ số có nghĩa',
    run: ([x, d, m]) => num(x).round(new MathContext(int(d, 1, MAX_SCALE), mode(m))),
  },
  floor: { params: ['num'], optional: ['int'], desc: 'floor(x, scale = 0): như round(x, scale, FLOOR)', run: ([x, s]) => num(x).setScale(s ? int(s, -MAX_SCALE, MAX_SCALE) : 0, RoundingMode.FLOOR) },
  ceil: { params: ['num'], optional: ['int'], desc: 'ceil(x, scale = 0): như round(x, scale, CEILING)', run: ([x, s]) => num(x).setScale(s ? int(s, -MAX_SCALE, MAX_SCALE) : 0, RoundingMode.CEILING) },
  trunc: { params: ['num'], optional: ['int'], desc: 'trunc(x, scale = 0): như round(x, scale, DOWN)', run: ([x, s]) => num(x).setScale(s ? int(s, -MAX_SCALE, MAX_SCALE) : 0, RoundingMode.DOWN) },
  div: {
    params: ['num', 'num', 'int', 'mode'],
    desc: 'div(a, b, scale, MODE): chia, làm tròn kết quả tới `scale` chữ số thập phân',
    run: ([a, b, s, m]) => {
      if (num(b).signum() === 0) throw new Error('division by zero')
      return num(a).divide(num(b), int(s, -MAX_SCALE, MAX_SCALE), mode(m))
    },
  },
  sqrt: {
    params: ['num', 'int', 'mode'],
    desc: 'sqrt(x, scale, MODE): căn bậc hai, làm tròn tới `scale` chữ số thập phân',
    run: ([x, s, m]) => {
      if (num(x).signum() < 0) throw new Error('sqrt of negative number')
      const scale = int(s, 0, MAX_SCALE)
      const digits = num(x).toBigInt().toString().length
      return num(x).sqrt(new MathContext(digits + scale + 10, RoundingMode.DOWN)).setScale(scale, mode(m))
    },
  },
  abs: { params: ['num'], desc: 'abs(x): giá trị tuyệt đối', run: ([x]) => num(x).abs() },
  min: { params: ['num'], variadic: true, desc: 'min(a, b, ...): giá trị nhỏ nhất', run: (xs) => xs.map(num).reduce((a, b) => (b.compareTo(a) < 0 ? b : a)) },
  max: { params: ['num'], variadic: true, desc: 'max(a, b, ...): giá trị lớn nhất', run: (xs) => xs.map(num).reduce((a, b) => (b.compareTo(a) > 0 ? b : a)) },
  sum: { params: ['num'], variadic: true, desc: 'sum(a, b, ...): tổng', run: (xs) => xs.map(num).reduce((a, b) => a.add(b)) },
  avg: {
    params: ['num'], variadic: true,
    desc: 'avg(a, b, ...): trung bình cộng chính xác; không chia hết thì dùng div(sum(...), n, scale, MODE)',
    run: (xs) => exactDivide(xs.map(num).reduce((a, b) => a.add(b)), Big(xs.length), 'avg'),
  },
  pct: { params: ['num', 'num'], desc: 'pct(x, p): p phần trăm của x, chính xác', run: ([x, p]) => num(x).multiply(num(p)).movePointLeft(2) },
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

/** Tính biểu thức với các biến đã gán. Giá trị biến là số, chuỗi số, hoặc BigDecimal. */
export function calculate(expression: string, variables: Record<string, unknown> = {}): CalcResult {
  const result = evaluate(parse(expression), toDecimals(variables), 0)
  if (!(result instanceof BigDecimal)) throw new Error('expression must evaluate to a number, not a rounding mode')
  return describe(result)
}

/** Làm tròn một giá trị theo đúng một trong ba cách: số chữ số thập phân, bước, hoặc số chữ số có nghĩa. */
export function roundDecimal(
  value: unknown,
  rule: { mode: RoundingModeName; scale?: number; step?: number | string; significant?: number },
): CalcResult {
  const kinds = [rule.scale, rule.step, rule.significant].filter((v) => v !== undefined).length
  if (kinds !== 1) throw new Error('specify exactly one of scale, step, significant')
  if (!ROUNDING_MODES.includes(rule.mode)) throw new Error(`unknown rounding mode ${rule.mode}; use ${ROUNDING_MODES.join(', ')}`)
  const x = toDecimal('value', value)
  const m = { mode: rule.mode }
  if (rule.scale !== undefined) return describe(FUNCTIONS.round.run([x, Big(rule.scale), m]))
  if (rule.step !== undefined) return describe(FUNCTIONS.roundStep.run([x, toDecimal('step', rule.step), m]))
  return describe(FUNCTIONS.roundSig.run([x, Big(rule.significant!), m]))
}

/** Đổi số hoặc chuỗi số sang BigDecimal; `undefined` khi không phải số. */
export function toBigDecimal(value: unknown): BigDecimal | undefined {
  if (value instanceof BigDecimal) return value
  if (typeof value === 'number' && Number.isFinite(value)) return Big(String(value))
  if (typeof value === 'bigint') return Big(value)
  if (typeof value === 'string' && NUMERIC.test(value)) return Big(value.trim())
  return undefined
}

/** Tên các biến mà biểu thức cần, theo thứ tự xuất hiện, không lặp. */
export function variablesOf(expression: string): string[] {
  const names: string[] = []
  const walk = (node: Node) => {
    if (node.type === 'var' && !names.includes(node.name)) names.push(node.name)
    if (node.type === 'unary') walk(node.arg)
    if (node.type === 'binary') { walk(node.left); walk(node.right) }
    if (node.type === 'call') node.args.forEach(walk)
  }
  walk(parse(expression))
  return names
}

/** Ném lỗi nếu biểu thức sai cú pháp, gọi hàm không tồn tại, hoặc truyền sai loại tham số; không cần giá trị biến. */
export function checkExpression(expression: string) {
  const walk = (node: Node, expect: 'num' | 'mode') => {
    if (node.type === 'mode' && expect === 'num') throw new Error(`rounding mode ${node.name} at position ${node.pos} is only allowed as a function argument`)
    if (node.type !== 'mode' && expect === 'mode') throw new Error(`expected a rounding mode (${ROUNDING_MODES.join(', ')})`)
    if (node.type === 'unary') walk(node.arg, 'num')
    if (node.type === 'binary') { walk(node.left, 'num'); walk(node.right, 'num') }
    if (node.type === 'call') {
      const fn = signature(node)
      node.args.forEach((arg, i) => walk(arg, paramAt(fn, i) === 'mode' ? 'mode' : 'num'))
    }
  }
  walk(parse(expression), 'num')
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

function toDecimals(variables: Record<string, unknown>) {
  const out = new Map<string, BigDecimal>()
  for (const [name, raw] of Object.entries(variables)) out.set(name, toDecimal(name, raw))
  return out
}

function int(v: Value, min: number, max: number) {
  const d = num(v)
  if (d.stripTrailingZeros().scale() > 0) throw new Error(`expected an integer, got ${d.toPlainString()}`)
  const n = Number(d.toPlainString())
  if (n < min || n > max) throw new Error(`integer ${n} out of range ${min}..${max}`)
  return n
}

function exactDivide(a: BigDecimal, b: BigDecimal, where: string) {
  if (b.signum() === 0) throw new Error('division by zero')
  try {
    return a.divide(b)
  } catch {
    throw new Error(`${where}: ${a.toPlainString()} / ${b.toPlainString()} has no exact decimal result; use div(a, b, scale, MODE) to choose the rounding`)
  }
}

/** Tra hàm chỉ trong thuộc tính khai báo trực tiếp; tra thẳng sẽ lấy cả thuộc tính kế thừa như `constructor`. */
function lookup(name: string): Fn | undefined {
  return Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined
}

function signature(node: Extract<Node, { type: 'call' }>) {
  const fn = lookup(node.name)
  if (!fn) throw new Error(`unknown function ${node.name} at position ${node.pos}; available: ${Object.keys(FUNCTIONS).join(', ')}`)
  const min = fn.params.length
  const max = fn.variadic ? Infinity : min + (fn.optional?.length ?? 0)
  if (node.args.length < min || node.args.length > max) {
    throw new Error(`${fn.desc.split(':')[0]} expects ${max === Infinity ? `at least ${min}` : min === max ? min : `${min}-${max}`} arguments, got ${node.args.length}`)
  }
  return fn
}

function paramAt(fn: Fn, i: number): Param {
  return fn.params[i] ?? fn.optional?.[i - fn.params.length] ?? 'num'
}

function tokenize(input: string): Token[] {
  if (input.length > MAX_LENGTH) throw new Error(`expression longer than ${MAX_LENGTH} characters`)
  const tokens: Token[] = []
  const re = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/%^(),]))/y
  let pos = 0
  while (pos < input.length) {
    if (/^\s*$/.test(input.slice(pos))) break
    re.lastIndex = pos
    const m = re.exec(input)
    if (!m) {
      const at = pos + (input.slice(pos).length - input.slice(pos).trimStart().length)
      throw new Error(`unexpected character ${JSON.stringify(input[at])} at position ${at}`)
    }
    const text = m[1] ?? m[2] ?? m[3]
    const start = m.index + m[0].length - text.length
    if (m[1] !== undefined) tokens.push({ kind: 'num', text, pos: start })
    else if (m[2] !== undefined) tokens.push({ kind: 'id', text, pos: start })
    else tokens.push({ kind: 'op', text: text === '**' ? '^' : text, pos: start })
    pos = re.lastIndex
  }
  tokens.push({ kind: 'end', text: '', pos: input.length })
  return tokens
}

const BINARY: Record<string, { prec: number; right?: boolean }> = {
  '+': { prec: 1 }, '-': { prec: 1 }, '*': { prec: 2 }, '/': { prec: 2 }, '%': { prec: 2 }, '^': { prec: 4, right: true },
}

function parse(input: string): Node {
  const tokens = tokenize(input)
  let i = 0
  const peek = () => tokens[i]
  const next = () => tokens[i++]
  const expect = (text: string) => {
    const t = next()
    if (t.text !== text) throw new Error(`expected "${text}" at position ${t.pos}`)
  }

  const expression = (minPrec: number, depth: number): Node => {
    if (depth > MAX_DEPTH) throw new Error('expression is nested too deeply')
    let left = unary(depth)
    while (true) {
      const t = peek()
      const info = t.kind === 'op' ? BINARY[t.text] : undefined
      if (!info || info.prec < minPrec) break
      next()
      const right = expression(info.right ? info.prec : info.prec + 1, depth + 1)
      left = { type: 'binary', op: t.text, left, right, pos: t.pos }
    }
    return left
  }

  // Dấu âm có độ ưu tiên thấp hơn luỹ thừa: -2^2 = -4.
  const unary = (depth: number): Node => {
    const t = peek()
    if (t.kind === 'op' && (t.text === '-' || t.text === '+')) {
      next()
      return { type: 'unary', op: t.text, arg: expression(3, depth + 1) }
    }
    return primary(depth)
  }

  const primary = (depth: number): Node => {
    const t = next()
    if (t.kind === 'num') return { type: 'num', text: t.text }
    if (t.kind === 'id') {
      if (peek().text !== '(') {
        if ((ROUNDING_MODES as readonly string[]).includes(t.text)) return { type: 'mode', name: t.text as RoundingModeName, pos: t.pos }
        return { type: 'var', name: t.text, pos: t.pos }
      }
      next()
      const args: Node[] = []
      if (peek().text !== ')') {
        do { args.push(expression(1, depth + 1)) } while (peek().text === ',' && next())
      }
      expect(')')
      return { type: 'call', name: t.text, args, pos: t.pos }
    }
    if (t.text === '(') {
      const inner = expression(1, depth + 1)
      expect(')')
      return inner
    }
    throw new Error(t.kind === 'end' ? 'unexpected end of expression' : `unexpected "${t.text}" at position ${t.pos}`)
  }

  const tree = expression(1, 0)
  if (peek().kind !== 'end') throw new Error(`unexpected "${peek().text}" at position ${peek().pos}`)
  return tree
}

function evaluate(node: Node, vars: Map<string, BigDecimal>, depth: number): Value {
  const numeric = (n: Node) => {
    const v = evaluate(n, vars, depth + 1)
    if (!(v instanceof BigDecimal)) throw new Error(`rounding mode ${(v as { mode: string }).mode} is only allowed as a function argument`)
    return v
  }
  switch (node.type) {
    case 'num': return Big(node.text)
    case 'mode': return { mode: node.name }
    case 'var': {
      const value = vars.get(node.name)
      if (!value) throw new Error(`variable ${node.name} has no value`)
      return value
    }
    case 'unary': {
      const v = numeric(node.arg)
      return node.op === '-' ? v.negate() : v
    }
    case 'binary': {
      const a = numeric(node.left)
      const b = numeric(node.right)
      switch (node.op) {
        case '+': return a.add(b)
        case '-': return a.subtract(b)
        case '*': return a.multiply(b)
        case '/': return exactDivide(a, b, `division at position ${node.pos}`)
        case '%':
          if (b.signum() === 0) throw new Error(`modulo by zero at position ${node.pos}`)
          return a.remainder(b)
        case '^': {
          const e = int(b, -MAX_EXPONENT, MAX_EXPONENT)
          return e >= 0 ? a.pow(e) : exactDivide(Big(1), a.pow(-e), `negative power at position ${node.pos}`)
        }
      }
      throw new Error(`unknown operator ${node.op}`)
    }
    case 'call': {
      const fn = signature(node)
      const args = node.args.map((arg, i) => {
        const v = evaluate(arg, vars, depth + 1)
        const kind = paramAt(fn, i)
        if (kind === 'mode' && v instanceof BigDecimal) throw new Error(`${node.name}: argument ${i + 1} must be a rounding mode (${ROUNDING_MODES.join(', ')})`)
        if (kind !== 'mode' && !(v instanceof BigDecimal)) throw new Error(`${node.name}: argument ${i + 1} must be a number`)
        return v
      })
      return fn.run(args)
    }
  }
}
