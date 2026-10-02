import type { ReactNode } from 'react'
import { GenericView, Json } from './plugins/tool-views.tsx'
import { slots } from './slots.ts'
import type { ActionCallData } from './types.ts'

const PHASE: Record<string, string> = { setup: 'Chuẩn bị · ', teardown: 'Dọn dẹp · ', user: 'Bạn · ' }

/**
 * Thẻ một lời gọi tool: tiêu đề từ `view.title`, nội dung từ thành phần đăng ký cho `view.kind` (slot `toolView`).
 * Dùng chung cho cuộc chat và trang Lượt chạy.
 */
export function ToolCallCard({ call, pending = false, extra }: { call: ActionCallData; pending?: boolean; extra?: ReactNode }) {
  const View = (call.view && slots.toolView.get(call.view.kind)) || GenericView
  const state = pending ? 'pending' : call.status
  const title = call.view?.title ?? call.name
  const evidenceId = (call as { annotations?: { evidenceId?: string } }).annotations?.evidenceId
  return (
    <details className={`tool ${state}`}>
      <summary>
        <span className="dot" />
        {call.phase && PHASE[call.phase] && <span className="by">{PHASE[call.phase]}</span>}
        <span className="name">{title}</span>
        {evidenceId && <span className="tag">{evidenceId}</span>}
        {call.step && <span className="tag">bước {call.step}</span>}
        {!pending && <span className="duration">{call.durationMs} ms</span>}
      </summary>
      {call.reason && <div className="reason">Vì sao: {call.reason}</div>}
      {extra}
      {pending ? <Json value={call.args} /> : call.status === 'ok' && call.view
        ? <View call={call} view={call.view} />
        : call.status === 'ok' ? <GenericView call={call} view={{ kind: 'generic' }} /> : <div className="bad">{call.status === 'denied' ? 'Bị guard từ chối: ' : ''}{call.error}</div>}
    </details>
  )
}
