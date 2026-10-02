/**
 * Kiểm thử tri thức của nhóm: tool cho agent soạn plan, quy ước trong hướng dẫn, đánh dấu lỗi đã biết trong báo cáo.
 */
import { cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthoringSession } from '@aitest/authoring'
import type {} from '@aitest/knowledge'
import type {} from '@aitest/runner'
import type {} from '@aitest/web-host'
import { root, setupHarness, WsClient, type Harness, type Script } from '../../runner/tests/support.ts'

const PORT = 4193
const BASE = `http://127.0.0.1:${PORT}`

const scripts: Record<string, Script> = {
  async 'TC-01'(call) {
    const created = await call('http_request', { method: 'POST', url: `${BASE}/orders`, body: { symbol: 'VNM', side: 'BUY', qty: 100, price: 70000 } })
    const row = await call('db_query', { sql: 'SELECT * FROM orders WHERE id = ?', params: [created.result.body.id] })
    await call('assert_expectation', { expectId: 'http-201', evidenceId: created.evidenceId, path: '$.status' })
    await call('assert_expectation', { expectId: 'db-status', evidenceId: row.evidenceId, path: '$.rows[0].status' })
    await call('assert_expectation', { expectId: 'db-qty', evidenceId: row.evidenceId, path: '$.rows[0].qty' })
  },
  async 'TC-03'(call) {
    const created = await call('http_request', { method: 'POST', url: `${BASE}/orders`, body: { symbol: 'HPG', side: 'BUY', qty: 150, price: 25000 } })
    const count = await call('db_query', { sql: "SELECT COUNT(*) AS n FROM orders WHERE symbol = 'HPG' AND qty = 150" })
    await call('assert_expectation', { expectId: 'http-400', evidenceId: created.evidenceId, path: '$.status' })
    await call('assert_expectation', { expectId: 'db-none', evidenceId: count.evidenceId, path: '$.rows[0].n' })
  },
}

describe('knowledge', () => {
  let harness: Harness
  let session: AuthoringSession
  let kbDir: string
  const call = (name: string, args: Record<string, unknown> = {}) => harness.kernel.ctx.actions.invoke(session.scope, name, args)
  const run = (cases: string[]) => harness.kernel.ctx.runner.run({ plan: join(root, 'examples/plans/order.plan.yaml'), agent: 'scripted', cases })

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      config: 'aitest.web.yml',
      scripts,
      rows: (dir) => {
        kbDir = join(dir, 'kb')
        return [
          { id: 'knowledge', name: '@aitest/knowledge', config: { dir: kbDir } },
          { id: 'web', name: '@aitest/web-host', config: { port: 0, staticDir: join(dir, 'static') } },
          { id: 'authoring', name: '@aitest/authoring', config: { dir: join(dir, 'authoring') } },
        ]
      },
    })
    // Bản sao ghi chú mẫu để bài test không sửa thư mục kb/ của repo.
    await cp(join(root, 'kb'), kbDir, { recursive: true })
    harness.kernel.ctx.runner.config.agent = 'scripted'
    session = await harness.kernel.ctx.authoring.createSession()
  })

  afterAll(async () => {
    await session?.close()
    await harness?.dispose()
  })

  it('lists and reads notes by type and feature', async () => {
    const bugs = await call('kb_list', { type: 'bug', feature: 'order' })
    expect((bugs.value as { notes: unknown[] }).notes).toContainEqual(expect.objectContaining({ id: 'order-odd-lot-accepted', status: 'open' }))
    const note = await call('kb_read', { id: 'order-callback-delay' })
    expect(note.value).toMatchObject({ type: 'lesson', feature: 'order' })
    expect((note.value as { body: string }).body).toContain('wait_until')
  })

  it('puts every convention into the authoring guide', async () => {
    const guide = ((await call('get_authoring_guide')).value as { guide: string }).guide
    expect(guide).toContain('### Quy ước bắt buộc')
    expect(guide).toContain('Kết nối ghi DB chỉ dùng trong fixture')
    expect(guide).toContain('Đối chiếu chéo với cơ sở dữ liệu')
  })

  it('kb_propose writes a markdown note with its source and keeps the creation date on update', async () => {
    const created = await call('kb_propose', {
      id: 'order-cancel-race', type: 'lesson', feature: 'order', title: 'Huỷ ngay sau khi khớp', body: 'Huỷ lệnh vừa khớp trả 409.',
    })
    expect(created.value).toMatchObject({ created: true, note: { id: 'order-cancel-race', type: 'lesson' } })
    const text = await readFile(join(kbDir, 'lesson/order-cancel-race.md'), 'utf8')
    expect(text).toContain(`source: chat:${session.id}`)
    expect(text).toContain('Huỷ lệnh vừa khớp trả 409.')

    const moved = await call('kb_propose', { id: 'order-cancel-race', type: 'bug', title: 'Huỷ ngay sau khi khớp', body: 'Lỗi.' })
    expect(moved.value).toMatchObject({ created: false, note: { type: 'bug', status: 'open' } })
    await expect(readFile(join(kbDir, 'lesson/order-cancel-race.md'), 'utf8')).rejects.toThrow()

    const invalid = await call('kb_propose', { id: 'Bad Id', type: 'lesson', title: 't', body: 'b' })
    expect(invalid.error).toMatch(/invalid note id/)
  })

  it('marks a failing case as a known issue and a passing case as possibly fixed', async () => {
    const failing = await run(['TC-03'])
    expect(failing.cases[0]).toMatchObject({ verdict: 'fail', annotations: { knownIssues: [{ id: 'order-odd-lot-accepted' }] } })
    const markdown = await readFile(join(failing.logFile!, '../report.md'), 'utf8')
    expect(markdown).toContain('lỗi đã biết: order-odd-lot-accepted')

    // Ghi chú lỗi trỏ nhầm vào case đang đạt: báo cáo gợi ý lỗi có thể đã được sửa.
    await harness.kernel.ctx.actions.invoke(session.scope, 'kb_propose', {
      id: 'order-odd-lot-accepted', type: 'bug', title: 'Order API chấp nhận lệnh lẻ lô', body: 'x',
      cases: ['TP-ORDER-001/TC-01'],
    })
    const passing = await run(['TC-01'])
    expect(passing.cases[0]).toMatchObject({ verdict: 'pass', annotations: { possiblyFixed: [{ id: 'order-odd-lot-accepted' }] } })

    // Lỗi đã được đánh dấu sửa xong: case không đạt lại là lỗi mới.
    await harness.kernel.ctx.actions.invoke(session.scope, 'kb_propose', {
      id: 'order-odd-lot-accepted', type: 'bug', title: 'Order API chấp nhận lệnh lẻ lô', body: 'x',
      cases: ['TP-ORDER-001/TC-03'], status: 'fixed',
    })
    const regression = await run(['TC-03'])
    expect(regression.cases[0].annotations).toEqual({})
    expect(await readFile(join(regression.logFile!, '../report.md'), 'utf8')).toContain('**lỗi mới**')
  })

  it('serves notes to the knowledge page over WebSocket', async () => {
    const ws = await WsClient.open((await harness.kernel.ctx.web.ready()).replace('http', 'ws') + '/ws')
    try {
      const saved = await ws.call('kb.save', { id: 'ui-note', type: 'convention', title: 'Quy ước từ giao diện', body: 'Nội dung.' })
      expect(saved).toMatchObject({ id: 'ui-note', source: 'user' })
      expect((await ws.call('kb.list')).some((n: any) => n.id === 'ui-note')).toBe(true)
      await ws.call('kb.remove', { id: 'ui-note' })
      await expect(ws.call('kb.get', { id: 'ui-note' })).rejects.toThrow(/unknown note/)
    } finally {
      ws.socket.close()
    }
  })
})
