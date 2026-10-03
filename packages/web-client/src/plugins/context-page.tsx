import { useCallback, useEffect, useMemo, useState } from 'react'
import { connection } from '../connection.ts'
import { Markdown } from '../markdown.tsx'
import type { ClientPlugin, PageProps, ToolViewProps } from '../slots.ts'
import { OpenItemsTab } from './open-items.tsx'

/**
 * Trang Ngữ cảnh: những gì agent soạn plan biết trước khi bắt đầu.
 * - Bộ nhớ: ký ức giữa các phiên (plugin `memory`): xem, sửa, xoá, lịch sử, khôi phục, cảnh báo rà soát.
 * - Skill: quy trình soạn plan theo chuẩn Agent Skills (plugin `context`).
 * - Tài liệu: thư mục ngữ cảnh; thêm hoặc bỏ thư mục.
 * Kèm thẻ `memory-saved` trong cuộc chat (hoàn tác được) và bản xem trước `memory` trên thẻ duyệt.
 */
export const contextPage: ClientPlugin = (s) => {
  s.page.register('context', { id: 'context', title: 'Ngữ cảnh', order: 4, component: ContextPage })
  s.toolView.register('memory-saved', MemorySavedView)
  s.toolView.register('context-change', ContextChangeView)
}

type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
type MemoryScope = 'personal' | 'team'

interface Memory {
  name: string
  description: string
  type: MemoryType
  scope: MemoryScope
  body: string
  version: number
  created: string
  updated: string
  source?: string
  links: string[]
}

interface Review {
  duplicates: Array<[string, string]>
  brokenLinks: Array<{ name: string; link: string }>
  stale: string[]
}

interface Doc { id: string; title: string; description?: string; systems: string[]; features: string[]; inclusion: 'always' | 'auto'; size: number; usedBy?: string[] }
interface Skill { name: string; description: string; path: string; systems: string[]; features: string[]; files: string[] }
interface Library { dirs: string[]; skillDirs: string[]; docs: Doc[]; skills: Skill[]; issues: Array<{ path: string; error: string }> }

export const MEMORY_TYPE: Record<MemoryType, string> = {
  user: 'Người dùng',
  feedback: 'Góp ý cách làm',
  project: 'Dự án',
  reference: 'Nơi tra cứu',
}
const MEMORY_TYPES = Object.keys(MEMORY_TYPE) as MemoryType[]
const SCOPE: Record<MemoryScope, string> = { personal: 'cá nhân', team: 'nhóm' }

const TABS = [
  { id: 'memory', title: 'Bộ nhớ' },
  { id: 'open-items', title: 'Việc còn mở' },
  { id: 'skills', title: 'Skill' },
  { id: 'docs', title: 'Tài liệu' },
] as const

function ContextPage({ param, navigate }: PageProps) {
  const tab = TABS.some((t) => t.id === param) ? param! : 'memory'
  return (
    <main className="manager knowledge">
      <header>
        <h2>Ngữ cảnh</h2>
        <div className="tabs inline">
          {TABS.map((t) => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => navigate(`context/${t.id}`)}>{t.title}</button>)}
        </div>
      </header>
      {tab === 'memory' ? <MemoryTab /> : tab === 'open-items' ? <OpenItemsTab /> : tab === 'skills' ? <LibraryTab kind="skills" /> : <LibraryTab kind="docs" />}
    </main>
  )
}

// ---------------------------------------------------------------- Bộ nhớ

function MemoryTab() {
  const [data, setData] = useState<{ memories: Memory[]; user: string; dirs: Record<MemoryScope, string>; review: Review }>()
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<{ name: string; scope: MemoryScope } | 'new'>()
  const reload = useCallback(() => { void connection.call<typeof data>('memory.list').then(setData) }, [])
  useEffect(reload, [reload])

  const shown = useMemo(() => (data?.memories ?? []).filter((m) => `${m.name} ${m.description} ${m.body}`.toLowerCase().includes(filter.toLowerCase())), [data, filter])
  const warnings = data ? [
    ...data.review.duplicates.map(([a, b]) => `\`${a}\` và \`${b}\` gần trùng nhau; gộp lại thành một ký ức.`),
    ...data.review.brokenLinks.map((l) => `\`${l.name}\` liên kết tới \`[[${l.link}]]\` không tồn tại.`),
    ...data.review.stale.map((n) => `\`${n}\` không cập nhật hơn 180 ngày; kiểm tra lại còn đúng không.`),
  ] : []

  return (
    <>
      <p className="muted">
        Agent soạn plan đọc mục lục bộ nhớ ở đầu mỗi cuộc chat mới, nên không phải hỏi lại điều bạn đã nói.
        Ký ức <b>cá nhân</b> lưu ở <code>{data?.dirs.personal ?? '…'}</code> (người dùng <code>{data?.user ?? '…'}</code>, không vào git);
        ký ức <b>nhóm</b> lưu ở <code>{data?.dirs.team ?? '…'}</code>, đưa vào git để cả nhóm dùng chung.
        Bạn có thể nói với agent "nhớ là…" hoặc "quên…".
      </p>
      {warnings.length > 0 && (
        <div className="card notice small">
          <b>Cần rà soát</b>
          <ul>{warnings.map((w) => <li key={w}><Markdown text={w} /></li>)}</ul>
        </div>
      )}
      <div className="kb-layout">
        <div className="kb-list">
          <div className="row">
            <input placeholder="Lọc theo tên, mô tả, nội dung…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <button className="primary" onClick={() => setSelected('new')}>+ Ký ức</button>
          </div>
          {MEMORY_TYPES.map((t) => {
            const group = shown.filter((m) => m.type === t)
            if (!group.length) return null
            return (
              <section key={t}>
                <h3>{MEMORY_TYPE[t]} <span className="muted small">{group.length}</span></h3>
                {group.map((m) => (
                  <button key={`${m.scope}/${m.name}`} className={`kb-item ${selected !== 'new' && selected?.name === m.name && selected.scope === m.scope ? 'active' : ''}`}
                    onClick={() => setSelected({ name: m.name, scope: m.scope })}>
                    <span className="title">{m.scope === 'team' && <span className="badge">nhóm</span>} {m.description}</span>
                    <span className="meta">{m.name} · v{m.version} · {m.updated.slice(0, 10)}</span>
                  </button>
                ))}
              </section>
            )
          })}
          {data && !shown.length && <div className="muted">{data.memories.length ? 'Không có ký ức phù hợp.' : 'Chưa có ký ức nào. Agent tự ghi khi bạn sửa cách làm hoặc nói "nhớ…".'}</div>}
        </div>
        {selected
          ? <MemoryEditor key={selected === 'new' ? 'new' : `${selected.scope}/${selected.name}`} target={selected}
              onChanged={(next) => { reload(); setSelected(next) }} />
          : <div className="panel-empty">Chọn một ký ức để xem, sửa hoặc xem lịch sử.</div>}
      </div>
    </>
  )
}

function MemoryEditor({ target, onChanged }: { target: { name: string; scope: MemoryScope } | 'new'; onChanged(next?: { name: string; scope: MemoryScope }): void }) {
  const isNew = target === 'new'
  const [memory, setMemory] = useState<Pick<Memory, 'name' | 'description' | 'type' | 'scope' | 'body'> & Partial<Memory>>(
    { name: '', description: '', type: 'project', scope: 'personal', body: '' })
  const [history, setHistory] = useState<Array<{ version: number; deleted: boolean }>>([])
  const [editing, setEditing] = useState(isNew)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (isNew) return
    connection.call<{ memory: Memory; history: typeof history }>('memory.get', target).then((r) => { setMemory(r.memory); setHistory(r.history) }, (e) => setError(e.message))
  }, [isNew, target])

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined)
    try { await fn() } catch (e) { setError((e as Error).message) }
  }
  const save = () => run(async () => {
    const saved = await connection.call<Memory>('memory.save', {
      name: memory.name, description: memory.description, type: memory.type, body: memory.body, scope: memory.scope,
      ...(isNew ? {} : { expectedVersion: memory.version }),
    })
    setEditing(false)
    onChanged({ name: saved.name, scope: saved.scope })
  })
  const remove = () => run(async () => {
    await connection.call('memory.delete', { name: memory.name, scope: memory.scope })
    onChanged()
  })
  const restore = (version: number) => run(async () => {
    await connection.call('memory.restore', { name: memory.name, scope: memory.scope, version })
    onChanged({ name: memory.name, scope: memory.scope })
  })
  const set = <K extends keyof typeof memory>(key: K, value: (typeof memory)[K]) => setMemory({ ...memory, [key]: value })

  if (!editing) {
    return (
      <article className="kb-note card">
        <div className="card-head">
          <span className="badge">{MEMORY_TYPE[memory.type]}</span>
          <div className="card-title"><b>{memory.description}</b><code>{memory.name}</code></div>
          <button onClick={() => setEditing(true)}>Sửa</button>
          <button onClick={remove}>Xoá</button>
        </div>
        <div className="muted small">
          Phạm vi: <b>{SCOPE[memory.scope]}</b> · Phiên bản {memory.version} · Cập nhật: {memory.updated?.replace('T', ' ').slice(0, 16) ?? '—'}
          {memory.source ? <> · Nguồn: {memory.source === 'ui' ? 'giao diện' : <code>{memory.source}</code>}</> : null}
        </div>
        <Markdown text={memory.body} />
        {history.length > 0 && (
          <details>
            <summary className="muted small">Lịch sử ({history.length} bản)</summary>
            <ul className="small">
              {history.map((h) => (
                <li key={`${h.version}${h.deleted}`}>
                  Bản {h.version}{h.deleted ? ' (đã xoá)' : ''} <button className="link" onClick={() => restore(h.version)}>Khôi phục</button>
                </li>
              ))}
            </ul>
          </details>
        )}
        {error && <div className="bad small">{error}</div>}
      </article>
    )
  }

  return (
    <article className="kb-note card">
      <div className="row">
        <label className="field"><span className="field-name">Tên (kebab-case) *</span>
          <input value={memory.name} disabled={!isNew} placeholder="order-status-names" onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field"><span className="field-name">Loại</span>
          <select value={memory.type} onChange={(e) => set('type', e.target.value as MemoryType)}>
            {MEMORY_TYPES.map((t) => <option key={t} value={t}>{MEMORY_TYPE[t]}</option>)}
          </select>
        </label>
        <label className="field"><span className="field-name">Phạm vi</span>
          <select value={memory.scope} disabled={!isNew} onChange={(e) => set('scope', e.target.value as MemoryScope)}>
            <option value="personal">Cá nhân</option>
            <option value="team">Nhóm (vào git)</option>
          </select>
        </label>
      </div>
      <label className="field"><span className="field-name">Mô tả một dòng * (agent đọc trong mục lục để biết khi nào cần)</span>
        <input value={memory.description} onChange={(e) => set('description', e.target.value)} />
      </label>
      <label className="field"><span className="field-name">Nội dung (Markdown; góp ý ghi thêm "Vì sao:" và "Áp dụng khi:")</span>
        <textarea className="editor" value={memory.body} onChange={(e) => set('body', e.target.value)} />
      </label>
      <div className="actions">
        <button className="primary" disabled={!memory.name || !memory.description || !memory.body.trim()} onClick={save}>Lưu</button>
        {!isNew && <button onClick={() => setEditing(false)}>Huỷ</button>}
      </div>
      {error && <div className="bad small">{error}</div>}
    </article>
  )
}

// ---------------------------------------------------------------- Skill và tài liệu

function LibraryTab({ kind }: { kind: 'skills' | 'docs' }) {
  const [lib, setLib] = useState<Library>()
  const [selected, setSelected] = useState<string>()
  const [content, setContent] = useState<{ text: string; path?: string }>()
  const [error, setError] = useState<string>()
  const reload = useCallback(() => { void connection.call<Library>('library.list').then(setLib, (e) => setError(e.message)) }, [])
  useEffect(reload, [reload])
  useEffect(() => { setSelected(undefined); setContent(undefined) }, [kind])

  const open = async (id: string, path?: string) => {
    setSelected(id)
    setError(undefined)
    try {
      const params = kind === 'skills' ? { skill: id, ...(path ? { path } : {}) } : { doc: id }
      const r = await connection.call<{ content: string }>('library.read', params)
      setContent({ text: r.content, path })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!lib) return error ? <div className="bad">{error}</div> : <div className="muted">Đang tải…</div>
  const dirs = kind === 'skills' ? lib.skillDirs : lib.dirs
  const skill = kind === 'skills' ? lib.skills.find((s) => s.name === selected) : undefined
  const doc = kind === 'docs' ? lib.docs.find((d) => d.id === selected) : undefined
  const issues = lib.issues.filter((i) => (kind === 'skills') === i.path.endsWith('SKILL.md'))
  const isMarkdown = !content?.path || /\.(md|markdown)$/.test(content.path)

  return (
    <>
      <p className="muted">
        {kind === 'skills'
          ? <>Skill là quy trình soạn plan cho một loại yêu cầu, theo chuẩn Agent Skills: thư mục có <code>SKILL.md</code> (frontmatter <code>name</code>, <code>description</code>) và file kèm như plan mẫu.
            Agent chỉ thấy tên và mô tả; khi việc khớp mô tả, agent nạp nội dung bằng <code>use_skill</code>.</>
          : <>Tài liệu trong thư mục ngữ cảnh (đặc tả, quy trình nghiệp vụ, thuật ngữ, OpenAPI). Agent thấy mục lục kèm mô tả, đọc nội dung khi cần.
            Frontmatter <code>inclusion: always</code> đưa tài liệu vào hướng dẫn của mọi cuộc chat; <code>systems</code> gắn tài liệu với hệ thống trong catalog.</>}
      </p>
      <DirsEditor kind={kind} dirs={dirs} onSaved={reload} />
      {issues.length > 0 && (
        <div className="card notice small">
          <b>File không nạp được</b>
          <ul>{issues.map((i) => <li key={i.path}><code>{i.path}</code>: {i.error}</li>)}</ul>
        </div>
      )}
      <div className="kb-layout">
        <div className="kb-list">
          {kind === 'skills'
            ? lib.skills.map((s) => (
                <button key={s.name} className={`kb-item ${selected === s.name ? 'active' : ''}`} onClick={() => open(s.name)}>
                  <span className="title"><code>{s.name}</code></span>
                  <span className="meta">{s.description}</span>
                </button>
              ))
            : lib.docs.map((d) => (
                <button key={d.id} className={`kb-item ${selected === d.id ? 'active' : ''}`} onClick={() => open(d.id)}>
                  <span className="title">{d.inclusion === 'always' && <span className="badge active">luôn dùng</span>} {d.title}</span>
                  <span className="meta">{d.id}{d.systems.length ? ` · ${d.systems.join(', ')}` : ''}{d.usedBy?.length ? ` · ${d.usedBy.length} plan dùng` : ''}</span>
                </button>
              ))}
          {(kind === 'skills' ? lib.skills : lib.docs).length === 0 && (
            <div className="muted">{kind === 'skills' ? 'Chưa có skill. Tạo thư mục <tên>/SKILL.md trong thư mục skill.' : 'Chưa có tài liệu trong thư mục ngữ cảnh.'}</div>
          )}
        </div>
        {selected && content ? (
          <article className="kb-note card">
            <div className="card-head">
              <div className="card-title">
                <b>{skill ? skill.name : doc?.title}</b>
                <code>{skill ? `${skill.path}/${content.path ?? 'SKILL.md'}` : doc?.id}</code>
              </div>
              {content.path && <button onClick={() => open(selected)}>SKILL.md</button>}
            </div>
            {(skill?.description || doc?.description) && !content.path && <div className="muted small">{skill?.description ?? doc?.description}</div>}
            {doc && (
              <div className="muted small">
                {doc.usedBy?.length
                  ? <>Plan tham chiếu bằng <code>contextRefs</code>: {doc.usedBy.map((p) => <a key={p} href={`#/plans/${p}`}><code>{p}</code></a>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}</>
                  : <>Chưa plan nào tham chiếu; thêm <code>contextRefs: [{doc.id}]</code> vào plan để agent chạy test đọc tài liệu này.</>}
              </div>
            )}
            {skill && skill.files.length > 0 && (
              <div className="tags">
                {skill.files.map((f) => <button key={f} className={`tag ${content.path === f ? 'active' : ''}`} onClick={() => open(skill.name, f)}>{f}</button>)}
              </div>
            )}
            {isMarkdown ? <Markdown text={stripFrontmatter(content.text)} /> : <pre className="code">{content.text}</pre>}
          </article>
        ) : <div className="panel-empty">{error ? <span className="bad">{error}</span> : `Chọn một ${kind === 'skills' ? 'skill' : 'tài liệu'} để xem.`}</div>}
      </div>
    </>
  )
}

/** Bỏ khối frontmatter YAML ở đầu tài liệu Markdown; tiêu đề và mô tả đã hiện ở đầu thẻ. */
function stripFrontmatter(text: string) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/** Danh sách thư mục; lưu đổi cấu hình row thư viện qua kernel (patch layer). */
function DirsEditor({ kind, dirs, onSaved }: { kind: 'skills' | 'docs'; dirs: string[]; onSaved(): void }) {
  const [value, setValue] = useState(dirs.join('\n'))
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => setValue(dirs.join('\n')), [dirs])
  const save = async () => {
    setError(undefined)
    try {
      await connection.call('library.setDirs', { kind: kind === 'skills' ? 'skills' : 'context', dirs: value.split('\n') })
      setOpen(false)
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="small">
      Thư mục: {dirs.map((d) => <code key={d}>{d}</code>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}
      {' '}<button className="link" onClick={() => setOpen(!open)}>{open ? 'Đóng' : 'Đổi thư mục'}</button>
      {open && (
        <div className="card">
          <label className="field"><span className="field-name">Mỗi dòng một thư mục, tương đối với thư mục làm việc của Host</span>
            <textarea className="editor small" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          <div className="actions"><button className="primary" onClick={save}>Lưu</button></div>
          {error && <div className="bad small">{error}</div>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Thẻ trong cuộc chat

/** Thẻ `memory_save`, `memory_delete`: agent đã ghi hoặc xoá gì; hoàn tác ngay trên thẻ. */
function MemorySavedView({ view }: ToolViewProps) {
  const v = view as unknown as {
    name: string; type?: MemoryType; scope?: MemoryScope; description?: string; body?: string; reason?: string
    saved?: boolean; created?: boolean; deleted?: boolean; version?: number
  }
  const [state, setState] = useState<'idle' | 'done' | string>('idle')
  const scope = v.scope ?? 'personal'
  const changed = v.saved || v.deleted
  const undo = async () => {
    try {
      if (v.deleted) await connection.call('memory.restore', { name: v.name, scope, version: v.version })
      else if (v.created) await connection.call('memory.delete', { name: v.name, scope })
      else await connection.call('memory.restore', { name: v.name, scope, version: (v.version ?? 1) - 1 })
      setState('done')
    } catch (e) {
      setState((e as Error).message)
    }
  }
  return (
    <div className="memory-card">
      <div className="small muted">
        {v.type && <><b>{MEMORY_TYPE[v.type]}</b> · </>}ký ức {SCOPE[scope]} <code>{v.name}</code>{v.version ? ` · bản ${v.version}` : ''}
      </div>
      {v.description && <div>{v.description}</div>}
      {v.reason && <div className="muted small">Lý do xoá: {v.reason}</div>}
      {v.body && <Markdown text={v.body} />}
      {changed && (
        <div className="actions">
          {state === 'idle' && <button onClick={undo}>Hoàn tác</button>}
          {state === 'done' && <span className="muted small">Đã hoàn tác. Agent được báo ở lượt sau.</span>}
          {state !== 'idle' && state !== 'done' && <span className="bad small">{state}</span>}
        </div>
      )}
    </div>
  )
}

/** Bản xem trước trên thẻ duyệt khi agent ghi hoặc xoá ký ức nhóm (hoặc khi tắt tự ghi). */
export function MemoryPreview({ preview }: { preview: any }) {
  return (
    <div className="memory-card">
      <div className="small muted">
        <b>{MEMORY_TYPE[preview.type as MemoryType] ?? preview.type}</b> · ký ức {SCOPE[preview.scope as MemoryScope] ?? preview.scope} <code>{preview.name}</code>
        {preview.scope === 'team' && ' · ghi vào thư mục bộ nhớ nhóm (vào git)'}
      </div>
      <div>{preview.description}</div>
      {preview.deleting && <div className="bad small">Xoá ký ức này{preview.reason ? `: ${preview.reason}` : ''}</div>}
      <Markdown text={preview.body ?? ''} />
      {preview.previous && preview.previous !== preview.body && (
        <details><summary className="muted small">Nội dung hiện tại (sẽ được thay)</summary><Markdown text={preview.previous} /></details>
      )}
    </div>
  )
}

/** Thẻ `propose_system_knowledge`, `propose_context_doc` trong cuộc chat: đã ghi gì, vào đâu. */
function ContextChangeView({ view }: ToolViewProps) {
  const v = view as unknown as { target?: string; summary?: string; saved?: boolean; reason?: string }
  return (
    <div className="small">
      {v.saved ? 'Đã ghi' : 'Không ghi'} vào <code>{v.target}</code>{v.summary ? `: ${v.summary}` : ''}
      {v.reason && <div className="muted">Nguồn: {v.reason}</div>}
    </div>
  )
}
