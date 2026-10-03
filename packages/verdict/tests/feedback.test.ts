/**
 * Góp ý của agent chạy test để cải thiện plan: ghi qua `feedback_submit`, giới hạn và kiểm tra tham số, không đổi verdict;
 * hiện trong báo cáo dựng từ log, `report.md`, kết quả chạy thử cho agent soạn plan và tóm tắt lượt chạy.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthoringSession } from '@aitest/authoring'
import { setupHarness, WsClient, type Harness } from '../../runner/tests/support.ts'

const PORT = 4177
const BASE = `http://127.0.0.1:${PORT}`

const PLAN = `id: TP-FEEDBACK
name: Góp ý
requires: [http]
cases:
  - id: FB-01
    title: Liệt kê lệnh
    steps: [Gọi danh sách lệnh., Kiểm tra lệnh mới nhất.]
    expect:
      - { id: http-200, desc: API trả 200, check: { op: eq, value: 200 } }
`

describe('plan feedback from the test agent', () => {
  let harness: Harness
  let session: AuthoringSession
  let ws: WsClient
  const results: unknown[] = []

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      config: 'aitest.web.yml',
      scripts: {
        async 'FB-01'(call, prompt) {
          expect(prompt).toContain('## Góp ý cải thiện plan')
          const res = await call('http_request', { method: 'GET', url: `${BASE}/orders` })
          await call('assert_expectation', { expectId: 'http-200', evidenceId: res.evidenceId, path: '$.status' })
          const feedback = { kind: 'step', step: 1, message: 'Bước 1 không ghi URL của API danh sách lệnh', suggestion: 'Ghi rõ GET {{order-service.url}}/orders' }
          results.push(await call('feedback_submit', feedback))
          results.push(await call('feedback_submit', feedback))
          results.push(await call('feedback_submit', { kind: 'step', step: 9, message: 'x' }))
          results.push(await call('feedback_submit', { kind: 'expectation', expectId: 'http-200', message: 'Nên kiểm tra thêm số lệnh trả về' }))
        },
      },
      rows: (dir) => [
        { id: 'web', name: '@aitest/web-host', config: { port: 0, staticDir: join(dir, 'static') } },
        { id: 'chat', name: '@aitest/chat', config: { agent: 'scripted', dir: join(dir, 'chats') } },
      ],
    })
    harness.kernel.ctx.runner.config.agent = 'scripted'
    session = await harness.kernel.ctx.authoring.createSession()
    ws = await WsClient.open((await harness.kernel.ctx.web.ready()).replace('http', 'ws') + '/ws')
  }, 60_000)

  afterAll(async () => {
    ws?.socket.close()
    await session?.close()
    await harness?.dispose()
  })

  it('records feedback without changing the verdict and shows it in the report', async () => {
    const file = join(harness.dir, 'fb.plan.yaml')
    await writeFile(file, PLAN)
    const report = await harness.kernel.ctx.runner.run({ plan: file })
    expect(results[0]).toMatchObject({ outcome: 'ok', result: { recorded: true } })
    expect(results[1]).toMatchObject({ result: { recorded: false, reason: 'the same feedback was already recorded' } })
    expect(JSON.stringify(results[2])).toContain('step 9 does not exist')
    const c = report.cases[0]
    expect(c.verdict).toBe('pass')
    expect(c.feedback).toEqual([
      { kind: 'step', step: 1, message: 'Bước 1 không ghi URL của API danh sách lệnh', suggestion: 'Ghi rõ GET {{order-service.url}}/orders' },
      { kind: 'expectation', expectId: 'http-200', message: 'Nên kiểm tra thêm số lệnh trả về' },
    ])
    const markdown = await readFile(report.logFile!.replace(/events\.jsonl$/, 'report.md'), 'utf8')
    expect(markdown).toContain('### Góp ý của agent để cải thiện plan\n\n- **Bước** (bước 1): Bước 1 không ghi URL của API danh sách lệnh Đề xuất: Ghi rõ GET {{order-service.url}}/orders')
    const runs = await ws.call('runs.list', { planId: 'TP-FEEDBACK' })
    expect(runs[0]).toMatchObject({ feedback: 2, cases: [{ id: 'FB-01', feedback: 2 }] })
  })

  it('returns feedback to the planning agent in dry-run results', async () => {
    results.length = 0
    const { actions } = harness.kernel.ctx
    const { runId } = (await actions.invoke(session.scope, 'dry_run', { content: PLAN })).value as { runId: string }
    let result: any
    for (let i = 0; i < 20; i++) {
      result = (await actions.invoke(session.scope, 'get_run_result', { runId, waitSec: 5 })).value
      if (result.status !== 'running') break
    }
    expect(result.cases[0].feedback).toHaveLength(2)
    const guide = ((await actions.invoke(session.scope, 'get_authoring_guide', {})).value as { guide: string }).guide
    expect(guide).toContain('Đọc `feedback` của từng case')
  })
})
