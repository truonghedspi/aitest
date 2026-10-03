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
  /**
   * Các bước trung gian có tên của công thức, tính theo thứ tự trước `expr`; bước sau dùng kết quả bước trước.
   * Báo cáo ghi giá trị từng bước.
   */
  let?: Record<string, string>
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

/**
 * Một đầu vào của plan, phân giải một lần trước mọi case của lượt chạy và dùng như biến `{{tên}}`.
 * Nguồn giá trị theo thứ tự ưu tiên: người chạy điền → `fill` → agent `prepare` → `default`.
 */
export interface PlanInput {
  name: string
  desc?: string
  default?: unknown
  /** Thiếu giá trị sau mọi nguồn thì lượt chạy bị chặn (`blocked`). Mặc định `true`. */
  required: boolean
  /** Bước lấy giá trị xác định (gọi API, INSERT, truy vấn dữ liệu có sẵn); một bước phải `save` vào tên input. */
  fill: FixtureStep[]
  /** Mô tả bằng lời cách chuẩn bị; agent thực hiện qua tool và trả giá trị từ evidence. */
  prepare?: string
  /** Namespace agent được dùng khi `prepare`; mặc định là `requires` của plan. */
  uses?: string[]
  /** Điều kiện giá trị phải thoả; không thoả thì lượt chạy bị chặn. */
  require?: { op: AssertOp; value?: unknown }
  /** Bước dọn chạy sau mọi case, theo thứ tự ngược với lúc chuẩn bị. */
  cleanup: FixtureStep[]
}

/** Lời gọi tới một operation trong catalog hệ thống. */
export interface StepCall {
  /** `<system>.<operationId>`. */
  call: string
  path?: Record<string, unknown>
  query?: Record<string, unknown>
  headers?: Record<string, string>
  body?: unknown
  /** Ghi chú bằng lời, ví dụ "lấy id lệnh". */
  desc?: string
}

export interface TestCase {
  id: string
  title: string
  tags: string[]
  /** Các bước viết bằng ngôn ngữ tự nhiên, agent tự chọn action để thực hiện. */
  steps: string[]
  /**
   * Bước có cấu trúc, cùng chỉ số với `steps`: lời gọi tới operation trong catalog hệ thống (`call: order-service.createOrder`).
   * `steps[i]` là câu chỉ dẫn sinh từ lời gọi; lời gọi được kiểm theo OpenAPI khi soạn plan.
   */
  calls?: Array<StepCall | undefined>
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
  /** Công thức tự định nghĩa của plan, dùng trong `check.expr`, `check.let` và tool `calc`. */
  formulas?: Record<string, import('./formulas.ts').FormulaDefinition>
  /** Đầu vào của lượt chạy, theo thứ tự khai báo; input sau được dùng giá trị của input trước. */
  inputs?: PlanInput[]
  /** Môi trường được chạy plan; không khai báo thì chạy được mọi môi trường. */
  envs?: string[]
  /** Hệ thống trong catalog mà plan dùng tới, ví dụ `order-service`; cung cấp biến `{{order-service.url}}`. */
  systems?: string[]
  vars: Record<string, unknown>
  /** Bối cảnh riêng của plan cho agent chạy test. Điều dùng chung cho nhiều plan nằm ở catalog hệ thống hoặc `contextRefs`. */
  context?: string
  /** Tài liệu nghiệp vụ dùng chung (đường dẫn trong thư mục ngữ cảnh) đưa vào prompt của agent chạy test. */
  contextRefs?: string[]
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
export type ScopeKind = 'case' | 'authoring' | 'explore' | 'prepare'

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
  /** Môi trường mà scope chạy trên đó; action có bản riêng theo môi trường được chọn theo trường này. */
  env?: string
  /**
   * Xin người dùng duyệt một thao tác kèm bản xem trước. Chỉ có khi scope gắn với người dùng trực tiếp,
   * ví dụ cuộc chat. Action có tác động lâu dài phải gọi hàm này và từ chối chạy khi scope không có hàm.
   */
  confirm?(request: ConfirmRequest): Promise<boolean>
}

/** Yêu cầu duyệt do action gửi tới người dùng. `preview` là dữ liệu thuần JSON, có `kind` để giao diện chọn cách hiển thị. */
export interface ConfirmRequest {
  tool: string
  title: string
  preview: { kind: string; [key: string]: unknown }
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
   * Action tự xin duyệt qua `scope.confirm` kèm bản xem trước đầy đủ. Host không hỏi thêm lần nữa
   * khi agent xin quyền dùng tool này, để người dùng chỉ thấy một thẻ duyệt có đủ thông tin.
   */
  selfConfirm?: boolean
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
  /** `fallbackFrom`: model mặc định đã cấu hình nhưng agent không có, nên session dùng `current`. */
  models?: { current?: string; available: AgentModel[]; fallbackFrom?: string }
  /** Đổi model của session; không có khi agent không hỗ trợ đổi model. */
  setModel?(modelId: string): Promise<void>
  prompt(text: string, signal: AbortSignal): Promise<{ stopReason: string }>
  close(): Promise<void>
}

export interface AgentConnection {
  info: { name: string; version?: string; raw?: unknown }
  newSession(options: AgentSessionOptions): Promise<AgentSession>
  /**
   * Khôi phục phiên đã có (ACP `session/load`), giữ nguyên ngữ cảnh của agent: tin nhắn, kết quả tool, lập luận.
   * Chỉ có khi agent hỗ trợ. Lịch sử agent phát lại khi khôi phục không được chuyển cho `onUpdate`.
   */
  loadSession?(sessionId: string, options: AgentSessionOptions): Promise<AgentSession>
  close(): Promise<void>
}

/** Driver kết nối tới một loại agent, ví dụ ACP (Kiro) hoặc agent kịch bản dùng cho test. */
export interface AgentDriver {
  name: string
  connect(options: { cwd: string }): Promise<AgentConnection>
}

/** `blocked`: môi trường hoặc dữ liệu chưa đủ điều kiện để chạy (đầu vào thiếu, không thoả `require`); case không được chạy. */
export type Verdict = 'pass' | 'fail' | 'error' | 'inconclusive' | 'skipped' | 'blocked'

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
  /** Biến của lượt chạy (vars của plan, đầu vào, save của fixture) mà công thức đã dùng, kèm giá trị. */
  runVars?: Record<string, unknown>
  /** Giá trị từng bước `let` của công thức. */
  steps?: Record<string, unknown>
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
  /** Môi trường của lượt chạy. */
  env?: string
  startedAt: string
  finishedAt?: string
  durationMs: number
  totals: Record<Verdict, number> & { total: number }
  /** Đầu vào đã phân giải cho lượt chạy, kèm nguồn giá trị. */
  inputs: ResolvedInput[]
  /** Lý do lượt chạy bị chặn trước khi chạy case. */
  blocked: string[]
  /** Lượt chạy bị người dùng dừng giữa chừng: lý do (event `run/cancelled`). */
  cancelled?: string
  cases: CaseReport[]
  logFile?: string
}

export interface ResolvedInput {
  name: string
  source: 'user' | 'fill' | 'agent' | 'default' | 'missing'
  value?: unknown
  /** Với nguồn `agent`: evidence chứa giá trị. */
  evidence?: EvidenceRef & { action?: string }
  error?: string
}

/** Phạm vi chuẩn bị dữ liệu của lượt chạy: fixture của input và phiên agent `prepare`. */
export interface PrepareScope extends ActionScope {
  kind: 'prepare'
  runId: string
  plan: TestPlan
  vars: Record<string, unknown>
  phase: CasePhase
}

/**
 * Ngữ cảnh chuẩn bị của một lượt chạy, truyền cho `run/prepare`. Plugin ghi biến dùng chung vào `vars`,
 * lý do không chạy được vào `blocked`, bước dọn vào `cleanup`.
 */
export interface RunContext {
  runId: string
  plan: TestPlan
  /** Môi trường của lượt chạy; mọi scope của lượt chạy dùng môi trường này. */
  env?: string
  /** Giá trị đầu vào do người chạy truyền (CLI `--input`, form trên giao diện). */
  given: Record<string, unknown>
  /** Biến dùng chung cho mọi case: biến dựng sẵn `$run.*` và đầu vào đã phân giải. */
  vars: Record<string, unknown>
  blocked: string[]
  /** Bước dọn chạy sau mọi case, theo thứ tự ngược với lúc thêm. */
  cleanup: Array<{ scope: PrepareScope; step: FixtureStep }>
  log(type: string, data: unknown): void
  signal: AbortSignal
  /** Tạo scope chuẩn bị gắn với run log của lượt chạy. */
  createScope(namespaces: Iterable<string>): PrepareScope
  /** Chạy bước fixture trong scope chuẩn bị; `save` ghi vào `scope.vars`. Ném lỗi ở bước đầu tiên thất bại. */
  runFixtures(scope: PrepareScope, steps: FixtureStep[]): Promise<void>
  /** Gửi một prompt cho agent của lượt chạy, qua endpoint MCP riêng của scope. Ném lỗi khi không có agent. */
  promptAgent(scope: PrepareScope, prompt: string, timeoutMs: number): Promise<{ stopReason: string }>
}
