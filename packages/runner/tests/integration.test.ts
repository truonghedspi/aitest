/**
 * Kiểm thử năng lực test integration: fixture setup/teardown, webhook sink, wait_until.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { caseScope, root, promptVars, setupHarness, type Harness, type Script } from './support.ts'

const PORT = 4198
const BASE = `http://127.0.0.1:${PORT}`

const scripts: Record<string, Script> = {
  async 'IT-01'(call) {
    const hook = await call('webhook_create')
    const created = await call('http_request', {
      method: 'POST', url: `${BASE}/orders`,
      body: { symbol: 'MWG', side: 'BUY', qty: 300, price: 60000, callback_url: hook.result.url },
    })
    const callback = await call('webhook_wait', { id: hook.result.id, timeoutSec: 20 })
    const filled = await call('wait_until', {
      action: 'db_query',
      args: { sql: 'SELECT status FROM orders WHERE id = ?', params: [created.result.body.id] },
      path: '$.rows[0].status', op: 'eq', expected: 'FILLED', timeoutSec: 20, intervalMs: 300,
    })
    await call('assert_expectation', { expectId: 'http-201', evidenceId: created.evidenceId, path: '$.status' })
    await call('assert_expectation', { expectId: 'callback-event', evidenceId: callback.evidenceId, path: '$.requests[0].body.event' })
    await call('assert_expectation', { expectId: 'callback-qty', evidenceId: callback.evidenceId, path: '$.requests[0].body.filledQty' })
    await call('assert_expectation', { expectId: 'db-filled', evidenceId: filled.result.evidenceId, path: '$.rows[0].status' })
  },
  async 'IT-02'(call, prompt) {
    const id = promptVars(prompt).order_id
    // Bước trong prompt đã được thay biến từ fixture.
    expect(prompt).toContain(`/orders/${id}/cancel`)
    const first = await call('http_request', { method: 'POST', url: `${BASE}/orders/${id}/cancel` })
    const second = await call('http_request', { method: 'POST', url: `${BASE}/orders/${id}/cancel` })
    const row = await call('db_query', { sql: 'SELECT status FROM orders WHERE id = ?', params: [id] })
    await call('assert_expectation', { expectId: 'cancel-200', evidenceId: first.evidenceId, path: '$.status' })
    await call('assert_expectation', { expectId: 'cancel-again-409', evidenceId: second.evidenceId, path: '$.status' })
    await call('assert_expectation', { expectId: 'db-cancelled', evidenceId: row.evidenceId, path: '$.rows[0].status' })
  },
}

describe('integration capabilities (scripted agent)', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await setupHarness({ port: PORT, scripts, env: { EXEC_DELAY_MS: '800' } })
  })

  afterAll(() => harness?.dispose())

  it('runs async flow with webhook, wait_until and fixtures', async () => {
    const { ctx } = harness.kernel
    const report = await ctx.runner.run({ plan: join(root, 'examples/plans/order-integration.plan.yaml'), agent: 'scripted' })
    expect(Object.fromEntries(report.cases.map((c) => [c.id, [c.verdict, c.reasons]]))).toEqual({
      'IT-01': ['pass', []],
      'IT-02': ['pass', []],
    })

    // Callback chỉ gửi sau khi DB đã FILLED, nên wait_until đạt ngay ở lần gọi đầu.
    const it1 = report.cases.find((c) => c.id === 'IT-01')!
    expect(it1.actions.find((a) => a.name === 'wait_until')!.value).toMatchObject({ satisfied: true, attempts: 1 })

    // Fixture chạy qua pipeline action, được ghi log với đúng pha.
    const it2 = report.cases.find((c) => c.id === 'IT-02')!
    const phases = it2.actions.filter((a) => a.name === 'dbadmin_query').map((a) => a.phase)
    expect(phases).toEqual(['setup', 'setup', 'teardown'])

    // Teardown đã xoá lệnh tạo trong setup.
    const plan = await ctx.plans.load(join(root, 'examples/plans/order-integration.plan.yaml'))
    const left = await ctx.actions.invoke(caseScope(plan, 1, { phase: 'setup' }), 'dbadmin_query', {
      sql: "SELECT COUNT(*) AS n FROM orders WHERE symbol = 'MWG' AND side = 'SELL'",
    })
    expect(left.value).toMatchObject({ rows: [{ n: 0 }] })
  })

  it('reports setup failure as error without calling the agent', async () => {
    const { ctx } = harness.kernel
    const plan = await ctx.plans.load(join(root, 'examples/plans/order-integration.plan.yaml'))
    plan.cases = [{ ...plan.cases[1], setup: [{ action: 'dbadmin_query', args: { sql: 'SELECT * FROM missing_table' } }] }]
    const report = await ctx.runner.run({ plan, agent: 'scripted' })
    expect(report.cases[0].verdict).toBe('error')
    // Bước 1 là setup của plan, bước 2 là setup của case.
    expect(report.cases[0].reasons[0]).toMatch(/setup step 2 .* failed: no such table/)
    expect(report.cases[0].actions.some((a) => a.phase === 'agent')).toBe(false)
  })

  it('wait_until polls until an async state change is visible', async () => {
    const { ctx } = harness.kernel
    const plan = await ctx.plans.load(join(root, 'examples/plans/order-integration.plan.yaml'))
    const logged: Array<{ type: string; data: any }> = []
    const scope = caseScope(plan, 0, { log: (type, data) => { logged.push({ type, data }) } })
    const hook = await ctx.actions.invoke(scope, 'webhook_create', {})
    const created = await ctx.actions.invoke(scope, 'http_request', {
      method: 'POST', url: `${BASE}/orders`,
      body: { symbol: 'MWG', side: 'BUY', qty: 100, price: 60000, callback_url: (hook.value as any).url },
    })
    const id = (created.value as any).body.id
    const waited = await ctx.actions.invoke(scope, 'wait_until', {
      action: 'db_query', args: { sql: 'SELECT status FROM orders WHERE id = ?', params: [id] },
      path: '$.rows[0].status', op: 'eq', expected: 'FILLED', timeoutSec: 10, intervalMs: 200,
    })
    expect(waited.value).toMatchObject({ satisfied: true, actual: 'FILLED' })
    expect((waited.value as any).attempts).toBeGreaterThan(1)

    // Hết thời gian không phải lỗi: trả satisfied=false để verdict quyết định.
    const timedOut = await ctx.actions.invoke(scope, 'wait_until', {
      action: 'db_query', args: { sql: 'SELECT status FROM orders WHERE id = ?', params: [id] },
      path: '$.rows[0].status', op: 'eq', expected: 'NEVER', timeoutSec: 1, intervalMs: 200,
    })
    expect(timedOut.status).toBe('ok')
    expect(timedOut.value).toMatchObject({ satisfied: false, actual: 'FILLED' })
  })
})
