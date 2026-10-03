/**
 * Kiểm thử việc còn mở qua cấu hình thật: ghi, đóng, nhắc ở đầu phiên mới và ở mỗi lượt,
 * báo việc bị đóng trên giao diện, việc quá hạn, agent chạy test không thấy tool.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootFromFile, type Kernel } from '@aitest/core'
import type { AuthoringSession } from '@aitest/authoring'

const root = join(import.meta.dirname, '../../..')

describe('open items', () => {
  let dir: string
  let kernel: Kernel
  let chatA: AuthoringSession
  let chatB: AuthoringSession
  const call = (s: AuthoringSession, name: string, args: Record<string, unknown> = {}) => kernel.ctx.actions.invoke(s.scope, name, args)
  const turn = (s: AuthoringSession, text: string, firstTurn = false) =>
    kernel.ctx.authoring.turnNotes({ sessionId: s.id, text, firstTurn }).then((notes) => notes.join('\n\n'))

  beforeAll(async () => {
    dir = await mkdtemp(join(process.cwd(), '.aitest-oi-'))
    kernel = await bootFromFile(join(root, 'aitest.yml'), [
      { id: 'logger', name: 'aitest:noop', disabled: true },
      { id: 'memory', name: '@aitest/memory', config: { dir: join(dir, 'memory'), teamDir: join(dir, 'team') } },
      { id: 'open-items', name: '@aitest/open-items', config: { file: join(dir, 'open-items.json') } },
    ], { patchFile: false })
    chatA = await kernel.ctx.authoring.createSession({ id: 'chat-a' })
    chatB = await kernel.ctx.authoring.createSession({ id: 'chat-b' })
  }, 60_000)

  afterAll(async () => {
    await chatA?.close()
    await chatB?.close()
    await kernel?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('records an open question and lists it on every later turn of the same chat', async () => {
    expect(await turn(chatA, 'Soạn plan huỷ lệnh', true)).not.toContain('Việc còn mở')
    const added = await call(chatA, 'open_item_add', {
      kind: 'decision', title: 'Case CAN-02 mong đợi mã 409 hay 400?', options: ['409', '400'], plan: 'plans/order/cancel.plan.yaml', systems: ['order-service'],
    })
    expect(added.value).toMatchObject({ id: 'oi-1', item: { status: 'open', chatId: 'chat-a', kind: 'decision' } })
    const logged = chatA.log.events.filter((e) => e.type === 'action/call').at(-1)!.data as { view: unknown }
    expect(logged.view).toMatchObject({ kind: 'open-item', action: 'added', item: { id: 'oi-1' } })
    expect((await call(chatA, 'open_item_add', { kind: 'question', title: 'case can-02 mong đợi mã 409 hay 400?' })).error).toMatch(/already has this title/)
    expect((await call(chatA, 'open_item_add', { kind: 'nope', title: 'x' })).error).toBeTruthy()

    const note = await turn(chatA, 'Tiếp tục')
    expect(note).toContain('## Việc còn mở của cuộc chat này\n- `oi-1` [quyết định] Case CAN-02 mong đợi mã 409 hay 400? (phương án: 409 | 400) — plan plans/order/cancel.plan.yaml')
    // Cuộc chat khác không bị nhắc việc của chat A ở mỗi lượt.
    expect(await turn(chatB, 'Xin chào', true)).toBe('')
    expect(await turn(chatB, 'Tiếp')).not.toContain('oi-1')
    expect(await readFile(join(dir, 'open-items.json'), 'utf8')).toContain('"id": "oi-1"')
  })

  it('reminds a new agent session of open items from earlier chats', async () => {
    const intro = await kernel.ctx.authoring.intro()
    expect(intro).toContain('## Việc còn mở từ các cuộc chat trước')
    expect(intro).toMatch(/- `oi-1` \[quyết định\] Case CAN-02 mong đợi mã 409 hay 400\? \(phương án: 409 \| 400\) — plan plans\/order\/cancel\.plan\.yaml, ngày \d{4}-\d\d-\d\d/)
    expect(intro.indexOf('## Bộ nhớ từ các phiên trước')).toBeLessThan(intro.indexOf('## Việc còn mở'))
    const guide = (await call(chatB, 'get_authoring_guide')).value as { guide: string }
    expect(guide.guide).toContain('## Việc còn mở')
  })

  it('closes items from the agent and from the UI, and tells the chat what the user decided', async () => {
    const second = await call(chatA, 'open_item_add', { kind: 'question', title: 'Có cần kiểm tra lệnh SELL không?' })
    expect((second.value as { id: string }).id).toBe('oi-2')
    await turn(chatA, 'lượt ghi nhận danh sách')

    // Người dùng chốt trên giao diện: lượt sau agent được báo kèm kết luận.
    await kernel.ctx.openItems.resolve('oi-1', 'Dùng 409 theo đặc tả', 'resolved', 'ui')
    const note = await turn(chatA, 'Tiếp tục')
    expect(note).toContain('- `oi-2` [câu hỏi] Có cần kiểm tra lệnh SELL không?')
    expect(note).toContain('Đã đóng ngoài lượt trước của bạn:\n- `oi-1` Case CAN-02 mong đợi mã 409 hay 400? → đã chốt trên giao diện: Dùng 409 theo đặc tả')
    expect(await turn(chatA, 'Tiếp nữa')).not.toContain('oi-1')

    // Agent tự đóng: không báo lại cho chính nó.
    const closed = await call(chatA, 'open_item_resolve', { id: 'oi-2', resolution: 'Không cần', status: 'dropped' })
    expect(closed.value).toMatchObject({ id: 'oi-2', status: 'dropped', item: { closedBy: 'chat-a' } })
    expect(await turn(chatA, 'Tiếp')).toBe('')
    expect((await call(chatA, 'open_item_resolve', { id: 'oi-2', resolution: 'x' })).error).toMatch(/already dropped/)
    expect((await call(chatA, 'open_item_resolve', { id: 'oi-9', resolution: 'x' })).error).toMatch(/unknown open item/)

    const listed = await call(chatB, 'open_item_list', { status: 'resolved' })
    expect(listed.value).toMatchObject({ total: 1, items: [{ id: 'oi-1', resolution: 'Dùng 409 theo đặc tả', closedBy: 'ui' }] })
    expect(await kernel.ctx.authoring.intro()).not.toContain('Việc còn mở')
    await kernel.ctx.openItems.reopen('oi-1')
    expect(await kernel.ctx.authoring.intro()).toContain('`oi-1`')
  })

  it('keeps stale items out of the session intro and hides the tools from test runs', async () => {
    await kernel.ctx.openItems.store.update((items) => { for (const i of items) i.updated = '2020-01-01T00:00:00.000Z' })
    expect(await kernel.ctx.authoring.intro()).not.toContain('Việc còn mở')
    expect((await kernel.ctx.openItems.list({ status: 'open' })).map((i) => i.id)).toEqual(['oi-1'])
    const caseTools = kernel.ctx.actions.list({ kind: 'case', namespaces: new Set(['authoring']), phase: 'agent' }).map((a) => a.name)
    expect(caseTools.filter((n) => n.startsWith('open_item'))).toEqual([])
  })

  it('removes its sections when the plugin is unloaded', async () => {
    await kernel.setEnabled('open-items-tools', false)
    await kernel.setEnabled('open-items', false)
    expect(kernel.ctx.actions.list(chatA.scope).map((a) => a.name)).not.toContain('open_item_add')
    expect((await call(chatA, 'get_authoring_guide')).value).not.toMatchObject({ guide: expect.stringContaining('## Việc còn mở') })
  })
})
