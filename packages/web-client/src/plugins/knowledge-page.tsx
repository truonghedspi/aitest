import { useCallback, useEffect, useMemo, useState } from 'react'
import { connection } from '../connection.ts'
import { Markdown } from '../markdown.tsx'
import type { ClientPlugin, PageProps, ToolViewProps } from '../slots.ts'

/**
 * Trang Knowledge và thẻ hiển thị ghi chú trong cuộc chat.
 * Ghi chú lưu thành file Markdown phía Host (plugin `knowledge`); trang này đọc, sửa, thêm, xoá.
 */
export const knowledgePage: ClientPlugin = (s) => {
  s.page.register('knowledge', { id: 'knowledge', title: 'Knowledge', order: 5, component: KnowledgePage })
  s.toolView.register('kb-list', KbListView)
  s.toolView.register('kb-note', KbNoteView)
}

type NoteType = 'bug' | 'convention' | 'lesson'

interface Note {
  id: string
  type: NoteType
  title: string
  status?: 'open' | 'fixed'
  feature?: string
  cases?: string[]
  source?: string
  created?: string
  updated?: string
  body?: string
  path?: string
}

const TYPE: Record<NoteType, string> = { bug: 'Lỗi đã biết', convention: 'Quy ước', lesson: 'Bài học' }
const TYPES = Object.keys(TYPE) as NoteType[]

function KnowledgePage({ param, navigate }: PageProps) {
  const [notes, setNotes] = useState<Note[]>([])
  const [filter, setFilter] = useState('')
  const [type, setType] = useState<NoteType | ''>('')
  const reload = useCallback(() => { void connection.call<Note[]>('kb.list').then(setNotes) }, [])
  useEffect(reload, [reload])

  const shown = useMemo(() => notes.filter((n) => (!type || n.type === type)
    && `${n.id} ${n.title} ${n.feature ?? ''} ${(n.cases ?? []).join(' ')}`.toLowerCase().includes(filter.toLowerCase())), [notes, type, filter])
  const editing = param === 'new' ? 'new' : param

  return (
    <main className="manager knowledge">
      <header>
        <h2>Knowledge</h2>
        <input placeholder="Lọc theo tiêu đề, tính năng, case…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value as NoteType | '')}>
          <option value="">Mọi loại</option>
          {TYPES.map((t) => <option key={t} value={t}>{TYPE[t]}</option>)}
        </select>
        <button className="primary" onClick={() => navigate('knowledge/new')}>+ Ghi chú mới</button>
      </header>
      <p className="muted">
        Tri thức tích luỹ của nhóm, lưu thành file Markdown trong thư mục <code>kb/</code>. Quy ước tự vào hướng dẫn của agent soạn plan;
        lỗi đã biết được đánh dấu trong báo cáo khi case liên quan không đạt.
      </p>
      <div className="kb-layout">
        <div className="kb-list">
          {TYPES.filter((t) => !type || t === type).map((t) => {
            const group = shown.filter((n) => n.type === t)
            if (!group.length) return null
            return (
              <section key={t}>
                <h3>{TYPE[t]} <span className="muted small">{group.length}</span></h3>
                {group.map((n) => (
                  <button key={n.id} className={`kb-item ${n.id === editing ? 'active' : ''}`} onClick={() => navigate(`knowledge/${n.id}`)}>
                    <span className="title">
                      {n.type === 'bug' && <span className={`badge ${n.status === 'fixed' ? 'active' : 'failed'}`}>{n.status === 'fixed' ? 'đã sửa' : 'đang mở'}</span>} {n.title}
                    </span>
                    <span className="meta">{n.id}{n.feature ? ` · ${n.feature}` : ''}{n.cases?.length ? ` · ${n.cases.length} case` : ''}</span>
                  </button>
                ))}
              </section>
            )
          })}
          {!shown.length && <div className="muted">Không có ghi chú phù hợp.</div>}
        </div>
        {editing
          ? <NoteEditor key={editing} id={editing} onSaved={(id) => { reload(); navigate(`knowledge/${id}`) }} onRemoved={() => { reload(); navigate('knowledge') }} />
          : <div className="panel-empty">Chọn một ghi chú để xem, hoặc tạo ghi chú mới.</div>}
      </div>
    </main>
  )
}

function NoteEditor({ id, onSaved, onRemoved }: { id: string; onSaved(id: string): void; onRemoved(): void }) {
  const isNew = id === 'new'
  const [note, setNote] = useState<Note>({ id: '', type: 'lesson', title: '', body: '' })
  const [editing, setEditing] = useState(isNew)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!isNew) connection.call<Note>('kb.get', { id }).then(setNote, (e) => setError(e.message))
  }, [id, isNew])

  const set = <K extends keyof Note>(key: K, value: Note[K]) => setNote({ ...note, [key]: value })
  const save = async () => {
    setError(undefined)
    try {
      const saved = await connection.call<Note>('kb.save', {
        id: note.id, type: note.type, title: note.title, body: note.body, feature: note.feature || undefined,
        status: note.type === 'bug' ? note.status ?? 'open' : undefined,
        cases: note.cases?.filter(Boolean),
      })
      setEditing(false)
      onSaved(saved.id)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const remove = async () => {
    try {
      await connection.call('kb.remove', { id: note.id })
      onRemoved()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!editing) {
    return (
      <article className="kb-note card">
        <div className="card-head">
          <span className="badge">{TYPE[note.type]}</span>
          <div className="card-title"><b>{note.title}</b><code>{note.path ?? note.id}</code></div>
          <button onClick={() => setEditing(true)}>Sửa</button>
        </div>
        <div className="muted small">
          {note.feature && <>Tính năng: <b>{note.feature}</b> · </>}
          {note.type === 'bug' && <>Trạng thái: <b>{note.status === 'fixed' ? 'đã sửa' : 'đang mở'}</b> · </>}
          Nguồn: {note.source ?? '—'} · Cập nhật: {note.updated ?? '—'}
        </div>
        {note.cases?.length ? <div className="tags">{note.cases.map((c) => <span key={c} className="tag">{c}</span>)}</div> : null}
        <Markdown text={note.body ?? ''} />
        {error && <div className="bad small">{error}</div>}
      </article>
    )
  }

  return (
    <article className="kb-note card">
      <label className="field"><span className="field-name">Mã (id) *</span>
        <input value={note.id} disabled={!isNew} placeholder="order-cancel-after-fill" onChange={(e) => set('id', e.target.value)} />
      </label>
      <div className="row">
        <label className="field"><span className="field-name">Loại</span>
          <select value={note.type} onChange={(e) => set('type', e.target.value as NoteType)}>
            {TYPES.map((t) => <option key={t} value={t}>{TYPE[t]}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-name">Tính năng</span>
          <input value={note.feature ?? ''} placeholder="order" onChange={(e) => set('feature', e.target.value)} />
        </label>
        {note.type === 'bug' && (
          <label className="field"><span className="field-name">Trạng thái</span>
            <select value={note.status ?? 'open'} onChange={(e) => set('status', e.target.value as 'open' | 'fixed')}>
              <option value="open">Đang mở</option>
              <option value="fixed">Đã sửa</option>
            </select>
          </label>
        )}
      </div>
      <label className="field"><span className="field-name">Tiêu đề *</span><input value={note.title} onChange={(e) => set('title', e.target.value)} /></label>
      {note.type === 'bug' && (
        <label className="field">
          <span className="field-name">Case liên quan (mỗi dòng một case, dạng mã-plan/mã-case)</span>
          <textarea className="editor small" value={(note.cases ?? []).join('\n')} onChange={(e) => set('cases', e.target.value.split('\n').map((c) => c.trim()))} />
        </label>
      )}
      <label className="field"><span className="field-name">Nội dung (Markdown)</span>
        <textarea className="editor" value={note.body ?? ''} onChange={(e) => set('body', e.target.value)} />
      </label>
      <div className="actions">
        <button className="primary" disabled={!note.id || !note.title} onClick={save}>Lưu</button>
        {!isNew && <button onClick={() => setEditing(false)}>Huỷ</button>}
        {!isNew && <button onClick={remove}>Xoá</button>}
      </div>
      {error && <div className="bad small">{error}</div>}
    </article>
  )
}

function KbListView({ view }: ToolViewProps) {
  const notes = (view.notes as Note[]) ?? []
  if (!notes.length) return <div className="muted">Không có ghi chú.</div>
  return <ul>{notes.map((n) => <li key={n.id}><b>{TYPE[n.type]}</b>: {n.title} <code>{n.id}</code></li>)}</ul>
}

function KbNoteView({ view }: ToolViewProps) {
  const note = view.note as Note | undefined
  if (!note) return null
  return (
    <div>
      <div><b>{TYPE[note.type]}</b>: {note.title} <code>{note.id}</code></div>
      {note.cases?.length ? <div className="tags">{note.cases.map((c) => <span key={c} className="tag">{c}</span>)}</div> : null}
      <Markdown text={note.body ?? ''} />
    </div>
  )
}
