/**
 * JSON Schema (từ OpenAPI) rút gọn thành một dòng dễ đọc cho agent, và kiểm tra giá trị theo schema.
 * Ví dụ: `{symbol*: string /^[A-Z]{3}$/, side*: BUY|SELL, qty*: integer ≥100 ×100, callback_url: string}`.
 */
export function compactSchema(schema: any, depth = 0): string {
  if (!schema || typeof schema !== 'object') return 'any'
  if (depth > 4) return '…'
  if (Array.isArray(schema.enum)) return schema.enum.map((v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))).join('|')
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) return schema[key].map((s: any) => compactSchema(s, depth + 1)).join(' | ')
  }
  if (Array.isArray(schema.allOf)) return compactSchema(Object.assign({}, ...schema.allOf), depth)
  const type = Array.isArray(schema.type) ? schema.type.join('|') : schema.type
  if (type === 'array' || schema.items) return `[${compactSchema(schema.items, depth + 1)}]`
  if (type === 'object' || schema.properties) {
    const required = new Set<string>(schema.required ?? [])
    const fields = Object.entries<any>(schema.properties ?? {}).map(([name, s]) => `${name}${required.has(name) ? '*' : ''}: ${compactSchema(s, depth + 1)}`)
    return fields.length ? `{${fields.join(', ')}}` : 'object'
  }
  const notes: string[] = []
  if (schema.format) notes.push(schema.format)
  if (schema.pattern) notes.push(`/${schema.pattern}/`)
  if (schema.minimum !== undefined) notes.push(`≥${schema.minimum}`)
  if (schema.maximum !== undefined) notes.push(`≤${schema.maximum}`)
  if (schema.multipleOf !== undefined) notes.push(`×${schema.multipleOf}`)
  if (schema.minLength !== undefined || schema.maxLength !== undefined) notes.push(`len ${schema.minLength ?? 0}..${schema.maxLength ?? '∞'}`)
  if (schema.nullable) notes.push('nullable')
  return [type ?? 'any', ...notes].join(' ')
}

/** Một vi phạm khi đối chiếu giá trị với schema. */
export interface SchemaIssue {
  level: 'error' | 'warning'
  path: string
  message: string
}

const TEMPLATE = /\{\{[^}]+\}\}/

/**
 * Đối chiếu giá trị trong plan với schema: trường bắt buộc, trường lạ, enum, kiểu, ràng buộc số.
 * Mọi vi phạm body là cảnh báo, vì case kiểm tra API từ chối dữ liệu sai cố ý gửi body vi phạm.
 * Giá trị chứa biến `{{…}}` chỉ được kiểm sự có mặt, không kiểm kiểu (giá trị có lúc chạy).
 */
export function checkValue(schema: any, value: unknown, path = 'body'): SchemaIssue[] {
  if (!schema || typeof schema !== 'object' || value === undefined) return []
  if (typeof value === 'string' && TEMPLATE.test(value)) return []
  const issues: SchemaIssue[] = []
  if (Array.isArray(schema.allOf)) return checkValue(Object.assign({}, ...schema.allOf), value, path)
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) return []
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e: unknown) => e === value)) issues.push({ level: 'warning', path, message: `${path} must be one of ${schema.enum.join(', ')}; got ${JSON.stringify(value)} (fine if the case tests invalid input)` })
    return issues
  }
  const type = schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined)
  if (value === null) {
    if (!schema.nullable && type !== 'null') issues.push({ level: 'warning', path, message: `${path} is null but the schema does not allow null` })
    return issues
  }
  if (type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const name of schema.required ?? []) {
      if (!(name in record)) issues.push({ level: 'warning', path: `${path}.${name}`, message: `${path}.${name} is required (fine if the case tests invalid input)` })
    }
    const props = schema.properties ?? {}
    for (const [name, v] of Object.entries(record)) {
      if (!(name in props)) {
        if (schema.additionalProperties === false || Object.keys(props).length) issues.push({ level: 'warning', path: `${path}.${name}`, message: `${path}.${name} is not in the API schema; fields: ${Object.keys(props).join(', ')}` })
        continue
      }
      issues.push(...checkValue(props[name], v, `${path}.${name}`))
    }
    return issues
  }
  if (type === 'array' && Array.isArray(value)) {
    value.slice(0, 50).forEach((v, i) => issues.push(...checkValue(schema.items, v, `${path}[${i}]`)))
    return issues
  }
  const actual = Array.isArray(value) ? 'array' : typeof value
  const expected = type === 'integer' ? 'number' : type
  // Giá trị sai kiểu có thể là chủ đích của case kiểm tra lỗi; chỉ cảnh báo.
  if (expected && expected !== actual) {
    issues.push({ level: 'warning', path, message: `${path} should be ${type}, got ${actual} ${JSON.stringify(value)} (fine if the case tests invalid input)` })
    return issues
  }
  if (typeof value === 'number') {
    if (type === 'integer' && !Number.isInteger(value)) issues.push({ level: 'warning', path, message: `${path} should be an integer, got ${value}` })
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ level: 'warning', path, message: `${path} = ${value} is below minimum ${schema.minimum} (fine if the case tests invalid input)` })
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ level: 'warning', path, message: `${path} = ${value} is above maximum ${schema.maximum} (fine if the case tests invalid input)` })
    if (schema.multipleOf !== undefined && value % schema.multipleOf !== 0) issues.push({ level: 'warning', path, message: `${path} = ${value} is not a multiple of ${schema.multipleOf} (fine if the case tests invalid input)` })
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    issues.push({ level: 'warning', path, message: `${path} = ${JSON.stringify(value)} does not match /${schema.pattern}/ (fine if the case tests invalid input)` })
  }
  return issues
}

/** Giá trị mẫu hợp lệ theo schema, cho khung plan: dùng example, default, enum, giới hạn số; chuỗi theo tên trường. */
export function sampleValue(schema: any, name = 'value', depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 4) return null
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum)) return schema.enum[0]
  if (Array.isArray(schema.allOf)) return sampleValue(Object.assign({}, ...schema.allOf), name, depth)
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) return sampleValue((schema.oneOf ?? schema.anyOf)[0], name, depth)
  const type = schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : 'string')
  if (type === 'object') {
    const required = new Set<string>(schema.required ?? [])
    return Object.fromEntries(Object.entries<any>(schema.properties ?? {})
      .filter(([k]) => required.size === 0 || required.has(k))
      .map(([k, s]) => [k, sampleValue(s, k, depth + 1)]))
  }
  if (type === 'array') return [sampleValue(schema.items, name, depth + 1)]
  if (type === 'integer' || type === 'number') {
    const step = schema.multipleOf ?? 1
    const min = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? Number(schema.exclusiveMinimum) + 1 : 1)
    return Math.ceil(min / step) * step
  }
  if (type === 'boolean') return true
  if (schema.format === 'date-time') return '2026-01-01T00:00:00Z'
  if (schema.format === 'date') return '2026-01-01'
  if (schema.format === 'email') return 'qa@example.com'
  if (schema.format === 'uri' || /url/i.test(name)) return 'https://example.com/hook'
  return `TODO_${name}`
}
