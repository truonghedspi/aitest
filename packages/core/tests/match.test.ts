import { describe, expect, it } from 'vitest'
import { compare, readPath } from '../src/match.ts'

describe('readPath', () => {
  const doc = { status: 201, body: { items: [{ id: 7 }], 'x-key': 'v' } }

  it('reads nested properties and indexes', () => {
    expect(readPath(doc, '$.status')).toBe(201)
    expect(readPath(doc, '$.body.items[0].id')).toBe(7)
    expect(readPath(doc, '$.body["x-key"]')).toBe('v')
    expect(readPath(doc, '$')).toBe(doc)
  })

  it('returns undefined for missing path', () => {
    expect(readPath(doc, '$.body.items[3].id')).toBeUndefined()
  })

  it('rejects malformed path', () => {
    expect(() => readPath(doc, '$.body..x')).toThrow(/invalid path/)
  })
})

describe('compare', () => {
  it('treats numeric strings as equal to numbers', () => {
    expect(compare('eq', '100', 100).passed).toBe(true)
    expect(compare('eq', 'NEW', 'NEW').passed).toBe(true)
    expect(compare('eq', { a: 1 }, { a: 1 }).passed).toBe(true)
    expect(compare('eq', 201, 400).passed).toBe(false)
  })

  it('supports ordering, contains, matches and existence', () => {
    expect(compare('gte', 5, 5).passed).toBe(true)
    expect(compare('lt', 'abc', 5).passed).toBe(false)
    expect(compare('contains', ['A', 'B'], 'B').passed).toBe(true)
    expect(compare('matches', '2026-10-01', '^\\d{4}-').passed).toBe(true)
    expect(compare('exists', null, undefined).passed).toBe(true)
    expect(compare('not_exists', undefined, undefined).passed).toBe(true)
  })
})

describe('normalizePath', () => {
  it('accepts paths prefixed with $.result', () => {
    const doc = { status: 201, rows: [{ qty: 100 }] }
    expect(readPath(doc, '$.result.status')).toBe(201)
    expect(readPath(doc, '$.result.rows[0].qty')).toBe(100)
    expect(readPath(doc, '$.result')).toBe(doc)
    expect(readPath({ resultCode: 1 }, '$.resultCode')).toBe(1)
  })
})

describe('readPath on evidence that has its own result field', () => {
  it('prefers the literal path', () => {
    expect(readPath({ result: { code: 7 } }, '$.result.code')).toBe(7)
  })
})
