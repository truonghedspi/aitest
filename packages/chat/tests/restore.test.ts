/**
 * Kiểm thử khôi phục phiên agent của cuộc chat sau khi Host khởi động lại:
 * agent hỗ trợ `loadSession` thì giữ nguyên ngữ cảnh; không khôi phục được thì mở phiên mới
 * và gửi lại lịch sử, bản nháp, môi trường.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentDriver, AgentSessionOptions } from '@aitest/core'
import type {} from '@aitest/chat'
import { setupHarness, WsClient, type Harness } from '../../runner/tests/support.ts'

/** Agent giả có bộ nhớ theo phiên, giống agent lưu phiên trên đĩa (Kiro). */
const memory = new Map<string, string[]>()
const prompts: string[] = []
const loads: string[] = []
let supportsLoad = true

function makeSession(id: string, options: AgentSessionOptions) {
  return {
    id,
    async prompt(text: string) {
      prompts.push(text)
      memory.get(id)!.push(text)
      options.onUpdate({ kind: 'message', text: `Đã nhận ${memory.get(id)!.length} tin.`, raw: {} })
      return { stopReason: 'end_turn' }
    },
    async close() {},
  }
}

const rememberingAgent: AgentDriver = {
  name: 'remembering',
  async connect() {
    return {
      info: { name: 'remembering' },
      async newSession(options) {
        const id = randomUUID()
        memory.set(id, [])
        return makeSession(id, options)
      },
      get loadSession() {
        if (!supportsLoad) return undefined
        return async (id: string, options: AgentSessionOptions) => {
          loads.push(id)
          if (!memory.has(id)) throw new Error(`session ${id} not found`)
          return makeSession(id, options)
        }
      },
      async close() {},
    }
  },
}

describe('chat agent session restore', () => {
  let harness: Harness
  let ws: WsClient

  beforeAll(async () => {
    harness = await setupHarness({
      port: 4182,
      config: 'aitest.web.yml',
      scripts: {},
      rows: (dir) => [
        { id: 'web', name: '@aitest/web-host', config: { port: 0, staticDir: join(dir, 'static') } },
        { id: 'chat', name: '@aitest/chat', config: { agent: 'remembering', dir: join(dir, 'chats') } },
      ],
    })
    harness.kernel.ctx.agents.register(rememberingAgent)
    ws = await WsClient.open((await harness.kernel.ctx.web.ready()).replace('http', 'ws') + '/ws')
  })

  afterAll(async () => {
    ws?.socket.close()
    await harness?.dispose()
  })

  /** Giả lập Host khởi động lại: bỏ cuộc chat khỏi bộ nhớ và đóng kết nối agent. */
  const restart = async (chatId: string) => {
    const service = harness.kernel.ctx.chats as unknown as { chats: Map<string, { dispose(): Promise<void> }>; resetConnection(): void }
    await service.chats.get(chatId)!.dispose()
    service.chats.delete(chatId)
    service.resetConnection()
  }
  const send = async (chatId: string, text: string) => {
    const chat = await harness.kernel.ctx.chats.get(chatId)
    await chat.send(text)
    return chat.events().filter((e) => e.type === 'agent/session').map((e) => e.data as any)
  }

  it('reloads the previous agent session after a restart instead of resending history', async () => {
    const { id } = await ws.call('chats.create', { title: 'Khôi phục' })
    let sessions = await send(id, 'Soạn plan đặt lệnh')
    expect(sessions).toEqual([expect.objectContaining({ restored: false })])
    expect(prompts.at(-1)).toContain('trợ lý soạn test plan')
    const first = sessions[0].sessionId

    await restart(id)
    sessions = await send(id, 'Thêm case huỷ lệnh')
    expect(loads.at(-1)).toBe(first)
    expect(sessions.at(-1)).toMatchObject({ sessionId: first, restored: true })
    // Phiên khôi phục đã có ngữ cảnh: chỉ gửi tin nhắn mới, không gửi lại vai trò và lịch sử.
    expect(prompts.at(-1)).toBe('Thêm case huỷ lệnh')
    expect(memory.get(first)).toHaveLength(2)
  })

  it('tells a restored session to re-read the guide when what the agent sees has changed', async () => {
    const { id } = await ws.call('chats.create', { title: 'Hướng dẫn đổi' })
    let sessions = await send(id, 'Soạn plan')
    const hash = sessions[0].contextHash
    expect(hash).toMatch(/^[0-9a-f]{16}$/)

    // Nền tảng cập nhật: thêm một phần hướng dẫn mới trong lúc Host dừng.
    const fiber = harness.kernel.ctx.plugin({
      name: 'guide-change',
      inject: ['authoring'],
      apply(ctx: any) { ctx.authoring.guideSection({ id: 'test/new-rule', order: 99, render: () => '## Quy tắc mới\nBiến của lượt chạy được tự gắn.' }) },
    })
    await restart(id)
    sessions = await send(id, 'Làm tiếp')
    expect(sessions.at(-1)).toMatchObject({ restored: true, contextChanged: true })
    expect(sessions.at(-1).contextHash).not.toBe(hash)
    expect(prompts.at(-1)).toContain('## Nền tảng đã cập nhật')
    expect(prompts.at(-1)).toContain('Gọi lại `get_authoring_guide`')
    // Chỉ nhắc một lần; khôi phục lại khi không đổi gì thì không nhắc.
    expect(await send(id, 'Tiếp nữa').then(() => prompts.at(-1))).toBe('Tiếp nữa')
    await restart(id)
    sessions = await send(id, 'Sau khi khởi động lại')
    expect(sessions.at(-1)).not.toHaveProperty('contextChanged')
    expect(prompts.at(-1)).toBe('Sau khi khởi động lại')
    fiber.dispose()
  })

  it('opens a new session with history, draft and environment when the agent lost the session', async () => {
    const { id } = await ws.call('chats.create', { env: 'local' })
    await send(id, 'Bắt đầu')
    await ws.call('chats.editDraft', { chatId: id, content: 'id: TP-DRAFT\nname: Nháp\n' })
    await restart(id)
    memory.clear()
    const sessions = await send(id, 'Làm tiếp')
    expect(sessions.at(-1)).toMatchObject({ restored: false, previous: sessions[0].sessionId, restoreError: expect.stringContaining('not found') })
    const prompt = prompts.at(-1)!
    expect(prompt).toContain('trợ lý soạn test plan')
    expect(prompt).toContain('## Lịch sử hội thoại trước đó')
    expect(prompt).toContain('Người dùng: Bắt đầu')
    expect(prompt).toContain('## Trạng thái hiện tại')
    expect(prompt).toContain('Môi trường: `local`.')
    expect(prompt).toContain('id: TP-DRAFT')
  })

  it('falls back to a new session when the agent cannot load sessions', async () => {
    supportsLoad = false
    const { id } = await ws.call('chats.create', {})
    await send(id, 'Một')
    await restart(id)
    const before = loads.length
    const sessions = await send(id, 'Hai')
    expect(loads.length).toBe(before)
    expect(sessions.at(-1)).toMatchObject({ restored: false, previous: sessions[0].sessionId })
    expect(prompts.at(-1)).toContain('Người dùng: Một')
    supportsLoad = true
  })
})
