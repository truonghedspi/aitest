import { useEffect, useMemo, useState } from 'react'
import { connection } from '../connection.ts'
import { draftState, SAVE_DIR } from '../derive.ts'
import type { ClientPlugin, PanelProps } from '../slots.ts'
import { useChat } from '../store.ts'
import type { Outcome } from '../types.ts'
import { Issues, RunCases } from './tool-views.tsx'

/**
 * Bảng "Plan đang soạn": luôn hiển thị bản nháp mới nhất, kết quả kiểm tra và chạy thử.
 * Người dùng mở plan có sẵn, sửa YAML và bấm Kiểm tra, Chạy thử (chọn case), Lưu trực tiếp; các thao tác này
 * gọi tool soạn plan qua Host (pha `user`), được ghi vào log và báo cho agent ở lượt tiếp theo.
 */
export const planPanel: ClientPlugin = (slots) => {
  slots.panel.register('plan', { id: 'plan', title: 'Plan đang soạn', order: 0, component: PlanPanel })
}

function PlanPanel({ chatId }: PanelProps) {
  const { events } = useChat(chatId)
  const draft = useMemo(() => draftState(events), [events])
  const [text, setText] = useState(draft.content ?? '')
  const [dirty, setDirty] = useState(false)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [picking, setPicking] = useState(false)
  /** Case được chọn để chạy thử; `undefined` nghĩa là chạy mọi case. */
  const [selected, setSelected] = useState<string[]>()
  const summary = draft.validation?.summary
  const cases = summary?.cases ?? []
  /** Giá trị đầu vào người dùng điền cho lần chạy thử; ô để trống dùng fill, prepare hoặc default. */
  const [inputValues, setInputValues] = useState<Record<string, string>>({})

  // Bản nháp từ log thay thế nội dung đang hiển thị, trừ khi người dùng đang sửa dở.
  useEffect(() => {
    if (!dirty && draft.content !== undefined) setText(draft.content)
  }, [draft.content, dirty])
  // Mở plan khác: đặt lại đường dẫn lưu, lựa chọn case và trạng thái sửa dở.
  useEffect(() => {
    if (!draft.opened) return
    const { path: opened } = draft.opened
    setPath(opened.startsWith(SAVE_DIR) ? opened.slice(SAVE_DIR.length) : opened.split('/').pop()!)
    setSelected(undefined)
    setInputValues({})
    setDirty(false)
  }, [draft.opened?.seq])
  useEffect(() => {
    if (path) return
    if (draft.saved?.path) setPath(draft.saved.path.replace(/^plans\//, ''))
    else if (draft.validation?.summary?.id) setPath(`${draft.validation.summary.id.toLowerCase()}.plan.yaml`)
  }, [draft.saved?.path, draft.validation?.summary?.id, path])

  const invoke = async (label: string, tool: string, args: Record<string, unknown>) => {
    setBusy(label)
    setError(undefined)
    try {
      if (dirty) {
        await connection.call('chats.editDraft', { chatId, content: text })
        setDirty(false)
      }
      const outcome = await connection.call<Outcome>('chats.invoke', { chatId, tool, args })
      if (outcome.status !== 'ok') setError(outcome.error)
      return outcome
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  const dryRun = async () => {
    const inputs = Object.fromEntries(Object.entries(inputValues).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]))
    const started = await invoke('Đang chạy thử…', 'dry_run', {
      content: text, ...(selected ? { cases: selected } : {}), ...(Object.keys(inputs).length ? { inputs } : {}),
    })
    if (started?.status !== 'ok') return
    setBusy('Đang chạy thử…')
    try {
      for (let i = 0; i < 20; i++) {
        const result = await connection.call<Outcome>('chats.invoke', {
          chatId, tool: 'get_run_result', args: { runId: started.value.runId, waitSec: 30 },
        })
        if (result.status !== 'ok' || result.value.status !== 'running') break
      }
    } finally {
      setBusy(undefined)
    }
  }

  const unsaved = dirty || !!draft.saved?.stale || (draft.content !== undefined && !draft.saved)
  const picker = picking && (
    <PlanPicker
      chatId={chatId}
      warn={draft.content !== undefined && unsaved}
      onClose={() => setPicking(false)}
      onError={setError}
    />
  )

  if (draft.content === undefined && !dirty) {
    return (
      <div className="panel-empty">
        <p>Chưa có bản nháp. Mô tả tính năng cần kiểm thử ở khung chat, agent sẽ soạn plan và hiển thị tại đây.</p>
        <p>Hoặc mở một plan có sẵn để sửa, chạy thử cùng agent.</p>
        {picker || <button onClick={() => setPicking(true)}>Mở plan có sẵn</button>}
        {error && <div className="bad">{error}</div>}
      </div>
    )
  }

  const v = draft.validation
  return (
    <div className="plan-panel">
      <div className="panel-head">
        <div className="panel-title">
          {summary ? <><b>{summary.name}</b> <span className="muted">{summary.id}</span></> : <b>Bản nháp</b>}
        </div>
        <button disabled={!!busy} onClick={() => setPicking(!picking)}>{picking ? 'Đóng danh sách' : 'Đổi plan'}</button>
      </div>
      <div className="panel-meta">
        {dirty ? 'Bạn đang sửa (chưa gửi)' : `Bản mới nhất · ${draft.source ?? ''}`}
        {draft.saved && <span className={draft.saved.stale ? 'warn' : 'ok'}> · {draft.saved.stale ? 'có thay đổi chưa lưu' : `đã lưu ${draft.saved.path}`}</span>}
        {draft.opened && !draft.opened.path.startsWith(SAVE_DIR) && !draft.saved && (
          <span className="muted"> · mở từ {draft.opened.path}; Lưu tạo bản mới trong {SAVE_DIR}</span>
        )}
      </div>
      {picker}
      <textarea
        className="editor"
        spellCheck={false}
        value={text}
        onChange={(e) => { setText(e.target.value); setDirty(true) }}
      />
      <div className="actions">
        <button disabled={!!busy} onClick={() => invoke('Đang kiểm tra…', 'validate_plan', { content: text })}>Kiểm tra</button>
        <button disabled={!!busy || selected?.length === 0} onClick={dryRun}>
          Chạy thử{selected ? ` (${selected.length} case)` : ''}
        </button>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="ten-plan.plan.yaml" />
        <button
          className="primary"
          disabled={!!busy || !path}
          onClick={() => invoke('Đang lưu…', 'save_plan', { path, content: text, overwrite: !!draft.saved })}
        >Lưu</button>
      </div>
      {!!summary?.inputs?.length && (
        <div className="input-form">
          {summary.inputs.map((i) => (
            <label key={i.name} style={{ display: 'contents' }}>
              <span title={i.desc}>
                <code>{i.name}</code>{i.required && i.mode === 'user' && i.default === undefined ? ' *' : ''}
                {i.desc && <span className="muted small"> {i.desc}</span>}
              </span>
              <input
                value={inputValues[i.name] ?? ''}
                placeholder={inputPlaceholder(i)}
                title={i.desc}
                onChange={(e) => setInputValues({ ...inputValues, [i.name]: e.target.value })}
              />
            </label>
          ))}
        </div>
      )}
      {cases.length > 1 && (
        <div className="case-picker">
          <span className="muted">Case chạy thử:</span>
          {cases.map((c) => (
            <label key={c.id} title={c.title}>
              <input
                type="checkbox"
                checked={!selected || selected.includes(c.id)}
                onChange={(e) => {
                  const current = selected ?? cases.map((x) => x.id)
                  const next = e.target.checked ? [...current, c.id] : current.filter((id) => id !== c.id)
                  setSelected(next.length === cases.length ? undefined : cases.map((x) => x.id).filter((id) => next.includes(id)))
                }}
              />
              {c.id}
            </label>
          ))}
        </div>
      )}
      {busy && <div className="muted">{busy}</div>}
      {error && <div className="bad">{error}</div>}
      {v && (
        <section>
          <h4>Kiểm tra {v.stale && <span className="warn">(của bản cũ hơn)</span>}</h4>
          <div className={v.valid ? 'ok' : 'bad'}>{v.valid ? 'Hợp lệ' : 'Không hợp lệ'} · {v.errors.length} lỗi · {v.warnings.length} cảnh báo</div>
          <Issues items={v.errors} level="error" />
          <Issues items={v.warnings} level="warning" />
        </section>
      )}
      {draft.run && (
        <section>
          <h4>Chạy thử</h4>
          {draft.run.pending ? <div className="muted">Đang chạy…</div> : <RunCases value={draft.run.value} />}
        </section>
      )}
    </div>
  )
}

interface PlanItem { path: string; id?: string; name?: string; cases?: Array<{ id: string; title?: string }>; error?: string }

/** Chọn plan có sẵn để mở làm bản nháp: tên, mã và các case đứng trước, đường dẫn đứng cuối; lọc theo mọi trường đó. */
function PlanPicker({ chatId, warn, onClose, onError }: { chatId: string; warn: boolean; onClose(): void; onError(message?: string): void }) {
  const [plans, setPlans] = useState<PlanItem[]>()
  const [query, setQuery] = useState('')
  const [opening, setOpening] = useState<string>()

  useEffect(() => {
    connection.call<PlanItem[]>('chats.listPlans', { chatId }).then(setPlans, (e) => onError((e as Error).message))
  }, [chatId])

  const open = async (path: string) => {
    setOpening(path)
    onError(undefined)
    try {
      await connection.call('chats.openPlan', { chatId, path })
      onClose()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setOpening(undefined)
    }
  }

  const q = query.trim().toLowerCase()
  const shown = (plans ?? []).filter((p) => !q || [p.path, p.id, p.name, ...(p.cases ?? []).flatMap((c) => [c.id, c.title])].some((v) => v?.toLowerCase().includes(q)))
  return (
    <div className="plan-picker">
      <div className="actions">
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm theo tên, mã plan, case hoặc đường dẫn" />
        <button onClick={onClose}>Đóng</button>
      </div>
      {warn && <div className="warn small">Bản nháp hiện tại có thay đổi chưa lưu và sẽ được thay bằng plan được mở.</div>}
      {!plans ? <div className="muted">Đang tải…</div> : !shown.length ? <div className="muted">Không có plan phù hợp.</div> : (
        <ul>
          {shown.map((p) => (
            <li key={p.path}>
              <button className="plan-item" disabled={!!opening} onClick={() => open(p.path)} title={p.error ?? p.path}>
                {p.error
                  ? <span className="bad">Không đọc được plan: {p.error}</span>
                  : <>
                    <span><b>{p.name}</b> <span className="muted">{p.id}</span></span>
                    <span className="small">
                      {p.cases?.length ?? 0} case{p.cases?.length ? ': ' : ''}
                      {p.cases?.map((c) => c.title ? `${c.id} ${c.title}` : c.id).join(' · ')}
                    </span>
                  </>}
                <span className="muted small"><code>{p.path}</code>{opening === p.path ? ' · đang mở…' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Gợi ý trong ô đầu vào: để trống thì giá trị lấy từ đâu. */
export function inputPlaceholder(i: { desc?: string; default?: unknown; required: boolean; mode: string }) {
  // Ô hẹp: chỉ nêu điều xảy ra khi để trống; mô tả đầy đủ nằm ở tooltip.
  return i.mode === 'fill' ? 'trống: lấy bằng bước fill'
    : i.mode === 'prepare' ? 'trống: agent tự chuẩn bị'
    : i.default !== undefined ? `trống: mặc định ${JSON.stringify(i.default)}`
    : i.required ? 'bắt buộc điền' : 'không bắt buộc'
}
