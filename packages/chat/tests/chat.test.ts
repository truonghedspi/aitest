/**
 * Kiểm thử Host chat qua giao thức WebSocket thật, với agent giả lập:
 * agent stream tin nhắn, gọi tool soạn plan qua MCP gateway và xin quyền trước khi lưu, như Kiro qua ACP.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AgentDriver } from '@aitest/core'
import type {} from '@aitest/chat'
import { setupHarness, WsClient, type Harness } from '../../runner/tests/support.ts'

const PLAN = `id: TP-CHAT
name: Plan từ cuộc chat
requires: [http]
cases:
  - id: C1
    title: Gọi danh sách lệnh
    steps: [Gọi GET http://127.0.0.1:4195/orders.]
    expect:
      - { id: http-200, desc: API trả về 200, check: { op: eq, value: 200 } }
`

/** Model mà agent giả lập đã nhận: lúc mở session và mỗi lần đổi. */
const modelLog: string[] = []

/** Agent giả lập: mỗi lượt kiểm tra plan, xin quyền rồi lưu; ghi lại prompt nhận được. */
function fakeAgent(prompts: string[]): AgentDriver {
  return {
    name: 'fake-chat',
    async connect() {
      return {
        info: { name: 'fake' },
        async newSession(options) {
          const client = new Client({ name: 'fake-agent', version: '0' })
          await client.connect(new StreamableHTTPClientTransport(new URL(options.mcpServers[0].url)))
          const call = async (name: string, args: Record<string, unknown>) => {
            const res = await client.callTool({ name, arguments: args })
            return JSON.parse((res.content as Array<{ text: string }>)[0].text)
          }
          const models = {
            current: options.model ?? 'auto',
            available: [{ id: 'auto', name: 'auto' }, { id: 'fast', name: 'fast', description: 'Model nhanh' }],
          }
          modelLog.push(`open:${models.current}`)
          return {
            id: 'fake-session',
            models,
            async setModel(id: string) {
              if (!models.available.some((m) => m.id === id)) throw new Error(`unknown model ${id}`)
              models.current = id
              modelLog.push(`set:${id}`)
            },
            async prompt(text) {
              prompts.push(text)
              options.onUpdate({ kind: 'message', text: 'Đang soạn ', raw: {} })
              options.onUpdate({ kind: 'message', text: 'bản nháp.', raw: {} })
              options.onUpdate({ kind: 'tool_call', text: 'Running: @aitest/validate_plan', raw: { toolCallId: 'v1', title: 'Running: @aitest/validate_plan' } })
              const allowedValidate = await options.onPermission!({ title: 'Running: @aitest/validate_plan', raw: { toolCallId: 'v1' } })
              if (allowedValidate) await call('validate_plan', { content: PLAN })
              const allowedSave = await options.onPermission!({
                title: 'Running: @aitest/save_plan', raw: { toolCallId: 's1', rawInput: { path: 'chat/test.plan.yaml' } },
              })
              if (allowedSave) await call('save_plan', { path: 'chat/test.plan.yaml', content: PLAN })
              options.onUpdate({ kind: 'message', text: allowedSave ? 'Đã lưu.' : 'Không lưu.', raw: {} })
              return { stopReason: 'end_turn' }
            },
            close: () => client.close(),
          }
        },
        async close() {},
      }
    },
  }
}

describe('chat host over WebSocket', () => {
  let harness: Harness
  let ws: WsClient
  const prompts: string[] = []

  beforeAll(async () => {
    harness = await setupHarness({
      port: 4195,
      config: 'aitest.web.yml',
      scripts: {},
      rows: (dir) => [
        { id: 'web', name: '@aitest/web-host', config: { port: 0, staticDir: join(dir, 'static') } },
        { id: 'chat', name: '@aitest/chat', config: { agent: 'fake-chat', dir: join(dir, 'chats') } },
        { id: 'authoring-save', name: '@aitest/authoring/save', config: { dir: join(dir, 'plans') } },
      ],
    })
    harness.kernel.ctx.agents.register(fakeAgent(prompts))
    const url = await harness.kernel.ctx.web.ready()
    ws = await WsClient.open(url.replace('http', 'ws') + '/ws')
  })

  afterAll(async () => {
    ws?.socket.close()
    await harness?.dispose()
  })

  it('runs a turn: streams, logs tool calls with views, waits for approval, then saves', async () => {
    const chat = await ws.call('chats.create', { title: 'Soạn plan thử' })
    const snapshot = await ws.call('chats.subscribe', { chatId: chat.id })
    expect(snapshot.events.map((e: any) => e.type)).toEqual(['chat/created'])

    await ws.call('chats.send', { chatId: chat.id, text: 'Soạn plan gọi danh sách lệnh' })
    const request = await ws.waitFor((m) => m.type === 'event' && m.event.type === 'permission/request')
    expect(request.event.data).toMatchObject({ tool: 'save_plan', args: { path: 'chat/test.plan.yaml' } })
    await ws.waitFor((m) => m.type === 'live' && m.frame.type === 'status' && m.frame.status === 'waiting')

    await ws.call('chats.decide', { chatId: chat.id, requestId: request.event.data.requestId, allowed: true })
    await ws.waitFor((m) => m.type === 'event' && m.event.type === 'turn/end')

    const events = ws.pushed.filter((m) => m.type === 'event').map((m) => m.event)
    const types = events.map((e) => e.type)
    // Tool chỉ đọc được duyệt tự động; tool ghi cần người dùng duyệt.
    expect(events.find((e) => e.type === 'permission/decision' && e.data.tool === 'validate_plan').data.by).toBe('policy')
    expect(events.find((e) => e.type === 'permission/decision' && e.data.tool === 'save_plan').data.by).toBe('user')
    expect(types).toContain('agent/prompt')
    expect(events.find((e) => e.type === 'agent/message').data.text).toBe('Đang soạn bản nháp.')
    const validate = events.find((e) => e.type === 'action/call' && e.data.name === 'validate_plan')
    expect(validate.data.view).toMatchObject({ kind: 'plan-validation', valid: true })
    expect(await readFile(join(harness.dir, 'plans/chat/test.plan.yaml'), 'utf8')).toBe(PLAN)

    // Chỉ dẫn vai trò chỉ gửi ở lượt đầu và đã được ghi vào log.
    expect(prompts[0]).toContain('trợ lý soạn test plan')
    expect(events.find((e) => e.type === 'agent/prompt').data.text).toBe(prompts[0])
  })

  it('replays only newer events after a given seq and lists chats', async () => {
    const [chat] = await ws.call('chats.list')
    const all = await ws.call('chats.subscribe', { chatId: chat.id })
    const last = all.events.at(-1).seq
    const tail = await ws.call('chats.subscribe', { chatId: chat.id, afterSeq: last - 2 })
    expect(tail.events.map((e: any) => e.seq)).toEqual([last - 1, last])
    expect(chat).toMatchObject({ title: 'Soạn plan thử', status: 'idle' })
  })

  it('runs UI-invoked tools without the agent and tells the agent on the next turn', async () => {
    const [chat] = await ws.call('chats.list')
    await ws.call('chats.editDraft', { chatId: chat.id, content: PLAN.replace('TP-CHAT', 'TP-EDITED') })
    const outcome = await ws.call('chats.invoke', { chatId: chat.id, tool: 'validate_plan', args: { content: PLAN } })
    expect(outcome).toMatchObject({ status: 'ok', value: { valid: true } })
    await expect(ws.call('chats.invoke', { chatId: chat.id, tool: 'explore', args: {} })).rejects.toThrow(/cannot be invoked/)

    const pushedBefore = ws.pushed.length
    await ws.call('chats.send', { chatId: chat.id, text: 'Tiếp tục' })
    const request = await ws.waitFor((m) => ws.pushed.indexOf(m) >= pushedBefore && m.type === 'event' && m.event.type === 'permission/request')
    await ws.call('chats.decide', { chatId: chat.id, requestId: request.event.data.requestId, allowed: false })
    await ws.waitFor((m) => ws.pushed.indexOf(m) >= pushedBefore && m.type === 'event' && m.event.type === 'turn/end')

    const second = prompts[1]
    expect(second).toContain('TP-EDITED')
    expect(second).toContain('Người dùng đã tự chạy `validate_plan`')
    expect(second).not.toContain('trợ lý soạn test plan')
    const userCall = (await ws.call('chats.subscribe', { chatId: chat.id })).events
      .find((e: any) => e.type === 'action/call' && e.data.phase === 'user')
    expect(userCall.data.name).toBe('validate_plan')
  })

  it('lists models and switches the model of a chat', async () => {
    const [summary] = await ws.call('chats.list')
    const models = await ws.call('chats.models', { chatId: summary.id })
    expect(models).toMatchObject({ current: 'auto', switchable: true, available: [{ id: 'auto' }, { id: 'fast' }] })
    const changed = await ws.call('chats.setModel', { chatId: summary.id, modelId: 'fast' })
    expect(changed.current).toBe('fast')
    expect(modelLog.at(-1)).toBe('set:fast')
    await expect(ws.call('chats.setModel', { chatId: summary.id, modelId: 'nope' })).rejects.toThrow(/unknown model nope/)
    const events = (await ws.call('chats.subscribe', { chatId: summary.id })).events
    expect(events.filter((e: any) => e.type === 'chat/model').map((e: any) => e.data.modelId)).toEqual(['fast'])
  })

  it('restores a chat from its log and sends the history to a new agent session', async () => {
    const [summary] = await ws.call('chats.list')
    // Bỏ cuộc chat khỏi bộ nhớ, như sau khi Host khởi động lại.
    const service = harness.kernel.ctx.chats as unknown as { chats: Map<string, { dispose(): Promise<void> }> }
    await service.chats.get(summary.id)!.dispose()
    service.chats.delete(summary.id)

    const restored = await harness.kernel.ctx.chats.get(summary.id)
    expect(restored.events()[0].type).toBe('chat/created')
    const lastSeq = restored.events().at(-1)!.seq
    const turn = restored.send('Lưu lại giúp tôi')
    await ws.call('chats.subscribe', { chatId: summary.id, afterSeq: lastSeq })
    const request = await ws.waitFor((m) => m.type === 'event' && m.event.seq > lastSeq && m.event.type === 'permission/request')
    restored.decide(request.event.data.requestId, false)
    await turn

    const third = prompts[2]
    expect(third).toContain('trợ lý soạn test plan')
    expect(third).toContain('## Lịch sử hội thoại trước đó')
    expect(third).toContain('Người dùng: Soạn plan gọi danh sách lệnh')
    // seq tiếp nối log cũ, không bắt đầu lại từ 1.
    expect(restored.events(lastSeq)[0].seq).toBe(lastSeq + 1)
    // Model đã chọn trước khi khởi động lại được áp dụng cho session mới.
    expect(modelLog.at(-1)).toBe('open:fast')
  })
})
