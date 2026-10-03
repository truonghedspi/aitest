import { useEffect, useMemo, useRef, useState } from 'react'
import { connection } from '../connection.ts'
import { defaultEnv, EnvSelect, useEnvs, useSelectedEnv } from '../env.tsx'
import { timeline, type TimelineItem } from '../derive.ts'
import { Markdown } from '../markdown.tsx'
import { slots, type ClientPlugin, type PageProps } from '../slots.ts'
import { useChat, useChatList } from '../store.ts'
import type { ChatSummary } from '../types.ts'
import { ToolCallCard } from '../components.tsx'
import { DiffView, Json } from './tool-views.tsx'
import { MemoryPreview } from './context-page.tsx'

/** Trang soạn plan cùng agent: danh sách cuộc chat ở cột trái, hội thoại và bảng plan ở giữa. */
export const chatPage: ClientPlugin = (s) => {
  s.page.register('chat', { id: 'chat', title: 'Soạn plan', order: 0, component: ChatPage, sidebar: ChatSidebar })
}

const STATUS_LABEL = { idle: 'Sẵn sàng', running: 'Agent đang làm việc…', waiting: 'Chờ bạn duyệt' } as const

/** Tiêu đề lấy từ log (`chat/renamed` gần nhất), để cập nhật ngay khi cuộc chat tự đặt tên. */
function chatTitle(events: Array<{ type: string; data: any }>): string | undefined {
  return events.findLast((e) => e.type === 'chat/renamed' || e.type === 'chat/created')?.data?.title
}

/** Chế độ duyệt người dùng chọn gần nhất; cuộc chat mới dùng lại chế độ này. */
const PERMISSION_KEY = 'aitest.permissionMode'
function lastPermissionMode(): 'ask' | 'auto' | undefined {
  try {
    const value = localStorage.getItem(PERMISSION_KEY)
    return value === 'auto' || value === 'ask' ? value : undefined
  } catch {
    return undefined
  }
}
function rememberPermissionMode(mode: 'ask' | 'auto') {
  try { localStorage.setItem(PERMISSION_KEY, mode) } catch { /* trình duyệt chặn lưu trữ: bỏ qua */ }
}

async function createChat(navigate: (path: string) => void, env?: string) {
  const chat = await connection.call<ChatSummary>('chats.create', { env, permissionMode: lastPermissionMode() })
  navigate(`chat/${chat.id}`)
}

function ChatSidebar({ param, navigate }: PageProps) {
  const list = useChatList()
  const [env] = useSelectedEnv()
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [cleanup, setCleanup] = useState(false)
  const q = query.trim().toLowerCase()
  const match = (c: ChatSummary) => !q || c.title.toLowerCase().includes(q)
  const active = list.filter((c) => !c.archived && match(c))
  const archived = list.filter((c) => c.archived && match(c))
  const archive = (c: ChatSummary, value: boolean) => connection.call('chats.archive', { chatId: c.id, archived: value }).catch(() => {})

  const item = (c: ChatSummary) => (
    <div key={c.id} className={`chat-item ${c.id === param ? 'active' : ''} ${c.archived ? 'archived' : ''}`}>
      <button className="chat-open" onClick={() => navigate(`chat/${c.id}`)}>
        <span className="title">{c.title}</span>
        <span className="meta">{c.status !== 'idle' ? STATUS_LABEL[c.status] : new Date(c.updatedAt).toLocaleString('vi-VN')}</span>
      </button>
      {c.status === 'idle' && (
        <button className="chat-action" onClick={() => void archive(c, !c.archived)} title={c.archived ? 'Bỏ lưu trữ' : 'Lưu trữ cuộc chat'}>
          {c.archived ? '↩' : '🗄'}
        </button>
      )}
    </div>
  )

  return (
    <>
      <button className="primary wide" onClick={() => createChat(navigate, env)}>+ Cuộc chat mới</button>
      {list.length > 5 && <input className="chat-search" placeholder="Tìm cuộc chat…" value={query} onChange={(e) => setQuery(e.target.value)} />}
      <nav className="chat-list">
        {active.map(item)}
        {!active.length && <div className="muted small">{q ? 'Không có cuộc chat phù hợp.' : 'Chưa có cuộc chat nào.'}</div>}
      </nav>
      <div className="chat-list-footer">
        {archived.length > 0 && (
          <button className="link small" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? '▾' : '▸'} Đã lưu trữ ({archived.length})
          </button>
        )}
        {showArchived && <nav className="chat-list">{archived.map(item)}</nav>}
        <button className="link small" onClick={() => setCleanup(!cleanup)}>Lưu trữ cuộc chat cũ…</button>
        {cleanup && <ArchiveOlder list={list} onDone={() => setCleanup(false)} />}
      </div>
    </>
  )
}

/** Lưu trữ hàng loạt cuộc chat không hoạt động quá N ngày; xem trước số lượng trước khi làm. */
function ArchiveOlder({ list, onDone }: { list: ChatSummary[]; onDone(): void }) {
  const [days, setDays] = useState(30)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()
  const cutoff = Date.now() - days * 86_400_000
  const count = list.filter((c) => !c.archived && c.status === 'idle' && Date.parse(c.updatedAt) < cutoff).length
  const run = async () => {
    setBusy(true)
    try {
      const { archived } = await connection.call<{ archived: string[] }>('chats.archiveOlder', { days })
      setResult(`Đã lưu trữ ${archived.length} cuộc chat.`)
      setTimeout(onDone, 1500)
    } catch (e) {
      setResult((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="archive-older">
      <label className="small">
        Không hoạt động quá{' '}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30, 90].map((d) => <option key={d} value={d}>{d} ngày</option>)}
        </select>
      </label>
      <div className="small muted">{count} cuộc chat sẽ được lưu trữ; bỏ lưu trữ lại được bất cứ lúc nào.</div>
      <button className="primary" disabled={busy || !count} onClick={run}>Lưu trữ {count} cuộc chat</button>
      {result && <div className="small">{result}</div>}
    </div>
  )
}

function ChatPage({ param, navigate }: PageProps) {
  const [env] = useSelectedEnv()
  if (!param) {
    return (
      <main className="welcome">
        <h1>Soạn test plan cùng AI</h1>
        <p>Mô tả tính năng cần kiểm thử. Agent đọc tài liệu, khảo sát hệ thống, soạn plan, kiểm tra và chạy thử trước khi lưu.</p>
        <button className="primary" onClick={() => createChat(navigate, env)}>Bắt đầu cuộc chat mới</button>
      </main>
    )
  }
  return <div className="chat-page"><ChatView key={param} chatId={param} /></div>
}

function ChatView({ chatId }: { chatId: string }) {
  const chat = useChat(chatId)
  const items = useMemo(() => timeline(chat.events), [chat.events])
  const archived = !!chat.events.findLast((e) => e.type === 'chat/archived')?.data.archived
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
          <ArchiveButton chatId={chatId} archived={archived} busy={chat.status !== 'idle'} />
          {!archived && <ChatEnvPicker chatId={chatId} events={chat.events} busy={chat.status !== 'idle'} />}
          {!archived && <ModelPicker chatId={chatId} busy={chat.status !== 'idle'} />}
          {!archived && <PermissionToggle chatId={chatId} mode={permissionMode(chat.events, chat.summary?.permissionMode)} />}
          <span className={`status ${chat.status}`}>{STATUS_LABEL[chat.status]}</span>
        </header>
        <div className="timeline">
          {items.map((item) => <Item key={`${item.kind}-${item.seq}`} item={item} chatId={chatId} />)}
          {chat.live.thought && <div className="thought live">{chat.live.thought}</div>}
          {chat.live.message && <div className="bubble agent live"><Markdown text={chat.live.message} /></div>}
          <div ref={bottom} />
        </div>
        {archived ? (
          <div className="archived-banner">
            Cuộc chat đã lưu trữ: chỉ xem được. Bỏ lưu trữ để nhắn tiếp; agent tiếp tục từ phiên cũ.
            {' '}<button className="primary" onClick={() => void connection.call('chats.archive', { chatId, archived: false })}>Bỏ lưu trữ</button>
          </div>
        ) : <Composer chatId={chatId} status={chat.status} />}
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
    case 'tool': return (
      <ToolCallCard call={item.call} pending={item.pending}
        onCancel={() => void connection.call('chats.cancelTool', { chatId, callId: item.call.callId }).catch(() => {})} />
    )
    case 'agent-tool': return <div className="agent-tool">⚙ {item.title} — {item.status}</div>
    case 'permission': return <PermissionCard item={item} chatId={chatId} />
    case 'note': return <div className="note">{item.text}</div>
    case 'error': return <div className="note bad">Lỗi: {item.text}</div>
  }
}

interface ModelState {
  current?: string
  /** Model mặc định đã cấu hình nhưng agent không có. */
  fallbackFrom?: string
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
      {state.fallbackFrom && (
        <span className="warn small" title={`Model mặc định ${state.fallbackFrom} không có trong danh sách của agent; đang dùng ${state.current}. Đổi model mặc định bằng AITEST_MODEL.`}>
          ⚠ không có {state.fallbackFrom}
        </span>
      )}
      {error && <span className="bad small" title={error}>!</span>}
    </label>
  )
}

/** Môi trường của cuộc chat: khảo sát và chạy thử của agent dùng môi trường này. */
function ArchiveButton({ chatId, archived, busy }: { chatId: string; archived: boolean; busy: boolean }) {
  if (archived) return <span className="badge">Đã lưu trữ</span>
  return (
    <button className="link small" disabled={busy} title={busy ? 'Chờ agent xong lượt hiện tại' : 'Ẩn khỏi danh sách, giải phóng phiên agent'}
      onClick={() => void connection.call('chats.archive', { chatId, archived: true })}>
      Lưu trữ
    </button>
  )
}

function permissionMode(events: Array<{ type: string; data: any }>, fallback?: 'ask' | 'auto'): 'ask' | 'auto' {
  return events.findLast((e) => e.type === 'chat/permissionMode')?.data.mode ?? fallback ?? 'ask'
}

/** Bật/tắt tự duyệt tool cho cuộc chat; lựa chọn được nhớ cho cuộc chat mới. */
function PermissionToggle({ chatId, mode }: { chatId: string; mode: 'ask' | 'auto' }) {
  const [error, setError] = useState<string>()
  const toggle = async () => {
    const next = mode === 'auto' ? 'ask' : 'auto'
    setError(undefined)
    try {
      await connection.call('chats.setPermissionMode', { chatId, mode: next })
      rememberPermissionMode(next)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <button className={`permission-toggle ${mode}`} onClick={toggle}
      title={mode === 'auto'
        ? 'Đang tự duyệt: chạy thử, lưu plan, ghi bộ nhớ… chạy không cần hỏi. Thêm tool mới và tool riêng của agent vẫn hỏi. Bấm để tắt.'
        : 'Đang hỏi trước khi chạy tool có tác động. Bấm để tự duyệt.'}>
      {mode === 'auto' ? '⚡ Tự duyệt' : 'Hỏi duyệt'}
      {error && <span className="bad small" title={error}> !</span>}
    </button>
  )
}

function ChatEnvPicker({ chatId, events, busy }: { chatId: string; events: Array<{ type: string; data: any }>; busy: boolean }) {
  const envs = useEnvs()
  const [error, setError] = useState<string>()
  if (!envs?.length) return null
  const current = events.findLast((e) => e.type === 'chat/env')?.data.env ?? defaultEnv(envs)
  const change = async (env: string) => {
    setError(undefined)
    try {
      await connection.call('chats.setEnv', { chatId, env })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <span className={busy ? 'disabled' : ''} title={busy ? 'Chờ agent xong lượt hiện tại để đổi môi trường' : undefined}>
      <EnvSelect value={current} onChange={(env) => { if (!busy) void change(env) }} compact />
      {error && <span className="bad small" title={error}> !</span>}
    </span>
  )
}

function PermissionCard({ item, chatId }: { item: Extract<TimelineItem, { kind: 'permission' }>; chatId: string }) {
  const decide = (allowed: boolean) => connection.call('chats.decide', { chatId, requestId: item.requestId, allowed })
  // Tool không phải của aitest (hoặc thuộc nhóm luôn hỏi) vẫn chờ: duyệt luôn yêu cầu này bằng tay.
  const autoFromNow = async () => {
    rememberPermissionMode('auto')
    await connection.call('chats.setPermissionMode', { chatId, mode: 'auto' })
    await decide(true).catch(() => {})
  }
  const label = item.tool === 'dry_run' ? 'chạy thử plan trên môi trường kiểm thử'
    : item.tool === 'save_plan' ? 'lưu plan' : item.title
  return (
    <div className={`permission ${item.decision === undefined ? 'open' : item.decision ? 'allowed' : 'denied'}`}>
      <div>Agent xin phép <b>{label}</b></div>
      {item.preview?.kind === 'tool-proposal' ? <ToolProposal preview={item.preview} />
        : item.preview?.kind === 'memory' ? <MemoryPreview preview={item.preview} />
        : item.preview?.kind === 'context-change' ? <ContextChangePreview preview={item.preview} />
        : item.preview !== undefined ? <Json value={item.preview} />
        : item.args !== undefined && item.tool !== 'dry_run' && item.tool !== 'save_plan' && <Json value={item.args} />}
      {item.tool === 'save_plan' && <div className="muted">Đường dẫn: <code>{(item.args as any)?.path}</code></div>}
      {item.decision === undefined
        ? (
          <div className="actions">
            <button className="primary" onClick={() => decide(true)}>Cho phép</button>
            {item.tool && <button onClick={autoFromNow} title="Bật tự duyệt cho cuộc chat này; yêu cầu đang chờ được duyệt luôn">Cho phép và tự duyệt từ giờ</button>}
            <button onClick={() => decide(false)}>Từ chối</button>
          </div>
        )
        : <div className="muted">{!item.decision ? 'Đã từ chối' : item.by === 'auto' ? 'Tự duyệt (chế độ tự duyệt)' : 'Đã cho phép'}</div>}
    </div>
  )
}

/** Bản xem trước của `propose_tool`: đúng cấu hình sẽ ghi vào patch layer và các tool sẽ được bật. */
function ToolProposal({ preview }: { preview: any }) {
  return (
    <div className="proposal">
      {preview.reason && <div>Lý do: {preview.reason}</div>}
      <div>
        Quyền: {preview.access === 'write'
          ? <b className="bad">đọc và ghi: agent gửi được dữ liệu vào hệ thống</b>
          : <b>chỉ đọc</b>}
      </div>
      <div className="tags">
        {preview.tools.read.map((t: string) => <span key={t} className="tag">{t}</span>)}
        {preview.tools.write.map((t: string) => <span key={t} className="tag bad">{t}</span>)}
      </div>
      {preview.env?.length > 0 && (
        <div className="muted">
          Biến môi trường: {preview.env.map((e: { name: string; set: boolean }) => (
            <code key={e.name} className={e.set ? '' : 'warn'}>{e.name}{e.set ? '' : ' (chưa đặt, dùng giá trị mặc định)'} </code>
          ))}
        </div>
      )}
      <div className="muted">
        Row <code>{preview.rowId}</code> dùng plugin <code>{preview.plugin}</code>
        {preview.patchFile ? <>, ghi vào <code>{preview.patchFile}</code></> : null}:
      </div>
      <Json value={preview.config} />
    </div>
  )
}

interface SkillOption { name: string; description: string }

/** Danh sách skill cho gợi ý `/`, nạp lại mỗi khi mở cuộc chat; rỗng khi Host không có plugin thư viện ngữ cảnh. */
const loadSkills = () => connection.call<{ skills: SkillOption[] }>('library.list')
  .then((r) => r.skills.map((x) => ({ name: x.name, description: x.description })), () => [] as SkillOption[])

function Composer({ chatId, status }: { chatId: string; status: string }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const [skills, setSkills] = useState<SkillOption[]>([])
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => { void loadSkills().then(setSkills) }, [chatId])

  // Đang gõ tên skill ở đầu tin nhắn (sau các skill đã chọn): `/api-in`.
  const typing = /^((?:\/[a-z0-9-]+\s+)*)\/([a-z0-9-]*)$/.exec(text)
  const matches = typing && !dismissed ? skills.filter((x) => x.name.startsWith(typing[2])) : []
  const unknown = /^\/([a-z0-9][a-z0-9-]*)\s/.exec(text)
  const unknownName = unknown && skills.length && !skills.some((x) => x.name === unknown[1]) ? unknown[1] : undefined

  const pick = (name: string) => {
    setText(`${typing?.[1] ?? ''}/${name} `)
    setActive(0)
  }
  const send = async () => {
    if (!text.trim()) return
    setError(undefined)
    try {
      await connection.call('chats.send', { chatId, text })
      setText('')
      setDismissed(false)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        pick(matches[Math.min(active, matches.length - 1)].name)
        return
      }
      if (e.key === 'Escape') { setDismissed(true); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
  }
  return (
    <div className="composer">
      {error && <div className="bad">{error}</div>}
      {matches.length > 0 && (
        <ul className="skill-menu" role="listbox">
          {matches.map((x, i) => (
            <li key={x.name} role="option" aria-selected={i === active} className={i === active ? 'active' : ''}
              onMouseDown={(e) => { e.preventDefault(); pick(x.name) }}>
              <code>/{x.name}</code> <span className="muted">{x.description}</span>
            </li>
          ))}
        </ul>
      )}
      {unknownName && <div className="muted small">Không có skill <code>/{unknownName}</code>; tin nhắn được gửi như văn bản thường.</div>}
      <textarea
        value={text}
        placeholder={`Mô tả tính năng cần kiểm thử, hoặc góp ý cho bản nháp… (Enter để gửi, Shift+Enter xuống dòng${skills.length ? ', / để gọi skill' : ''})`}
        onChange={(e) => { setText(e.target.value); setDismissed(false) }}
        onKeyDown={onKeyDown}
      />
      <div className="actions">
        {status !== 'idle'
          ? <button onClick={() => connection.call('chats.cancel', { chatId })}>Dừng</button>
          : <button className="primary" onClick={send} disabled={!text.trim()}>Gửi</button>}
      </div>
    </div>
  )
}

/** Bản xem trước khi agent đề xuất sửa catalog hệ thống hoặc tài liệu ngữ cảnh: file, lý do, diff. */
function ContextChangePreview({ preview }: { preview: { target: string; summary?: string; reason?: string; diff: string } }) {
  return (
    <div className="context-change">
      <div className="muted small">
        Ngữ cảnh dùng chung · <code>{preview.target}</code>{preview.summary ? ` · ${preview.summary}` : ''}
      </div>
      {preview.reason && <div className="small">Nguồn: {preview.reason}</div>}
      <DiffView diff={preview.diff} />
      <div className="muted small">Thay đổi này áp dụng cho mọi plan dùng ngữ cảnh này; file nằm trong git nên xem lại được qua pull request.</div>
    </div>
  )
}
