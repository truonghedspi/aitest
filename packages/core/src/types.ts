/**
 * Kiểu miền dùng chung cho mọi plugin.
 *
 * Mọi plugin chỉ trao đổi với nhau qua các kiểu trong file này và qua event
 * khai báo ở `events.ts`, không import trực tiếp lẫn nhau.
 */

/** Toán tử so sánh mà assertion hỗ trợ. */
export type AssertOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'matches' | 'exists' | 'not_exists'

/** Điều kiện kiểm tra cố định do người soạn plan khai báo; agent không được thay đổi. */
export interface ExpectationCheck {
  op: AssertOp
  value?: unknown
}

/** Một kết quả mong đợi của test case. */
export interface Expectation {
  id: string
  desc: string
  check?: ExpectationCheck
}

/**
 * Một bước chuẩn bị hoặc dọn dẹp dữ liệu. Runner thực thi bước này một cách xác định, không qua AI.
 * Bước fixture được gọi mọi action đã đăng ký, không bị giới hạn bởi `requires`.
 */
export interface FixtureStep {
  action: string
  args: Record<string, unknown>
  /** Lưu giá trị từ kết quả thành biến: `{ order_id: '$.rows[0].id' }`. Bước sau dùng `{{order_id}}`. */
  save?: Record<string, string>
  desc?: string
}

export interface TestCase {
  id: string
  title: string
  tags: string[]
  /** Các bước viết bằng ngôn ngữ tự nhiên, agent tự chọn action để thực hiện. */
  steps: string[]
  expect: Expectation[]
  timeoutMs?: number
  setup: FixtureStep[]
  teardown: FixtureStep[]
}

export interface TestPlan {
  id: string
  name: string
  description?: string
  /** Đường dẫn tuyệt đối tới file nguồn của plan. */
  source: string
  /** Tên format đã parse plan, ví dụ `yaml`. */
  format: string
  /** Các namespace action mà plan được phép dùng, ví dụ `http`, `db`. */
  requires: string[]
  vars: Record<string, unknown>
  /** Bối cảnh nghiệp vụ bổ sung cho agent. */
  context?: string
  /** Chạy trước mỗi case, trước `case.setup`. */
  setup: FixtureStep[]
  /** Chạy sau mỗi case, sau `case.teardown`; luôn chạy kể cả khi case lỗi. */
  teardown: FixtureStep[]
  cases: TestCase[]
}

/** JSON Schema dạng object, dùng làm input schema của action. */
export interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

/**
 * Phạm vi thực thi của một test case.
 *
 * Mỗi case có một scope riêng. Plugin gắn trạng thái riêng của mình vào scope
 * bằng `WeakMap<CaseScope, ...>` thay vì sửa đối tượng này.
 */
export type CasePhase = 'setup' | 'agent' | 'teardown'

export interface CaseScope {
  runId: string
  plan: TestPlan
  /** Case đã thay biến `{{...}}` bằng giá trị từ `vars` và fixture. */
  case: TestCase
  /** Biến của plan cộng biến lưu từ fixture. */
  vars: Record<string, unknown>
  /** Pha hiện tại. Ngoài pha `agent`, mọi action đã đăng ký đều gọi được. */
  phase: CasePhase
  /** Namespace action được phép dùng trong case này. */
  namespaces: ReadonlySet<string>
  signal: AbortSignal
  /** Ghi một event vào run log (append-only). */
  log(type: string, data: unknown): void
}

export interface ActionContext {
  scope: CaseScope
  callId: string
  signal: AbortSignal
}

/** Định nghĩa một action mà agent gọi được thông qua MCP gateway. */
export interface ActionDefinition<A = any> {
  /** Tên tool phía MCP, khớp `^[a-z][a-z0-9_]{0,63}$`, ví dụ `http_request`. */
  name: string
  /** Namespace dùng để giới hạn theo `requires` của plan, ví dụ `http`. */
  namespace: string
  description: string
  inputSchema: JsonSchemaObject
  /** Action luôn khả dụng, không phụ thuộc `requires` (ví dụ assertion). */
  always?: boolean
  /** Action chỉ đọc, không gây side effect. */
  readOnly?: boolean
  /** Kết quả có được lưu làm evidence cho assertion hay không. Mặc định là `true`. */
  evidence?: boolean
  execute(args: A, ctx: ActionContext): Promise<unknown>
}

export interface ActionCall {
  id: string
  name: string
  namespace: string
  args: Record<string, unknown>
  scope: CaseScope
  definition: ActionDefinition
}

export type ActionStatus = 'ok' | 'error' | 'denied'

export interface ActionOutcome {
  status: ActionStatus
  value?: unknown
  error?: string
  durationMs: number
  /** Thông tin do plugin khác bổ sung trong `action/after`, ví dụ `evidenceId`. */
  annotations: Record<string, unknown>
}

export type ActionDecision = { type: 'allow' } | { type: 'deny'; reason: string }

/** Endpoint MCP mà agent sẽ kết nối tới. */
export interface McpEndpoint {
  name: string
  url: string
  headers: Record<string, string>
}

export type AgentUpdateKind = 'message' | 'thought' | 'tool_call' | 'tool_update' | 'plan' | 'other'

export interface AgentUpdate {
  kind: AgentUpdateKind
  text?: string
  raw: unknown
}

export interface AgentSessionOptions {
  cwd: string
  mcpServers: McpEndpoint[]
  onUpdate(update: AgentUpdate): void
  /** Hook xin quyền dùng tool của agent; trả về `true` để cho phép. */
  onPermission?(request: { title: string; raw: unknown }): Promise<boolean> | boolean
}

export interface AgentSession {
  id: string
  prompt(text: string, signal: AbortSignal): Promise<{ stopReason: string }>
  close(): Promise<void>
}

export interface AgentConnection {
  info: { name: string; version?: string; raw?: unknown }
  newSession(options: AgentSessionOptions): Promise<AgentSession>
  close(): Promise<void>
}

/** Driver kết nối tới một loại agent, ví dụ ACP (Kiro) hoặc agent kịch bản dùng cho test. */
export interface AgentDriver {
  name: string
  connect(options: { cwd: string }): Promise<AgentConnection>
}

export type Verdict = 'pass' | 'fail' | 'error' | 'inconclusive' | 'skipped'

export interface VerdictDecision {
  verdict: Verdict
  reasons: string[]
}

/** Bản ghi trong run log. Đây là nguồn sự thật duy nhất để dựng báo cáo. */
export interface RunEvent<T = unknown> {
  seq: number
  ts: string
  runId: string
  caseId?: string
  type: string
  data: T
}

export interface AssertionRecord {
  expectId: string
  evidenceId?: string
  path?: string
  op: AssertOp
  expected?: unknown
  actual?: unknown
  passed: boolean
  message: string
  /** `plan`: tiêu chí lấy từ `check` của plan. `agent`: agent tự chọn tiêu chí vì plan không khai báo. */
  criteria: 'plan' | 'agent'
}

export interface ActionRecord {
  callId: string
  phase?: CasePhase
  name: string
  args: Record<string, unknown>
  status: ActionStatus
  value?: unknown
  error?: string
  durationMs: number
  annotations: Record<string, unknown>
}

export interface StepNote {
  step: number
  status: 'done' | 'failed' | 'skipped'
  note?: string
}

export interface CaseReport {
  id: string
  title: string
  verdict: Verdict
  reasons: string[]
  durationMs: number
  stopReason?: string
  /** `assertion` là lần quyết định; `attempts` là mọi lần assert theo thứ tự. */
  expectations: Array<Expectation & { assertion?: AssertionRecord; attempts: AssertionRecord[] }>
  actions: ActionRecord[]
  steps: StepNote[]
  agentSummary: string
}

export interface RunReport {
  runId: string
  plan: { id: string; name: string; source: string }
  agent: string
  startedAt: string
  finishedAt?: string
  durationMs: number
  totals: Record<Verdict, number> & { total: number }
  cases: CaseReport[]
  logFile?: string
}
