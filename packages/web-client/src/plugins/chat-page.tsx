import { useEffect, useMemo, useRef, useState } from 'react'
import { connection } from '../connection.ts'
import { timeline, type TimelineItem } from '../derive.ts'
import { Markdown } from '../markdown.tsx'
import { slots, type ClientPlugin, type PageProps } from '../slots.ts'
import { useChat, useChatList } from '../store.ts'
import type { ChatSummary } from '../types.ts'
import { ToolCallCard } from '../components.tsx'
import { Json } from './tool-views.tsx'

/** Trang soạn plan cùng agent: danh sách cuộc chat ở cột trái, hội thoại và bảng plan ở giữa. */
export const chatPage: ClientPlugin = (s) => {
  s.page.register('chat', { id: 'chat', title: 'Soạn plan', order: 0, component: ChatPage, sidebar: ChatSidebar })
}

const STATUS_LABEL = { idle: 'Sẵn sàng', running: 'Agent đang làm việc…', waiting: 'Chờ bạn duyệt' } as const

/** Tiêu đề lấy từ log (`chat/renamed` gần nhất), để cập nhật ngay khi cuộc chat tự đặt tên. */
function chatTitle(events: Array<{ type: string; data: any }>): string | undefined {
  return events.findLast((e) => e.type === 'chat/renamed' || e.type === 'chat/created')?.data?.title
}

async function createChat(navigate: (path: string) => void) {
  const chat = await connection.call<ChatSummary>('chats.create', {})
  navigate(`chat/${chat.id}`)
}

function ChatSidebar({ param, navigate }: PageProps) {
  const list = useChatList()
  return (
    <>
      <button className="primary wide" onClick={() => createChat(navigate)}>+ Cuộc chat mới</button>
      <nav className="chat-list">
        {list.map((c) => (
          <button key={c.id} className={`chat-item ${c.id === param ? 'active' : ''}`} onClick={() => navigate(`chat/${c.id}`)}>
            <span className="title">{c.title}</span>
            <span className="meta">{c.status !== 'idle' ? STATUS_LABEL[c.status] : new Date(c.updatedAt).toLocaleString('vi-VN')}</span>
          </button>
        ))}
      </nav>
    </>
  )
}

function ChatPage({ param, navigate }: PageProps) {
  if (!param) {
    return (
      <main className="welcome">
        <h1>Soạn test plan cùng AI</h1>
        <p>Mô tả tính năng cần kiểm thử. Agent đọc tài liệu, khảo sát hệ thống, soạn plan, kiểm tra và chạy thử trước khi lưu.</p>
        <button className="primary" onClick={() => createChat(navigate)}>Bắt đầu cuộc chat mới</button>
      </main>
    )
  }
  return <div className="chat-page"><ChatView key={param} chatId={param} /></div>
}

function ChatView({ chatId }: { chatId: string }) {
  const chat = useChat(chatId)
  const items = useMemo(() => timeline(chat.events), [chat.events])
  const panels = slots.panel.values().sort((a, b) => a.order - b.order)
  const [panelId, setPanelId] = useState(panels[0]?.id)
  const Panel = panels.find((p) => p.id === panelId)?.component
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [items.length, chat.live.message])

  return (
    <>
      <main className="conversation">
        <header>
          <h2>{chatTitle(chat.events) ?? chat.summary?.title ?? '…'}</h2>
          <ModelPicker chatId={chatId} busy={chat.status !== 'idle'} />
          <span className={`status ${chat.status}`}>{STATUS_LABEL[chat.status]}</span>
        </header>
        <div className="timeline">
          {items.map((item) => <Item key={`${item.kind}-${item.seq}`} item={item} chatId={chatId} />)}
          {chat.live.thought && <div className="thought live">{chat.live.thought}</div>}
          {chat.live.message && <div className="bubble agent live"><Markdown text={chat.live.message} /></div>}
          <div ref={bottom} />
        </div>
        <Composer chatId={chatId} status={chat.status} />
      </main>
      <aside className="panel">
        <div className="tabs">
          {panels.map((p) => <button key={p.id} className={p.id === panelId ? 'active' : ''} onClick={() => setPanelId(p.id)}>{p.title}</button>)}
        </div>
        {Panel && <Panel chatId={chatId} />}
      </aside>
    </>
  )
}

function Item({ item, chatId }: { item: TimelineItem; chatId: string }) {
  switch (item.kind) {
    case 'user': return <div className="bubble user">{item.text}</div>
    case 'agent': return <div className="bubble agent"><Markdown text={item.text} /></div>
    case 'thought': return <details className="thought"><summary>Suy nghĩ của agent</summary>{item.text}</details>
    case 'tool': return <ToolCallCard call={item.call} pending={item.pending} />
    case 'agent-tool': return <div className="agent-tool">⚙ {item.title} — {item.status}</div>
    case 'permission': return <PermissionCard item={item} chatId={chatId} />
    case 'note': return <div className="note">{item.text}</div>
    case 'error': return <div className="note bad">Lỗi: {item.text}</div>
  }
}

interface ModelState {
  current?: string
  available: Array<{ id: string; name: string; description?: string }>
  switchable: boolean
}

/**
 * Chọn model cho cuộc chat. Danh sách lấy từ agent (mở session agent nếu chưa có).
 * Đổi model áp dụng cho các lượt sau và được ghi vào log của cuộc chat.
 */
function ModelPicker({ chatId, busy }: { chatId: string; busy: boolean }) {
  const [state, setState] = useState<ModelState>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setState(undefined)
    connection.call<ModelState>('chats.models', { chatId }).then(setState, (e) => setError(e.message))
  }, [chatId])

  if (error && !state) return <span className="bad small" title={error}>Không tải được model</span>
  if (!state) return <span className="muted small">Đang tải model…</span>
  if (!state.available.length) return <span className="muted small">Model: {state.current ?? 'mặc định'}</span>

  const change = async (modelId: string) => {
    setSaving(true)
    setError(undefined)
    try {
      setState(await connection.call<ModelState>('chats.setModel', { chatId, modelId }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const current = state.available.find((m) => m.id === state.current)
  return (
    <label className="model-picker" title={current?.description ?? ''}>
      <span className="muted small">Model</span>
      <select value={state.current ?? ''} disabled={busy || saving || !state.switchable} onChange={(e) => change(e.target.value)}>
        {state.available.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.name}</option>)}
      </select>
      {error && <span className="bad small" title={error}>!</span>}
    </label>
  )
}

function PermissionCard({ item, chatId }: { item: Extract<TimelineItem, { kind: 'permission' }>; chatId: string }) {
  const decide = (allowed: boolean) => connection.call('chats.decide', { chatId, requestId: item.requestId, allowed })
  const label = item.tool === 'dry_run' ? 'chạy thử plan trên môi trường kiểm thử'
    : item.tool === 'save_plan' ? 'lưu plan' : item.title
  return (
    <div className={`permission ${item.decision === undefined ? 'open' : item.decision ? 'allowed' : 'denied'}`}>
      <div>Agent xin phép <b>{label}</b></div>
      {item.args !== undefined && item.tool !== 'dry_run' && item.tool !== 'save_plan' && <Json value={item.args} />}
      {item.tool === 'save_plan' && <div className="muted">Đường dẫn: <code>{(item.args as any)?.path}</code></div>}
      {item.decision === undefined
        ? <div className="actions"><button className="primary" onClick={() => decide(true)}>Cho phép</button><button onClick={() => decide(false)}>Từ chối</button></div>
        : <div className="muted">{item.decision ? 'Đã cho phép' : 'Đã từ chối'}</div>}
    </div>
  )
}

function Composer({ chatId, status }: { chatId: string; status: string }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const send = async () => {
    if (!text.trim()) return
    setError(undefined)
    try {
      await connection.call('chats.send', { chatId, text })
      setText('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="composer">
      {error && <div className="bad">{error}</div>}
      <textarea
        value={text}
        placeholder="Mô tả tính năng cần kiểm thử, hoặc góp ý cho bản nháp… (Enter để gửi, Shift+Enter xuống dòng)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
      />
      <div className="actions">
        {status !== 'idle'
          ? <button onClick={() => connection.call('chats.cancel', { chatId })}>Dừng</button>
          : <button className="primary" onClick={send} disabled={!text.trim()}>Gửi</button>}
      </div>
    </div>
  )
}
