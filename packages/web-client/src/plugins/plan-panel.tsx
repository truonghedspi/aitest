import { useEffect, useMemo, useState } from 'react'
import { connection } from '../connection.ts'
import { draftState } from '../derive.ts'
import type { ClientPlugin, PanelProps } from '../slots.ts'
import { useChat } from '../store.ts'
import type { Outcome } from '../types.ts'
import { Issues, RunCases } from './tool-views.tsx'

/**
 * Bảng "Plan đang soạn": luôn hiển thị bản nháp mới nhất, kết quả kiểm tra và chạy thử.
 * Người dùng sửa YAML và bấm Kiểm tra, Chạy thử, Lưu trực tiếp; các thao tác này gọi tool soạn plan
 * qua Host (pha `user`), được ghi vào log và báo cho agent ở lượt tiếp theo.
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

  // Bản nháp từ log thay thế nội dung đang hiển thị, trừ khi người dùng đang sửa dở.
  useEffect(() => {
    if (!dirty && draft.content !== undefined) setText(draft.content)
  }, [draft.content, dirty])
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
    const started = await invoke('Đang chạy thử…', 'dry_run', { content: text })
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

  if (draft.content === undefined && !dirty) {
    return <div className="panel-empty">Chưa có bản nháp. Mô tả tính năng cần kiểm thử ở khung chat, agent sẽ soạn plan và hiển thị tại đây.</div>
  }

  const v = draft.validation
  return (
    <div className="plan-panel">
      <div className="panel-meta">
        {dirty ? 'Bạn đang sửa (chưa gửi)' : `Bản mới nhất · ${draft.source ?? ''}`}
        {draft.saved && <span className={draft.saved.stale ? 'warn' : 'ok'}> · {draft.saved.stale ? 'có thay đổi chưa lưu' : `đã lưu ${draft.saved.path}`}</span>}
      </div>
      <textarea
        className="editor"
        spellCheck={false}
        value={text}
        onChange={(e) => { setText(e.target.value); setDirty(true) }}
      />
      <div className="actions">
        <button disabled={!!busy} onClick={() => invoke('Đang kiểm tra…', 'validate_plan', { content: text })}>Kiểm tra</button>
        <button disabled={!!busy} onClick={dryRun}>Chạy thử</button>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="ten-plan.plan.yaml" />
        <button
          className="primary"
          disabled={!!busy || !path}
          onClick={() => invoke('Đang lưu…', 'save_plan', { path, content: text, overwrite: !!draft.saved })}
        >Lưu</button>
      </div>
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
