import { useEffect, useSyncExternalStore } from 'react'
import { connection } from './connection.ts'
import type { ChatStatus, ChatSummary, LiveFrame, RunEvent } from './types.ts'

/**
 * Trạng thái phía client của một cuộc chat, dựng hoàn toàn từ log của Host.
 *
 * Luồng follow: `chats.subscribe` trả snapshot các event sau `seq` cuối đã có, sau đó Host đẩy
 * từng event mới. Event trùng hoặc cũ bị bỏ qua theo `seq`. Khi kết nối lại, store đăng ký lại
 * với `seq` cuối nên không mất và không lặp event. `live` chỉ giữ token đang stream, xoá khi
 * event bền vững tương ứng tới.
 */
export interface ChatSnapshot {
  summary?: ChatSummary
  events: RunEvent[]
  status: ChatStatus
  live: { message: string; thought: string }
}

class ChatStore {
  private snapshot: ChatSnapshot = { events: [], status: 'idle', live: { message: '', thought: '' } }
  private readonly listeners = new Set<() => void>()
  private lastSeq = 0

  constructor(readonly chatId: string) {
    connection.listen((message) => {
      if (message.chatId !== chatId) return
      if (message.type === 'event') this.accept([message.event])
      if (message.type === 'live') this.live(message.frame)
    })
    connection.onOpen(() => void this.subscribe())
    void this.subscribe()
  }

  get = () => this.snapshot

  subscribeStore = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async subscribe() {
    const result = await connection.call<{ summary: ChatSummary; events: RunEvent[] }>('chats.subscribe', {
      chatId: this.chatId, afterSeq: this.lastSeq,
    }).catch(() => undefined)
    if (!result) return
    this.set({ summary: result.summary, status: result.summary.status })
    this.accept(result.events)
  }

  private accept(events: RunEvent[]) {
    const fresh = events.filter((e) => e.seq > this.lastSeq).sort((a, b) => a.seq - b.seq)
    if (!fresh.length) return
    this.lastSeq = fresh.at(-1)!.seq
    let { message, thought } = this.snapshot.live
    for (const e of fresh) {
      if (e.type === 'agent/message' || e.type === 'turn/end') message = ''
      if (e.type === 'agent/thought' || e.type === 'turn/end') thought = ''
    }
    this.set({ events: [...this.snapshot.events, ...fresh], live: { message, thought } })
  }

  private live(frame: LiveFrame) {
    if (frame.type === 'status') return this.set({ status: frame.status })
    const live = { ...this.snapshot.live }
    live[frame.kind] += frame.text
    this.set({ live })
  }

  private set(patch: Partial<ChatSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}

const stores = new Map<string, ChatStore>()

export function useChat(chatId: string): ChatSnapshot {
  let store = stores.get(chatId)
  if (!store) stores.set(chatId, store = new ChatStore(chatId))
  return useSyncExternalStore(store.subscribeStore, store.get)
}

let chatList: ChatSummary[] = []
const listListeners = new Set<() => void>()
const setList = (list: ChatSummary[]) => {
  chatList = list
  for (const l of listListeners) l()
}
connection.listen((message) => { if (message.type === 'chats') setList(message.list) })
connection.onOpen(() => { void connection.call<ChatSummary[]>('chats.watchList').then(setList) })

export function useChatList(): ChatSummary[] {
  useEffect(() => { void connection.call<ChatSummary[]>('chats.watchList').then(setList) }, [])
  return useSyncExternalStore((l) => { listListeners.add(l); return () => { listListeners.delete(l) } }, () => chatList)
}
