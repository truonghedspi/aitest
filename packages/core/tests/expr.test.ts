/**
 * Kiểm thử ngôn ngữ biểu thức cho công thức nghiệp vụ phức tạp: dữ liệu nhiều dòng, hàm ẩn danh, bước trung gian,
 * công thức tự định nghĩa có ví dụ kiểm chứng, và các giới hạn an toàn.
 */
import { describe, expect, it } from 'vitest'
import { checkFormula, checkFormulas, evaluateFormula, freeVariables, readPath, type UserFormula } from '@aitest/core'

/** Giao dịch như đọc từ DB: số lượng là số, giá là chuỗi số (DECIMAL), có chiều mua bán. */
const trades = [
  { id: 1, symbol: 'VNM', side: 'BUY', qty: 100, price: '70000.5' },
  { id: 2, symbol: 'FPT', side: 'BUY', qty: 300, price: '120000' },
  { id: 3, symbol: 'VNM', side: 'SELL', qty: 40, price: '71000.25' },
  { id: 4, symbol: 'VNM', side: 'BUY', qty: 60, price: '69500' },
  { id: 5, symbol: 'FPT', side: 'SELL', qty: 100, price: '121000' },
]

/** Công thức nghiệp vụ mẫu: phí theo bậc giá trị giao dịch, thuế bán, tiền ròng. */
const formulas: Record<string, UserFormula & { examples?: Array<{ args: Record<string, unknown>; result: unknown }> }> = {
  notional: { params: ['t'], expr: 't.qty * t.price' },
  feeRate: {
    params: ['value'],
    desc: 'Phí theo bậc: dưới 100 triệu 0,15%; tới 500 triệu 0,12%; trên đó 0,1%',
    expr: 'value < 100000000 ? 0.0015 : value <= 500000000 ? 0.0012 : 0.001',
    examples: [{ args: { value: 50000000 }, result: '0.0015' }, { args: { value: 600000000 }, result: '0.001' }],
  },
  fee: {
    params: ['t'],
    let: { value: 'notional(t)' },
    expr: 'round(value * feeRate(value), 0, HALF_UP)',
    examples: [{ args: { t: { qty: 100, price: 10300 } }, result: '1545' }],
  },
  tax: { params: ['t'], expr: "t.side == 'SELL' ? round(notional(t) * 0.001, 0, HALF_UP) : 0" },
  net: { params: ['t'], expr: "t.side == 'BUY' ? -(notional(t) + fee(t)) : notional(t) - fee(t) - tax(t)" },
}

describe('expression language for business formulas', () => {
  it('aggregates rows with lambdas, exactly, using numeric strings from the database', () => {
    const r = evaluateFormula('sum(trades, t -> t.qty * t.price)', { trades })
    // 7000050.0 + 36000000 + 2840010.00 + 4170000 + 12100000
    expect(r.value).toBe('62110060.00')
    expect(evaluateFormula("count(trades, t -> t.side == 'BUY')", { trades }).value).toBe('3')
    expect(evaluateFormula("map(filter(trades, t -> t.symbol == 'VNM'), t -> t.id)", { trades }).value).toEqual(['1', '3', '4'])
    expect(evaluateFormula('max(trades, t -> t.price)', { trades }).value).toBe('121000')
    expect(evaluateFormula('sum([])').value).toBe('0')
    expect(evaluateFormula('sum(1.10, 2.205, 3)').value).toBe('6.305')
  })

  it('computes a weighted average price per symbol with grouping, sorting and explicit rounding', () => {
    const r = evaluateFormula(
      "map(sortBy(groupBy(filter(trades, t -> t.side == 'BUY'), t -> t.symbol), g -> g.key), g -> [g.key, div(sum(g.items, t -> t.qty * t.price), sum(g.items, t -> t.qty), 2, HALF_EVEN)])",
      { trades },
    )
    // VNM: (100 × 70000.5 + 60 × 69500) / 160 = 69812.8125 → 69812.81 (HALF_EVEN)
    expect(r.value).toEqual([['FPT', '120000.00'], ['VNM', '69812.81']])
  })

  it('records named steps and uses nested user formulas', () => {
    const r = evaluateFormula('gross - fees - taxes', { trades }, {
      formulas,
      let: {
        sells: "filter(trades, t -> t.side == 'SELL')",
        gross: 'sum(sells, t -> notional(t))',
        fees: 'sum(sells, t -> fee(t))',
        taxes: 'sum(sells, t -> tax(t))',
      },
    })
    // Bán VNM 40 × 71000.25 = 2840010.00, FPT 100 × 121000 = 12100000
    expect(r.steps).toMatchObject({ gross: '14940010.00', fees: '22410', taxes: '14940' })
    expect(r.value).toBe('14902660.00')
  })

  it('computes running totals and balances that a system shows row by row', () => {
    expect(evaluateFormula('cumsum(trades, t -> t.qty)', { trades }).value).toEqual(['100', '400', '440', '500', '600'])
    // Vị thế ròng sau từng giao dịch theo mã VNM: mua cộng, bán trừ.
    const position = evaluateFormula(
      "scan(filter(trades, t -> t.symbol == 'VNM'), 0, (pos, t) -> t.side == 'BUY' ? pos + t.qty : pos - t.qty)",
      { trades },
    )
    expect(position.value).toEqual(['100', '60', '120'])
    // Số dư tiền sau từng giao dịch, bắt đầu từ 100 triệu.
    const balance = evaluateFormula('scan(trades, 100000000, (cash, t) -> cash + net(t))', { trades }, { formulas })
    expect(balance.value).toHaveLength(5)
    // Mua 100 × 70000.5 = 7000050.0, phí round(10500.075) = 10500: 100000000 − 7010550.0
    expect((balance.value as string[])[0]).toBe('92989450.0')
  })

  it('supports conditions, nulls, records and lazy branches', () => {
    expect(evaluateFormula("if(len(xs) == 0, 0, sum(xs) / len(xs))", { xs: [] }).value).toBe('0')
    expect(evaluateFormula('x != null and x > 1 or not flag', { x: null, flag: true }).value).toBe(false)
    expect(evaluateFormula('coalesce(r.discount, 0) + r.amount', { r: { amount: '10.5' } }).value).toBe('10.5')
    expect(evaluateFormula('rows[-1].id', { rows: trades }).value).toBe('5')
    expect(evaluateFormula("find(rows, r -> r.id == 3).side", { rows: trades }).value).toBe('SELL')
    expect(evaluateFormula("distinct(rows, r -> r.symbol)", { rows: trades }).value).toHaveLength(2)
    expect(evaluateFormula("all(rows, r -> r.qty > 0) and any(rows, r -> r.price == 120000)", { rows: trades }).value).toBe(true)
    expect(evaluateFormula('reduce(rows, 0, (acc, r) -> max(acc, r.qty))', { rows: trades }).value).toBe('300')
    // Chú thích trong công thức nhiều dòng.
    expect(evaluateFormula('1 + # phí cố định\n 2').value).toBe('3')
  })

  it('reports errors with the failing step, function and position', () => {
    expect(() => evaluateFormula('total', { rows: trades }, { let: { total: 'sum(rows, r -> r.symbol)' } }))
      .toThrow(/step total: sum item 1: expected a number, got string VNM/)
    expect(() => evaluateFormula('a.b', { a: 1 })).toThrow(/cannot read field b of number at position 1/)
    expect(() => evaluateFormula('filter(rows, r -> r.qty)', { rows: trades })).toThrow(/filter: expected true\/false/)
    expect(() => evaluateFormula('div(1, 3, 2)')).toThrow(/expects 4 arguments/)
    expect(() => evaluateFormula('1 / 3')).toThrow(/has no exact decimal result; use div/)
  })

  it('lists free variables, excluding lambda parameters and steps', () => {
    expect(freeVariables('sum(rows, r -> r.qty * rate) + bonus', { let: { bonus: 'base * 2' } })).toEqual(['base', 'rows', 'rate'])
    expect(() => checkFormula('evil(1)')).toThrow(/unknown function evil/)
    expect(() => checkFormula('fee(1, 2)', { formulas })).toThrow(/fee\(t\) expects 1 arguments, got 2/)
    expect(() => checkFormula('fee(t)', { formulas })).not.toThrow()
  })

  it('checks formula libraries: examples, parameters, recursion, name conflicts', () => {
    expect(checkFormulas(formulas)).toEqual([])
    const broken = {
      ...formulas,
      feeRate: { ...formulas.feeRate, examples: [{ args: { value: 50000000 }, result: '0.002' }] },
      leak: { params: ['x'], expr: 'x + secret' },
      loop: { params: ['x'], expr: 'loop(x)', examples: [{ args: { x: 1 }, result: 1 }] },
      sum: { params: ['x'], expr: 'x' },
    }
    expect(checkFormulas(broken)).toEqual([
      'formula feeRate: example 1 gives "0.0015", expected "0.002"',
      'formula leak: uses secret, which are not parameters; formulas only see their parameters',
      expect.stringMatching(/^formula loop: example 1: .*nested deeper than 32/),
      'formula sum: conflicts with built-in function sum',
    ])
  })

  it('stays safe: no prototype access, bounded work', () => {
    expect(evaluateFormula('r.constructor', { r: {} }).value).toBe(null)
    expect(evaluateFormula('r.__proto__', { r: {} }).value).toBe(null)
    const xs = Array.from({ length: 3000 }, (_, i) => i)
    expect(() => evaluateFormula('sum(xs, a -> sum(xs, b -> a * b))', { xs })).toThrow(/more than 5000000 steps/)
  })

  it('reads whole columns with [*] paths', () => {
    const doc = { rows: [{ qty: 1, lines: [{ v: 1 }, { v: 2 }] }, { qty: 2, lines: [{ v: 3 }] }, { other: true }] }
    expect(readPath(doc, '$.rows[*].qty')).toEqual([1, 2, null])
    expect(readPath(doc, '$.rows[*].lines[*].v')).toEqual([1, 2, 3])
    expect(readPath(doc, '$.rows[-1].other')).toBe(true)
    expect(readPath(doc, '$.rows.constructor')).toBeUndefined()
  })
})
