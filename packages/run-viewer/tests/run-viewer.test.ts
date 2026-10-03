/**
 * Kiểm thử xem log lượt chạy qua WebSocket: danh sách, snapshot, theo dõi lượt chạy đang ghi dở ở process khác.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '@aitest/runner'
import type {} from '@aitest/web-host'
import { root, setupHarness, WsClient, type Harness, type Script } from '../../runner/tests/support.ts'

const PORT = 4191
const BASE = `http://127.0.0.1:${PORT}`

const scripts: Record<string, Script> = {
  async 'TC-03'(call) {
    const created = await call('http_request', { method: 'POST', url: `${BASE}/orders`, body: { symbol: 'HPG', side: 'BUY', qty: 150, price: 25000 } })
    const count = await call('db_query', { sql: "SELECT COUNT(*) AS n FROM orders WHERE symbol = 'HPG' AND qty = 150" })
    // Lần assert đầu dùng path sai, lần sau sửa: trang xem log phải thấy cả hai lần thử.
    await call('assert_expectation', { expectId: 'http-400', evidenceId: created.evidenceId, path: '$.code' })
    await call('assert_expectation', { expectId: 'http-400', evidenceId: created.evidenceId, path: '$.status' })
    await call('assert_expectation', { expectId: 'db-none', evidenceId: count.evidenceId, path: '$.rows[0].n' })
  },
}

describe('run viewer', () => {
  let harness: Harness
  let ws: WsClient
  let runsDir: string

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      config: 'aitest.web.yml',
      scripts,
      rows: (dir) => [
        { id: 'web', name: '@aitest/web-host', config: { port: 0, staticDir: join(dir, 'static') } },
        { id: 'run-viewer', name: '@aitest/run-viewer', config: { pollMs: 50 } },
      ],
    })
    runsDir = join(harness.dir, 'runs')
    ws = await WsClient.open((await harness.kernel.ctx.web.ready()).replace('http', 'ws') + '/ws')
  })

  afterAll(async () => {
    ws?.socket.close()
    await harness?.dispose()
  })

  it('lists finished runs and returns every event of a run', async () => {
    const report = await harness.kernel.ctx.runner.run({ plan: join(root, 'examples/plans/order.plan.yaml'), agent: 'scripted', cases: ['TC-03'] })
    const runs = await ws.call('runs.list')
    expect(runs[0]).toMatchObject({
      runId: report.runId, finished: true, dryRun: false, plan: { id: 'TP-ORDER-001' },
      totals: { fail: 1 }, cases: [{ id: 'TC-03', verdict: 'fail' }],
    })

    const { events, summary } = await ws.call('runs.subscribe', { runId: report.runId })
    expect(summary.finished).toBe(true)
    const types = events.map((e: any) => e.type)
    for (const type of ['run/start', 'case/start', 'agent/prompt', 'action/call', 'assert/result', 'case/end', 'run/end']) expect(types).toContain(type)
    // Đủ dữ liệu để giải thích: cả hai lần assert và evidence của từng lần.
    const attempts = events.filter((e: any) => e.type === 'assert/result' && e.data.expectId === 'http-400')
    expect(attempts.map((a: any) => [a.data.path, a.data.actual])).toEqual([['$.code', undefined], ['$.status', 201]])
    const evidence = events.find((e: any) => e.type === 'action/call' && e.data.annotations?.evidenceId === attempts[1].data.evidenceId)
    expect(evidence.data).toMatchObject({ name: 'http_request', value: { status: 201 } })

    const tail = await ws.call('runs.subscribe', { runId: report.runId, afterSeq: events.at(-2).seq })
    expect(tail.events).toHaveLength(1)
  })

  it('follows a run that another process is still writing', async () => {
    const runId = 'cli-run-in-progress'
    const file = join(runsDir, runId, 'events.jsonl')
    await mkdir(join(runsDir, runId), { recursive: true })
    const line = (seq: number, type: string, data: unknown, caseId?: string) =>
      JSON.stringify({ seq, ts: new Date().toISOString(), runId, caseId, type, data }) + '\n'
    await writeFile(file, line(1, 'run/start', { plan: { id: 'P', name: 'Plan', source: 'p.plan.yaml' }, agent: 'kiro' }))

    const first = await ws.call('runs.subscribe', { runId })
    expect(first.summary.finished).toBe(false)
    expect((await ws.call('runs.list')).find((r: any) => r.runId === runId)).toMatchObject({ finished: false })

    // Ghi một dòng hoàn chỉnh cộng nửa dòng: chỉ dòng hoàn chỉnh được đẩy.
    const partial = line(3, 'run/end', {})
    await appendFile(file, line(2, 'case/start', { id: 'C1', title: 't', expect: [] }, 'C1') + partial.slice(0, 10))
    const pushed = await ws.waitFor((m) => m.type === 'run-event' && m.runId === runId && m.event.seq === 2)
    expect(pushed.event.type).toBe('case/start')
    await appendFile(file, partial.slice(10))
    const end = await ws.waitFor((m) => m.type === 'run-event' && m.runId === runId && m.event.type === 'run/end')
    expect(end.event.seq).toBe(3)
  })

  it('follows a run subscribed before its log file exists (dry run just started)', async () => {
    const runId = 'dryrun-not-yet-written'
    const first = await ws.call('runs.subscribe', { runId })
    expect(first.events).toEqual([])
    await mkdir(join(runsDir, runId), { recursive: true })
    const line = (seq: number, type: string, data: unknown) => JSON.stringify({ seq, ts: new Date().toISOString(), runId, type, data }) + '\n'
    await writeFile(join(runsDir, runId, 'events.jsonl'), line(1, 'run/start', { plan: { id: 'P', name: 'Plan' }, agent: 'kiro' }) + line(2, 'run/end', {}))
    const start = await ws.waitFor((m) => m.type === 'run-event' && m.runId === runId && m.event.type === 'run/start')
    expect(start.event.seq).toBe(1)
    await ws.waitFor((m) => m.type === 'run-event' && m.runId === runId && m.event.type === 'run/end')
  })

  it('rejects run ids that could escape the runs directory', async () => {
    await expect(ws.call('runs.subscribe', { runId: '../../etc' })).rejects.toThrow(/invalid run id/)
  })
})
