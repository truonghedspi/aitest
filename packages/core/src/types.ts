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
  /**
   * Công thức tính giá trị mong đợi, thay cho `value`, ví dụ `round(qty * price * 0.0015, 2)`.
   * Agent chỉ chỉ ra evidence chứa từng biến; nền tảng đọc giá trị thật và tính chính xác.
   */
  expr?: string
}

/** Tham chiếu tới một giá trị trong evidence: mã evidence và path. */
export interface EvidenceRef {
  evidenceId: string
  path: string
}

/** Đọc giá trị thật từ evidence đã thu thập trong một scope. Plugin `verdict` cung cấp (`ctx.evidence`). */
export interface EvidenceReader {
  /** Ném lỗi khi mã evidence không tồn tại trong scope. Trả `undefined` khi path không có giá trị. */
  read(scope: ActionScope, ref: EvidenceRef): unknown
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

export type CasePhase = 'setup' | 'agent' | 'teardown'

/**
 * Loại phạm vi thực thi action.
 * - `case`: một test case đang chạy.
 * - `authoring`: một phiên soạn plan cùng agent.
 * - `explore`: lời gọi khảo sát hệ thống từ phiên soạn plan; chỉ cho phép lời gọi chỉ đọc.
 */
export type ScopeKind = 'case' | 'authoring' | 'explore'

/** Pha của lời gọi: chuẩn bị, agent, dọn dẹp, hoặc người dùng thao tác trực tiếp trên giao diện. */
export type ActionPhase = CasePhase | 'user'

/**
 * Phạm vi thực thi chung của action.
 *
 * Plugin gắn trạng thái riêng vào scope bằng `WeakMap<ActionScope, ...>` thay vì sửa đối tượng này.
 */
export interface ActionScope {
  kind: ScopeKind
  /** Mã định danh để ghi log và hiển thị: mã case hoặc mã phiên soạn plan. */
  id: string
  /** Namespace action được phép dùng ở pha `agent`. */
  namespaces: ReadonlySet<string>
  /** Ngoài pha `agent`, mọi action cùng loại scope đều gọi được. */
  phase: ActionPhase
  signal: AbortSignal
  /** Ghi một event vào log append-only của scope. */
  log(type: string, data: unknown): void
}

/** Phạm vi của một test case trong lượt chạy. */
export interface CaseScope extends ActionScope {
  kind: 'case'
  runId: string
  plan: TestPlan
  /** Case đã thay biến `{{...}}` bằng giá trị từ `vars` và fixture. */
  case: TestCase
  /** Biến của plan cộng biến lưu từ fixture. */
  vars: Record<string, unknown>
  phase: CasePhase
}

export interface ActionContext {
  scope: ActionScope
  callId: string
  signal: AbortSignal
}

/**
 * Dữ liệu hiển thị một lời gọi action trên giao diện.
 * `kind` chọn thành phần hiển thị phía client; kind không có thành phần riêng dùng thẻ mặc định.
 */
export interface ToolView {
  kind: string
  /** Tiêu đề ngắn của thẻ, ví dụ `POST /orders → 201`. */
  title?: string
  [key: string]: unknown
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
  /** Loại scope được gọi action này. Mặc định `['case', 'explore']`. */
  scopes?: ScopeKind[]
  /** Action chỉ đọc, không gây side effect. */
  readOnly?: boolean
  /**
   * Với action không chỉ đọc, cho biết một lời gọi cụ thể có chỉ đọc hay không.
   * Ví dụ `http_request` với method GET. Dùng khi khảo sát hệ thống lúc soạn plan.
   */
  isReadOnlyCall?(args: Record<string, unknown>): boolean
  /** Kết quả có được lưu làm evidence cho assertion hay không. Mặc định là `true`. */
  evidence?: boolean
  execute(args: A, ctx: ActionContext): Promise<unknown>
  /**
   * Dựng dữ liệu hiển thị từ tham số và kết quả. Phải là hàm thuần: không I/O, không đọc trạng thái,
   * vì được gọi cả lúc chạy lẫn lúc dựng lại từ log.
   */
  present?(args: A, outcome: ActionOutcome): ToolView | undefined
}

/** Lý do agent tự khai báo cho một lời gọi tool: lấy dữ liệu gì, để làm gì, phục vụ bước nào. */
export interface CallIntent {
  reason?: string
  /** Số thứ tự bước trong test case (đánh số từ 1). */
  step?: number
}

export interface ActionCall {
  id: string
  name: string
  namespace: string
  args: Record<string, unknown>
  scope: ActionScope
  definition: ActionDefinition
  intent: CallIntent
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

/** Một model mà agent cho phép chọn. */
export interface AgentModel {
  id: string
  name: string
  description?: string
}

export interface AgentSessionOptions {
  cwd: string
  /** Model dùng cho session; bỏ trống thì dùng mặc định của agent. */
  model?: string
  mcpServers: McpEndpoint[]
  onUpdate(update: AgentUpdate): void
  /** Hook xin quyền dùng tool của agent; trả về `true` để cho phép. */
  onPermission?(request: { title: string; raw: unknown }): Promise<boolean> | boolean
}

export interface AgentSession {
  id: string
  /** Model hiện tại và danh sách model chọn được, nếu agent công bố. */
  models?: { current?: string; available: AgentModel[] }
  /** Đổi model của session; không có khi agent không hỗ trợ đổi model. */
  setModel?(modelId: string): Promise<void>
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
  /** Công thức tính giá trị mong đợi, khi plan dùng `check.expr`. */
  expr?: string
  /** Giá trị thật của từng biến trong công thức, kèm nơi lấy. */
  inputs?: Record<string, EvidenceRef & { value: unknown }>
}

export interface ActionRecord {
  callId: string
  /** Lý do agent khai báo khi gọi; không có với fixture và thao tác của người dùng. */
  reason?: string
  step?: number
  /** Loại scope thực hiện lời gọi; lời gọi `explore` lồng trong tool `explore` của phiên soạn plan. */
  scope?: ScopeKind
  phase?: ActionPhase
  view?: ToolView
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
  /** Thông tin plugin gắn vào case qua event `case/annotation`, ví dụ `knownIssues`. */
  annotations: Record<string, unknown>
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
