/**
 * Kiểm thử luồng API cơ bản với agent kịch bản:
 * kernel → runner → gateway → actions → guard → verdict → run log → reporter.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deriveReport, type Kernel } from '@aitest/core'
import { caseScope, root, setupHarness, type Harness, type Script } from './support.ts'

const PORT = 4199
const BASE = `http://127.0.0.1:${PORT}`

/** Kịch bản cho từng case, mô phỏng cách một agent thật sẽ hành động. */
const scripts: Record<string, Script> = {
  async 'TC-01'(call) {
    const created = await call('http_request', { method: 'POST', url: `${BASE}/orders`, body: { symbol: 'VNM', side: 'BUY', qty: 100, price: 70000 } })
    const row = await call('db_query', { sql: 'SELECT * FROM orders WHERE id = ?', params: [created.result.body.id] })
    await call('assert_expectation', { expectId: 'http-201', evidenceId: created.evidenceId, path: '$.status' })
    await call('assert_expectation', { expectId: 'db-status', evidenceId: row.evidenceId, path: '$.rows[0].status' })
    await call('assert_expectation', { expectId: 'db-qty', evidenceId: row.evidenceId, path: '$.rows[0].qty' })
  },
  async 'TC-02'(call) {
    const created = await call('http_request', { method: 'POST', url: `${BASE}/orders`, body: { symbol: 'FPT', side: 'SELL', qty: 200, price: 120000 } })
    const id = created.result.body.id
    const cancelled = await call('http_request', { method: 'POST', url: `${BASE}/orders/${id}/cancel` })
    const row = await call('db_query', { sql: 'SELECT status, cancelled_at FROM orders WHERE id = ?', params: [id] })
    // Gộp nhiều expectation vào một lời gọi; phần tử sai tham số không làm hỏng phần tử khác.
    const batch = await call('assert_expectation', {
      assertions: [
        { expectId: 'cancel-200', evidenceId: cancelled.evidenceId, path: '$.status' },
        { expectId: 'db-cancelled', evidenceId: row.evidenceId, path: '$.rows[0].status' },
        { expectId: 'db-cancelled-at', evidenceId: 'ev99', path: '$.rows[0].cancelled_at' },
      ],
    })
    expect(batch.result.results.map((r: { passed?: boolean; error?: string }) => r.error ? 'error' : r.passed)).toEqual([true, true, 'error'])
    expect(batch.result.note).toMatch(/1 assertion/)
    await call('assert_expectation', { assertions: [{ expectId: 'db-cancelled-at', evidenceId: row.evidenceId, path: '$.rows[0].cancelled_at' }] })
  },
  async 'TC-03'(call) {
    const created = await call('http_request', { method: 'POST', url: `${BASE}/orders`, body: { symbol: 'HPG', side: 'BUY', qty: 150, price: 25000 } })
    const count = await call('db_query', { sql: "SELECT COUNT(*) AS n FROM orders WHERE symbol = 'HPG' AND qty = 150" })
    await call('assert_expectation', { expectId: 'http-400', evidenceId: created.evidenceId, path: '$.status' })
    await call('assert_expectation', { expectId: 'db-none', evidenceId: count.evidenceId, path: '$.rows[0].n' })
  },
}

describe('aitest e2e (scripted agent)', () => {
  let harness: Harness
  let kernel: Kernel

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      scripts,
      rows: [{ id: 'action-clock', name: './examples/plugins/action-clock.ts', config: { timezone: 'Asia/Ho_Chi_Minh' }, baseDir: root }],
    })
    kernel = harness.kernel
  })

  afterAll(() => harness?.dispose())

  it('runs the plan and derives deterministic verdicts', async () => {
    const report = await kernel.ctx.runner.run({ plan: join(root, 'examples/plans/order.plan.yaml'), agent: 'scripted', model: 'model-x' })
    // Model của lượt chạy được ghi vào log từng case.
    const sessions = (await kernel.ctx.runlog.read(report.logFile!)).filter((e) => e.type === 'agent/session')
    expect(sessions.map((e) => (e.data as { model: string }).model)).toEqual(['model-x', 'model-x', 'model-x'])
    const verdicts = Object.fromEntries(report.cases.map((c) => [c.id, c.verdict]))
    expect(verdicts).toEqual({ 'TC-01': 'pass', 'TC-02': 'pass', 'TC-03': 'fail' })

    // TC-03 phát hiện lỗi cố ý: API chấp nhận lệnh lẻ lô.
    const tc3 = report.cases.find((c) => c.id === 'TC-03')!
    expect(tc3.expectations.find((e) => e.id === 'http-400')!.assertion).toMatchObject({ actual: 201, passed: false, criteria: 'plan' })

    // Báo cáo dựng lại từ file log phải trùng với báo cáo trong bộ nhớ.
    const replayed = deriveReport(await kernel.ctx.runlog.read(report.logFile!))
    expect(replayed.cases.map((c) => c.verdict)).toEqual(report.cases.map((c) => c.verdict))

    const markdown = await readFile(join(report.logFile!, '../report.md'), 'utf8')
    expect(markdown).toContain('TC-03')
    const junit = await readFile(join(report.logFile!, '../junit.xml'), 'utf8')
    expect(junit).toContain('failures="1"')
  })

  it('runs independent cases in parallel, one agent connection per worker', async () => {
    const source = join(root, 'examples/plans/order.plan.yaml')
    const plan = await kernel.ctx.plans.load(source)
    const text = (await readFile(source, 'utf8')).replace(/^concurrency: \d+\n/m, '')
    expect(kernel.ctx.plans.parse(text.replace('\ncases:', '\nconcurrency: 2\ncases:'), source).concurrency).toBe(2)
    expect(() => kernel.ctx.plans.parse(text.replace('\ncases:', '\nconcurrency: 0\ncases:'), source)).toThrow()
    const order = (events: Array<{ type: string; caseId?: string }>) => events.filter((e) => e.type === 'case/start' || e.type === 'case/end').map((e) => e.type)

    // Plan khai báo `concurrency`; ba case được chia cho hai luồng.
    const byPlan = await kernel.ctx.runner.run({ plan: { ...plan, concurrency: 2 }, agent: 'scripted' })
    expect(Object.fromEntries(byPlan.cases.map((c) => [c.id, c.verdict]))).toEqual({ 'TC-01': 'pass', 'TC-02': 'pass', 'TC-03': 'fail' })
    const planEvents = await kernel.ctx.runlog.read(byPlan.logFile!)
    expect(planEvents.filter((e) => e.type === 'agent/connected')).toHaveLength(2)
    expect(order(planEvents).slice(0, 2)).toEqual(['case/start', 'case/start'])

    // Tham số của lượt chạy thắng plan; không vượt số case.
    const byOption = await kernel.ctx.runner.run({ plan: { ...plan, concurrency: 2 }, agent: 'scripted', concurrency: 8 })
    const optionEvents = await kernel.ctx.runlog.read(byOption.logFile!)
    expect(optionEvents.find((e) => e.type === 'run/start')!.data).toMatchObject({ concurrency: 3 })
    expect(optionEvents.filter((e) => e.type === 'agent/connected')).toHaveLength(3)
    expect(order(optionEvents).slice(0, 3)).toEqual(['case/start', 'case/start', 'case/start'])
    expect(byOption.cases.map((c) => c.verdict)).toEqual(['pass', 'pass', 'fail'])
    // Báo cáo dựng lại từ log xen kẽ vẫn đúng từng case.
    const replayed = deriveReport(optionEvents)
    expect(replayed.cases.find((c) => c.id === 'TC-02')!.expectations.every((e) => e.assertion?.passed)).toBe(true)
  })

  it('guard blocks write SQL on read-only namespace', async () => {
    const plan = await kernel.ctx.plans.load(join(root, 'examples/plans/order.plan.yaml'))
    const scope = caseScope(plan)
    const outcome = await kernel.ctx.actions.invoke(scope, 'db_query', { sql: 'DELETE FROM orders' })
    expect(outcome.status).toBe('denied')
    expect(outcome.error).toMatch(/read-only/)
  })

  it('hides actions outside the plan requires from the agent', () => {
    const names = kernel.ctx.actions.list({ kind: 'case', namespaces: new Set(['http']), phase: 'agent' }).map((a) => a.name)
    expect(names).toContain('http_request')
    expect(names).toContain('assert_expectation')
    expect(names).toContain('wait_until')
    expect(names).not.toContain('db_query')
    expect(names).not.toContain('dbadmin_query')
  })

  it('loads a local plugin by relative path and removes its actions on unload', async () => {
    expect(kernel.ctx.actions.get('clock_now')).toBeDefined()

    const extra = kernel.ctx.plugin({
      name: 'temp-action',
      inject: ['actions'],
      apply(ctx: Kernel['ctx']) {
        ctx.actions.register({
          name: 'temp_echo', namespace: 'temp', description: 'echo', inputSchema: { type: 'object' },
          execute: async (args) => args,
        })
      },
    })
    await extra
    expect(kernel.ctx.actions.get('temp_echo')).toBeDefined()
    await extra.dispose()
    expect(kernel.ctx.actions.get('temp_echo')).toBeUndefined()
  })
})
