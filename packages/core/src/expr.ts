import { Big, BigDecimal, MathContext, RoundingMode } from 'bigdecimal.js'

/**
 * Ngôn ngữ biểu thức của aitest: tính giá trị mong đợi chính xác trên BigDecimal, kể cả công thức nghiệp vụ phức tạp
 * trên dữ liệu nhiều dòng (cộng dồn, nhóm, lọc, điều kiện).
 *
 * Kiểu dữ liệu: số (BigDecimal), chuỗi, đúng/sai, `null`, danh sách, bản ghi (object từ evidence).
 * - Số: `+ - * % ^` chính xác; `/` chỉ khi chia hết, chia không hết dùng `div(a, b, scale, MODE)`.
 *   Chuỗi số (ví dụ `"123.45"` từ DB) được dùng như số trong phép tính và so sánh.
 * - Không làm tròn mặc định; hàm làm tròn nhận cách làm tròn tường minh (`HALF_UP`…).
 * - `t.qty`, `rows[0]`, `[a, b]`, `{ key: a }`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `and`/`&&`, `or`/`||`, `not`/`!`, `c ? a : b`.
 * - Hàm ẩn danh làm tham số: `t -> t.qty * t.price`, `(acc, t) -> acc + t.amount`.
 * - Hàm trên danh sách: `sum`, `count`, `avg`, `min`, `max`, `map`, `filter`, `reduce`, `cumsum`, `sortBy`, `groupBy`…
 * - Công thức tự định nghĩa (`UserFormula`): hàm thuần, gọi như hàm dựng sẵn, ví dụ `fee(qty, price)`.
 * Không dùng `eval`; số bước tính bị giới hạn để biểu thức không chạy vô hạn.
 */

export const ROUNDING_MODES = ['UP', 'DOWN', 'CEILING', 'FLOOR', 'HALF_UP', 'HALF_DOWN', 'HALF_EVEN', 'UNNECESSARY'] as const
export type RoundingModeName = typeof ROUNDING_MODES[number]

/** Công thức tự định nghĩa: hàm thuần trên tham số; gọi được công thức khác, không đọc biến bên ngoài. */
export interface UserFormula {
  params: string[]
  expr: string
  /** Các bước trung gian có tên, tính theo thứ tự trước `expr`. */
  let?: Record<string, string>
  desc?: string
}

export interface EvalOptions {
  /** Các bước có tên, tính theo thứ tự; bước sau dùng được kết quả bước trước. */
  let?: Record<string, string>
  formulas?: Record<string, UserFormula>
}

export interface EvalResult {
  /** Kết quả ở dạng JSON thuần: số là chuỗi thập phân đầy đủ, danh sách, bản ghi, chuỗi, đúng/sai, `null`. */
  value: unknown
  /** Giá trị của từng bước `let`, cùng dạng với `value`. */
  steps: Record<string, unknown>
}

const MAX_LENGTH = 20_000
const MAX_DEPTH = 96
const MAX_SCALE = 1000
const MAX_EXPONENT = 10_000
const MAX_STEPS = 5_000_000
const MAX_CALL_DEPTH = 32

class Mode {
  constructor(readonly name: RoundingModeName) {}
}

class Lambda {
  constructor(readonly params: string[], readonly body: Node, readonly scope: Scope) {}
}

type Val = BigDecimal | string | boolean | null | Val[] | { [key: string]: Val } | Mode | Lambda

type Node =
  | { type: 'num'; text: string }
  | { type: 'str'; value: string }
  | { type: 'lit'; value: boolean | null }
  | { type: 'var'; name: string; pos: number }
  | { type: 'list'; items: Node[] }
  | { type: 'record'; fields: Array<[string, Node]> }
  | { type: 'unary'; op: '-' | '+' | '!'; arg: Node; pos: number }
  | { type: 'binary'; op: string; left: Node; right: Node; pos: number }
  | { type: 'cond'; test: Node; then: Node; else: Node }
  | { type: 'member'; object: Node; name: string; pos: number }
  | { type: 'index'; object: Node; index: Node; pos: number }
  | { type: 'call'; name: string; args: Node[]; pos: number }
  | { type: 'lambda'; params: string[]; body: Node; pos: number }

interface Token { kind: 'num' | 'str' | 'id' | 'op' | 'end'; text: string; pos: number }

/* ------------------------------------------------------------------ tokenizer, parser */

const OPS = ['->', '**', '==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '^', '(', ')', ',', '.', '[', ']', '{', '}', '<', '>', '!', '?', ':']

function tokenize(input: string): Token[] {
  if (input.length > MAX_LENGTH) throw new Error(`expression longer than ${MAX_LENGTH} characters`)
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const c = input[i]
    if (/\s/.test(c)) { i++; continue }
    // Chú thích `# …` tới hết dòng, cho công thức nhiều dòng.
    if (c === '#') { while (i < input.length && input[i] !== '\n') i++; continue }
    const numMatch = /^(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)/.exec(input.slice(i))
    if (numMatch) { tokens.push({ kind: 'num', text: numMatch[1], pos: i }); i += numMatch[1].length; continue }
    if (c === '"' || c === "'") {
      let j = i + 1
      let text = ''
      while (j < input.length && input[j] !== c) {
        if (input[j] === '\\' && j + 1 < input.length) { text += input[j + 1]; j += 2 } else { text += input[j]; j++ }
      }
      if (j >= input.length) throw new Error(`unterminated string at position ${i}`)
      tokens.push({ kind: 'str', text, pos: i })
      i = j + 1
      continue
    }
    const idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i))
    if (idMatch) { tokens.push({ kind: 'id', text: idMatch[0], pos: i }); i += idMatch[0].length; continue }
    const op = OPS.find((o) => input.startsWith(o, i))
    if (!op) throw new Error(`unexpected character ${JSON.stringify(c)} at position ${i}`)
    tokens.push({ kind: 'op', text: op === '**' ? '^' : op, pos: i })
    i += op.length
  }
  tokens.push({ kind: 'end', text: '', pos: input.length })
  return tokens
}

const BINARY: Record<string, { prec: number; right?: boolean }> = {
  'or': { prec: 1 }, '||': { prec: 1 },
  'and': { prec: 2 }, '&&': { prec: 2 },
  '==': { prec: 3 }, '!=': { prec: 3 },
  '<': { prec: 4 }, '<=': { prec: 4 }, '>': { prec: 4 }, '>=': { prec: 4 },
  '+': { prec: 5 }, '-': { prec: 5 },
  '*': { prec: 6 }, '/': { prec: 6 }, '%': { prec: 6 },
  '^': { prec: 8, right: true },
}

const parseCache = new Map<string, Node>()

/** Kiểm tra cú pháp một biểu thức (không kiểm tên hàm); ném lỗi kèm vị trí khi sai. */
export function parseExpression(input: string): void {
  parse(input)
}

function parse(input: string): Node {
  const cached = parseCache.get(input)
  if (cached) return cached
  const tokens = tokenize(input)
  let i = 0
  const peek = (k = 0) => tokens[Math.min(i + k, tokens.length - 1)]
  const next = () => tokens[i++]
  const expect = (text: string) => {
    const t = next()
    if (t.text !== text) throw new Error(`expected "${text}" at position ${t.pos}${t.kind === 'end' ? ' (end of expression)' : `, found "${t.text}"`}`)
  }
  const binaryOf = (t: Token) => (t.kind === 'op' || (t.kind === 'id' && (t.text === 'and' || t.text === 'or'))) ? BINARY[t.text] : undefined

  const expression = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new Error('expression is nested too deeply')
    // Hàm ẩn danh: `x -> …` hoặc `(a, b) -> …`.
    if (peek().kind === 'id' && peek(1).text === '->') {
      const t = next()
      next()
      return { type: 'lambda', params: [t.text], body: expression(depth + 1), pos: t.pos }
    }
    if (peek().text === '(') {
      let k = 1
      const params: string[] = []
      let ok = true
      if (peek(k).text !== ')') {
        while (true) {
          if (peek(k).kind !== 'id') { ok = false; break }
          params.push(peek(k).text)
          k++
          if (peek(k).text === ',') { k++; continue }
          break
        }
      }
      if (ok && peek(k).text === ')' && peek(k + 1).text === '->') {
        const pos = peek().pos
        i += k + 2
        return { type: 'lambda', params, body: expression(depth + 1), pos }
      }
    }
    const test = binary(1, depth)
    if (peek().text === '?') {
      next()
      const then = expression(depth + 1)
      expect(':')
      return { type: 'cond', test, then, else: expression(depth + 1) }
    }
    return test
  }

  const binary = (minPrec: number, depth: number): Node => {
    if (depth > MAX_DEPTH) throw new Error('expression is nested too deeply')
    let left = unary(depth)
    while (true) {
      const t = peek()
      const info = binaryOf(t)
      if (!info || info.prec < minPrec) break
      next()
      const right = binary(info.right ? info.prec : info.prec + 1, depth + 1)
      const op = t.text === 'and' ? '&&' : t.text === 'or' ? '||' : t.text
      left = { type: 'binary', op, left, right, pos: t.pos }
    }
    return left
  }

  // Dấu âm có độ ưu tiên thấp hơn luỹ thừa: -2^2 = -4.
  const unary = (depth: number): Node => {
    const t = peek()
    if ((t.kind === 'op' && (t.text === '-' || t.text === '+' || t.text === '!')) || (t.kind === 'id' && t.text === 'not')) {
      next()
      const op = t.text === 'not' ? '!' : t.text as '-' | '+' | '!'
      return { type: 'unary', op, arg: binary(op === '!' ? 3 : 7, depth + 1), pos: t.pos }
    }
    return postfix(depth)
  }

  const postfix = (depth: number): Node => {
    let node = primary(depth)
    while (true) {
      const t = peek()
      if (t.text === '.' && t.kind === 'op') {
        next()
        const name = next()
        if (name.kind !== 'id') throw new Error(`expected a field name after "." at position ${t.pos}`)
        node = { type: 'member', object: node, name: name.text, pos: t.pos }
      } else if (t.text === '[' && t.kind === 'op') {
        next()
        const index = expression(depth + 1)
        expect(']')
        node = { type: 'index', object: node, index, pos: t.pos }
      } else break
    }
    return node
  }

  const primary = (depth: number): Node => {
    const t = next()
    if (t.kind === 'num') return { type: 'num', text: t.text }
    if (t.kind === 'str') return { type: 'str', value: t.text }
    if (t.kind === 'id') {
      if (t.text === 'true' || t.text === 'false') return { type: 'lit', value: t.text === 'true' }
      if (t.text === 'null') return { type: 'lit', value: null }
      if (peek().text === '(') {
        next()
        const args: Node[] = []
        if (peek().text !== ')') {
          do { args.push(expression(depth + 1)) } while (peek().text === ',' && next())
        }
        expect(')')
        return { type: 'call', name: t.text, args, pos: t.pos }
      }
      return { type: 'var', name: t.text, pos: t.pos }
    }
    if (t.text === '(') {
      const inner = expression(depth + 1)
      expect(')')
      return inner
    }
    if (t.text === '{') {
      // Bản ghi: `{ netCash: a - b, 'tổng phí': fees }`.
      const fields: Array<[string, Node]> = []
      if (peek().text !== '}') {
        do {
          const key = next()
          if (key.kind !== 'id' && key.kind !== 'str') throw new Error(`expected a field name at position ${key.pos}`)
          expect(':')
          fields.push([key.text, expression(depth + 1)])
        } while (peek().text === ',' && next())
      }
      expect('}')
      return { type: 'record', fields }
    }
    if (t.text === '[') {
      const items: Node[] = []
      if (peek().text !== ']') {
        do { items.push(expression(depth + 1)) } while (peek().text === ',' && next())
      }
      expect(']')
      return { type: 'list', items }
    }
    throw new Error(t.kind === 'end' ? 'unexpected end of expression' : `unexpected "${t.text}" at position ${t.pos}`)
  }

  const tree = expression(0)
  if (peek().kind !== 'end') throw new Error(`unexpected "${peek().text}" at position ${peek().pos}`)
  if (parseCache.size > 500) parseCache.clear()
  parseCache.set(input, tree)
  return tree
}

/* ------------------------------------------------------------------ values */

const isNum = (v: unknown): v is BigDecimal => v instanceof BigDecimal
const isList = (v: unknown): v is Val[] => Array.isArray(v)
const isRecord = (v: unknown): v is Record<string, Val> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof BigDecimal) && !(v instanceof Mode) && !(v instanceof Lambda)

const NUMERIC = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/

function typeName(v: Val): string {
  if (v === null) return 'null'
  if (isNum(v)) return 'number'
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'boolean'
  if (isList(v)) return 'list'
  if (v instanceof Mode) return 'rounding mode'
  if (v instanceof Lambda) return 'function'
  return 'record'
}

function show(v: Val): string {
  const plain = toPlain(v)
  const text = typeof plain === 'string' ? plain : JSON.stringify(plain)
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

/** Số từ số hoặc chuỗi số; báo lỗi rõ ràng với giá trị khác. */
function asNum(v: Val, where: string): BigDecimal {
  if (isNum(v)) return v
  if (v instanceof Mode) throw new Error(`rounding mode ${v.name} is only allowed as a function argument (${where})`)
  if (typeof v === 'string' && NUMERIC.test(v)) return Big(v.trim())
  throw new Error(`${where}: expected a number, got ${typeName(v)}${v === null ? '' : ` ${show(v)}`}`)
}

function asList(v: Val, where: string): Val[] {
  if (isList(v)) return v
  throw new Error(`${where}: expected a list, got ${typeName(v)}`)
}

function asBool(v: Val, where: string): boolean {
  if (typeof v === 'boolean') return v
  throw new Error(`${where}: expected true/false, got ${typeName(v)}${v === null ? '' : ` ${show(v)}`}`)
}

function asInt(v: Val, min: number, max: number, where: string) {
  const d = asNum(v, where)
  if (d.stripTrailingZeros().scale() > 0) throw new Error(`${where}: expected an integer, got ${d.toPlainString()}`)
  const n = Number(d.toPlainString())
  if (n < min || n > max) throw new Error(`${where}: integer ${n} out of range ${min}..${max}`)
  return n
}

function asMode(v: Val, where: string, arg: number) {
  if (v instanceof Mode) return RoundingMode[v.name]
  throw new Error(`${where}: argument ${arg} must be a rounding mode (${ROUNDING_MODES.join(', ')})`)
}

function exactDivide(a: BigDecimal, b: BigDecimal, where: string) {
  if (b.signum() === 0) throw new Error(`${where}: division by zero`)
  try {
    return a.divide(b)
  } catch {
    throw new Error(`${where}: ${a.toPlainString()} / ${b.toPlainString()} has no exact decimal result; use div(a, b, scale, MODE) to choose the rounding`)
  }
}

/** Giá trị JSON (evidence, biến) sang giá trị của biểu thức: số JSON thành BigDecimal, chuỗi giữ nguyên. */
export function fromPlain(value: unknown): Val {
  if (value === undefined || value === null) return null
  if (value instanceof BigDecimal) return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`number ${value} is not finite`)
    return Big(String(value))
  }
  if (typeof value === 'bigint') return Big(value)
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(fromPlain)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromPlain(v)]))
  throw new Error(`unsupported value ${String(value)}`)
}

/** Giá trị của biểu thức sang JSON: số thành chuỗi thập phân đầy đủ, không ký hiệu mũ. */
export function toPlain(v: Val): unknown {
  if (isNum(v)) return v.toPlainString()
  if (isList(v)) return v.map(toPlain)
  if (v instanceof Mode) return v.name
  if (v instanceof Lambda) throw new Error('a function cannot be the result of an expression')
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]))
  return v
}

/** So sánh bằng nhau theo giá trị: số so theo giá trị (1.50 == 1.5), danh sách và bản ghi so từng phần tử. */
function equals(a: Val, b: Val): boolean {
  const an = isNum(a) || (typeof a === 'string' && NUMERIC.test(a) && isNum(b))
  const bn = isNum(b) || (typeof b === 'string' && NUMERIC.test(b) && isNum(a))
  if (an && bn) return asNum(a, '==').compareTo(asNum(b, '==')) === 0
  if (isList(a) && isList(b)) return a.length === b.length && a.every((x, i) => equals(x, b[i]))
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && equals(a[k], b[k]))
  }
  return a === b
}

function order(a: Val, b: Val, where: string): number {
  if (typeof a === 'string' && typeof b === 'string' && !(NUMERIC.test(a) && NUMERIC.test(b))) return a < b ? -1 : a > b ? 1 : 0
  return asNum(a, where).compareTo(asNum(b, where))
}

/* ------------------------------------------------------------------ evaluation */

class Scope {
  constructor(private readonly vars: Map<string, Val>, private readonly parent?: Scope) {}
  get(name: string): Val | undefined {
    return this.vars.has(name) ? this.vars.get(name) : this.parent?.get(name)
  }
  has(name: string): boolean {
    return this.vars.has(name) || !!this.parent?.has(name)
  }
  child(vars: Map<string, Val>) {
    return new Scope(vars, this)
  }
}

interface Ctx {
  formulas: Record<string, UserFormula>
  steps: number
  callDepth: number
}

function tick(ctx: Ctx) {
  if (++ctx.steps > MAX_STEPS) throw new Error(`expression needs more than ${MAX_STEPS} steps; simplify it or reduce the data`)
}

function evaluate(node: Node, scope: Scope, ctx: Ctx): Val {
  tick(ctx)
  switch (node.type) {
    case 'num': return Big(node.text)
    case 'str': return node.value
    case 'lit': return node.value
    case 'list': return node.items.map((n) => evaluate(n, scope, ctx))
    case 'record': {
      const out: Record<string, Val> = {}
      for (const [key, value] of node.fields) out[key] = evaluate(value, scope, ctx)
      return out
    }
    case 'var': {
      if ((ROUNDING_MODES as readonly string[]).includes(node.name) && !scope.has(node.name)) return new Mode(node.name as RoundingModeName)
      const value = scope.get(node.name)
      if (value === undefined) throw new Error(`variable ${node.name} has no value`)
      return value
    }
    case 'lambda': return new Lambda(node.params, node.body, scope)
    case 'unary': {
      const v = evaluate(node.arg, scope, ctx)
      if (node.op === '!') return !asBool(v, `not at position ${node.pos}`)
      const n = asNum(v, `${node.op} at position ${node.pos}`)
      return node.op === '-' ? n.negate() : n
    }
    case 'cond': return asBool(evaluate(node.test, scope, ctx), '? :') ? evaluate(node.then, scope, ctx) : evaluate(node.else, scope, ctx)
    case 'member': {
      const object = evaluate(node.object, scope, ctx)
      if (object === null) throw new Error(`cannot read field ${node.name} of null at position ${node.pos}`)
      if (!isRecord(object)) throw new Error(`cannot read field ${node.name} of ${typeName(object)} at position ${node.pos}`)
      return Object.hasOwn(object, node.name) ? object[node.name] : null
    }
    case 'index': {
      const object = evaluate(node.object, scope, ctx)
      const index = evaluate(node.index, scope, ctx)
      if (isList(object)) {
        let n = asInt(index, -object.length, object.length - 1, `index at position ${node.pos}`)
        if (n < 0) n += object.length
        return object[n]
      }
      if (isRecord(object) && typeof index === 'string') return Object.hasOwn(object, index) ? object[index] : null
      throw new Error(`cannot index ${typeName(object)} at position ${node.pos}`)
    }
    case 'binary': {
      const where = `${node.op} at position ${node.pos}`
      if (node.op === '&&') return asBool(evaluate(node.left, scope, ctx), where) && asBool(evaluate(node.right, scope, ctx), where)
      if (node.op === '||') return asBool(evaluate(node.left, scope, ctx), where) || asBool(evaluate(node.right, scope, ctx), where)
      const left = evaluate(node.left, scope, ctx)
      const right = evaluate(node.right, scope, ctx)
      switch (node.op) {
        case '==': return equals(left, right)
        case '!=': return !equals(left, right)
        case '<': return order(left, right, where) < 0
        case '<=': return order(left, right, where) <= 0
        case '>': return order(left, right, where) > 0
        case '>=': return order(left, right, where) >= 0
      }
      const a = asNum(left, where)
      const b = asNum(right, where)
      switch (node.op) {
        case '+': return a.add(b)
        case '-': return a.subtract(b)
        case '*': return a.multiply(b)
        case '/': return exactDivide(a, b, where)
        case '%':
          if (b.signum() === 0) throw new Error(`${where}: modulo by zero`)
          return a.remainder(b)
        case '^': {
          const e = asInt(b, -MAX_EXPONENT, MAX_EXPONENT, where)
          return e >= 0 ? a.pow(e) : exactDivide(Big(1), a.pow(-e), where)
        }
      }
      throw new Error(`unknown operator ${node.op}`)
    }
    case 'call': return call(node, scope, ctx)
  }
}

/** Gọi hàm ẩn danh với tham số. */
function apply(fn: Val, args: Val[], ctx: Ctx, where: string): Val {
  if (!(fn instanceof Lambda)) throw new Error(`${where}: expected a function like x -> x.amount, got ${typeName(fn)}`)
  if (fn.params.length > args.length) throw new Error(`${where}: function takes ${fn.params.length} parameters, ${args.length} given`)
  return evaluate(fn.body, fn.scope.child(new Map(fn.params.map((p, i) => [p, args[i]]))), ctx)
}

/** Danh sách lấy từ tham số: một danh sách, hoặc danh sách đi kèm hàm chiếu (`sum(rows, r -> r.x)`). */
function projected(args: Val[], ctx: Ctx, name: string): Val[] {
  const list = asList(args[0], name)
  return args[1] === undefined ? list : list.map((item, i) => apply(args[1], [item, Big(i)], ctx, name))
}

/** Hàm nhận danh sách hoặc nhiều số: `sum(xs)`, `sum(xs, x -> …)`, `sum(a, b, c)`. */
function numbers(args: Val[], ctx: Ctx, name: string): BigDecimal[] {
  const items = args.length >= 1 && isList(args[0]) && (args.length === 1 || args[1] instanceof Lambda) ? projected(args, ctx, name) : args
  return items.map((v, i) => asNum(v, `${name} item ${i + 1}`))
}

type Builtin = { desc: string; lazy?: boolean; run(args: Val[], ctx: Ctx, node: Extract<Node, { type: 'call' }>, scope: Scope): Val }

const roundTo = (x: Val, scale: number, m: RoundingMode) => asNum(x, 'round').setScale(scale, m)

export const BUILTINS: Record<string, Builtin> = {
  round: {
    desc: 'round(x, scale, MODE): làm tròn tới `scale` chữ số thập phân; scale âm làm tròn tới hàng chục, trăm…',
    run: ([x, s, m]) => roundTo(x, asInt(s, -MAX_SCALE, MAX_SCALE, 'round'), asMode(m, 'round', 3)),
  },
  roundStep: {
    desc: 'roundStep(x, step, MODE): làm tròn tới bội số của `step` (bước giá, lô giao dịch)',
    run: ([x, s, m]) => {
      const step = asNum(s, 'roundStep')
      if (step.signum() <= 0) throw new Error('roundStep: step must be greater than 0')
      return asNum(x, 'roundStep').divide(step, 0, asMode(m, 'roundStep', 3)).multiply(step)
    },
  },
  roundSig: {
    desc: 'roundSig(x, digits, MODE): làm tròn tới `digits` chữ số có nghĩa',
    run: ([x, d, m]) => asNum(x, 'roundSig').round(new MathContext(asInt(d, 1, MAX_SCALE, 'roundSig'), asMode(m, 'roundSig', 3))),
  },
  floor: { desc: 'floor(x, scale = 0): như round(x, scale, FLOOR)', run: ([x, s]) => roundTo(x, s === undefined ? 0 : asInt(s, -MAX_SCALE, MAX_SCALE, 'floor'), RoundingMode.FLOOR) },
  ceil: { desc: 'ceil(x, scale = 0): như round(x, scale, CEILING)', run: ([x, s]) => roundTo(x, s === undefined ? 0 : asInt(s, -MAX_SCALE, MAX_SCALE, 'ceil'), RoundingMode.CEILING) },
  trunc: { desc: 'trunc(x, scale = 0): như round(x, scale, DOWN)', run: ([x, s]) => roundTo(x, s === undefined ? 0 : asInt(s, -MAX_SCALE, MAX_SCALE, 'trunc'), RoundingMode.DOWN) },
  div: {
    desc: 'div(a, b, scale, MODE): chia, làm tròn kết quả tới `scale` chữ số thập phân',
    run: ([a, b, s, m]) => {
      const d = asNum(b, 'div')
      if (d.signum() === 0) throw new Error('div: division by zero')
      return asNum(a, 'div').divide(d, asInt(s, -MAX_SCALE, MAX_SCALE, 'div'), asMode(m, 'div', 4))
    },
  },
  sqrt: {
    desc: 'sqrt(x, scale, MODE): căn bậc hai, làm tròn tới `scale` chữ số thập phân',
    run: ([x, s, m]) => {
      const v = asNum(x, 'sqrt')
      if (v.signum() < 0) throw new Error('sqrt of negative number')
      const scale = asInt(s, 0, MAX_SCALE, 'sqrt')
      const digits = v.toBigInt().toString().length
      return v.sqrt(new MathContext(digits + scale + 10, RoundingMode.DOWN)).setScale(scale, asMode(m, 'sqrt', 3))
    },
  },
  abs: { desc: 'abs(x): giá trị tuyệt đối', run: ([x]) => asNum(x, 'abs').abs() },
  pct: { desc: 'pct(x, p): p phần trăm của x, chính xác', run: ([x, p]) => asNum(x, 'pct').multiply(asNum(p, 'pct')).movePointLeft(2) },
  num: { desc: 'num(x): đổi chuỗi số sang số', run: ([x]) => asNum(x, 'num') },
  sum: {
    desc: 'sum(xs) | sum(xs, x -> …) | sum(a, b, …): tổng; danh sách rỗng cho 0',
    run: (args, ctx) => numbers(args, ctx, 'sum').reduce((a, b) => a.add(b), Big(0)),
  },
  min: {
    desc: 'min(xs) | min(xs, x -> …) | min(a, b, …): nhỏ nhất',
    run: (args, ctx) => { const xs = numbers(args, ctx, 'min'); if (!xs.length) throw new Error('min of empty list'); return xs.reduce((a, b) => (b.compareTo(a) < 0 ? b : a)) },
  },
  max: {
    desc: 'max(xs) | max(xs, x -> …) | max(a, b, …): lớn nhất',
    run: (args, ctx) => { const xs = numbers(args, ctx, 'max'); if (!xs.length) throw new Error('max of empty list'); return xs.reduce((a, b) => (b.compareTo(a) > 0 ? b : a)) },
  },
  avg: {
    desc: 'avg(xs) | avg(xs, x -> …) | avg(a, b, …): trung bình chính xác; không chia hết thì dùng div(sum(xs), len(xs), scale, MODE)',
    run: (args, ctx) => {
      const xs = numbers(args, ctx, 'avg')
      if (!xs.length) throw new Error('avg of empty list')
      return exactDivide(xs.reduce((a, b) => a.add(b)), Big(xs.length), 'avg')
    },
  },
  count: {
    desc: 'count(xs) | count(xs, x -> điều kiện): số phần tử (thoả điều kiện)',
    run: ([xs, pred], ctx) => Big(pred === undefined ? asList(xs, 'count').length : asList(xs, 'count').filter((x, i) => asBool(apply(pred, [x, Big(i)], ctx, 'count'), 'count')).length),
  },
  len: { desc: 'len(xs): độ dài danh sách hoặc chuỗi', run: ([x]) => Big(typeof x === 'string' ? x.length : asList(x, 'len').length) },
  map: { desc: 'map(xs, x -> …): biến đổi từng phần tử', run: (args, ctx) => projected(args, ctx, 'map') },
  filter: {
    desc: 'filter(xs, x -> điều kiện): giữ phần tử thoả điều kiện',
    run: ([xs, pred], ctx) => asList(xs, 'filter').filter((x, i) => asBool(apply(pred, [x, Big(i)], ctx, 'filter'), 'filter')),
  },
  find: {
    desc: 'find(xs, x -> điều kiện): phần tử đầu tiên thoả điều kiện, không có thì null',
    run: ([xs, pred], ctx) => asList(xs, 'find').find((x, i) => asBool(apply(pred, [x, Big(i)], ctx, 'find'), 'find')) ?? null,
  },
  any: { desc: 'any(xs, x -> điều kiện): có phần tử thoả', run: ([xs, pred], ctx) => asList(xs, 'any').some((x, i) => asBool(apply(pred, [x, Big(i)], ctx, 'any'), 'any')) },
  all: { desc: 'all(xs, x -> điều kiện): mọi phần tử thoả', run: ([xs, pred], ctx) => asList(xs, 'all').every((x, i) => asBool(apply(pred, [x, Big(i)], ctx, 'all'), 'all')) },
  reduce: {
    desc: 'reduce(xs, init, (acc, x) -> …): gộp lần lượt từ trái sang phải',
    run: ([xs, init, fn], ctx) => asList(xs, 'reduce').reduce<Val>((acc, x, i) => apply(fn, [acc, x, Big(i)], ctx, 'reduce'), init),
  },
  cumsum: {
    desc: 'cumsum(xs) | cumsum(xs, x -> …): tổng cộng dồn, cùng độ dài với xs',
    run: (args, ctx) => {
      let acc = Big(0)
      return projected(args, ctx, 'cumsum').map((v, i) => (acc = acc.add(asNum(v, `cumsum item ${i + 1}`))))
    },
  },
  scan: {
    desc: 'scan(xs, init, (acc, x) -> …): như reduce nhưng giữ mọi giá trị trung gian (số dư sau từng giao dịch)',
    run: ([xs, init, fn], ctx) => {
      let acc = init
      return asList(xs, 'scan').map((x, i) => (acc = apply(fn, [acc, x, Big(i)], ctx, 'scan')))
    },
  },
  sortBy: {
    desc: "sortBy(xs, x -> khoá, 'desc'?): sắp xếp ổn định theo khoá; mặc định tăng dần",
    run: ([xs, key, dir], ctx) => {
      const list = asList(xs, 'sortBy').map((x, i) => ({ x, k: apply(key, [x, Big(i)], ctx, 'sortBy') }))
      const sign = dir === 'desc' ? -1 : 1
      return list.sort((a, b) => sign * order(a.k, b.k, 'sortBy')).map((e) => e.x)
    },
  },
  groupBy: {
    desc: 'groupBy(xs, x -> khoá): danh sách { key, items } theo thứ tự xuất hiện của khoá',
    run: ([xs, key], ctx) => {
      const groups: Array<{ key: Val; items: Val[] }> = []
      asList(xs, 'groupBy').forEach((x, i) => {
        const k = apply(key, [x, Big(i)], ctx, 'groupBy')
        const g = groups.find((e) => equals(e.key, k))
        if (g) g.items.push(x)
        else groups.push({ key: k, items: [x] })
      })
      return groups
    },
  },
  distinct: {
    desc: 'distinct(xs) | distinct(xs, x -> khoá): bỏ phần tử trùng, giữ lần xuất hiện đầu',
    run: (args, ctx) => {
      const keys = projected(args, ctx, 'distinct')
      const list = asList(args[0], 'distinct')
      return list.filter((_, i) => keys.findIndex((k) => equals(k, keys[i])) === i)
    },
  },
  first: { desc: 'first(xs): phần tử đầu, danh sách rỗng thì null', run: ([xs]) => asList(xs, 'first')[0] ?? null },
  last: { desc: 'last(xs): phần tử cuối, danh sách rỗng thì null', run: ([xs]) => asList(xs, 'last').at(-1) ?? null },
  coalesce: { desc: 'coalesce(a, b, …): giá trị đầu tiên khác null', run: (args) => args.find((a) => a !== null) ?? null },
  if: {
    desc: 'if(điều kiện, a, b): a khi đúng, b khi sai (chỉ tính nhánh được chọn)',
    lazy: true,
    run: (_args, ctx, node, scope) => {
      if (node.args.length !== 3) throw new Error('if(condition, a, b) expects 3 arguments')
      return asBool(evaluate(node.args[0], scope, ctx), 'if') ? evaluate(node.args[1], scope, ctx) : evaluate(node.args[2], scope, ctx)
    },
  },
}

/** Vị trí (từ 0) của tham số cách làm tròn trong hàm dựng sẵn. */
const MODE_ARG: Record<string, number> = { round: 2, roundStep: 2, roundSig: 2, div: 3, sqrt: 2 }

/** Số tham số cho phép của hàm dựng sẵn: [ít nhất, nhiều nhất]. */
const ARITY: Record<string, [number, number]> = {
  round: [3, 3], roundStep: [3, 3], roundSig: [3, 3], floor: [1, 2], ceil: [1, 2], trunc: [1, 2], div: [4, 4], sqrt: [3, 3],
  abs: [1, 1], pct: [2, 2], num: [1, 1], sum: [1, Infinity], min: [1, Infinity], max: [1, Infinity], avg: [1, Infinity],
  count: [1, 2], len: [1, 1], map: [2, 2], filter: [2, 2], find: [2, 2], any: [2, 2], all: [2, 2], reduce: [3, 3], cumsum: [1, 2],
  scan: [3, 3], sortBy: [2, 3], groupBy: [2, 2], distinct: [1, 2], first: [1, 1], last: [1, 1], coalesce: [1, Infinity], if: [3, 3],
}

function checkArity(name: string, count: number, pos: number) {
  const [min, max] = ARITY[name] ?? [0, Infinity]
  if (count < min || count > max) {
    const expected = max === Infinity ? `at least ${min}` : min === max ? String(min) : `${min}-${max}`
    throw new Error(`${BUILTINS[name].desc.split(':')[0]} expects ${expected} arguments, got ${count} (at position ${pos})`)
  }
}

function call(node: Extract<Node, { type: 'call' }>, scope: Scope, ctx: Ctx): Val {
  const builtin = Object.hasOwn(BUILTINS, node.name) ? BUILTINS[node.name] : undefined
  const formula = Object.hasOwn(ctx.formulas, node.name) ? ctx.formulas[node.name] : undefined
  if (formula) {
    const args = node.args.map((a) => evaluate(a, scope, ctx))
    return callFormula(node.name, formula, args, ctx)
  }
  if (!builtin) throw new Error(`unknown function ${node.name} at position ${node.pos}; available: ${[...Object.keys(BUILTINS), ...Object.keys(ctx.formulas)].join(', ')}`)
  checkArity(node.name, node.args.length, node.pos)
  if (builtin.lazy) return builtin.run([], ctx, node, scope)
  const args = node.args.map((a) => evaluate(a, scope, ctx))
  try {
    return builtin.run(args, ctx, node, scope)
  } catch (error) {
    const message = (error as Error).message
    throw new Error(message.includes('position') ? message : `${message} (in ${node.name} at position ${node.pos})`)
  }
}

function callFormula(name: string, formula: UserFormula, args: Val[], ctx: Ctx): Val {
  if (args.length !== formula.params.length) throw new Error(`${name}(${formula.params.join(', ')}) expects ${formula.params.length} arguments, got ${args.length}`)
  if (ctx.callDepth >= MAX_CALL_DEPTH) throw new Error(`formula calls nested deeper than ${MAX_CALL_DEPTH} (recursive formula ${name}?)`)
  ctx.callDepth++
  try {
    // Công thức là hàm thuần: chỉ thấy tham số và các bước của chính nó.
    let local = new Scope(new Map(formula.params.map((p, i) => [p, args[i]])))
    for (const [step, expr] of Object.entries(formula.let ?? {})) {
      local = local.child(new Map([[step, evaluate(parse(expr), local, ctx)]]))
    }
    return evaluate(parse(formula.expr), local, ctx)
  } catch (error) {
    throw new Error(`in formula ${name}: ${(error as Error).message}`)
  } finally {
    ctx.callDepth--
  }
}

/* ------------------------------------------------------------------ public API */

/**
 * Tính biểu thức với các bước `let` và công thức tự định nghĩa. Biến nhận giá trị JSON (số, chuỗi số, danh sách, bản ghi).
 * Trả về kết quả và giá trị từng bước ở dạng JSON thuần.
 */
export function evaluateFormula(expression: string, variables: Record<string, unknown> = {}, options: EvalOptions = {}): EvalResult {
  const ctx: Ctx = { formulas: options.formulas ?? {}, steps: 0, callDepth: 0 }
  let scope = new Scope(new Map(Object.entries(variables).map(([k, v]) => [k, fromPlain(v)])))
  const steps: Record<string, unknown> = {}
  for (const [name, expr] of Object.entries(options.let ?? {})) {
    let value: Val
    try {
      value = evaluate(parse(expr), scope, ctx)
    } catch (error) {
      throw new Error(`step ${name}: ${(error as Error).message}`)
    }
    steps[name] = toPlain(value)
    scope = scope.child(new Map([[name, value]]))
  }
  return { value: toPlain(evaluate(parse(expression), scope, ctx)), steps }
}

/** Giá trị số của biểu thức (dạng BigDecimal); lỗi nếu kết quả không phải số. */
export function evaluateNumber(expression: string, variables: Record<string, unknown> = {}, options: EvalOptions = {}): BigDecimal {
  const ctx: Ctx = { formulas: options.formulas ?? {}, steps: 0, callDepth: 0 }
  let scope = new Scope(new Map(Object.entries(variables).map(([k, v]) => [k, fromPlain(v)])))
  for (const [name, expr] of Object.entries(options.let ?? {})) scope = scope.child(new Map([[name, evaluate(parse(expr), scope, ctx)]]))
  const v = evaluate(parse(expression), scope, ctx)
  if (v instanceof Mode) throw new Error('expression must evaluate to a number, not a rounding mode')
  return asNum(v, 'result')
}

/**
 * Biến tự do mà biểu thức cần (không tính tham số hàm ẩn danh, tên bước `let`, cách làm tròn), theo thứ tự xuất hiện.
 */
export function freeVariables(expression: string, options: EvalOptions = {}): string[] {
  const names: string[] = []
  const bound = new Set<string>()
  const visit = (node: Node, local: Set<string>) => {
    switch (node.type) {
      case 'var':
        if (!local.has(node.name) && !bound.has(node.name) && !(ROUNDING_MODES as readonly string[]).includes(node.name) && !names.includes(node.name)) names.push(node.name)
        break
      case 'list': node.items.forEach((n) => visit(n, local)); break
      case 'record': node.fields.forEach(([, n]) => visit(n, local)); break
      case 'unary': visit(node.arg, local); break
      case 'binary': visit(node.left, local); visit(node.right, local); break
      case 'cond': visit(node.test, local); visit(node.then, local); visit(node.else, local); break
      case 'member': visit(node.object, local); break
      case 'index': visit(node.object, local); visit(node.index, local); break
      case 'call': node.args.forEach((n) => visit(n, local)); break
      case 'lambda': visit(node.body, new Set([...local, ...node.params])); break
    }
  }
  for (const [name, expr] of Object.entries(options.let ?? {})) {
    visit(parse(expr), new Set())
    bound.add(name)
  }
  visit(parse(expression), new Set())
  return names
}

/** Kiểm tra cú pháp và tên hàm, không cần giá trị biến. */
export function checkFormula(expression: string, options: EvalOptions = {}) {
  const formulas = options.formulas ?? {}
  const walk = (node: Node) => {
    switch (node.type) {
      case 'call':
        if (!Object.hasOwn(BUILTINS, node.name) && !Object.hasOwn(formulas, node.name)) {
          throw new Error(`unknown function ${node.name} at position ${node.pos}; available: ${[...Object.keys(BUILTINS), ...Object.keys(formulas)].join(', ')}`)
        }
        if (!Object.hasOwn(formulas, node.name)) {
          checkArity(node.name, node.args.length, node.pos)
          // Tham số cách làm tròn phải là tên cách làm tròn (hoặc biến), không phải số hay chuỗi.
          const modeAt = MODE_ARG[node.name]
          const arg = modeAt === undefined ? undefined : node.args[modeAt]
          if (arg && (arg.type === 'num' || arg.type === 'str' || arg.type === 'lit')) {
            throw new Error(`${node.name}: argument ${modeAt! + 1} expected a rounding mode (${ROUNDING_MODES.join(', ')})`)
          }
        }
        else if (formulas[node.name].params.length !== node.args.length) {
          throw new Error(`${node.name}(${formulas[node.name].params.join(', ')}) expects ${formulas[node.name].params.length} arguments, got ${node.args.length} (at position ${node.pos})`)
        }
        node.args.forEach(walk)
        break
      case 'list': node.items.forEach(walk); break
      case 'record': node.fields.forEach(([, n]) => walk(n)); break
      case 'unary': walk(node.arg); break
      case 'binary': walk(node.left); walk(node.right); break
      case 'cond': walk(node.test); walk(node.then); walk(node.else); break
      case 'member': walk(node.object); break
      case 'index': walk(node.object); walk(node.index); break
      case 'lambda': walk(node.body); break
    }
  }
  for (const [name, expr] of Object.entries(options.let ?? {})) {
    try {
      walk(parse(expr))
    } catch (error) {
      throw new Error(`step ${name}: ${(error as Error).message}`)
    }
  }
  walk(parse(expression))
}

/**
 * Kiểm tra một bộ công thức: cú pháp, tên hàm, tham số trùng, gọi vòng; và chạy `examples` nếu có.
 * Trả về danh sách lỗi (rỗng khi hợp lệ).
 */
export function checkFormulas(
  formulas: Record<string, UserFormula & { examples?: Array<{ args: Record<string, unknown>; result: unknown }> }>,
): string[] {
  const issues: string[] = []
  for (const [name, f] of Object.entries(formulas)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) issues.push(`formula ${name}: name must be an identifier`)
    if (Object.hasOwn(BUILTINS, name)) issues.push(`formula ${name}: conflicts with built-in function ${name}`)
    if (new Set(f.params).size !== f.params.length) issues.push(`formula ${name}: duplicate parameters`)
    try {
      checkFormula(f.expr, { let: f.let, formulas })
      const free = freeVariables(f.expr, { let: f.let }).filter((v) => !f.params.includes(v))
      if (free.length) issues.push(`formula ${name}: uses ${free.join(', ')}, which are not parameters; formulas only see their parameters`)
    } catch (error) {
      issues.push(`formula ${name}: ${(error as Error).message}`)
      continue
    }
    for (const [i, example] of (f.examples ?? []).entries()) {
      try {
        const args = f.params.map((p) => {
          if (!(p in example.args)) throw new Error(`missing argument ${p}`)
          return fromPlain(example.args[p])
        })
        const ctx: Ctx = { formulas, steps: 0, callDepth: 0 }
        const actual = callFormula(name, f, args, ctx)
        if (!equals(actual, fromPlain(example.result))) {
          issues.push(`formula ${name}: example ${i + 1} gives ${JSON.stringify(toPlain(actual))}, expected ${JSON.stringify(example.result)}`)
        }
      } catch (error) {
        issues.push(`formula ${name}: example ${i + 1}: ${(error as Error).message}`)
      }
    }
  }
  return issues
}

/** So sánh hai giá trị JSON theo ngữ nghĩa của biểu thức (số so theo giá trị). */
export function valuesEqual(a: unknown, b: unknown): boolean {
  return equals(fromPlain(a), fromPlain(b))
}
