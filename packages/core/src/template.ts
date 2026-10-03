import { coerceJson } from './formula-vars.ts'
/** Placeholder `{{tên}}`; tên gồm chữ, số, `.`, `-` và tiền tố `$` của biến dựng sẵn. */
export const PLACEHOLDER = /\{\{\s*([$\w.-]+)\s*\}\}/g

/**
 * Thay `{{tên}}` trong mọi chuỗi của một giá trị.
 * Chuỗi chỉ gồm đúng một placeholder thì giữ nguyên kiểu của biến (số, object...).
 */
export function fillTemplate<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([$\w.-]+)\s*\}\}$/.exec(value)
    if (whole) {
      const v = lookupVar(vars, whole[1])
      if (v !== undefined) return v as T
    }
    return value.replace(PLACEHOLDER, (m, key) => {
      const v = lookupVar(vars, key)
      if (v === undefined) return m
      return typeof v === 'string' ? v : JSON.stringify(v)
    }) as T
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars)])) as T
  }
  return value
}

/**
 * Giá trị của `{{khoá}}`: khoá phẳng trước (`order-service.url`, `$run.id`); nếu không có thì đọc trường lồng của biến
 * dạng object, kể cả chuỗi JSON: `{{account_data.id}}`, `{{account_data.items.0.qty}}`. Không có thì `undefined`.
 */
export function lookupVar(vars: Record<string, unknown>, key: string): unknown {
  if (key in vars) return vars[key]
  const parts = key.split('.')
  for (let i = parts.length - 1; i >= 1; i--) {
    const root = parts.slice(0, i).join('.')
    if (!(root in vars)) continue
    let current: unknown = coerceJson(vars[root])
    for (const part of parts.slice(i)) {
      if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined
      current = (current as Record<string, unknown>)[part]
    }
    return current
  }
  return undefined
}

/** Tên gốc của `{{khoá}}` có trong tập biến đã biết (khoá phẳng hoặc gốc của trường lồng); dùng khi kiểm tra plan. */
export function knownVarRoot(known: ReadonlySet<string>, key: string): boolean {
  if (known.has(key)) return true
  const parts = key.split('.')
  for (let i = parts.length - 1; i >= 1; i--) if (known.has(parts.slice(0, i).join('.'))) return true
  return false
}
