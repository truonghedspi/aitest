/**
 * Kiểm thử các tool soạn plan qua cấu hình thật (`aitest.yml`), gọi qua `ctx.actions.invoke` với scope `authoring`.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthoringSession } from '@aitest/authoring'
import { root, setupHarness, type Harness, type Script } from '../../runner/tests/support.ts'

const PORT = 4196
const BASE = `http://127.0.0.1:${PORT}`

const scripts: Record<string, Script> = {
  async 'TC-03'(call) {
    const created = await call('http_request', { method: 'POST', url: `${BASE}/orders`, body: { symbol: 'HPG', side: 'BUY', qty: 150, price: 25000 } })
    const count = await call('db_query', { sql: "SELECT COUNT(*) AS n FROM orders WHERE symbol = 'HPG' AND qty = 150" })
    await call('assert_expectation', { expectId: 'http-400', evidenceId: created.evidenceId, path: '$.status' })
    await call('assert_expectation', { expectId: 'db-none', evidenceId: count.evidenceId, path: '$.rows[0].n' })
  },
}

describe('authoring tools', () => {
  let harness: Harness
  let session: AuthoringSession
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    return harness.kernel.ctx.actions.invoke(session.scope, name, args)
  }

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      scripts,
      rows: (dir) => [
        { id: 'authoring', name: '@aitest/authoring', config: { dir: join(dir, 'authoring') } },
        { id: 'authoring-save', name: '@aitest/authoring/save', config: { dir: join(dir, 'plans') } },
      ],
    })
    harness.kernel.ctx.runner.config.agent = 'scripted'
    session = await harness.kernel.ctx.authoring.createSession()
  })

  afterAll(async () => {
    await session?.close()
    await harness?.dispose()
  })

  it('exposes only authoring tools to an authoring session', () => {
    const names = harness.kernel.ctx.actions.list(session.scope).map((a) => a.name)
    expect(names).toContain('validate_plan')
    expect(names).toContain('explore')
    expect(names).not.toContain('http_request')
    expect(names).not.toContain('assert_expectation')
  })

  it('builds the agent guide from plugin sections and the plan format', async () => {
    const outcome = await call('get_authoring_guide')
    const guide = (outcome.value as { guide: string }).guide
    expect(guide).toContain('## Quy trình')
    expect(guide).toContain('## Định dạng plan YAML')
    expect(guide).toContain('## Chạy thử')
    expect(guide.indexOf('## Quy trình')).toBeLessThan(guide.indexOf('## Định dạng plan YAML'))
  })

  it('lists and reads context sources by line range', async () => {
    const listed = await call('list_context_sources')
    expect(listed.value).toMatchObject({ sources: [{ id: 'order-spec', docs: [{ id: 'SPEC.md' }] }] })
    const read = await call('read_context_source', { source: 'order-spec', doc: 'SPEC.md', offset: 1, limit: 5 })
    const value = read.value as { content: string; nextOffset: number; totalLines: number }
    expect(value.content).toContain('# Đặc tả nghiệp vụ Order API')
    expect(value.nextOffset).toBe(6)
    expect(value.totalLines).toBeGreaterThan(20)
  })

  it('explore allows read-only calls and rejects writes', async () => {
    const tables = await call('explore', { action: 'db_query', args: { sql: "SELECT name FROM sqlite_master WHERE type = 'table'" } })
    expect(tables.status).toBe('ok')
    expect(tables.value).toMatchObject({ rows: expect.arrayContaining([{ name: 'orders' }]) })

    const get = await call('explore', { action: 'http_request', args: { method: 'GET', url: `${BASE}/orders` } })
    expect(get.value).toMatchObject({ status: 200 })

    const post = await call('explore', { action: 'http_request', args: { method: 'POST', url: `${BASE}/orders`, body: {} } })
    expect(post.status).toBe('error')
    expect(post.error).toMatch(/read-only/)

    const admin = await call('explore', { action: 'dbadmin_query', args: { sql: 'SELECT 1' } })
    expect(admin.error).toMatch(/may modify data/)

    // Guard vẫn áp dụng: action chỉ đọc nhưng câu SQL ghi bị từ chối.
    const write = await call('explore', { action: 'db_query', args: { sql: 'DELETE FROM orders' } })
    expect(write.error).toMatch(/denied/)

    const assertTool = await call('explore', { action: 'assert_expectation', args: {} })
    expect(assertTool.error).toMatch(/not available/)
  })

  it('validate_plan reports schema errors, lint errors and warnings', async () => {
    const valid = await call('validate_plan', { content: await readFile(join(root, 'examples/plans/order.plan.yaml'), 'utf8') })
    expect(valid.value).toMatchObject({ valid: true, errors: [], summary: { id: 'TP-ORDER-001' } })

    const broken = await call('validate_plan', { content: 'id: X\nname: Y\ncases: []\nfoo: [' })
    expect(broken.value).toMatchObject({ valid: false })

    const lint = await call('validate_plan', {
      content: [
        'id: TP-LINT', 'name: Lint', 'requires: [http, kafka, dbadmin]',
        'setup:', '  - action: missing_action',
        'cases:',
        '  - id: C1', '    title: t',
        '    steps: ["Gọi GET /orders/{{order_id}}"]',
        '    expect:',
        '      - { id: e1, desc: d1 }',
        '      - { id: e2, desc: d2, check: { op: eq } }',
      ].join('\n'),
    })
    const value = lint.value as { valid: boolean; errors: Array<{ message: string }>; warnings: Array<{ message: string }> }
    expect(value.valid).toBe(false)
    const errors = value.errors.map((e) => e.message).join('\n')
    expect(errors).toContain('namespace kafka has no registered action')
    expect(errors).toContain('unknown action missing_action')
    expect(errors).toContain('namespace dbadmin is fixture-only')
    expect(errors).toContain('undefined variable {{order_id}}')
    expect(errors).toContain('op eq requires value')
    expect(value.warnings.map((w) => w.message).join('\n')).toContain('expectation e1 has no check')
  })

  it('dry_run runs the draft and get_run_result returns verdicts with actual values', async () => {
    const content = await readFile(join(root, 'examples/plans/order.plan.yaml'), 'utf8')
    const unknown = await call('dry_run', { content, cases: ['TC-99'] })
    expect(unknown.error).toMatch(/unknown case: TC-99/)
    const started = await call('dry_run', { content, cases: ['TC-03'] })
    const { runId } = started.value as { runId: string }
    let result: any
    for (let i = 0; i < 10; i++) {
      result = (await call('get_run_result', { runId, waitSec: 10 })).value
      if (result.status !== 'running') break
    }
    expect(result).toMatchObject({ status: 'done', totals: { total: 1, fail: 1 } })
    expect(result.cases[0].expectations[0]).toMatchObject({ id: 'http-400', passed: false, actual: 201, expected: 400 })
  })

  it('save_plan writes valid plans inside the plan directory only', async () => {
    const content = await readFile(join(root, 'examples/plans/order.plan.yaml'), 'utf8')
    const outside = await call('save_plan', { path: '../escape.plan.yaml', content })
    expect(outside.error).toMatch(/inside/)
    const wrongName = await call('save_plan', { path: 'order.yaml', content })
    expect(wrongName.error).toMatch(/plan\.yaml/)
    const invalid = await call('save_plan', { path: 'bad.plan.yaml', content: 'id: X' })
    expect(invalid.error).toMatch(/invalid/)

    const saved = await call('save_plan', { path: 'order/copy.plan.yaml', content })
    expect(saved.status).toBe('ok')
    expect(await readFile(join(harness.dir, 'plans/order/copy.plan.yaml'), 'utf8')).toBe(content)
    const again = await call('save_plan', { path: 'order/copy.plan.yaml', content })
    expect(again.error).toMatch(/file exists/)
    const overwrite = await call('save_plan', { path: 'order/copy.plan.yaml', content, overwrite: true })
    expect(overwrite.value).toMatchObject({ overwritten: true, planId: 'TP-ORDER-001' })
  })

  it('records every tool call with its view in the session log', async () => {
    const events = session.log.events.filter((e) => e.type === 'action/call')
    const validate = events.find((e) => (e.data as any).name === 'validate_plan')!
    expect((validate.data as any).view).toMatchObject({ kind: 'plan-validation', valid: true })
    expect(session.log.events.some((e) => e.type === 'action/start')).toBe(true)
  })
})
