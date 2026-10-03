import type { ReactNode } from 'react'

/**
 * Plan dưới dạng tài liệu cho người đọc nghiệp vụ (BA, QA): mục tiêu, phạm vi, dữ liệu đầu vào, rồi từng case với
 * chuẩn bị, các bước, kết quả mong đợi viết thành câu, dọn dẹp. Chi tiết kỹ thuật (lời gọi API, công thức) thu nhỏ.
 * Dữ liệu lấy từ `describePlan` của plan-manager (`plans.get`, `plans.preview`).
 */
export interface PlanDoc {
  id: string
  name: string
  description?: string
  context?: string
  systems: string[]
  envs: string[]
  inputs: Array<{ name: string; desc?: string; default?: unknown; required: boolean; mode: 'fill' | 'prepare' | 'user' }>
  contextRefs?: string[]
  setup?: string[]
  teardown?: string[]
  cases: Array<{
    id: string
    title: string
    tags: string[]
    steps: string[]
    calls?: Array<{ call: string; desc?: string; path?: unknown; query?: unknown; body?: unknown } | null>
    setup?: string[]
    teardown?: string[]
    expect: Array<{ id: string; desc: string; op?: string; value?: unknown; expr?: string }>
  }>
}

const OP: Record<string, string> = {
  eq: 'bằng', ne: 'khác', gt: 'lớn hơn', gte: 'lớn hơn hoặc bằng', lt: 'nhỏ hơn', lte: 'nhỏ hơn hoặc bằng',
  contains: 'có chứa', matches: 'khớp mẫu', exists: 'có giá trị', not_exists: 'không có giá trị',
}

const INPUT_MODE: Record<string, string> = { fill: 'tự tạo khi chạy', prepare: 'agent chuẩn bị', user: 'người chạy điền' }

function show(value: unknown) {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Tiêu chí đạt viết thành câu: "bằng 409", "bằng giá trị tính theo công thức …". */
export function criterion(e: { op?: string; value?: unknown; expr?: string }): ReactNode {
  if (!e.op) return <span className="muted">người đọc báo cáo tự đánh giá</span>
  const op = OP[e.op] ?? e.op
  if (e.expr) return <>{op} giá trị tính theo công thức <code>{e.expr}</code></>
  if (e.op === 'exists' || e.op === 'not_exists') return <>{op}</>
  return <>{op} <b>{show(e.value)}</b></>
}

/** Bước có cấu trúc: mục đích lên trước, lời gọi API thu nhỏ bên dưới. */
function Step({ text, call }: { text: string; call?: { call: string; desc?: string; path?: unknown; query?: unknown; body?: unknown } | null }) {
  if (!call) return <li>{text}</li>
  const params = [
    call.path !== undefined && `path ${show(call.path)}`,
    call.query !== undefined && `query ${show(call.query)}`,
    call.body !== undefined && `body ${show(call.body)}`,
  ].filter(Boolean).join(' · ')
  return (
    <li>
      {call.desc ? call.desc.charAt(0).toUpperCase() + call.desc.slice(1) : <>Gọi <code>{call.call}</code></>}
      <div className="muted small tech"><code>{call.call}</code>{params ? ` · ${params}` : ''}</div>
    </li>
  )
}

export function PlanDocument({ plan, caseBadge, compact = false }: {
  plan: PlanDoc
  /** Nội dung đặt trước tiêu đề case, ví dụ kết quả lần chạy gần nhất. */
  caseBadge?: (caseId: string) => ReactNode
  /** Ẩn phần đầu (tên, mô tả, đầu vào) khi trang đã hiển thị riêng. */
  compact?: boolean
}) {
  return (
    <div className="plan-doc">
      {!compact && (
        <>
          <h3>{plan.name} <span className="muted small">{plan.id}</span></h3>
          {plan.description && <p>{plan.description}</p>}
          <dl className="plan-facts">
            {plan.systems.length > 0 && <><dt>Hệ thống</dt><dd>{plan.systems.join(', ')}</dd></>}
            <dt>Môi trường</dt><dd>{plan.envs.length ? plan.envs.join(', ') : 'mọi môi trường'}</dd>
            <dt>Số case</dt><dd>{plan.cases.length}</dd>

          </dl>
          {plan.inputs.length > 0 && (
            <section>
              <h4>Dữ liệu đầu vào</h4>
              <ul>
                {plan.inputs.map((i) => (
                  <li key={i.name}>
                    <b>{i.desc ?? i.name}</b> <span className="muted small">({i.required ? 'bắt buộc' : 'tuỳ chọn'}, {INPUT_MODE[i.mode]}{i.default !== undefined ? `, mặc định ${show(i.default)}` : ''})</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {plan.contextRefs && plan.contextRefs.length > 0 && (
        <div className="small">
          <span className="muted">Tài liệu nghiệp vụ agent chạy test đọc: </span>
          {plan.contextRefs.map((r) => <a key={r} href="#/context/docs" title="Xem trên trang Ngữ cảnh"><code>{r}</code> </a>)}
        </div>
      )}
      {plan.setup && plan.setup.length > 0 && (
        <section>
          <h4>Chuẩn bị trước mỗi case</h4>
          <ul>{plan.setup.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </section>
      )}
      {plan.cases.map((c) => (
        <article key={c.id} className="doc-case">
          <h4>{caseBadge?.(c.id)} <span className="case-id">{c.id}</span> {c.title} {c.tags.map((t) => <span key={t} className="tag">{t}</span>)}</h4>
          {c.setup && c.setup.length > 0 && (
            <div><div className="label">Chuẩn bị</div><ul>{c.setup.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
          )}
          <div>
            <div className="label">Các bước</div>
            <ol>{c.steps.map((s, i) => <Step key={i} text={s} call={c.calls?.[i]} />)}</ol>
          </div>
          {c.expect.length > 0 && (
            <div>
              <div className="label">Kết quả mong đợi</div>
              <ul className="expect-list">
                {c.expect.map((e) => (
                  <li key={e.id}>
                    {e.desc}
                    <div className="muted small">Đạt khi giá trị thực tế {criterion(e)}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {c.teardown && c.teardown.length > 0 && (
            <div><div className="label">Dọn dẹp</div><ul>{c.teardown.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
          )}
        </article>
      ))}
      {plan.teardown && plan.teardown.length > 0 && (
        <section>
          <h4>Dọn dẹp sau mỗi case</h4>
          <ul>{plan.teardown.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </section>
      )}
      {!compact && plan.context && (
        <details><summary className="muted small">Bối cảnh riêng của plan</summary><pre className="code">{plan.context}</pre></details>
      )}
    </div>
  )
}
