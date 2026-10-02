/** Kiểu dữ liệu trên kênh WebSocket, khớp với `@aitest/core` và `@aitest/chat` phía Host. */

export interface RunEvent<T = any> {
  seq: number
  ts: string
  runId: string
  /** Mã case, với event thuộc một test case trong run log. */
  caseId?: string
  type: string
  data: T
}

export interface ToolView {
  kind: string
  title?: string
  [key: string]: unknown
}

export type ChatStatus = 'idle' | 'running' | 'waiting'

export interface ChatSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  status: ChatStatus
}

export type LiveFrame =
  | { type: 'chunk'; kind: 'message' | 'thought'; text: string }
  | { type: 'status'; status: ChatStatus }

export interface ActionCallData {
  callId: string
  phase?: string
  name: string
  args: Record<string, any>
  status: 'ok' | 'error' | 'denied'
  value?: any
  error?: string
  durationMs: number
  view?: ToolView
}

export interface Outcome {
  status: 'ok' | 'error' | 'denied'
  value?: any
  error?: string
}
