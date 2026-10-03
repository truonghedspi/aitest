import { useEffect, useMemo, useState } from 'react'
import { connection } from '../connection.ts'
import { ExportDialog, exportPlans, ImportDialog } from '../plan-bundle.tsx'
import { PlanDocument, type PlanDoc } from '../plan-document.tsx'
import { defaultEnv, EnvSelect, EnvTag, envLabel, setSelectedEnv, useEnvs, useSelectedEnv } from '../env.tsx'
import type { ClientPlugin, PageProps } from '../slots.ts'
import { inputPlaceholder } from './plan-panel.tsx'
import { ICON, RunList, RunTable, timeAgo, Totals, useRuns, VERDICT, type RunSummary } from './runs-page.tsx'

/**
 * Trang "Plan": quản lý plan và lượt chạy ở một nơi.
 * - `#/plans`: danh sách plan kèm kết quả lần chạy gần nhất; tìm kiếm, lọc theo trạng thái.
 * - `#/plans/<đường dẫn>.plan.yaml`: chi tiết plan, các case, đầu vào, lịch sử chạy, nội dung YAML.
 * - `#/plans/runs`: mọi lượt chạy; chi tiết lượt chạy mở ở `#/runs/<mã>`.
 */
export const plansPage: ClientPlugin = (s) => {
  s.page.register('plans', { id: 'plans', title: 'Plan', order: 2, component: PlansPage })
}

interface ModelList {
  agent: string
  current?: string
  fallbackFrom?: string
  available: Array<{ id: string; name: string; description?: string }>
  error?: string
}

interface PlanItem { path: string; id?: string; name?: string; cases?: Array<{ id: string; title: string }>; error?: string }

interface PlanDetail {
  path: string
  content: string
  valid: boolean
  errors: Array<{ message: string; path?: string }>
  warnings: Array<{ message: string; path?: string }>
  plan?: PlanDoc & { requires: string[] }
}

type Status = 'all' | 'never' | 'pass' | 'problem' | 'invalid'
const STATUS_LABEL: Record<Status, string> = { all: 'Tất cả', never: 'Chưa chạy', pass: 'Đạt hết', problem: 'Có case chưa đạt', invalid: 'Plan lỗi' }

function PlansPage({ param, navigate }: PageProps) {
  const [env] = useSelectedEnv()
  if (param && param !== 'runs') return <PlanView path={param} navigate={navigate} />
  const tab = param === 'runs' ? 'runs' : 'plans'
  return (
    <main className="manager plans">
      <header>
        <h2>Plan</h2>
        <div className="tabs inline">
          <button className={tab === 'plans' ? 'active' : ''} onClick={() => navigate('plans')}>Danh sách plan</button>
          <button className={tab === 'runs' ? 'active' : ''} onClick={() => navigate('plans/runs')}>Lượt chạy</button>
        </div>
        <span className="spacer" />
        <EnvSelect value={env} onChange={setSelectedEnv} />
        <button className="primary" onClick={() => void newChat(navigate, env)}>+ Soạn plan mới cùng agent</button>
      </header>
      {tab === 'plans' ? <PlanList navigate={navigate} /> : <RunList navigate={navigate} />}
    </main>
  )
}

/* ------------------------------------------------------------------ danh sách */

function PlanList({ navigate }: { navigate(path: string): void }) {
  const [plans, setPlans] = useState<PlanItem[]>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Status>('all')
  const [running, setRunning] = useState<PlanItem>()
  const [bundleDialog, setBundleDialog] = useState<'export' | 'import'>()
  const runs = useRuns(undefined, 200)
  const [env] = useSelectedEnv()
  const envs = useEnvs()

  const load = () => connection.call<PlanItem[]>('plans.list').then(setPlans, (e) => setError((e as Error).message))
  useEffect(() => { void load() }, [])

  // Lần chạy gần nhất của mỗi plan; ưu tiên lượt chạy thật, không có thì lấy lượt chạy thử.
  const lastRun = useMemo(() => {
    const map = new Map<string, RunSummary>()
    // Chỉ lượt chạy của môi trường đang chọn; lượt chạy cũ không ghi môi trường được tính là môi trường mặc định.
    for (const r of runs ?? []) {
      const key = r.plan?.id
      if (!key || (env && (r.env ?? defaultEnv(envs)) !== env)) continue
      const current = map.get(key)
      if (!current || (current.dryRun && !r.dryRun)) map.set(key, r)
    }
    return map
  }, [runs, env, envs])

  const statusOf = (p: PlanItem): Exclude<Status, 'all'> => {
    if (p.error) return 'invalid'
    const r = p.id ? lastRun.get(p.id) : undefined
    if (!r) return 'never'
    return r.finished && !r.blocked && r.totals && r.totals.pass === r.totals.total ? 'pass' : 'problem'
  }

  const q = query.trim().toLowerCase()
  const shown = (plans ?? []).filter((p) => (status === 'all' || statusOf(p) === status)
    && (!q || [p.path, p.id, p.name, ...(p.cases ?? []).flatMap((c) => [c.id, c.title])].some((v) => v?.toLowerCase().includes(q))))
  const groups = groupBy(shown, (p) => p.path.split('/').slice(0, -1).join('/') || '.')
  const counts = Object.fromEntries((Object.keys(STATUS_LABEL) as Status[]).map((s) => [s, s === 'all' ? plans?.length ?? 0 : (plans ?? []).filter((p) => statusOf(p) === s).length]))

  return (
    <>
      <div className="toolbar">
        <input className="search" placeholder="Tìm theo tên, mã plan, case hoặc đường dẫn" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={() => setBundleDialog('export')} disabled={!plans?.length} title="Đóng gói plan cùng tài liệu và hệ thống để chuyển sang aitest khác">⇩ Export</button>
        <button onClick={() => setBundleDialog('import')} title="Nhập gói plan xuất từ aitest khác">⇧ Import</button>
        <div className="chips">
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
            <button key={s} className={`chip ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
              {STATUS_LABEL[s]} <span className="muted">{counts[s]}</span>
            </button>
          ))}
        </div>
      </div>
      {bundleDialog === 'export' && plans && <ExportDialog plans={plans} onClose={() => setBundleDialog(undefined)} />}
      {bundleDialog === 'import' && <ImportDialog onClose={() => setBundleDialog(undefined)} onDone={() => void load()} />}
      {error && <div className="bad">{error}</div>}
      {!plans && !error && <div className="muted">Đang tải…</div>}
      {env && <p className="muted small">Kết quả lần chạy gần nhất trên môi trường <EnvTag env={env} />. Đổi môi trường ở góc trên.</p>}
      {plans && !plans.length && (
        <div className="empty">
          <p>Chưa có plan nào trong các thư mục plan.</p>
          <button className="primary" onClick={() => void newChat(navigate, env)}>Soạn plan đầu tiên cùng agent</button>
        </div>
      )}
      {plans && plans.length > 0 && !shown.length && <div className="empty">Không có plan phù hợp bộ lọc.</div>}
      {[...groups].map(([folder, items]) => (
        <section key={folder} className="plan-group">
          <h4 className="muted">{folder}/</h4>
          {items.map((p) => {
            const r = p.id ? lastRun.get(p.id) : undefined
            return (
              <div key={p.path} className={`plan-card ${statusOf(p)}`} onClick={() => navigate(`plans/${p.path}`)}>
                <div className="plan-card-main">
                  {p.error ? <b className="bad">Không đọc được plan</b> : <><b>{p.name}</b> <span className="muted">{p.id}</span></>}
                  <div className="small">
                    {p.error ? <span className="bad">{p.error}</span>
                      : <>{p.cases?.length ?? 0} case: {p.cases?.map((c) => `${c.id} ${c.title}`).join(' · ')}</>}
                  </div>
                  <code className="muted small">{p.path}</code>
                </div>
                <div className="plan-card-run" onClick={(e) => { if (r) { e.stopPropagation(); navigate(`runs/${r.runId}`) } }} title={r ? 'Xem lượt chạy' : undefined}>
                  {r ? (
                    <>
                      <span>{r.cases.map((c) => <span key={c.id} title={`${c.id}: ${VERDICT[c.verdict] ?? c.verdict}`}>{ICON[c.verdict] ?? '·'}</span>)}</span>
                      <span className="small">{!r.finished ? <span className="badge pending">Đang chạy</span> : r.blocked ? <span className="warn">🚧 Chưa đủ điều kiện</span> : <Totals totals={r.totals} />}</span>
                      <span className="muted small">{r.startedAt && timeAgo(r.startedAt)}{r.dryRun ? ' · chạy thử' : ''}</span>
                    </>
                  ) : <span className="muted small">Chưa chạy{env ? ` trên ${env}` : ''}</span>}
                </div>
                <div className="plan-card-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="primary" disabled={!!p.error} onClick={() => setRunning(p)} title="Chạy plan với agent">▶ Chạy</button>
                  <button onClick={() => void editWithAgent(p.path, navigate, env)} title="Mở plan trong cuộc chat để sửa cùng agent">Sửa cùng agent</button>
                </div>
              </div>
            )
          })}
        </section>
      ))}
      {running && <RunDialog path={running.path} onClose={() => setRunning(undefined)} navigate={navigate} />}
    </>
  )
}

/* ------------------------------------------------------------------ chi tiết */

function PlanView({ path, navigate }: { path: string; navigate(path: string): void }) {
  const [detail, setDetail] = useState<PlanDetail>()
  const [error, setError] = useState<string>()
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState<'cases' | 'runs' | 'yaml'>('cases')
  useEffect(() => {
    setDetail(undefined)
    connection.call<PlanDetail>('plans.get', { path }).then(setDetail, (e) => setError((e as Error).message))
  }, [path])
  const runs = useRuns(detail?.plan?.id)
  const [env, setEnv] = useSelectedEnv()
  const envs = useEnvs()
  const plan = detail?.plan
  // Lần chạy gần nhất theo từng môi trường; ưu tiên lượt chạy thật.
  const lastByEnv = useMemo(() => {
    const map = new Map<string, RunSummary>()
    for (const r of runs ?? []) {
      const key = r.env ?? defaultEnv(envs) ?? ''
      const current = map.get(key)
      if (!current || (current.dryRun && !r.dryRun)) map.set(key, r)
    }
    return map
  }, [runs, envs])
  const last = env ? lastByEnv.get(env) : runs?.find((r) => !r.dryRun) ?? runs?.[0]
  /** Kết quả của case trong một lượt chạy; không có lượt chạy thì chưa có kết quả. */
  const verdictIn = (run: RunSummary | undefined, caseId: string) => run?.cases.find((c) => c.id === caseId)?.verdict
  const verdictOf = (caseId: string) => verdictIn(last, caseId)
  const columns = (envs ?? []).filter((e) => !plan?.envs.length || plan.envs.includes(e.name))
  const allowedHere = !env || !plan?.envs.length || plan.envs.includes(env)

  return (
    <main className="manager plan-view">
      <header>
        <button onClick={() => navigate('plans')}>← Danh sách plan</button>
        <h2>{plan?.name ?? path}</h2>
        {plan && <span className="muted">{plan.id}</span>}
        <span className="spacer" />
        <EnvSelect value={env} onChange={setEnv} allowed={plan?.envs} />
        <button onClick={() => void exportPlans([path]).catch((e) => setError((e as Error).message))} title="Tải gói gồm plan, tài liệu và hệ thống plan dùng">⇩ Export</button>
        <button onClick={() => void editWithAgent(path, navigate, env)}>Sửa cùng agent</button>
        <button className="primary" disabled={!detail?.valid || !allowedHere} onClick={() => setRunning(true)}
          title={allowedHere ? undefined : `Plan chỉ chạy trên: ${plan?.envs.join(', ')}`}>▶ Chạy plan</button>
      </header>
      {error && <div className="bad">{error}</div>}
      {!detail && !error && <div className="muted">Đang tải…</div>}
      {detail && (
        <>
          <div className="plan-meta">
            <code className="muted small">{path}</code>
            {plan?.requires.map((r) => <span key={r} className="tag" title="Namespace tool">{r}</span>)}
            {plan?.systems.map((s) => <span key={s} className="tag system" title="Hệ thống trong catalog">{s}</span>)}
            {!!plan?.envs.length && <span className="small muted">· chỉ chạy trên {plan.envs.map((e) => <EnvTag key={e} env={e} />)}</span>}
            {last && (
              <span className="small" onClick={() => navigate(`runs/${last.runId}`)} role="link">
                · Lần chạy gần nhất{env ? ` trên ${env}` : ''} {last.startedAt && timeAgo(last.startedAt)}: {last.blocked ? '🚧 chưa đủ điều kiện' : <Totals totals={last.totals} />}
              </span>
            )}
          </div>
          {!detail.valid && (
            <div className="notice bad">
              Plan chưa hợp lệ nên chưa chạy được. Bấm "Sửa cùng agent" để agent sửa giúp.
              <ul>{detail.errors.map((e) => <li key={e.message}>{e.path ? <code>{e.path}</code> : null} {e.message}</li>)}</ul>
            </div>
          )}
          {plan?.description && <p>{plan.description}</p>}

          <div className="tabs">
            <button className={tab === 'cases' ? 'active' : ''} onClick={() => setTab('cases')}>Case ({plan?.cases.length ?? 0})</button>
            <button className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>Lịch sử chạy ({runs?.length ?? '…'})</button>
            <button className={tab === 'yaml' ? 'active' : ''} onClick={() => setTab('yaml')}>Nội dung YAML</button>
          </div>

          {tab === 'cases' && plan && (
            <>
              {plan.inputs.length > 0 && (
                <section>
                  <h4>Đầu vào của lượt chạy</h4>
                  <table className="plain">
                    <thead><tr><th>Tên</th><th>Mô tả</th><th>Khi không điền</th></tr></thead>
                    <tbody>
                      {plan.inputs.map((i) => (
                        <tr key={i.name}><td><code>{i.name}</code></td><td>{i.desc}</td><td className="muted">{inputPlaceholder(i).replace(/^trống: /, '')}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
              {plan.context && <details><summary>Bối cảnh cho agent</summary><pre className="code">{plan.context}</pre></details>}
              {columns.length > 1 && (
                <section>
                  <h4>Kết quả theo môi trường</h4>
                  <div className="matrix-wrap">
                    <table className="plain matrix">
                      <thead>
                        <tr>
                          <th>Case</th>
                          {columns.map((e) => {
                            const r = lastByEnv.get(e.name)
                            return (
                              <th key={e.name} className={e.name === env ? 'current' : ''}>
                                <button className="link" onClick={() => setEnv(e.name)} title={envLabel(e)}>{e.name}</button>
                                <div className="muted small">
                                  {r ? <span role="link" onClick={() => navigate(`runs/${r.runId}`)}>{r.startedAt && timeAgo(r.startedAt)}{r.dryRun ? ' · thử' : ''}</span> : 'chưa chạy'}
                                </div>
                              </th>
                            )
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {plan.cases.map((c) => (
                          <tr key={c.id}>
                            <td><b>{c.id}</b> <span className="muted small">{c.title}</span></td>
                            {columns.map((e) => {
                              const r = lastByEnv.get(e.name)
                              const v = r?.blocked ? 'blocked' : verdictIn(r, c.id)
                              return <td key={e.name} className={e.name === env ? 'current' : ''} title={v ? VERDICT[v] : 'Chưa chạy'}>{v ? ICON[v] : '○'}</td>
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <PlanDocument plan={plan} compact caseBadge={(id) => {
                const v = verdictOf(id)
                return <span title={v ? VERDICT[v] : 'Chưa chạy'}>{v ? ICON[v] : '○'}</span>
              }} />
            </>
          )}
          {tab === 'runs' && (
            !runs ? <div className="muted">Đang tải…</div>
              : !runs.length ? <div className="empty">Plan chưa được chạy lần nào. <button className="primary" disabled={!detail.valid} onClick={() => setRunning(true)}>▶ Chạy lần đầu</button></div>
              : <RunTable runs={runs} navigate={navigate} />
          )}
          {tab === 'yaml' && (
            <>
              {detail.warnings.length > 0 && <ul className="warn small">{detail.warnings.map((w) => <li key={w.message}>{w.message}</li>)}</ul>}
              <pre className="code">{detail.content}</pre>
            </>
          )}
        </>
      )}
      {running && <RunDialog path={path} onClose={() => setRunning(false)} navigate={navigate} detail={detail} />}
    </main>
  )
}

/* ------------------------------------------------------------------ chạy plan */

/** Hộp thoại chạy plan: chọn case, điền đầu vào, rồi chuyển sang màn theo dõi lượt chạy. */
function RunDialog({ path, detail: given, onClose, navigate }: { path: string; detail?: PlanDetail; onClose(): void; navigate(path: string): void }) {
  const [detail, setDetail] = useState(given)
  const [selected, setSelected] = useState<string[]>()
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [selectedEnv] = useSelectedEnv()
  const [env, setEnv] = useState(selectedEnv)
  const envs = useEnvs()
  useEffect(() => {
    if (!given) connection.call<PlanDetail>('plans.get', { path }).then(setDetail, (e) => setError((e as Error).message))
  }, [path])
  useEffect(() => { if (!env && selectedEnv) setEnv(selectedEnv) }, [selectedEnv])
  const [models, setModels] = useState<ModelList>()
  const [model, setModel] = useState('')
  useEffect(() => { connection.call<ModelList>('plans.models').then(setModels, () => setModels({ agent: '', available: [] })) }, [])
  const plan = detail?.plan
  const envInfo = envs?.find((e) => e.name === env)
  const envAllowed = !env || !plan?.envs.length || plan.envs.includes(env)
  const cases = plan?.cases ?? []
  const chosen = selected ?? cases.map((c) => c.id)
  const missing = (plan?.inputs ?? []).filter((i) => i.required && i.mode === 'user' && i.default === undefined && !inputs[i.name]?.trim())

  const start = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const values = Object.fromEntries(Object.entries(inputs).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]))
      const { runId } = await connection.call<{ runId: string }>('plans.run', { path, cases: selected, inputs: values, env, model: model || undefined })
      onClose()
      navigate(`runs/${runId}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="dialog modal" onClick={(e) => e.stopPropagation()}>
        <header><h3>Chạy {plan?.name ?? path}</h3><button onClick={onClose}>Đóng</button></header>
        {!detail && !error && <div className="muted">Đang tải…</div>}
        {detail && !detail.valid && <div className="bad">Plan chưa hợp lệ: {detail.errors.map((e) => e.message).join('; ')}</div>}
        {plan && (
          <>
            {!!envs?.length && (
              <div className="env-row">
                <EnvSelect value={env} onChange={setEnv} allowed={plan.envs} />
                {envInfo?.readOnly && <span className="warn small">Môi trường chỉ đọc: bước tạo hoặc sửa dữ liệu sẽ bị chặn.</span>}
                {!envAllowed && <span className="bad small">Plan chỉ chạy trên: {plan.envs.join(', ')}</span>}
              </div>
            )}
            <div className="env-row">
              <label className="env-select" title="Model của agent chạy test cho lượt này; mặc định theo cấu hình (AITEST_RUN_MODEL)">
                <span className="muted small">Model chạy test</span>
                <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!models}>
                  <option value="">{models ? `Mặc định${models.current ? ` (${models.current})` : ''}` : 'Đang tải…'}</option>
                  {models?.available.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.name}</option>)}
                </select>
              </label>
              {models?.fallbackFrom && <span className="warn small">Không có model mặc định {models.fallbackFrom}; agent dùng {models.current}</span>}
              {models?.error && <span className="warn small" title={models.error}>Không lấy được danh sách model; vẫn chạy được với model mặc định</span>}
            </div>
            <h4>Case <span className="muted small">({chosen.length}/{cases.length})</span>
              <button className="link small" onClick={() => setSelected(undefined)}>chọn tất cả</button>
              <button className="link small" onClick={() => setSelected([])}>bỏ chọn</button>
            </h4>
            <div className="case-checklist">
              {cases.map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(c.id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...chosen, c.id] : chosen.filter((id) => id !== c.id)
                      setSelected(next.length === cases.length ? undefined : cases.map((x) => x.id).filter((id) => next.includes(id)))
                    }}
                  />
                  <b>{c.id}</b> {c.title}
                </label>
              ))}
            </div>
            {plan.inputs.length > 0 && (
              <>
                <h4>Đầu vào <span className="muted small">(để trống: dùng cách lấy giá trị trong plan)</span></h4>
                <div className="input-form">
                  {plan.inputs.map((i) => (
                    <label key={i.name} style={{ display: 'contents' }}>
                      <span title={i.desc}>
                        <code>{i.name}</code>{i.required && i.mode === 'user' && i.default === undefined ? ' *' : ''}
                        {i.desc && <span className="muted small"> {i.desc}</span>}
                      </span>
                      <input value={inputs[i.name] ?? ''} placeholder={inputPlaceholder(i)} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })} />
                    </label>
                  ))}
                </div>
              </>
            )}
            <p className="muted small">Agent chạy test thật trên môi trường đang cấu hình. Bạn được chuyển sang màn theo dõi ngay khi lượt chạy bắt đầu.</p>
            <div className="actions">
              <button onClick={onClose}>Huỷ</button>
              <button className="primary" disabled={busy || !chosen.length || missing.length > 0 || !detail?.valid || !envAllowed} onClick={start}>
                {busy ? 'Đang bắt đầu…' : `▶ Chạy ${chosen.length} case${env ? ` trên ${env}` : ''}`}
              </button>
            </div>
            {missing.length > 0 && <div className="warn small">Cần điền: {missing.map((i) => i.name).join(', ')}</div>}
          </>
        )}
        {error && <div className="bad">{error}</div>}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ tiện ích */

async function newChat(navigate: (path: string) => void, env?: string) {
  const chat = await connection.call<{ id: string }>('chats.create', { env })
  navigate(`chat/${chat.id}`)
}

/** Mở plan trong một cuộc chat mới để sửa cùng agent. */
async function editWithAgent(path: string, navigate: (path: string) => void, env?: string) {
  const chat = await connection.call<{ id: string }>('chats.create', { env })
  await connection.call('chats.openPlan', { chatId: chat.id, path })
  navigate(`chat/${chat.id}`)
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    map.set(k, [...(map.get(k) ?? []), item])
  }
  return map
}
