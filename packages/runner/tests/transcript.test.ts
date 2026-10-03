/**
 * Tin nhắn của agent trong run log: mẩu stream liền nhau được gộp, đoạn đang đệm được ghi trước lời gọi tool
 * của gateway và sau 1 s agent ngừng gửi, để dòng thời gian đúng thứ tự cả khi agent dừng lâu giữa chừng.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { root, setupHarness, type Harness } from './support.ts'

const PORT = 4176
const BASE = `http://127.0.0.1:${PORT}`

describe('agent transcript', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      scripts: {
        async 'TC-01'(call, _prompt, say) {
          say('Tôi sẽ ')
          say('đặt lệnh trước.')
          const created = await call('http_request', { method: 'POST', url: `${BASE}/orders`, body: { symbol: 'VNM', side: 'BUY', qty: 100, price: 70000 } })
          say('Đang chờ…')
          await sleep(1300)
          const row = await call('db_query', { sql: 'SELECT * FROM orders WHERE id = ?', params: [created.result.body.id] })
          await call('assert_expectation', {
            assertions: [
              { expectId: 'http-201', evidenceId: created.evidenceId, path: '$.status' },
              { expectId: 'db-status', evidenceId: row.evidenceId, path: '$.rows[0].status' },
              { expectId: 'db-qty', evidenceId: row.evidenceId, path: '$.rows[0].qty' },
            ],
          })
          say('Cả ba expectation đạt.')
        },
      },
    })
  })

  afterAll(() => harness?.dispose())

  it('logs agent messages in order with tool calls', async () => {
    const report = await harness.kernel.ctx.runner.run({ plan: join(root, 'examples/plans/order.plan.yaml'), agent: 'scripted', cases: ['TC-01'] })
    expect(report.cases[0].verdict).toBe('pass')
    const events = await harness.kernel.ctx.runlog.read(report.logFile!)
    const trace = events
      .filter((e) => (e.type === 'agent/update' && (e.data as { kind: string }).kind === 'message') || (e.type === 'action/call' && (e.data as { phase?: string }).phase === 'agent'))
      .map((e) => e.type === 'action/call' ? `call:${(e.data as { name: string }).name}` : `say:${(e.data as { text: string }).text}`)
    expect(trace).toEqual([
      'say:Tôi sẽ đặt lệnh trước.',
      'call:http_request',
      // Ghi sau 1 s im lặng, trước khi agent gọi tool kế tiếp.
      'say:Đang chờ…',
      'call:db_query',
      'call:assert_expectation',
      'say:Cả ba expectation đạt.',
    ])
    const waiting = events.find((e) => e.type === 'agent/update' && (e.data as { text?: string }).text === 'Đang chờ…')!
    const query = events.find((e) => e.type === 'action/call' && (e.data as { name: string }).name === 'db_query')!
    expect(new Date(query.ts).getTime() - new Date(waiting.ts).getTime()).toBeGreaterThan(200)
  })
})
