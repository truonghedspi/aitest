import type { ClientPlugin, ToolViewProps } from '../slots.ts'

/**
 * Thẻ hiển thị cho các tool soạn plan, chọn theo `view.kind` do Host dựng (`present` của action).
 */
export const toolViews: ClientPlugin = (slots) => {
  slots.toolView.register('code', CodeView)
  slots.toolView.register('plan-validation', ValidationView)
  slots.toolView.register('run-result', RunResultView)
  slots.toolView.register('explore', ExploreView)
  slots.toolView.register('action-list', ActionListView)
  slots.toolView.register('plan-list', PlanListView)
  slots.toolView.register('context-list', ContextListView)
  slots.toolView.register('calc', CalcView)
  slots.toolView.register('tool-catalog', ToolCatalogView)
  slots.toolView.register('tool-added', ToolAddedView)
  slots.toolView.register('system-list', SystemListView)
}

function CalcView({ view, call }: ToolViewProps) {
  if (call.status !== 'ok') return <div className="bad">{call.error}</div>
  const inputs = Object.entries((view.inputs as Record<string, unknown>) ?? {})
  return (
    <div>
      <code>{String(view.expression)}</code> = <b>{String(view.result)}</b>
      {inputs.length > 0 && <div className="muted small">{inputs.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(' · ')}</div>}
    </div>
  )
}

export function GenericView({ call }: ToolViewProps) {
  return <Json value={call.status === 'ok' ? call.value : call.error} />
}

function CodeView({ view }: ToolViewProps) {
  return <pre className="code">{String(view.text ?? '')}</pre>
}

function ValidationView({ view }: ToolViewProps) {
  const errors = (view.errors as Array<{ message: string; path?: string }>) ?? []
  const warnings = (view.warnings as Array<{ message: string; path?: string }>) ?? []
  return (
    <div>
      <div className={view.valid ? 'ok' : 'bad'}>
        {view.valid ? 'Hợp lệ' : 'Không hợp lệ'} · {errors.length} lỗi · {warnings.length} cảnh báo
      </div>
      <Issues items={errors} level="error" />
      <Issues items={warnings} level="warning" />
    </div>
  )
}

export function Issues({ items, level }: { items: Array<{ message: string; path?: string }>; level: string }) {
  if (!items.length) return null
  return (
    <ul className={`issues ${level}`}>
      {items.map((i, k) => <li key={k}>{i.path && <code>{i.path}</code>} {i.message}</li>)}
    </ul>
  )
}

function RunResultView({ view }: ToolViewProps) {
  if (view.status === 'running') return <div className="muted">Đang chạy… ({String(view.elapsedSec ?? 0)} giây)</div>
  if (view.status === 'error') return <div className="bad">{String(view.error)}</div>
  return <RunCases value={view} />
}

const ICON: Record<string, string> = { pass: '✅', fail: '❌', error: '💥', inconclusive: '❔', skipped: '⏭️', blocked: '🚧' }

export function RunCases({ value }: { value: any }) {
  return (
    <div className="run">
      {value.runId && <a className="small" href={`#/runs/${value.runId}`}>Xem log chi tiết: agent đã làm gì và vì sao ra kết quả này →</a>}
      {(value.cases ?? []).map((c: any) => (
        <details key={c.id} open={c.verdict !== 'pass'}>
          <summary>{ICON[c.verdict] ?? ''} <b>{c.id}</b> {c.title} — {c.verdict}</summary>
          <table>
            <thead><tr><th>Expectation</th><th>Mong đợi</th><th>Thực tế</th><th></th></tr></thead>
            <tbody>
              {c.expectations.map((e: any) => (
                <tr key={e.id}>
                  <td title={e.desc}>{e.id}</td>
                  <td><code>{e.op} {JSON.stringify(e.expected)}</code>{e.expr && <div className="muted small">{e.expr}</div>}</td>
                  <td><code>{e.actual === undefined ? '—' : JSON.stringify(e.actual)}</code></td>
                  <td>{e.passed === undefined ? 'chưa assert' : e.passed ? '✅' : '❌'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.hints?.length > 0 && <ul className="hints">{c.hints.map((h: string, k: number) => <li key={k}>{h}</li>)}</ul>}
        </details>
      ))}
    </div>
  )
}

function ExploreView({ view, call }: ToolViewProps) {
  const value = view.value as any
  const rows = value?.rows as Array<Record<string, unknown>> | undefined
  return (
    <div>
      <Json value={view.args} />
      {call.status !== 'ok' ? <div className="bad">{call.error}</div>
        : rows ? <Rows rows={rows} />
          : <Json value={value} />}
    </div>
  )
}

function Rows({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (!rows.length) return <div className="muted">Không có dòng nào.</div>
  const columns = Object.keys(rows[0])
  return (
    <div className="scroll">
      <table>
        <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{rows.slice(0, 20).map((r, i) => <tr key={i}>{columns.map((c) => <td key={c}>{String(r[c])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function ActionListView({ view }: ToolViewProps) {
  const actions = view.actions as Array<{ name: string; namespace: string }>
  return <div className="tags">{actions.map((a) => <span key={a.name} className="tag">{a.namespace}/{a.name}</span>)}</div>
}

function PlanListView({ view }: ToolViewProps) {
  const plans = view.plans as Array<{ path: string; id?: string; name?: string; error?: string }>
  return <ul>{plans.map((p) => <li key={p.path}><code>{p.path}</code> {p.id} — {p.name ?? p.error}</li>)}</ul>
}

function ToolCatalogView({ view }: ToolViewProps) {
  const entries = view.entries as Array<{ id: string; title: string; installed: boolean }>
  return <div className="tags">{entries.map((e) => <span key={e.id} className="tag">{e.title}{e.installed ? ' ✓' : ''}</span>)}</div>
}

function ToolAddedView({ view, call }: ToolViewProps) {
  if (call.status !== 'ok') return <GenericView view={view} call={call} />
  if (!view.added) return <div className="muted">Không thêm tool.</div>
  const tools = view.tools as string[]
  return <div>Row <code>{view.rowId as string}</code>: <span className="tags">{tools.map((t) => <span key={t} className="tag">{t}</span>)}</span></div>
}

function SystemListView({ view }: ToolViewProps) {
  const systems = view.systems as Array<{ id: string; title: string }>
  return <div className="tags">{systems.map((s) => <span key={s.id} className="tag" title={s.title}>{s.id}</span>)}</div>
}

function ContextListView({ view }: ToolViewProps) {
  const sources = view.sources as Array<{ id: string; title: string; docs: Array<{ id: string }> }>
  return <ul>{sources.map((s) => <li key={s.id}><b>{s.title}</b>: {s.docs.map((d) => d.id).join(', ')}</li>)}</ul>
}

export function Json({ value }: { value: unknown }) {
  return <pre className="code">{JSON.stringify(value, null, 2)?.slice(0, 4000)}</pre>
}
