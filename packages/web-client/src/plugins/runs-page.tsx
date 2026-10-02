import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ToolCallCard } from '../components.tsx'
import { connection } from '../connection.ts'
import { EnvTag } from '../env.tsx'
import { Markdown } from '../markdown.tsx'
import type { ClientPlugin, PageProps } from '../slots.ts'
import type { ActionCallData, RunEvent } from '../types.ts'
import { Json } from './tool-views.tsx'

/**
 * Trang Lượt chạy: xem lại agent đã làm gì trong từng test case và vì sao ra kết quả đó.
 * Mọi thứ dựng từ run log (`events.jsonl`); lượt chạy chưa kết thúc được cập nhật liên tục.
 */
export const runsPage: ClientPlugin = (s) => {
  // Trang con của "Plan": danh sách lượt chạy nằm ở tab của trang Plan, chi tiết lượt chạy mở tại `runs/<mã>`.
  s.page.register('runs', { id: 'runs', title: 'Lượt chạy', order: 3, component: RunsPage, parent: 'plans' })
}

export interface RunSummary {
  runId: string
  plan?: { id: string; name: string; source?: string }
  agent?: string
  env?: string
  startedAt?: string
  finished: boolean
  dryRun: boolean
  durationMs: number
  totals?: Record<string, number>
  cases: Array<{ id: string; title: string; verdict: string }>
  blocked?: string[]
}

export const ICON: Record<string, string> = { pass: '✅', fail: '❌', error: '💥', inconclusive: '❔', skipped: '⏭️', blocked: '🚧', running: '⏳' }
export const VERDICT: Record<string, string> = {
  pass: 'Đạt', fail: 'Không đạt', error: 'Lỗi', inconclusive: 'Chưa kết luận', skipped: 'Bỏ qua', blocked: 'Chưa đủ điều kiện', running: 'Đang chạy',
}

/* ------------------------------------------------------------------ store */

interface RunState { summary?: RunSummary; events: RunEvent[] }

class RunStore {
  private state: RunState = { events: [] }
  private readonly listeners = new Set<() => void>()
  private lastSeq = 0

  constructor(readonly runId: string) {
    connection.listen((m) => { if (m.type === 'run-event' && m.runId === runId) this.accept([m.event]) })
    connection.onOpen(() => void this.subscribe())
    void this.subscribe()
  }

  get = () => this.state
  subscribeStore = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }

  private async subscribe() {
    const r = await connection.call<{ summary: RunSummary; events: RunEvent[] }>('runs.subscribe', { runId: this.runId, afterSeq: this.lastSeq }).catch(() => undefined)
    if (!r) return
    this.state = { ...this.state, summary: r.summary }
    this.accept(r.events)
  }

  private accept(events: RunEvent[]) {
    const fresh = events.filter((e) => e.seq > this.lastSeq).sort((a, b) => a.seq - b.seq)
    if (fresh.length) this.lastSeq = fresh.at(-1)!.seq
    this.state = { ...this.state, events: [...this.state.events, ...fresh] }
    for (const l of this.listeners) l()
  }
}

const stores = new Map<string, RunStore>()
function useRun(runId: string) {
  let store = stores.get(runId)
  if (!store) stores.set(runId, store = new RunStore(runId))
  return useSyncExternalStore(store.subscribeStore, store.get)
}

/* ------------------------------------------------------------------ derive */

interface Evidence { id: string; call: ActionCallData }

interface Assertion {
  seq: number; expectId: string; evidenceId?: string; path?: string; op: string; expected?: unknown; actual?: unknown
  passed: boolean; message: string; criteria: string; expr?: string; inputs?: Record<string, { evidenceId: string; path: string; value: unknown }>
}

interface CaseView {
  id: string
  title: string
  steps: string[]
  expect: Array<{ id: string; desc: string; check?: { op: string; value?: unknown; expr?: string } }>
  events: RunEvent[]
  evidence: Map<string, Evidence>
  assertions: Assertion[]
  end?: { verdict: string; reasons: string[]; durationMs: number; stopReason?: string }
  annotations: Record<string, Array<{ id: string; title: string }>>
  prompt?: string
  summary: string
  model?: string
}

function deriveCases(events: RunEvent[]): CaseView[] {
  const cases = new Map<string, CaseView>()
  for (const e of events) {
    if (e.type === 'case/start') {
      cases.set(e.data.id, {
        id: e.data.id, title: e.data.title, steps: e.data.steps ?? [], expect: e.data.expect, events: [], evidence: new Map(), assertions: [],
        annotations: {}, summary: '',
      })
      continue
    }
    const c = e.caseId ? cases.get(e.caseId) : undefined
    if (!c) continue
    c.events.push(e)
    if (e.type === 'action/call' && e.data.annotations?.evidenceId) c.evidence.set(e.data.annotations.evidenceId, { id: e.data.annotations.evidenceId, call: e.data })
    if (e.type === 'assert/result') c.assertions.push({ ...e.data, seq: e.seq })
    if (e.type === 'case/end') c.end = e.data
    if (e.type === 'case/annotation') c.annotations[e.data.key] = e.data.value
    if (e.type === 'agent/prompt') c.prompt = e.data.text
    if (e.type === 'agent/session') c.model = e.data.model
    if (e.type === 'agent/update' && e.data.kind === 'message' && e.data.text) c.summary = e.data.text
  }
  return [...cases.values()]
}

/** Đọc giá trị theo path rút gọn `$.a.b[0]`, khớp cách nền tảng đọc evidence (kể cả tiền tố `$.result`). */
function readPath(root: unknown, path: string): unknown {
  const walk = (p: string) => {
    const tokens = [...p.replace(/^\$/, '').matchAll(/\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[(['"])(.*?)\3\]/g)]
      .map((m) => m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[4]))
    let cur: any = root
    for (const t of tokens) { if (cur == null) return undefined; cur = cur[t] }
    return cur
  }
  const value = walk(path)
  return value !== undefined ? value : walk(path.replace(/^\$?\.result(?=$|[.[])/, '$'))
}

/* ------------------------------------------------------------------ pages */

function RunsPage({ param, navigate }: PageProps) {
  // Đường dẫn cũ `#/runs` chuyển sang tab Lượt chạy của trang Plan.
  useEffect(() => { if (!param) navigate('plans/runs') }, [param])
  return param ? <RunDetail runId={param.split('/')[0]} caseId={param.split('/')[1]} navigate={navigate} /> : null
}

/** Danh sách mọi lượt chạy, đặt trong tab "Lượt chạy" của trang Plan; tự làm mới mỗi 5 giây. */
export function RunList({ navigate }: { navigate(path: string): void }) {
  const runs = useRuns()
  const [filter, setFilter] = useState('')
  const [hideDry, setHideDry] = useState(false)
  const shown = (runs ?? []).filter((r) => (!hideDry || !r.dryRun) && `${r.runId} ${r.plan?.id} ${r.plan?.name}`.toLowerCase().includes(filter.toLowerCase()))
  return (
    <>
      <div className="toolbar">
        <input placeholder="Lọc theo plan, mã lượt chạy…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="muted small"><input type="checkbox" checked={hideDry} onChange={(e) => setHideDry(e.target.checked)} /> Ẩn lượt chạy thử</label>
      </div>
      <p className="muted small">Bấm một lượt chạy để xem agent đã làm gì trong từng case, dữ liệu thật nền tảng đọc được, và vì sao case ra kết quả đó.</p>
      {!runs ? <div className="muted">Đang tải…</div> : !shown.length ? <div className="empty">Chưa có lượt chạy nào.</div> : <RunTable runs={shown} navigate={navigate} showPlan />}
    </>
  )
}

/** Lượt chạy gần nhất, làm mới mỗi 5 giây; `planId` lọc theo plan. */
export function useRuns(planId?: string, limit?: number) {
  const [runs, setRuns] = useState<RunSummary[]>()
  useEffect(() => {
    let alive = true
    const load = () => { void connection.call<RunSummary[]>('runs.list', { planId, limit }).then((r) => { if (alive) setRuns(r) }) }
    load()
    const timer = setInterval(load, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [planId, limit])
  return runs
}

export function RunTable({ runs, navigate, showPlan }: { runs: RunSummary[]; navigate(path: string): void; showPlan?: boolean }) {
  return (
    <table className="run-table">
      <thead><tr><th>Bắt đầu</th>{showPlan && <th>Plan</th>}<th>Môi trường</th><th>Kết quả</th><th>Case</th><th>Thời lượng</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.runId} onClick={() => navigate(`runs/${r.runId}`)}>
            <td>
              {r.startedAt ? <span title={new Date(r.startedAt).toLocaleString('vi-VN')}>{timeAgo(r.startedAt)}</span> : '—'}
              {r.dryRun && <span className="tag">chạy thử</span>}
            </td>
            {showPlan && <td><b>{r.plan?.name ?? r.runId}</b><div className="muted small">{r.plan?.id} · {r.agent}</div></td>}
            <td>{r.env ? <EnvTag env={r.env} /> : <span className="muted small">—</span>}</td>
            <td>{!r.finished ? <span className="badge pending">Đang chạy</span> : r.blocked ? <b className="warn">🚧 Chưa đủ điều kiện</b> : <Totals totals={r.totals} />}</td>
            <td>{r.cases.map((c) => <span key={c.id} title={`${c.id}: ${VERDICT[c.verdict] ?? c.verdict}`}>{ICON[c.verdict] ?? '·'}</span>)}</td>
            <td>{(r.durationMs / 1000).toFixed(1)} s</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Thời gian tương đối dễ đọc: "vừa xong", "5 phút trước", "hôm qua", hoặc ngày. */
export function timeAgo(iso: string) {
  const diff = (Date.now() - Date.parse(iso)) / 1000
  if (diff < 60) return 'vừa xong'
  if (diff < 3600) return `${Math.floor(diff / 60)} phút trước`
  if (diff < 86400) return `${Math.floor(diff / 3600)} giờ trước`
  if (diff < 172800) return 'hôm qua'
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} ngày trước`
  return new Date(iso).toLocaleDateString('vi-VN')
}

export function Totals({ totals }: { totals?: Record<string, number> }) {
  if (!totals) return null
  return (
    <span className="small">
      <b className="ok">{totals.pass} đạt</b>
      {totals.fail > 0 && <> · <b className="bad">{totals.fail} không đạt</b></>}
      {totals.error > 0 && <> · <b className="bad">{totals.error} lỗi</b></>}
      {totals.inconclusive > 0 && <> · <b className="warn">{totals.inconclusive} chưa kết luận</b></>}
      {totals.blocked > 0 && <> · <b className="warn">{totals.blocked} chưa đủ điều kiện</b></>}
    </span>
  )
}

function RunDetail({ runId, caseId, navigate }: { runId: string; caseId?: string; navigate(path: string): void }) {
  const { summary, events } = useRun(runId)
  const cases = useMemo(() => deriveCases(events), [events])
  const current = cases.find((c) => c.id === caseId) ?? cases.find((c) => c.end && c.end.verdict !== 'pass') ?? cases[0]
  const finished = events.some((e) => e.type === 'run/end')
  // Tổng số tính lại từ log để luôn khớp khi lượt chạy đang diễn ra; snapshot ban đầu có thể đã cũ.
  const totals = useMemo(() => {
    const out: Record<string, number> = { pass: 0, fail: 0, error: 0, inconclusive: 0, blocked: 0 }
    for (const c of cases) if (c.end) out[c.end.verdict] = (out[c.end.verdict] ?? 0) + 1
    return out
  }, [cases])
  const runLevel = events.filter((e) => !e.caseId && !['run/start', 'run/end'].includes(e.type))
  return (
    <main className="manager run-detail">
      <header>
        <button onClick={() => navigate(summary?.plan?.source ? `plans/${summary.plan.source}` : 'plans/runs')}>
          ← {summary?.plan?.source ? 'Về plan' : 'Lượt chạy'}
        </button>
        <h2>{summary?.plan?.name ?? runId}</h2>
        <EnvTag env={summary?.env} />
        {!finished && <span className="badge pending">Đang chạy…</span>}
        <Totals totals={totals} />
      </header>
      <p className="muted small">
        <code>{runId}</code> · agent {summary?.agent} · {summary?.startedAt && new Date(summary.startedAt).toLocaleString('vi-VN')}
        {runLevel.some((e) => e.type === 'agent/connected') && <> · {runLevel.find((e) => e.type === 'agent/connected')!.data.name} {runLevel.find((e) => e.type === 'agent/connected')!.data.version}</>}
      </p>
      <RunPreparation events={runLevel} />
      <div className="run-layout">
        <nav className="case-list">
          {cases.map((c) => (
            <button key={c.id} className={c.id === current?.id ? 'active' : ''} onClick={() => navigate(`runs/${runId}/${c.id}`)}>
              <span>{ICON[c.end?.verdict ?? 'running']} <b>{c.id}</b></span>
              <span className="muted small">{c.title}</span>
            </button>
          ))}
        </nav>
        {current ? <CaseDetail key={current.id} item={current} /> : <div className="muted">Chưa có case nào.</div>}
      </div>
    </main>
  )
}

const SOURCE: Record<string, string> = { user: 'người chạy điền', fill: 'bước fill', agent: 'agent chuẩn bị', default: 'mặc định', missing: 'thiếu' }

/** Đầu vào của lượt chạy, nguồn giá trị, lý do bị chặn và các lời gọi tool khi chuẩn bị dữ liệu. */
function RunPreparation({ events }: { events: RunEvent[] }) {
  const inputs = events.find((e) => e.type === 'inputs/resolved')?.data.inputs as Array<{
    name: string; source: string; value?: unknown; error?: string; evidence?: { evidenceId: string; path: string }
  }> | undefined
  const blocked = events.find((e) => e.type === 'run/blocked')?.data.reasons as string[] | undefined
  const calls = events.filter((e) => e.type === 'action/call')
  const failures = events.filter((e) => ['inputs/fill-failed', 'inputs/prepare-failed', 'run/cleanup-failed'].includes(e.type))
  if (!inputs && !blocked && !calls.length) return null
  return (
    <section className="run-prep">
      {blocked && (
        <div className="bad">
          🚧 Lượt chạy bị chặn, các case không được chạy:
          <ul>{blocked.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      {inputs && (
        <table>
          <thead><tr><th>Đầu vào</th><th>Giá trị</th><th>Nguồn</th><th>Ghi chú</th></tr></thead>
          <tbody>
            {inputs.map((i) => (
              <tr key={i.name}>
                <td><code>{i.name}</code></td>
                <td>{i.value === undefined ? '—' : <code>{JSON.stringify(i.value)}</code>}</td>
                <td>{SOURCE[i.source] ?? i.source}</td>
                <td className={i.error ? 'bad' : 'muted'}>{i.error ?? (i.evidence ? `${i.evidence.evidenceId} ${i.evidence.path}` : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(calls.length > 0 || failures.length > 0) && (
        <details>
          <summary>Chuẩn bị và dọn dữ liệu ({calls.length} lời gọi{failures.length ? `, ${failures.length} lỗi` : ''})</summary>
          <ul className="small">
            {calls.map((e) => (
              <li key={e.seq}>
                <span className={e.data.status === 'ok' ? 'ok' : 'bad'}>{e.data.status === 'ok' ? '✓' : '✗'}</span>{' '}
                <code>{e.data.name}</code> <span className="muted">{e.data.phase === 'teardown' ? 'dọn' : 'chuẩn bị'}</span>
                {(e.data.reason || e.data.args?.desc) && <span className="muted"> · {e.data.reason ?? e.data.args.desc}</span>}
                {e.data.error && <span className="bad"> · {e.data.error}</span>}
              </li>
            ))}
            {failures.map((e) => <li key={e.seq} className="bad">{e.type}: {e.data.error}</li>)}
          </ul>
        </details>
      )}
    </section>
  )
}

function CaseDetail({ item }: { item: CaseView }) {
  const [tab, setTab] = useState<'why' | 'journey' | 'timeline' | 'prompt' | 'raw'>('why')
  const [evidence, setEvidence] = useState<string>()
  const verdict = item.end?.verdict ?? 'running'
  return (
    <section className="case-detail">
      <div className={`verdict-box ${verdict}`}>
        <div className="verdict-title">{ICON[verdict]} {item.id} — {item.title}: <b>{VERDICT[verdict] ?? verdict}</b></div>
        {item.end && <div className="muted small">{(item.end.durationMs / 1000).toFixed(1)} s · model {item.model ?? 'mặc định'} · agent dừng: {item.end.stopReason ?? '—'}</div>}
        {item.end?.reasons.length ? <ul>{item.end.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul> : null}
        {item.annotations.knownIssues && <div className="warn small">Lỗi đã biết: {item.annotations.knownIssues.map((i) => `${i.id} (${i.title})`).join(', ')}</div>}
        {item.annotations.possiblyFixed && <div className="ok small">Có thể đã sửa: {item.annotations.possiblyFixed.map((i) => i.id).join(', ')}</div>}
      </div>
      <div className="tabs inline">
        {([['why', 'Giải thích kết quả'], ['journey', 'Hành trình'], ['timeline', 'Dòng thời gian'], ['prompt', 'Prompt gửi agent'], ['raw', 'Dữ liệu thô']] as const).map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'why' && <Explanation item={item} onEvidence={setEvidence} />}
      {tab === 'journey' && <Journey item={item} onEvidence={setEvidence} />}
      {tab === 'timeline' && <Timeline item={item} onEvidence={setEvidence} />}
      {tab === 'prompt' && (item.prompt ? <pre className="code prompt">{item.prompt}</pre> : <div className="muted">Case chưa gửi prompt cho agent (có thể lỗi ở bước chuẩn bị).</div>)}
      {tab === 'raw' && <RawEvents events={item.events} />}
      {evidence && <EvidencePanel item={item} id={evidence} onClose={() => setEvidence(undefined)} />}
    </section>
  )
}

/** Với mỗi expectation: tiêu chí, evidence và path agent chọn, giá trị thật nền tảng đọc được, và các lần thử. */
function Explanation({ item, onEvidence }: { item: CaseView; onEvidence(id: string): void }) {
  return (
    <div className="explain">
      {item.expect.map((e) => {
        const attempts = item.assertions.filter((a) => a.expectId === e.id)
        const final = attempts.at(-1)
        return (
          <div key={e.id} className={`explain-item ${final ? (final.passed ? 'pass' : 'fail') : 'missing'}`}>
            <div className="explain-head">
              <span>{final ? (final.passed ? '✅' : '❌') : '❔'}</span>
              <b>{e.id}</b> <span>{e.desc}</span>
            </div>
            <dl>
              <dt>Tiêu chí</dt>
              <dd>
                {e.check?.expr ? <><code>{e.check.op}</code> công thức <code>{e.check.expr}</code></>
                  : e.check ? <><code>{e.check.op}</code> <code>{JSON.stringify(e.check.value)}</code></>
                    : final ? <>agent tự chọn: <code>{final.op} {JSON.stringify(final.expected)}</code></> : 'agent tự chọn'}
                {e.check ? <span className="muted small"> (cố định trong plan)</span> : <span className="warn small"> (plan không khai báo tiêu chí)</span>}
              </dd>
              {final ? (
                <>
                  {final.expr && (
                    <>
                      <dt>Giá trị mong đợi</dt>
                      <dd>
                        <code>{String(final.expected)}</code> = <code>{final.expr}</code> với{' '}
                        {Object.entries(final.inputs ?? {}).map(([n, i]) => (
                          <span key={n}><code>{n} = {JSON.stringify(i.value)}</code> (<EvidenceLink id={i.evidenceId} onOpen={onEvidence} /> <code>{i.path}</code>) </span>
                        ))}
                        {[...new Set(Object.values(final.inputs ?? {}).map((i) => i.evidenceId))].map((id) => (
                          <div key={id} className="muted small">{id}: <Why call={item.evidence.get(id)?.call} /></div>
                        ))}
                      </dd>
                    </>
                  )}
                  <dt>Giá trị thật</dt>
                  <dd>
                    <code>{JSON.stringify(final.actual) ?? 'undefined'}</code> đọc tại <EvidenceLink id={final.evidenceId} onOpen={onEvidence} /> <code>{final.path}</code>
                    {final.evidenceId && item.evidence.get(final.evidenceId) && <span className="muted small"> — kết quả của <code>{item.evidence.get(final.evidenceId)!.call.name}</code></span>}
                  </dd>
                  <dt>Vì sao lấy dữ liệu này</dt>
                  <dd><Why call={final.evidenceId ? item.evidence.get(final.evidenceId)?.call : undefined} /></dd>
                  <dt>Kết luận</dt>
                  <dd className={final.passed ? 'ok' : 'bad'}>{final.passed ? 'Đạt' : final.message}</dd>
                  {attempts.length > 1 && (
                    <>
                      <dt>Các lần thử</dt>
                      <dd>
                        <ol className="attempts">
                          {attempts.map((a) => <li key={a.seq}><EvidenceLink id={a.evidenceId} onOpen={onEvidence} /> <code>{a.path}</code> → <code>{JSON.stringify(a.actual) ?? 'undefined'}</code> {a.passed ? '✅' : '❌'}</li>)}
                        </ol>
                        <span className="muted small">Lần cuối cùng quyết định kết quả.</span>
                      </dd>
                    </>
                  )}
                </>
              ) : (
                <>
                  <dt>Kết luận</dt>
                  <dd className="warn">Agent không assert expectation này, nên case chưa kết luận được. Xem "Dòng thời gian" để biết agent dừng ở đâu; thường do mô tả expectation mơ hồ hoặc thiếu bước tạo dữ liệu cần kiểm tra.</dd>
                </>
              )}
            </dl>
          </div>
        )
      })}
      {item.summary && <div className="agent-summary"><div className="field-name">Tóm tắt cuối cùng của agent</div><Markdown text={item.summary} /></div>}
    </div>
  )
}

/** Lý do agent khai báo khi gọi action tạo ra evidence; fixture do nền tảng chạy nên không có lý do. */
function Why({ call }: { call?: ActionCallData }) {
  if (!call) return <span className="muted">—</span>
  if (call.phase && call.phase !== 'agent') return <span className="muted">Dữ liệu từ fixture do nền tảng chạy{call.reason ? `: ${call.reason}` : '.'}</span>
  return call.reason
    ? <span>{call.reason}{call.step ? <span className="muted small"> (bước {call.step})</span> : null}</span>
    : <span className="warn small">Agent không nêu lý do.</span>
}

/**
 * Hành trình theo từng bước của test case: agent gọi gì, vì sao, lấy được evidence nào, ghi chú của bước.
 * Lời gọi agent không gắn bước được gom vào mục riêng; fixture hiển thị ở đầu và cuối.
 */
function Journey({ item, onEvidence }: { item: CaseView; onEvidence(id: string): void }) {
  const calls = item.events.filter((e) => e.type === 'action/call').map((e) => e.data as ActionCallData & { annotations?: { evidenceId?: string } })
  const notes = item.events.filter((e) => e.type === 'step/note').map((e) => e.data as { step: number; status: string; note?: string })
  const agentCalls = calls.filter((c) => (c.phase ?? 'agent') === 'agent' && c.name !== 'note_step')
  const unassigned = agentCalls.filter((c) => !c.step || c.step > item.steps.length)
  const fixtures = (phase: string) => calls.filter((c) => c.phase === phase)
  const asserts = new Set(['assert_expectation'])
  const Call = ({ c }: { c: ActionCallData & { annotations?: { evidenceId?: string } } }) => (
    <li className={c.status === 'ok' ? '' : 'bad'}>
      <code>{c.view?.title ?? c.name}</code>
      {c.annotations?.evidenceId && <> → <EvidenceLink id={c.annotations.evidenceId} onOpen={onEvidence} /></>}
      {c.status !== 'ok' && <span className="bad small"> ({c.status}: {c.error})</span>}
      <div className="reason">
        {c.reason ? `Vì sao: ${c.reason}`
          : c.phase && c.phase !== 'agent' ? <span className="muted">Fixture trong plan, không có mô tả (`desc`).</span>
            : asserts.has(c.name) ? 'Đối chiếu kết quả với expectation.' : <span className="warn">Agent không nêu lý do.</span>}
      </div>
    </li>
  )
  return (
    <div className="journey">
      {fixtures('setup').length > 0 && (
        <section><h4>Chuẩn bị dữ liệu (nền tảng chạy, không qua agent)</h4><ul>{fixtures('setup').map((c) => <Call key={c.callId} c={c} />)}</ul></section>
      )}
      {item.steps.map((text, i) => {
        const n = i + 1
        const inStep = agentCalls.filter((c) => c.step === n)
        const stepNotes = notes.filter((x) => x.step === n)
        return (
          <section key={n} className="journey-step">
            <h4>Bước {n}: <span className="step-text">{text}</span></h4>
            {inStep.length ? <ul>{inStep.map((c) => <Call key={c.callId} c={c} />)}</ul> : <div className="muted small">Không có lời gọi tool nào gắn với bước này.</div>}
            {stepNotes.map((x, k) => <div key={k} className={`small ${x.status === 'failed' ? 'bad' : 'muted'}`}>Agent ghi nhận: {x.status}{x.note ? ` — ${x.note}` : ''}</div>)}
          </section>
        )
      })}
      {unassigned.length > 0 && (
        <section className="journey-step"><h4>Không gắn với bước nào</h4><ul>{unassigned.map((c) => <Call key={c.callId} c={c} />)}</ul></section>
      )}
      {fixtures('teardown').length > 0 && (
        <section><h4>Dọn dữ liệu (nền tảng chạy)</h4><ul>{fixtures('teardown').map((c) => <Call key={c.callId} c={c} />)}</ul></section>
      )}
    </div>
  )
}

function EvidenceLink({ id, onOpen }: { id?: string; onOpen(id: string): void }) {
  if (!id) return <span className="muted">—</span>
  return <button className="link tag" onClick={() => onOpen(id)}>{id}</button>
}

function EvidencePanel({ item, id, onClose }: { item: CaseView; id: string; onClose(): void }) {
  const ev = item.evidence.get(id)
  const paths = item.assertions.filter((a) => a.evidenceId === id).map((a) => a.path!).concat(
    item.assertions.flatMap((a) => Object.values(a.inputs ?? {}).filter((i) => i.evidenceId === id).map((i) => i.path)),
  )
  return (
    <aside className="evidence-panel card">
      <header><b>Evidence {id}</b><button onClick={onClose}>Đóng</button></header>
      {!ev ? <div className="muted">Không tìm thấy evidence này trong case.</div> : (
        <>
          <div className="small">Action <code>{ev.call.name}</code> · {ev.call.status} · {ev.call.durationMs} ms</div>
          <div className="field-name">Tham số agent truyền</div>
          <Json value={ev.call.args} />
          {[...new Set(paths)].map((p) => <div key={p} className="small">Giá trị tại <code>{p}</code>: <code>{JSON.stringify(readPath(ev.call.value, p))}</code></div>)}
          <div className="field-name">Kết quả đầy đủ</div>
          <Json value={ev.call.status === 'ok' ? ev.call.value : ev.call.error} />
        </>
      )}
    </aside>
  )
}

/** Mọi việc agent và nền tảng đã làm trong case, theo đúng thứ tự trong log. */
function Timeline({ item, onEvidence }: { item: CaseView; onEvidence(id: string): void }) {
  const outputs = new Map<string, unknown>()
  for (const e of item.events) if (e.type === 'agent/update' && e.data.kind === 'tool_update' && e.data.toolCallId) outputs.set(e.data.toolCallId, e.data.output)
  const started = new Set(item.events.filter((e) => e.type === 'action/call').map((e) => e.data.callId))
  return (
    <div className="timeline run-timeline">
      {item.events.map((e) => {
        const d = e.data
        switch (e.type) {
          case 'fixture/vars': return <Row key={e.seq} e={e} label="Biến sau fixture"><Json value={d.vars} /></Row>
          case 'agent/prompt': return <Row key={e.seq} e={e} label="Gửi prompt cho agent"><details><summary className="muted small">{d.text.length} ký tự — bấm để xem</summary><pre className="code prompt">{d.text}</pre></details></Row>
          case 'action/start': return started.has(d.callId) ? null : <Row key={e.seq} e={e} label="Đang gọi"><ToolCallCard call={{ ...d, status: 'ok', durationMs: 0 }} pending /></Row>
          case 'action/call': return <Row key={e.seq} e={e} label={d.phase === 'agent' ? 'Agent gọi tool' : 'Nền tảng chạy fixture'}><ToolCallCard call={d} /></Row>
          case 'agent/permission': return <Row key={e.seq} e={e} label="Xin quyền"><span className={d.allowed ? 'ok' : 'bad'}>{d.allowed ? 'Cho phép' : 'Từ chối'}</span> <span className="muted small">{d.title}</span></Row>
          case 'agent/update':
            if (d.kind === 'message') return <Row key={e.seq} e={e} label="Agent trả lời"><div className="bubble agent"><Markdown text={d.text ?? ''} /></div></Row>
            if (d.kind === 'thought') return <Row key={e.seq} e={e} label="Agent suy nghĩ"><details className="thought"><summary>{(d.text ?? '').slice(0, 120)}{(d.text ?? '').length > 120 ? '…' : ''}</summary>{d.text}</details></Row>
            if (d.kind === 'tool_call' && !/@[\w-]+\//.test(d.title ?? '')) {
              return (
                <Row key={e.seq} e={e} label="Tool riêng của agent">
                  <details className="tool"><summary><span className="name">{d.title}</span></summary>
                    {d.input !== undefined && <><div className="field-name">Tham số</div><Json value={d.input} /></>}
                    {outputs.get(d.toolCallId) !== undefined && <><div className="field-name">Kết quả</div><Json value={outputs.get(d.toolCallId)} /></>}
                  </details>
                </Row>
              )
            }
            return null
          case 'assert/result':
            return (
              <Row key={e.seq} e={e} label="Assert">
                <span className={d.passed ? 'ok' : 'bad'}>{d.passed ? '✅' : '❌'} {d.expectId}</span>{' '}
                <code>{JSON.stringify(d.actual)}</code> tại <EvidenceLink id={d.evidenceId} onOpen={onEvidence} /> <code>{d.path}</code>{' '}
                <span className="muted small">{d.op} {d.expr ? `${d.expr} = ${d.expected}` : JSON.stringify(d.expected)}</span>
              </Row>
            )
          case 'step/note': return <Row key={e.seq} e={e} label={`Bước ${d.step}`}><span className={d.status === 'failed' ? 'bad' : ''}>{d.status}</span> {d.note}</Row>
          case 'case/annotation': return <Row key={e.seq} e={e} label="Đánh dấu"><code>{d.key}</code>: {d.value.map((i: { id: string }) => i.id).join(', ')}</Row>
          case 'case/end': return <Row key={e.seq} e={e} label="Kết thúc case"><b>{VERDICT[d.verdict] ?? d.verdict}</b> {d.reasons.join('; ')}</Row>
          default: return null
        }
      })}
    </div>
  )
}

function Row({ e, label, children }: { e: RunEvent; label: string; children: ReactNode }) {
  return (
    <div className="trace-row">
      <div className="trace-meta"><span className="muted small">#{e.seq} · {new Date(e.ts).toLocaleTimeString('vi-VN')}</span><span className="trace-label">{label}</span></div>
      <div className="trace-body">{children}</div>
    </div>
  )
}

function RawEvents({ events }: { events: RunEvent[] }) {
  const [type, setType] = useState('')
  const types = [...new Set(events.map((e) => e.type))]
  return (
    <div>
      <select value={type} onChange={(e) => setType(e.target.value)}>
        <option value="">Mọi loại event ({events.length})</option>
        {types.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      {events.filter((e) => !type || e.type === type).map((e) => (
        <details key={e.seq} className="raw-event"><summary><code>#{e.seq} {e.type}</code> <span className="muted small">{e.ts}</span></summary><Json value={e.data} /></details>
      ))}
    </div>
  )
}
