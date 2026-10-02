import type { ActionCallData, RunEvent } from './types.ts'

/** Các mục hiển thị trên dòng thời gian của cuộc chat, dựng từ log. */
export type TimelineItem =
  | { kind: 'user'; seq: number; text: string }
  | { kind: 'agent'; seq: number; text: string }
  | { kind: 'thought'; seq: number; text: string }
  | { kind: 'tool'; seq: number; call: ActionCallData; pending: boolean }
  | { kind: 'agent-tool'; seq: number; title: string; status: string }
  | { kind: 'permission'; seq: number; requestId: string; title: string; tool?: string; args?: unknown; preview?: any; decision?: boolean }
  | { kind: 'note'; seq: number; text: string }
  | { kind: 'error'; seq: number; text: string }

/** Tool của MCP gateway có tiêu đề dạng `@aitest/<tên>`; các tool này đã có thẻ `action/call` riêng. */
const GATEWAY_TOOL = /@[\w-]+\/\w+/

export function timeline(events: RunEvent[]): TimelineItem[] {
  const items: TimelineItem[] = []
  const tools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>()
  const permissions = new Map<string, Extract<TimelineItem, { kind: 'permission' }>>()
  // Lời gọi lồng bên trong tool `explore` đã hiển thị trong thẻ của `explore`. Nhận biết theo trường
  // `scope`, hoặc với log cũ, theo việc lời gọi bắt đầu khi một lời gọi `explore` chưa kết thúc.
  const openExplores = new Set<string>()
  const nested = new Set<string>()
  for (const e of events) {
    const d = e.data
    if (e.type === 'action/start') {
      if (d.scope === 'explore' || (openExplores.size && d.name !== 'explore')) nested.add(d.callId)
      else if (d.name === 'explore') openExplores.add(d.callId)
    }
    if (e.type === 'action/call') openExplores.delete(d.callId)
    if ((e.type === 'action/start' || e.type === 'action/call') && (d.scope === 'explore' || nested.has(d.callId))) continue
    switch (e.type) {
      case 'user/message': items.push({ kind: 'user', seq: e.seq, text: d.text }); break
      case 'agent/message': items.push({ kind: 'agent', seq: e.seq, text: d.text }); break
      case 'agent/thought': items.push({ kind: 'thought', seq: e.seq, text: d.text }); break
      case 'action/start': {
        const item = { kind: 'tool' as const, seq: e.seq, pending: true, call: { ...d, status: 'ok' as const, durationMs: 0 } }
        tools.set(d.callId, item)
        items.push(item)
        break
      }
      case 'action/call': {
        const item = tools.get(d.callId)
        if (item) Object.assign(item, { pending: false, call: d })
        else items.push({ kind: 'tool', seq: e.seq, pending: false, call: d })
        break
      }
      case 'agent/tool':
        if (!GATEWAY_TOOL.test(d.title ?? '') && d.status !== 'pending') {
          items.push({ kind: 'agent-tool', seq: e.seq, title: d.title ?? 'tool', status: d.status })
        }
        break
      case 'permission/request': {
        const item = { kind: 'permission' as const, seq: e.seq, requestId: d.requestId, title: d.title, tool: d.tool, args: d.args, preview: d.preview }
        permissions.set(d.requestId, item)
        items.push(item)
        break
      }
      case 'permission/decision': {
        const item = permissions.get(d.requestId)
        if (item) item.decision = d.allowed
        break
      }
      case 'draft/edit': items.push({ kind: 'note', seq: e.seq, text: 'Bạn đã sửa bản nháp plan.' }); break
      case 'draft/open': items.push({ kind: 'note', seq: e.seq, text: `Bạn đã mở plan ${d.path}.` }); break
      case 'chat/model': items.push({ kind: 'note', seq: e.seq, text: `Đã đổi model sang ${d.modelId}.` }); break
      case 'turn/end':
        if (d.error) items.push({ kind: 'error', seq: e.seq, text: d.error })
        else if (d.stopReason && d.stopReason !== 'end_turn') items.push({ kind: 'note', seq: e.seq, text: `Agent dừng: ${d.stopReason}` })
        break
    }
  }
  return items
}

/** Trạng thái bản nháp plan mới nhất, dựng từ các lời gọi tool soạn plan và chỉnh sửa của người dùng. */
export interface DraftState {
  content?: string
  source?: string
  validation?: { valid: boolean; errors: Issue[]; warnings: Issue[]; summary?: PlanSummary; stale: boolean }
  run?: { pending: boolean; value?: any; runId?: string }
  saved?: { path: string; stale: boolean }
  /** Plan có sẵn được mở gần nhất; `seq` đổi mỗi lần mở để bảng plan đặt lại đường dẫn lưu. */
  opened?: { path: string; seq: number }
}

/** Thư mục lưu mặc định của `save_plan`; plan mở từ thư mục này được ghi đè tại chỗ. */
export const SAVE_DIR = 'plans/'

export interface Issue { level: string; message: string; path?: string }
export interface PlanSummary {
  id: string
  name: string
  cases: Array<{ id: string; title: string }>
  inputs?: Array<{ name: string; desc?: string; default?: unknown; required: boolean; mode: 'fill' | 'prepare' | 'user' }>
}

const DRAFT_TOOLS = new Set(['validate_plan', 'dry_run', 'save_plan'])

export function draftState(events: RunEvent[]): DraftState {
  const state: DraftState = {}
  let validated: { content: string; value: any } | undefined
  let savedContent: string | undefined
  for (const e of events) {
    const d = e.data
    if (e.type === 'action/start' && DRAFT_TOOLS.has(d.name) && typeof d.args?.content === 'string') {
      state.content = d.args.content
      state.source = d.phase === 'user' ? 'Bạn' : 'Agent'
    }
    if (e.type === 'draft/open') {
      state.content = d.content
      state.source = `Bạn mở ${d.path}`
      state.opened = { path: d.path, seq: e.seq }
      state.run = undefined
      if (d.path.startsWith(SAVE_DIR)) {
        state.saved = { path: d.path, stale: false }
        savedContent = d.content
      } else {
        state.saved = undefined
      }
    }
    if (e.type === 'draft/edit') {
      state.content = d.content
      state.source = 'Bạn'
    }
    if (e.type === 'action/call' && d.name === 'validate_plan' && d.status === 'ok') validated = { content: d.args.content, value: d.value }
    if (e.type === 'action/call' && d.name === 'save_plan' && d.status === 'ok') {
      state.saved = { path: d.value.path, stale: false }
      savedContent = d.args.content
    }
    if (e.type === 'action/call' && d.name === 'dry_run' && d.status === 'ok') state.run = { pending: true, runId: d.value.runId }
    if (e.type === 'action/call' && d.name === 'get_run_result' && d.status === 'ok' && d.value?.runId === state.run?.runId) {
      state.run = { pending: d.value.status === 'running', value: d.value, runId: d.value.runId }
    }
  }
  if (validated) state.validation = { ...validated.value, stale: validated.content !== state.content }
  if (state.saved) state.saved.stale = savedContent !== state.content
  return state
}
