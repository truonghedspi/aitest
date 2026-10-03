/**
 * Kiểm thử expectation dạng công thức phức tạp với Order API thật: công thức của service (formulas.yml),
 * biến dạng danh sách từ DB, bước `let`, so sánh danh sách theo từng phần tử.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promptVars, root, setupHarness, type Call, type Harness, type Script } from './support.ts'

const PORT = 4181
const BASE = `http://127.0.0.1:${PORT}`

const ordersOf = (call: Call, symbol: string) =>
  call('db_query', { sql: 'SELECT id, side, qty, price, status FROM orders WHERE symbol = ? ORDER BY id', params: [symbol] })

const prompts: Record<string, string> = {}

const scripts: Record<string, Script> = {
  async 'FML-01'(call, prompt) {
    prompts['FML-01'] = prompt
    const symbol = promptVars(prompt).symbol
    const summary = await call('http_request', { method: 'GET', url: `${BASE}/orders/summary?symbol=${symbol}` })
    const rows = await ordersOf(call, symbol)
    const orders = { evidenceId: rows.evidenceId, path: '$.rows' }
    for (const [expectId, field] of [['order-count', 'orders'], ['total-fee', 'totalFee'], ['net-cash', 'netCash']]) {
      await call('assert_expectation', { expectId, evidenceId: summary.evidenceId, path: `$.body.${field}`, inputs: { orders } })
    }
  },
  async 'FML-02'(call, prompt) {
    const symbol = promptVars(prompt).symbol
    const positions = await call('http_request', { method: 'GET', url: `${BASE}/orders/positions?symbol=${symbol}` })
    const rows = await ordersOf(call, symbol)
    const inputs = { orders: { evidenceId: rows.evidenceId, path: '$.rows' } }
    // Lần đầu trỏ nhầm cột: báo phần tử lệch đầu tiên; lần sau trỏ đúng cột position.
    const wrong = await call('assert_expectation', { expectId: 'positions', evidenceId: positions.evidenceId, path: '$.body[*].qty', inputs })
    expect(wrong.result).toMatchObject({ passed: false, message: expect.stringMatching(/^item 1: expected "200", got 100/) })
    await call('assert_expectation', { expectId: 'positions', evidenceId: positions.evidenceId, path: '$.body[*].position', inputs })
  },
}

describe('formula expectations on real data', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await setupHarness({ port: PORT, scripts })
  }, 60_000)

  afterAll(() => harness?.dispose())

  it('checks aggregated and running values against service formulas, with named steps in the report', async () => {
    const report = await harness.kernel.ctx.runner.run({ plan: join(root, 'examples/plans/order-formulas.plan.yaml'), agent: 'scripted' })
    expect(report.cases.map((c) => [c.id, c.verdict, c.reasons])).toEqual([['FML-01', 'pass', []], ['FML-02', 'pass', []]])

    const fml1 = report.cases[0].expectations
    // Sau FML-01 (setup chạy một lần): mua 300×25000 + 200×25000, bán 100×26000 + 150×24000; lệnh mua 500 đã huỷ.
    expect(fml1.find((e) => e.id === 'order-count')!.assertion).toMatchObject({ expected: '4', actual: 4 })
    expect(fml1.find((e) => e.id === 'total-fee')!.assertion).toMatchObject({ expected: '28.05', actual: 28.05 })
    const net = fml1.find((e) => e.id === 'net-cash')!.assertion!
    expect(net.steps).toMatchObject({ gross: '-6300000', fees: '28050.00' })
    expect(net).toMatchObject({ expected: '-6328050.00', actual: -6328050 })
    expect(net.inputs!.orders.value).toHaveLength(5)

    // FML-02 chạy sau setup lần hai: 8 lệnh còn hiệu lực, vị thế cộng dồn của cả hai lần đặt.
    const positions = report.cases[1].expectations[0]
    expect(positions.attempts).toHaveLength(2)
    expect(positions.assertion!.expected).toEqual(['300', '200', '400', '250', '550', '450', '650', '500'])

    // Prompt nêu công thức, các bước và biến cần gắn; đầu vào `symbol` nền tảng tự gắn.
    expect(prompts['FML-01']).toContain('công thức `gross - fees` (các bước: `s`, `gross`, `fees`); bạn gắn `inputs` cho: `orders`')
    expect(prompts['FML-01']).toContain('`summary(orders)`')
  })

  it('validates formula examples and function names when authoring', async () => {
    const plan = (extra: string) => `id: TP-F\nname: F\nrequires: [http]\nsystems: [order-service]\n${extra}cases:\n  - id: C\n    title: t\n    steps: [a]\n    expect:\n      - { id: e, desc: d, check: { op: eq, expr: "total(rows)" } }\n`
    const bad = await harness.kernel.ctx.authoring.validate(plan('formulas:\n  total:\n    params: [rows]\n    expr: sum(rows, r -> fee(r))\n    examples:\n      - { args: { rows: [{ qty: 100, price: 70000 }] }, result: "10.51" }\n'))
    expect(bad.issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual([
      'formula total: example 1 gives "10.50", expected "10.51"',
    ])
    const unknown = await harness.kernel.ctx.authoring.validate(plan(''))
    expect(unknown.issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual([expect.stringContaining('unknown function total')])
  })
})
