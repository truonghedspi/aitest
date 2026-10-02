/**
 * Kiểm thử tính toán chính xác: tool `calc` và expectation có tiêu chí là công thức (`check.expr`).
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '@aitest/authoring'
import type {} from '@aitest/runner'
import { caseScope, root, setupHarness, type Harness, type Script } from '../../runner/tests/support.ts'

const PORT = 4192
const BASE = `http://127.0.0.1:${PORT}`
const prompts: string[] = []

/** Agent kịch bản: đặt lệnh, đọc DB, rồi assert phí bằng công thức với biến trỏ vào evidence của DB. */
const feeScript = (price: number): Script => async (call, prompt) => {
  prompts.push(prompt)
  const created = await call('http_request', { method: 'POST', url: `${BASE}/orders`, body: { symbol: 'REE', side: 'BUY', qty: 100, price } })
  const row = await call('db_query', { sql: 'SELECT qty, price FROM orders WHERE id = ?', params: [created.result.body.id] })
  await call('assert_expectation', { expectId: 'http-201', evidenceId: created.evidenceId, path: '$.status' })
  await call('assert_expectation', {
    expectId: 'fee-correct', evidenceId: created.evidenceId, path: '$.body.fee',
    inputs: { qty: { evidenceId: row.evidenceId, path: '$.rows[0].qty' }, price: { evidenceId: row.evidenceId, path: '$.rows[0].price' } },
  })
}

describe('exact calculation', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await setupHarness({ port: PORT, scripts: { 'FEE-01': feeScript(70000), 'FEE-02': feeScript(10300) } })
  })

  afterAll(() => harness?.dispose())

  it('calc computes exactly and reads variables from evidence', async () => {
    const { ctx } = harness.kernel
    const plan = await ctx.plans.load(join(root, 'examples/plans/order-fee.plan.yaml'))
    const scope = caseScope(plan)
    const plain = await ctx.actions.invoke(scope, 'calc', { expression: '0.1 + 0.2' })
    expect(plain.value).toMatchObject({ result: '0.3', value: 0.3 })
    // Kết quả của calc cũng là evidence, dùng được cho bước sau.
    expect(plain.annotations.evidenceId).toMatch(/^ev\d+$/)

    const created = await ctx.actions.invoke(scope, 'http_request', {
      method: 'POST', url: `${BASE}/orders`, body: { symbol: 'REE', side: 'BUY', qty: 100, price: 10300 },
    })
    const fee = await ctx.actions.invoke(scope, 'calc', {
      expression: 'round(qty * price / 1000 * 0.0015, 2, HALF_UP)',
      variables: { qty: 100, price: { evidenceId: created.annotations.evidenceId as string, path: '$.body.price' } },
    })
    expect(fee.value).toMatchObject({ result: '1.55', inputs: { qty: 100, price: 10300 }, sources: { price: { path: '$.body.price' } } })

    const missing = await ctx.actions.invoke(scope, 'calc', { expression: 'qty * 2' })
    expect(missing.error).toMatch(/variable qty has no value/)
    const badRef = await ctx.actions.invoke(scope, 'calc', { expression: 'x', variables: { x: { evidenceId: 'ev999', path: '$' } } })
    expect(badRef.error).toMatch(/unknown evidenceId ev999/)
  })

  it('is available to the authoring agent without declaring a namespace', async () => {
    const session = await harness.kernel.ctx.authoring.createSession()
    try {
      const outcome = await harness.kernel.ctx.actions.invoke(session.scope, 'calc', { expression: 'roundStep(70000 * 1.07, 100, FLOOR)' })
      expect(outcome.value).toMatchObject({ result: '74900' })
    } finally {
      await session.close()
    }
  })

  it('formula expectations compute the expected value from real evidence and catch a float rounding bug', async () => {
    const report = await harness.kernel.ctx.runner.run({ plan: join(root, 'examples/plans/order-fee.plan.yaml'), agent: 'scripted' })
    expect(Object.fromEntries(report.cases.map((c) => [c.id, c.verdict]))).toEqual({ 'FEE-01': 'pass', 'FEE-02': 'fail' })

    const fee = report.cases.find((c) => c.id === 'FEE-02')!.expectations.find((e) => e.id === 'fee-correct')!.assertion!
    expect(fee).toMatchObject({
      expr: 'round(qty * price / 1000 * 0.0015, 2, HALF_UP)', expected: '1.55', actual: 1.54, passed: false,
      inputs: { qty: { value: 100 }, price: { value: 10300 } },
    })
    // Agent được báo công thức và các biến cần gắn, không được giao tự tính.
    expect(prompts[0]).toContain('công thức `round(qty * price / 1000 * 0.0015, 2, HALF_UP)`')
    expect(prompts[0]).toContain('`qty`, `price`')
  })

  it('rejects a formula assertion without inputs for every variable', async () => {
    const { ctx } = harness.kernel
    const plan = await ctx.plans.load(join(root, 'examples/plans/order-fee.plan.yaml'))
    const scope = caseScope(plan)
    const ev = await ctx.actions.invoke(scope, 'calc', { expression: '1' })
    const outcome = await ctx.actions.invoke(scope, 'assert_expectation', {
      expectId: 'fee-correct', evidenceId: ev.annotations.evidenceId, path: '$.value',
      inputs: { qty: { evidenceId: ev.annotations.evidenceId, path: '$.value' } },
    })
    expect(outcome.error).toMatch(/provide inputs for: price/)
  })

  it('validates formula checks in plans', () => {
    const plans = harness.kernel.ctx.plans
    const plan = (check: string) => `id: X\nname: Y\ncases:\n  - id: C\n    title: t\n    steps: [a]\n    expect:\n      - { id: e, desc: d, check: ${check} }\n`
    expect(() => plans.parse(plan('{ op: eq, expr: "1 +" }'), 'x.plan.yaml')).toThrow(/unexpected end of expression/)
    expect(() => plans.parse(plan('{ op: eq, expr: "a", value: 1 }'), 'x.plan.yaml')).toThrow(/either value or expr/)
    expect(() => plans.parse(plan('{ op: contains, expr: "a" }'), 'x.plan.yaml')).toThrow(/numeric op/)
    expect(() => plans.parse(plan('{ op: eq, expr: "evil(a)" }'), 'x.plan.yaml')).toThrow(/unknown function evil/)
    expect(plans.parse(plan('{ op: gte, expr: "pct(a, 7)" }'), 'x.plan.yaml').cases[0].expect[0].check).toEqual({ op: 'gte', expr: 'pct(a, 7)', value: undefined })
  })
})
