/** Placeholder `{{tên}}`; tên gồm chữ, số, `.`, `-` và tiền tố `$` của biến dựng sẵn. */
export const PLACEHOLDER = /\{\{\s*([$\w.-]+)\s*\}\}/g

/**
 * Thay `{{tên}}` trong mọi chuỗi của một giá trị.
 * Chuỗi chỉ gồm đúng một placeholder thì giữ nguyên kiểu của biến (số, object...).
 */
export function fillTemplate<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([$\w.-]+)\s*\}\}$/.exec(value)
    if (whole && whole[1] in vars) return vars[whole[1]] as T
    return value.replace(PLACEHOLDER, (m, key) => {
      if (!(key in vars)) return m
      const v = vars[key]
      return typeof v === 'string' ? v : JSON.stringify(v)
    }) as T
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars)])) as T
  }
  return value
}

