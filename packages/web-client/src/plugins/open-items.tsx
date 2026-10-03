import { useCallback, useEffect, useMemo, useState } from 'react'
import { connection } from '../connection.ts'
import type { ClientPlugin, PanelProps, ToolViewProps } from '../slots.ts'
import { useChat, useChatList } from '../store.ts'

/**
 * Việc còn mở (plugin `open-items`): bảng cạnh bản nháp của cuộc chat, thẻ trong dòng thời gian,
 * và tab tổng hợp trên trang Ngữ cảnh. Đóng việc trên giao diện thì agent được báo ở lượt kế tiếp.
 */
export const openItems: ClientPlugin = (s) => {
  s.panel.register('open-items', { id: 'open-items', title: 'Việc còn mở', order: 5, component: OpenItemsPanel })
  s.toolView.register('open-item', OpenItemView)
}

type Kind = 'question' | 'decision' | 'issue' | 'todo'
type Status = 'open' | 'resolved' | 'dropped'

interface OpenItem {
  id: string
  kind: Kind
  title: string
  detail?: string
  options?: string[]
  status: Status
  resolution?: string
  chatId: string
  plan?: string
  systems?: string[]
  created: string
  updated: string
  closedBy?: string
}

const KIND: Record<Kind, string> = { question: 'Câu hỏi', decision: 'Quyết định', issue: 'Vấn đề', todo: 'Việc cần làm' }
const STATUS: Record<Status, string> = { open: 'còn mở', resolved: 'đã chốt', dropped: 'đã bỏ' }

function OpenItemsPanel({ chatId }: PanelProps) {
  const { events } = useChat(chatId)
  const [items, setItems] = useState<OpenItem[]>([])
  // Tải lại khi agent ghi hoặc đóng việc trong cuộc chat này.
  const version = useMemo(() => events.filter((e) => e.type === 'action/call' && /^open_item_(add|resolve)$/.test((e.data as { name?: string }).name ?? '')).length, [events])
  const reload = useCallback(() => { void connection.call<OpenItem[]>('openItems.list', { chatId }).then(setItems) }, [chatId])
  useEffect(reload, [reload, version])

  const open = items.filter((i) => i.status === 'open')
  const closed = items.filter((i) => i.status !== 'open')
  return (
    <div className="open-items">
      <p className="muted small">
        Điều chưa chốt trong cuộc chat này. Agent nhắc lại ở mỗi lượt và ở cuộc chat sau cho tới khi việc được đóng.
        Chốt ở đây thì agent được báo ở lượt kế tiếp.
      </p>
      {open.length === 0 && <div className="muted">Không có việc còn mở.</div>}
      {open.map((i) => <OpenItemCard key={i.id} item={i} onChanged={reload} />)}
      {closed.length > 0 && (
        <details>
          <summary className="muted small">Đã đóng ({closed.length})</summary>
          {closed.map((i) => <OpenItemCard key={i.id} item={i} onChanged={reload} />)}
        </details>
      )}
    </div>
  )
}

/** Một việc: chốt bằng một phương án hoặc câu trả lời tự do, bỏ, hoặc mở lại. */
export function OpenItemCard({ item, onChanged, chatTitle }: { item: OpenItem; onChanged(): void; chatTitle?: string }) {
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string>()
  const act = async (method: string, params: Record<string, unknown>) => {
    setError(undefined)
    try {
      await connection.call(method, params)
      setAnswer('')
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const resolve = (resolution: string, status: 'resolved' | 'dropped' = 'resolved') => act('openItems.resolve', { id: item.id, resolution, status })
  return (
    <div className={`card open-item ${item.status}`}>
      <div className="small muted">
        <b>{KIND[item.kind]}</b> · <code>{item.id}</code>{item.plan ? <> · <code>{item.plan}</code></> : null}
        {chatTitle ? <> · <a href={`#/chat/${item.chatId}`}>{chatTitle}</a></> : null} · {item.updated.slice(0, 10)}
      </div>
      <div>{item.title}</div>
      {item.detail && <div className="muted small">{item.detail}</div>}
      {item.status === 'open' ? (
        <>
          {item.options?.length ? (
            <div className="tags">{item.options.map((o) => <button key={o} className="tag" onClick={() => resolve(o)}>{o}</button>)}</div>
          ) : null}
          <div className="row">
            <input placeholder="Câu trả lời hoặc kết luận…" value={answer} onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && answer.trim()) void resolve(answer) }} />
            <button className="primary" disabled={!answer.trim()} onClick={() => resolve(answer)}>Chốt</button>
            <button onClick={() => resolve(answer.trim() || 'Người dùng bỏ trên giao diện', 'dropped')}>Bỏ</button>
          </div>
        </>
      ) : (
        <div className="small">
          <span className={`badge ${item.status === 'resolved' ? 'active' : ''}`}>{STATUS[item.status]}</span> {item.resolution}
          {' '}<button className="link" onClick={() => act('openItems.reopen', { id: item.id })}>Mở lại</button>
        </div>
      )}
      {error && <div className="bad small">{error}</div>}
    </div>
  )
}

/** Tab trên trang Ngữ cảnh: việc còn mở của mọi cuộc chat. */
export function OpenItemsTab() {
  const [items, setItems] = useState<OpenItem[]>()
  const [status, setStatus] = useState<Status>('open')
  const chats = useChatList()
  const reload = useCallback(() => { void connection.call<OpenItem[]>('openItems.list', { status }).then(setItems) }, [status])
  useEffect(reload, [reload])
  const title = (id: string) => chats.find((c) => c.id === id)?.title ?? 'cuộc chat'
  return (
    <>
      <p className="muted">
        Câu hỏi chờ trả lời, quyết định hoãn, vấn đề chưa xử lý mà agent ghi lại khi soạn plan.
        Việc còn mở được nhắc ở đầu mỗi cuộc chat mới (tối đa 30 ngày), nên bạn không phải nhớ chuyện còn dở.
      </p>
      <div className="tabs inline">
        {(Object.keys(STATUS) as Status[]).map((s) => <button key={s} className={s === status ? 'active' : ''} onClick={() => setStatus(s)}>{STATUS[s]}</button>)}
      </div>
      <div className="open-items wide">
        {items?.length === 0 && <div className="muted">Không có việc {STATUS[status]}.</div>}
        {items?.map((i) => <OpenItemCard key={i.id} item={i} onChanged={reload} chatTitle={title(i.chatId)} />)}
      </div>
    </>
  )
}

/** Thẻ `open_item_add`, `open_item_resolve` trong dòng thời gian. */
function OpenItemView({ view }: ToolViewProps) {
  const item = view.item as OpenItem | undefined
  if (!item) return null
  return (
    <div className="small">
      <b>{KIND[item.kind]}</b> <code>{item.id}</code>: {item.title}
      {item.options?.length ? <div className="muted">Phương án: {item.options.join(' | ')}</div> : null}
      {item.status !== 'open' && <div>→ {STATUS[item.status]}: {item.resolution}</div>}
    </div>
  )
}
