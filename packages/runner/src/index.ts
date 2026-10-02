import type {} from '@aitest/mcp-gateway'
import {
  deriveReport, errorMessage, readPath, Service, z, type FixtureStep,
  type AgentConnection, type AgentSession, type AgentUpdate, type CaseScope, type Context, type RunLog, type RunReport,
  type TestCase, type TestPlan, type VerdictDecision,
} from '@aitest/core'
import { registerDefaultSections } from './prompt.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    runner: Runner
  }
}

export interface RunOptions {
  plan: TestPlan | string
  /** Chỉ chạy các case có id nằm trong danh sách. */
  cases?: string[]
  /** Tên agent driver; mặc định lấy từ cấu hình. */
  agent?: string
  /** Mã lượt chạy; mặc định sinh từ thời điểm và mã plan. */
  runId?: string
}

export interface RunnerConfig {
  agent: string
  caseTimeout: number
  cancelGrace: number
  cwd?: string
  permission: 'gateway-only' | 'allow-all' | 'deny-all'
}

/**
 * Điều phối một lượt chạy test plan.
 *
 * Runner không biết action cụ thể, định dạng plan hay loại agent. Mọi thứ đi qua
 * service và event: `plans`, `agents`, `gateway`, `prompt`, `runlog`, `case/*`, `run/report`.
 */
export class Runner extends Service {
  static inject = ['plans', 'agents', 'actions', 'prompt', 'runlog', 'gateway']
  static Config = z.object({
    agent: z.string().default('kiro').description('Agent driver mặc định.'),
    caseTimeout: z.natural().default(300).description('Giới hạn thời gian mặc định của một case, đơn vị giây.'),
    cancelGrace: z.natural().default(15).description('Thời gian chờ agent dừng sau khi huỷ, đơn vị giây.'),
    cwd: z.string().description('Thư mục làm việc truyền cho agent; mặc định là thư mục hiện tại.'),
    permission: z.union(['gateway-only', 'allow-all', 'deny-all'] as const).default('gateway-only')
      .description('Chính sách duyệt yêu cầu dùng tool của agent.'),
  })

  constructor(ctx: Context, public config: RunnerConfig) {
    super(ctx, 'runner')
    registerDefaultSections(ctx)
  }

  async run(options: RunOptions): Promise<RunReport> {
    const plan = typeof options.plan === 'string' ? await this.ctx.plans.load(options.plan) : options.plan
    const cases = options.cases?.length ? plan.cases.filter((c) => options.cases!.includes(c.id)) : plan.cases
    const agentName = options.agent ?? this.config.agent
    const cwd = this.config.cwd ?? process.cwd()
    const runId = options.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${plan.id}`.replace(/[^\w.-]/g, '_')
    const log = await this.ctx.runlog.create(runId)
    log.append('run/start', { plan: { id: plan.id, name: plan.name, source: plan.source }, agent: agentName })

    let connection: AgentConnection | undefined
    let connectError: string | undefined
    try {
      connection = await this.ctx.agents.get(agentName).connect({ cwd })
      log.append('agent/connected', connection.info)
    } catch (error) {
      connectError = errorMessage(error)
    }

    for (const testCase of cases) {
      await this.runCase(log, plan, testCase, connection, connectError, cwd)
    }

    await connection?.close().catch(() => {})
    log.append('run/end', {})
    await log.close()
    const report = { ...deriveReport(log.events), logFile: log.file }
    await this.ctx.parallel('run/report', report)
    return report
  }

  private async runCase(
    log: RunLog, plan: TestPlan, testCase: TestCase,
    connection: AgentConnection | undefined, connectError: string | undefined, cwd: string,
  ) {
    const started = performance.now()
    const controller = new AbortController()
    const scope: CaseScope = {
      kind: 'case',
      id: testCase.id,
      runId: log.runId,
      plan,
      case: testCase,
      vars: { ...plan.vars },
      phase: 'setup',
      namespaces: new Set(plan.requires),
      signal: controller.signal,
      log: (type, data) => { log.append(type, data, testCase.id) },
    }
    scope.log('case/start', { id: testCase.id, title: testCase.title, expect: testCase.expect })
    await this.ctx.parallel('case/start', scope)

    let base: VerdictDecision = { verdict: 'inconclusive', reasons: [] }
    let stopReason: string | undefined
    const transcript = createTranscript(scope)
    const exposure = await this.ctx.gateway.expose(scope)
    let session: AgentSession | undefined
    const timeoutMs = testCase.timeoutMs ?? this.config.caseTimeout * 1000
    const timer = setTimeout(() => controller.abort(new Error(`case timeout after ${timeoutMs} ms`)), timeoutMs)

    try {
      await this.runFixtures(scope, [...plan.setup, ...testCase.setup])
      // Thay `{{biến}}` còn lại trong case bằng giá trị lưu từ fixture.
      scope.case = fillTemplate(testCase, scope.vars)
      scope.phase = 'agent'
      if (!connection) throw new Error(`agent connection failed: ${connectError}`)
      session = await connection.newSession({
        cwd,
        mcpServers: [exposure.endpoint],
        onUpdate: (update) => {
          transcript.push(update)
          this.ctx.emit('case/agent-update', scope, update)
        },
        onPermission: (request) => this.decidePermission(scope, exposure.endpoint.name, request),
      })
      const prompt = this.ctx.prompt.build(scope, this.ctx.actions.list(scope))
      scope.log('agent/prompt', { sessionId: session.id, text: prompt })
      const result = await withGrace(session.prompt(prompt, controller.signal), controller.signal, this.config.cancelGrace * 1000)
      stopReason = result.stopReason
      if (controller.signal.aborted) {
        base = { verdict: 'error', reasons: [errorMessage(controller.signal.reason)] }
      } else if (stopReason !== 'end_turn') {
        base.reasons.push(`agent stopped with reason: ${stopReason}`)
      }
    } catch (error) {
      base = { verdict: 'error', reasons: [errorMessage(error)] }
    } finally {
      clearTimeout(timer)
      transcript.flush()
      controller.abort()
      await session?.close().catch(() => {})
      await exposure.close()
    }

    // Teardown luôn chạy, với signal riêng vì signal của case đã bị huỷ.
    scope.phase = 'teardown'
    scope.signal = AbortSignal.timeout(this.config.caseTimeout * 1000)
    try {
      await this.runFixtures(scope, [...testCase.teardown, ...plan.teardown])
    } catch (error) {
      base.reasons.push(errorMessage(error))
    }

    const decision = await this.ctx.waterfall('case/verdict', scope, base, async () => base)
    const reasons = decision.verdict === base.verdict ? decision.reasons : [...base.reasons, ...decision.reasons]
    const final = { verdict: decision.verdict, reasons: [...new Set(reasons)] }
    scope.log('case/end', { ...final, durationMs: Math.round(performance.now() - started), stopReason })
    await this.ctx.parallel('case/end', scope, final)
  }

  /**
   * Chạy các bước fixture theo thứ tự. Bước đầu tiên lỗi sẽ dừng chuỗi và ném lỗi.
   * Tham số được thay biến trước khi gọi; `save` lưu giá trị kết quả vào `scope.vars`.
   */
  private async runFixtures(scope: CaseScope, steps: FixtureStep[]) {
    for (const [index, step] of steps.entries()) {
      const args = fillTemplate(step.args, scope.vars)
      const outcome = await this.ctx.actions.invoke(scope, step.action, args)
      if (outcome.status !== 'ok') {
        throw new Error(`${scope.phase} step ${index + 1} (${step.desc ?? step.action}) failed: ${outcome.error}`)
      }
      for (const [name, path] of Object.entries(step.save ?? {})) {
        const value = readPath(outcome.value, path)
        if (value === undefined) {
          throw new Error(`${scope.phase} step ${index + 1}: cannot save ${name}, path ${path} has no value`)
        }
        scope.vars[name] = value
      }
    }
    if (steps.length) scope.log('fixture/vars', { phase: scope.phase, vars: scope.vars })
  }

  /** Mặc định chỉ duyệt tool thuộc MCP gateway của case; từ chối tool khác của agent như shell, ghi file. */
  private decidePermission(scope: CaseScope, serverName: string, request: { title: string; raw: unknown }) {
    const policy = this.config.permission
    const names = this.ctx.actions.list(scope).map((def) => def.name)
    const text = `${request.title} ${JSON.stringify(request.raw)}`
    const allowed = policy === 'allow-all'
      || (policy === 'gateway-only' && (text.includes(serverName) || names.some((n) => text.includes(n))))
    scope.log('agent/permission', { title: request.title, allowed })
    return allowed
  }
}

export default Runner

/**
 * Gộp các chunk tin nhắn liên tiếp của agent thành một event duy nhất,
 * tránh ghi hàng nghìn event nhỏ vào run log.
 */
function createTranscript(scope: CaseScope) {
  let buffer: AgentUpdate | undefined
  const flush = () => {
    if (buffer) scope.log('agent/update', { kind: buffer.kind, text: buffer.text })
    buffer = undefined
  }
  return {
    flush,
    push(update: AgentUpdate) {
      if (update.kind === 'message' || update.kind === 'thought') {
        if (buffer?.kind === update.kind) buffer.text = (buffer.text ?? '') + (update.text ?? '')
        else { flush(); buffer = { ...update } }
        return
      }
      flush()
      const raw = update.raw as Record<string, unknown>
      // Tham số và kết quả của tool riêng của agent (đọc file, tìm kiếm...) chỉ có trong cập nhật ACP;
      // tool của gateway đã có bản ghi `action/call` đầy đủ.
      scope.log('agent/update', {
        kind: update.kind, text: update.text,
        toolCallId: raw?.toolCallId, status: raw?.status, title: raw?.title, toolKind: raw?.kind,
        input: clip(raw?.rawInput), output: clip(raw?.rawOutput),
      })
    },
  }
}

/** Rút gọn giá trị lớn trước khi ghi log, để log không phình vì kết quả tool của agent. */
function clip(value: unknown, max = 4000): unknown {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= max) return value
  return `${text.slice(0, max)}… [đã cắt ${text.length - max} ký tự]`
}

/**
 * Thay `{{tên}}` trong mọi chuỗi của một giá trị.
 * Chuỗi chỉ gồm đúng một placeholder thì giữ nguyên kiểu của biến (số, object...).
 */
export function fillTemplate<T>(value: T, vars: Record<string, unknown>): T {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(value)
    if (whole && whole[1] in vars) return vars[whole[1]] as T
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key) => {
      if (!(key in vars)) return m
      const v = vars[key]
      return typeof v === 'string' ? v : JSON.stringify(v)
    }) as T
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars)])) as T
  }
  return value
}

/** Chờ promise; nếu đã huỷ mà agent không dừng sau `graceMs` thì bỏ qua. */
function withGrace<T>(promise: Promise<T>, signal: AbortSignal, graceMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    promise.then(resolve, reject)
    const onAbort = () => setTimeout(() => reject(signal.reason ?? new Error('aborted')), graceMs).unref()
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
