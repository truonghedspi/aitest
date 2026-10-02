import type { WebConnection } from '@aitest/web-host'
import type { Context, RunEvent } from '@aitest/core'
import type { ChatService } from './index.ts'

/**
 * Method WebSocket của cuộc chat, theo mẫu luồng follow của dsh:
 * `chats.subscribe` trả snapshot các event sau `afterSeq`, sau đó host đẩy từng event mới
 * (`{ type: 'event' }`) và khung tạm (`{ type: 'live' }`). Client loại event trùng theo `seq`
 * và gọi lại `chats.subscribe` với `seq` cuối cùng khi kết nối lại.
 */
export function registerWebMethods(ctx: Context, chats: ChatService) {
  const listWatchers = new Set<WebConnection>()
  const pushList = async () => {
    if (!listWatchers.size) return
    const list = await chats.list()
    for (const connection of listWatchers) connection.push({ type: 'chats', list })
  }

  ctx.on('chat/live', (_chatId, frame) => {
    if (frame.type === 'status') void pushList()
  })

  ctx.web.method('chats.list', () => chats.list())

  ctx.web.method('chats.watchList', async (_params, connection: WebConnection) => {
    listWatchers.add(connection)
    connection.onClose(() => listWatchers.delete(connection))
    return chats.list()
  })

  ctx.web.method('chats.create', async (params: { title?: string }) => {
    const chat = await chats.create(params.title)
    void pushList()
    return chat.summary()
  })

  ctx.web.method('chats.subscribe', async (params: { chatId: string; afterSeq?: number }, connection: WebConnection) => {
    const chat = await chats.get(params.chatId)
    // Đăng ký listener trước khi lấy snapshot để không mất event ở giữa; client loại trùng theo seq.
    const offEvent = ctx.on('run/event', (event: RunEvent) => {
      if (event.runId === chat.id) connection.push({ type: 'event', chatId: chat.id, event })
    })
    const offLive = ctx.on('chat/live', (chatId, frame) => {
      if (chatId === chat.id) connection.push({ type: 'live', chatId, frame })
    })
    connection.onClose(() => { offEvent(); offLive() })
    return { summary: chat.summary(), events: chat.events(params.afterSeq ?? 0) }
  })

  ctx.web.method('chats.send', async (params: { chatId: string; text: string }) => {
    const chat = await chats.get(params.chatId)
    if (chat.status !== 'idle') throw new Error('agent is still working on the previous message')
    if (!params.text?.trim()) throw new Error('message is empty')
    // Một lượt có thể kéo dài nhiều phút; kết quả về qua luồng event.
    void chat.send(params.text).catch((error) => ctx.logger('chat').warn(error))
    void pushList()
    return { accepted: true }
  })

  ctx.web.method('chats.cancel', async (params: { chatId: string }) => {
    ;(await chats.get(params.chatId)).cancel()
    return { cancelled: true }
  })

  ctx.web.method('chats.decide', async (params: { chatId: string; requestId: string; allowed: boolean }) => {
    ;(await chats.get(params.chatId)).decide(params.requestId, params.allowed)
    return { ok: true }
  })

  ctx.web.method('chats.editDraft', async (params: { chatId: string; content: string }) => {
    ;(await chats.get(params.chatId)).editDraft(params.content)
    return { ok: true }
  })

  ctx.web.method('chats.listPlans', async (params: { chatId: string }) => (await chats.get(params.chatId)).listPlans())

  ctx.web.method('chats.openPlan', async (params: { chatId: string; path: string }) => {
    return (await chats.get(params.chatId)).openPlan(params.path)
  })

  ctx.web.method('chats.models', async (params: { chatId: string }) => (await chats.get(params.chatId)).models())

  ctx.web.method('chats.setModel', async (params: { chatId: string; modelId: string }) => {
    return (await chats.get(params.chatId)).setModel(params.modelId)
  })

  ctx.web.method('chats.invoke', async (params: { chatId: string; tool: string; args: Record<string, unknown> }) => {
    const outcome = await (await chats.get(params.chatId)).invoke(params.tool, params.args ?? {})
    return { status: outcome.status, value: outcome.value, error: outcome.error }
  })
}
