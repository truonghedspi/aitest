import { describe, expect, it } from 'vitest'
import { calculate, checkExpression, roundDecimal, toBigDecimal, variablesOf } from '../src/calc.ts'
import { compare } from '../src/match.ts'

describe('calculate (BigDecimal)', () => {
  it('is exact and keeps the full decimal part', () => {
    expect(calculate('0.1 + 0.2').text).toBe('0.3')
    expect(calculate('1.50 * 1.0')).toMatchObject({ text: '1.500', normalized: '1.5', scale: 3 })
    expect(calculate('100 * 10300 / 1000 * 0.0015').text).toBe('1.5450')
    // Số vượt độ chính xác của kiểu number vẫn chính xác.
    expect(calculate('a * b', { a: '123456789012345678901234567890.123456789', b: '987654321.000000001' }).text)
      .toBe('121932631124828532235939642223593964222.347203159123456789')
    expect(calculate('1 / 8').text).toBe('0.125')
  })

  it('refuses non-terminating division and asks for an explicit rounding', () => {
    expect(() => calculate('1 / 3')).toThrow(/no exact decimal result; use div\(a, b, scale, MODE\)/)
    expect(() => calculate('avg(1, 2, 2)')).toThrow(/avg: 5 \/ 3 has no exact decimal result/)
    expect(calculate('div(1, 3, 5, HALF_UP)').text).toBe('0.33333')
    expect(calculate('div(2, 3, 2, DOWN)').text).toBe('0.66')
    expect(calculate('avg(1, 2, 3, 4)').text).toBe('2.5')
  })

  it('rounds only with an explicit mode, per test', () => {
    expect(calculate('round(1.545, 2, HALF_UP)').text).toBe('1.55')
    expect(calculate('round(1.545, 2, HALF_EVEN)').text).toBe('1.54')
    expect(calculate('round(1.545, 2, HALF_DOWN)').text).toBe('1.54')
    expect(calculate('round(1.541, 2, UP)').text).toBe('1.55')
    expect(calculate('round(-1.545, 2, FLOOR)').text).toBe('-1.55')
    expect(calculate('round(-1.545, 2, CEILING)').text).toBe('-1.54')
    expect(calculate('round(12345, -2, HALF_UP)').text).toBe('12300')
    expect(calculate('round(1.5, 2, UNNECESSARY)').text).toBe('1.50')
    expect(() => calculate('round(1.545, 2, UNNECESSARY)')).toThrow()
    expect(calculate('roundStep(26775, 50, HALF_UP)').text).toBe('26800')
    expect(calculate('roundStep(70000 * 1.07, 100, FLOOR)').text).toBe('74900')
    expect(calculate('roundSig(123.456, 4, HALF_UP)').text).toBe('123.5')
    expect(calculate('floor(2.7)').text).toBe('2')
    expect(calculate('ceil(2.123, 2)').text).toBe('2.13')
    expect(calculate('trunc(-2.79, 1)').text).toBe('-2.7')
    expect(calculate('sqrt(2, 10, HALF_UP)').text).toBe('1.4142135624')
    expect(calculate('pct(70000, 7)')).toMatchObject({ text: '4900.00', normalized: '4900' })
    expect(() => calculate('round(1.5, 0)')).toThrow(/expects 3 arguments/)
    expect(() => calculate('round(1.5, 0, 2)')).toThrow(/argument 3 must be a rounding mode/)
    expect(() => calculate('round(1.5, 0.5, HALF_UP)')).toThrow(/expected an integer/)
  })

  it('rounds single values with roundDecimal', () => {
    expect(roundDecimal(1.545, { mode: 'HALF_EVEN', scale: 2 }).text).toBe('1.54')
    expect(roundDecimal('26775', { mode: 'HALF_UP', step: 50 }).text).toBe('26800')
    expect(roundDecimal(123.456, { mode: 'DOWN', significant: 2 }).text).toBe('120')
    expect(() => roundDecimal(1, { mode: 'HALF_UP', scale: 1, step: 5 })).toThrow(/exactly one/)
    expect(() => roundDecimal(1, { mode: 'NEAREST' as never, scale: 1 })).toThrow(/unknown rounding mode/)
  })

  it('follows operator precedence and binds variables', () => {
    expect(calculate('2 + 3 * 4').text).toBe('14')
    expect(calculate('2 ^ 3 ^ 2').text).toBe('512')
    expect(calculate('-2 ^ 2').text).toBe('-4')
    expect(calculate('2 ^ -3').text).toBe('0.125')
    expect(calculate('10.5 % 3').text).toBe('1.5')
    expect(calculate('qty * price', { qty: 100, price: '70000' }).text).toBe('7000000')
    expect(variablesOf('round(qty * price, 2, HALF_UP) + fee')).toEqual(['qty', 'price', 'fee'])
  })

  it('rejects unsafe or invalid input', () => {
    // Không có lời gọi phương thức: `process.exit()` là lỗi cú pháp, `process` chỉ là một biến chưa có giá trị.
    expect(() => calculate('process.exit()')).toThrow(/unexpected "\(" at position 12/)
    expect(() => calculate('process')).toThrow(/variable process has no value/)
    expect(() => calculate('constructor(1)')).toThrow(/unknown function constructor/)
    expect(() => calculate('toString()')).toThrow(/unknown function toString/)
    expect(() => calculate('__proto__ + 1')).toThrow(/variable __proto__ has no value/)
    expect(() => calculate('HALF_UP + 1')).toThrow(/only allowed as a function argument/)
    expect(() => calculate('1 / 0')).toThrow(/division by zero/)
    // Biến được là chuỗi (trường chữ của bản ghi); chỉ lỗi khi dùng chuỗi không phải số để tính.
    expect(() => calculate('a', { a: 'abc' })).toThrow(/expected a number, got string abc/)
    expect(() => calculate('a + 1', { a: 'abc' })).toThrow(/\+ at position 2: expected a number, got string abc/)
    expect(() => checkExpression('round(x, 2, HALF_UP)')).not.toThrow()
    expect(() => checkExpression('round(x, 2, 3)')).toThrow(/expected a rounding mode/)
    expect(() => checkExpression('foo(1)')).toThrow(/unknown function foo/)
    expect(() => calculate('1'.repeat(30000))).toThrow(/longer than/)
  })
})

describe('numeric comparison', () => {
  it('compares numbers as BigDecimal, without floating point', () => {
    expect(compare('eq', 1.5, '1.50').passed).toBe(true)
    expect(compare('eq', '0.30000000000000004', '0.3').passed).toBe(false)
    expect(compare('eq', 0.1 + 0.2, '0.3').passed).toBe(false)
    expect(compare('gt', '12345678901234567890.01', '12345678901234567890').passed).toBe(true)
    expect(compare('eq', 'NEW', 'NEW').passed).toBe(true)
    expect(toBigDecimal(1e21)?.toPlainString()).toBe('1000000000000000000000')
  })
})
