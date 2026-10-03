import { useMemo, useState } from 'react'
import { connection } from './connection.ts'

/**
 * Export, import gói plan (plugin `plan-bundle`) trên trang Plan: chuyển plan cùng tài liệu và hệ thống plan cần
 * sang một aitest khác. Import có bước xem trước; file khác bản đang có chỉ ghi khi người dùng chọn ghi đè.
 */

interface ImportItem { kind: string; path: string; target?: string; status: 'new' | 'same' | 'changed' | 'blocked'; reason?: string; dependsOn?: string }
interface Preview { plans: Array<{ path: string; id: string; name: string }>; items: ImportItem[]; warnings: string[] }
interface ImportResult {
  written: Array<{ kind: string; path: string; target: string; overwritten: boolean }>
  skipped: Array<{ path: string; reason: string }>
  plans: Array<{ target: string; id: string; valid: boolean; errors: string[] }>
  backupDir?: string
}

const STATUS: Record<ImportItem['status'], string> = { new: 'Mới', same: 'Giống hệt', changed: 'Khác bản đang có', blocked: 'Bị chặn' }
const KIND: Record<string, string> = { plan: 'Plan', context: 'Tài liệu', system: 'Hệ thống' }

/** Tải gói về máy dưới dạng file JSON. */
function download(bundle: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Xuất các plan đã chọn thành một gói. */
export async function exportPlans(paths: string[]): Promise<{ files: number }> {
  const bundle = await connection.call<{ files: unknown[]; plans: Array<{ id: string }> }>('bundles.export', { paths })
  const name = bundle.plans.length === 1 ? bundle.plans[0].id : `${bundle.plans.length}-plans`
  download(bundle, `aitest-${name}-${new Date().toISOString().slice(0, 10)}.json`)
  return { files: bundle.files.length }
}

/** Chọn nhiều plan để xuất cùng một gói. */
export function ExportDialog({ plans, onClose }: { plans: Array<{ path: string; id?: string; name?: string; error?: string }>; onClose(): void }) {
  const exportable = plans.filter((p) => !p.error)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const toggle = (path: string) => {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
  }
  const run = async () => {
    setBusy(true)
    setMessage(undefined)
    try {
      const { files } = await exportPlans([...selected])
      setMessage(`Đã tải gói gồm ${selected.size} plan, ${files} file.`)
    } catch (e) {
      setMessage(`Lỗi: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="dialog modal" onClick={(e) => e.stopPropagation()}>
        <header><h3>Export plan</h3><button onClick={onClose}>Đóng</button></header>
        <p className="muted small">
          Gói gồm plan đã chọn, tài liệu nghiệp vụ plan tham chiếu (<code>contextRefs</code>) và mô tả hệ thống (<code>systems</code>, OpenAPI, công thức).
          Không gồm cấu hình môi trường và bí mật.
        </p>
        <div className="row">
          <button className="link" onClick={() => setSelected(new Set(exportable.map((p) => p.path)))}>Chọn tất cả</button>
          <button className="link" onClick={() => setSelected(new Set())}>Bỏ chọn</button>
        </div>
        <ul className="bundle-list">
          {exportable.map((p) => (
            <li key={p.path}>
              <label><input type="checkbox" checked={selected.has(p.path)} onChange={() => toggle(p.path)} /> <b>{p.name ?? p.path}</b> <span className="muted small">{p.id} · {p.path}</span></label>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button className="primary" disabled={!selected.size || busy} onClick={run}>⇩ Tải gói ({selected.size} plan)</button>
        </div>
        {message && <div className={message.startsWith('Lỗi') ? 'bad' : 'ok'}>{message}</div>}
      </section>
    </div>
  )
}

/** Nhập gói: đọc file, xem trước, chọn ghi đè, nhập, xem kết quả kiểm tra plan trên máy này. */
export function ImportDialog({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [bundle, setBundle] = useState<unknown>()
  const [preview, setPreview] = useState<Preview>()
  const [overwrite, setOverwrite] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<ImportResult>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setError(undefined)
    setPreview(undefined)
    setResult(undefined)
    try {
      const parsed = JSON.parse(await file.text())
      setBundle(parsed)
      setPreview(await connection.call<Preview>('bundles.preview', { bundle: parsed }))
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const i of preview?.items ?? []) out[i.status] = (out[i.status] ?? 0) + 1
    return out
  }, [preview])
  const apply = async () => {
    setBusy(true)
    setError(undefined)
    try {
      setResult(await connection.call<ImportResult>('bundles.import', { bundle, overwrite: [...overwrite] }))
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const key = (i: ImportItem) => `${i.kind}:${i.path}`

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="dialog modal wide" onClick={(e) => e.stopPropagation()}>
        <header><h3>Import plan</h3><button onClick={onClose}>Đóng</button></header>
        {!result && (
          <label className="field">
            <span className="field-name">Chọn file gói (.json) xuất từ một aitest khác</span>
            <input type="file" accept=".json,application/json" onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
        )}
        {error && <div className="bad">{error}</div>}
        {preview && !result && (
          <>
            <div className="small">
              Gói có {preview.plans.length} plan: {preview.plans.map((p) => <b key={p.id}>{p.id} </b>)}
              <span className="muted"> · {Object.entries(counts).map(([s, n]) => `${STATUS[s as ImportItem['status']]} ${n}`).join(' · ')}</span>
            </div>
            {preview.warnings.length > 0 && (
              <div className="card notice small">
                <b>Máy này còn thiếu (plan nhập được nhưng chưa chạy được cho tới khi bổ sung)</b>
                <ul>{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              </div>
            )}
            <table className="plain bundle-table">
              <thead><tr><th>Loại</th><th>Ghi vào</th><th>Trạng thái</th></tr></thead>
              <tbody>
                {preview.items.map((i) => (
                  <tr key={key(i)} className={i.status}>
                    <td>{KIND[i.kind] ?? i.kind}</td>
                    <td><code>{i.target ?? i.path}</code></td>
                    <td>
                      {i.status === 'changed'
                        ? <label title={i.reason}><input type="checkbox" checked={overwrite.has(key(i))} onChange={() => {
                            const next = new Set(overwrite)
                            if (next.has(key(i))) next.delete(key(i))
                            else next.add(key(i))
                            setOverwrite(next)
                          }} /> Ghi đè (đang giữ bản trên máy này)</label>
                        : STATUS[i.status]}
                      {i.status === 'blocked' && <div className="bad small">{i.reason}</div>}
                      {i.dependsOn && <div className="muted small">Chỉ ghi khi ghi đè {i.dependsOn.replace(/^system:/, '')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="actions">
              <button className="primary" disabled={busy} onClick={apply}>⇧ Import</button>
              <span className="muted small">File bị ghi đè được giữ bản cũ để hoàn tác.</span>
            </div>
          </>
        )}
        {result && (
          <>
            <div className="ok">Đã ghi {result.written.length} file, bỏ qua {result.skipped.length}.</div>
            <ul className="small">
              {result.plans.map((p) => (
                <li key={p.target}>
                  {p.valid ? '✅' : '❌'} <b>{p.id}</b> <code>{p.target}</code>{p.errors.length ? <span className="bad"> — {p.errors.join('; ')}</span> : ' — hợp lệ trên máy này'}
                </li>
              ))}
            </ul>
            {result.backupDir && <div className="muted small">Bản ghi lần nhập và bản cũ của file bị ghi đè: <code>{result.backupDir}</code></div>}
          </>
        )}
      </section>
    </div>
  )
}
