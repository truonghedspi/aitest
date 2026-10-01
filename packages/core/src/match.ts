import { isDeepStrictEqual } from 'node:util'
import type { AssertOp } from './types.ts'

/**
 * Đọc giá trị theo path dạng JSONPath rút gọn: `$.body.items[0].id`, `$["x-header"]`.
 * Trả về `undefined` khi path không tồn tại.
 */
export function readPath(root: unknown, path: string): unknown {
  const value = walk(root, tokenize(path))
  if (value !== undefined) return value
  const normalized = normalizePath(path)
  return normalized === path.trim() ? undefined : walk(root, tokenize(normalized))
}

function walk(root: unknown, tokens: Array<string | number>): unknown {
  let current: any = root
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined
    current = current[token]
  }
  return current
}

/**
 * Agent nhìn thấy kết quả tool dạng `{ evidenceId, outcome, result }`, nên hay viết path bắt đầu bằng `$.result`.
 * Evidence lưu chính giá trị `result`. Khi path gốc không đọc được giá trị, `readPath` thử lại sau khi bỏ tiền tố này.
 * Nhờ đó, evidence thật sự có trường `result` (ví dụ từ MCP server ngoài) vẫn đọc đúng.
 */
export function normalizePath(path: string) {
  return path.trim().replace(/^\$?\.result(?=$|[.[])/, '$')
}

function tokenize(path: string): Array<string | number> {
  const source = path.trim().replace(/^\$/, '')
  const tokens: Array<string | number> = []
  const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[(['"])(.*?)\3\]/gy
  let match: RegExpExecArray | null
  let consumed = 0
  while ((match = re.exec(source))) {
    consumed = re.lastIndex
    if (match[1] !== undefined) tokens.push(match[1])
    else if (match[2] !== undefined) tokens.push(Number(match[2]))
    else tokens.push(match[4])
  }
  if (consumed !== source.length) throw new Error(`invalid path: ${path}`)
  return tokens
}

export interface CompareResult {
  passed: boolean
  message: string
}

/** So sánh xác định giữa giá trị thực tế và giá trị mong đợi. */
export function compare(op: AssertOp, actual: unknown, expected: unknown): CompareResult {
  const show = (v: unknown) => JSON.stringify(v)
  switch (op) {
    case 'exists':
      return result(actual !== undefined, `expected value to exist, got ${show(actual)}`)
    case 'not_exists':
      return result(actual === undefined, `expected value to be absent, got ${show(actual)}`)
    case 'eq':
      return result(looseEqual(actual, expected), `expected ${show(actual)} to equal ${show(expected)}`)
    case 'ne':
      return result(!looseEqual(actual, expected), `expected ${show(actual)} to differ from ${show(expected)}`)
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = Number(actual)
      const b = Number(expected)
      if (Number.isNaN(a) || Number.isNaN(b)) return result(false, `cannot compare ${show(actual)} ${op} ${show(expected)} as numbers`)
      const ok = op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b
      return result(ok, `expected ${a} ${op} ${b}`)
    }
    case 'contains': {
      if (typeof actual === 'string') return result(actual.includes(String(expected)), `expected ${show(actual)} to contain ${show(expected)}`)
      if (Array.isArray(actual)) return result(actual.some((item) => looseEqual(item, expected)), `expected array to contain ${show(expected)}`)
      return result(false, `contains requires string or array, got ${show(actual)}`)
    }
    case 'matches':
      return result(typeof actual === 'string' && new RegExp(String(expected)).test(actual), `expected ${show(actual)} to match /${expected}/`)
  }
}

function result(passed: boolean, failure: string): CompareResult {
  return { passed, message: passed ? 'ok' : failure }
}

/**
 * Bằng nhau theo cấu trúc, nới lỏng một điểm: số so với chuỗi số được coi là bằng nhau.
 * Lý do: nhiều driver DB trả cột số dưới dạng chuỗi.
 */
function looseEqual(actual: unknown, expected: unknown): boolean {
  if (isDeepStrictEqual(actual, expected)) return true
  if (typeof expected === 'number' && typeof actual === 'string' && actual.trim() !== '') return Number(actual) === expected
  if (typeof actual === 'number' && typeof expected === 'string' && expected.trim() !== '') return Number(expected) === actual
  return false
}
