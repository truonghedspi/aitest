/** Kiểm thử nguồn biến của công thức, đọc chuỗi JSON giữ chữ số, và `{{biến.trường}}` trong template. */
import { describe, expect, it } from 'vitest'
import { coerceJson, fillTemplate, formulaVariables, knownVarRoot, lookupVar, type TestPlan } from '@aitest/core'

describe('formula variables', () => {
  it('splits variables into run variables (vars, inputs, fixture saves) and evidence variables', () => {
    const plan = {
      vars: { limits: { max: 5 } }, inputs: [{ name: 'account' }],
      setup: [{ action: 'x', args: {}, save: { order_id: '$.id' } }], cases: [],
    } as unknown as TestPlan
    const testCase = { setup: [{ action: 'y', args: {}, save: { fee_rate: '$.rate' } }] } as unknown as TestPlan['cases'][0]
    const vars = formulaVariables(plan, testCase, { op: 'eq', expr: 'account.balance - limits.max + qty * fee_rate + order_id', let: { t: 'qty * 2' } })
    expect(vars).toEqual({
      fromRun: [{ name: 'account', source: 'input' }, { name: 'limits', source: 'vars' }, { name: 'fee_rate', source: 'fixture' }, { name: 'order_id', source: 'fixture' }],
      fromEvidence: ['qty'],
    })
  })

  it('reads JSON strings as objects without losing digits', () => {
    expect(coerceJson('{"balance": 12345678901234567.89, "n": 2}')).toEqual({ balance: '12345678901234567.89', n: 2 })
    expect(coerceJson('[1, 2]')).toEqual([1, 2])
    expect(coerceJson('FPT')).toBe('FPT')
    expect(coerceJson('{not json')).toBe('{not json')
  })

  it('fills {{var.field}} from object and JSON-string variables, preferring flat keys', () => {
    const vars = { 'order-service.url': 'http://x', account: '{"id": 7, "tags": ["a"]}', order: { id: 3, side: 'BUY' } }
    expect(lookupVar(vars, 'order-service.url')).toBe('http://x')
    expect(lookupVar(vars, 'account.id')).toBe(7)
    expect(lookupVar(vars, 'account.tags.0')).toBe('a')
    expect(lookupVar(vars, 'order.missing')).toBeUndefined()
    expect(fillTemplate({ url: '/orders/{{order.id}}', id: '{{account.id}}', keep: '{{nope.x}}' }, vars)).toEqual({ url: '/orders/3', id: 7, keep: '{{nope.x}}' })
    expect(knownVarRoot(new Set(['order']), 'order.id')).toBe(true)
    expect(knownVarRoot(new Set(['order']), 'orders.id')).toBe(false)
  })
})
