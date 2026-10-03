import type {} from '@aitest/mcp-gateway'
import {
  deriveReport, errorMessage, fillTemplate, readPath, runVars, Service, z, type ActionScope, type FixtureStep,
  type AgentConnection, type AgentSession, type AgentUpdate, type CaseScope, type Context, type PrepareScope, type RunContext,
  type RunLog, type RunReport, type TestCase, type TestPlan, type VerdictDecision,
} from '@aitest/core'
import { registerDefaultSections } from './prompt.ts'

export { fillTemplate }

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
  /** Model của agent cho lượt chạy; mặc định lấy từ cấu hình runner, rồi tới cấu hình driver. */
  model?: string
  /** Giá trị đầu vào do người chạy điền, theo tên input của plan. */
  inputs?: Record<string, unknown>
  /** Môi trường chạy (`envs/<tên>.yml`); mặc định của service `envs` khi có. */
  env?: string
  /**
   * Dừng lượt chạy khi signal bị huỷ (người dùng bấm Dừng): case đang chạy dừng với verdict `error` nhưng vẫn chạy
   * teardown; case chưa chạy ghi `error` "run cancelled"; dọn dữ liệu của lượt chạy vẫn chạy.
   */
  signal?: AbortSignal
  /** Giới hạn thời gian của case không khai báo `timeout` trong plan, đơn vị giây; mặc định `caseTimeout` của runner. */
  caseTimeout?: number
  /** Số case chạy cùng lúc; mặc định `concurrency` của plan, nếu không có thì 1. Bị giới hạn bởi `maxConcurrency` của runner. */
  concurrency?: number
}

export interface RunnerConfig {
  agent: string
  model?: string
  caseTimeout: number
  maxConcurrency: number
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
    model: z.string().description('Model của agent chạy test; bỏ trống thì dùng mặc định của driver.'),
    caseTimeout: z.natural().default(300).description('Giới hạn thời gian mặc định của một case, đơn vị giây.'),
    maxConcurrency: z.natural().min(1).default(4)
      .description('Số case tối đa chạy cùng lúc trong một lượt chạy; mỗi case chạy song song dùng một process agent riêng.'),
    cancelGrace: z.natural().default(15).description('Thời gian chờ agent dừng sau khi huỷ, đơn vị giây.'),
    cwd: z.string().description('Thư mục làm việc truyền cho agent; mặc định là thư mục hiện tại.'),
    permission: z.union(['gateway-only', 'allow-all', 'deny-all'] as const).default('gateway-only')
      .description('Chính sách duyệt yêu cầu dùng tool của agent.'),
  })

  constructor(ctx: Context, public config: RunnerConfig) {
    super(ctx, 'runner')
    registerDefaultSections(ctx)
    // Tin nhắn agent viết trước khi gọi tool của gateway được ghi trước `action/call`, để dòng thời gian đúng thứ tự.
    ctx.on('action/before', (call, next) => {
      transcripts.get(call.scope)?.flush()
      return next()
    })
  }

  async run(options: RunOptions): Promise<RunReport> {
    const plan = typeof options.plan === 'string' ? await this.ctx.plans.load(options.plan) : options.plan
    const cases = options.cases?.length ? plan.cases.filter((c) => options.cases!.includes(c.id)) : plan.cases
    const agentName = options.agent ?? this.config.agent
    const cwd = this.config.cwd ?? process.cwd()
    const runId = options.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${plan.id}`.replace(/[^\w.-]/g, '_')
    const log = await this.ctx.runlog.create(runId)
    const env = options.env || (this.ctx.get('envs') as { config?: { default?: string } } | undefined)?.config?.default
    const concurrency = Math.max(1, Math.min(options.concurrency ?? plan.concurrency ?? 1, this.config.maxConcurrency, cases.length || 1))
    log.append('run/start', {
      plan: { id: plan.id, name: plan.name, source: plan.source }, agent: agentName, ...(concurrency > 1 ? { concurrency } : {}),
      ...(env ? { env } : {}), ...(options.model || this.config.model ? { model: options.model || this.config.model } : {}),
    })

    let connection: AgentConnection | undefined
    let connectError: string | undefined
    try {
      connection = await this.ctx.agents.get(agentName).connect({ cwd })
      log.append('agent/connected', connection.info)
    } catch (error) {
      connectError = errorMessage(error)
    }

    // Chuỗi rỗng (biến môi trường không đặt) nghĩa là dùng model mặc định của driver.
    const model = options.model || this.config.model || undefined
    const run = this.createRunContext(log, plan, options.inputs ?? {}, connection, connectError, cwd, model, env)
    try {
      await this.ctx.parallel('run/start', run)
      await this.ctx.parallel('run/prepare', run)
    } catch (error) {
      run.blocked.push(`prepare failed: ${errorMessage(error)}`)
    }
    if (run.blocked.length) log.append('run/blocked', { reasons: run.blocked })

    const cancelled = () => options.signal?.aborted ? `run cancelled: ${errorMessage(options.signal.reason ?? 'by the user')}` : undefined
    options.signal?.addEventListener('abort', () => log.append('run/cancelled', { reason: cancelled() }), { once: true })
    // Mỗi luồng lấy case kế tiếp trong hàng đợi. Luồng thứ hai trở đi mở kết nối agent riêng khi nhận case đầu tiên,
    // để agent không phải xử lý nhiều prompt cùng lúc; không mở được thì dùng chung kết nối chính.
    const queue = [...cases]
    const extra: AgentConnection[] = []
    const worker = async (slot: number) => {
      let own: AgentConnection | undefined
      for (let testCase = queue.shift(); testCase; testCase = queue.shift()) {
        const stop = cancelled()
        if (stop) { this.endCase(log, testCase, 'error', [stop]); continue }
        if (run.blocked.length) { this.blockCase(log, testCase, run.blocked); continue }
        if (slot > 0 && connection && !own) {
          own = await this.ctx.agents.get(agentName).connect({ cwd }).then((c) => {
            extra.push(c)
            log.append('agent/connected', { ...c.info, slot })
            return c
          }, (error) => {
            log.append('agent/connect-failed', { slot, error: errorMessage(error) })
            return connection
          })
        }
        await this.runCase(log, plan, testCase, own ?? connection, connectError, cwd, model, run.vars, env, options.signal, options.caseTimeout)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, (_, slot) => worker(slot)))
    await Promise.all(extra.map((c) => c.close().catch(() => {})))

    // Dọn dữ liệu của lượt chạy theo thứ tự ngược; lỗi được ghi lại, không đổi verdict của case.
    for (const { scope, step } of [...run.cleanup].reverse()) {
      scope.phase = 'teardown'
      scope.signal = AbortSignal.timeout(this.config.caseTimeout * 1000)
      try {
        await this.runFixtures(scope, [step])
      } catch (error) {
        log.append('run/cleanup-failed', { step: step.desc ?? step.action, error: errorMessage(error) })
      }
    }

    await connection?.close().catch(() => {})
    log.append('run/end', {})
    await log.close()
    const report = { ...deriveReport(log.events), logFile: log.file }
    await this.ctx.parallel('run/report', report)
    return report
  }

  /** Ngữ cảnh chuẩn bị của lượt chạy cho `run/prepare`: biến dựng sẵn, fixture và phiên agent trong scope `prepare`. */
  private createRunContext(
    log: RunLog, plan: TestPlan, given: Record<string, unknown>,
    connection: AgentConnection | undefined, connectError: string | undefined, cwd: string, model?: string, env?: string,
  ): RunContext {
    const controller = new AbortController()
    const vars: Record<string, unknown> = { ...runVars(log.runId), ...(env ? { '$env': env } : {}) }
    log.append('run/vars', { vars })
    return {
      runId: log.runId,
      plan,
      env,
      given,
      vars,
      blocked: [],
      cleanup: [],
      log: (type, data) => { log.append(type, data) },
      signal: controller.signal,
      createScope: (namespaces) => ({
        kind: 'prepare', id: 'prepare', runId: log.runId, plan, env, vars: { ...fillTemplate(plan.vars, vars), ...vars },
        phase: 'setup', namespaces: new Set(namespaces), signal: controller.signal,
        log: (type, data) => { log.append(type, data) },
      }),
      runFixtures: (scope, steps) => this.runFixtures(scope, steps),
      promptAgent: async (scope, prompt, timeoutMs) => {
        if (!connection) throw new Error(`agent connection failed: ${connectError}`)
        return this.promptAgent(scope, connection, cwd, model, prompt, timeoutMs)
      },
    }
  }

  /** Một lượt prompt agent trong scope cho trước: mở endpoint MCP riêng, ghi transcript, giới hạn thời gian. */
  private async promptAgent(
    scope: PrepareScope, connection: AgentConnection, cwd: string, model: string | undefined, prompt: string, timeoutMs: number,
  ) {
    const controller = new AbortController()
    const signal = scope.signal
    scope.signal = controller.signal
    const transcript = createTranscript(scope)
    const exposure = await this.ctx.gateway.expose(scope)
    const timer = setTimeout(() => controller.abort(new Error(`${scope.kind} timeout after ${timeoutMs} ms`)), timeoutMs)
    let session: AgentSession | undefined
    try {
      scope.phase = 'agent'
      session = await connection.newSession({
        cwd,
        mcpServers: [exposure.endpoint],
        onUpdate: (update) => transcript.push(update),
        onPermission: (request) => this.decidePermission(scope, exposure.endpoint.name, request),
        model,
      })
      scope.log('agent/session', { sessionId: session.id, model: session.models?.current ?? model, scope: scope.kind, ...fallbackOf(session) })
      const text = withInstructions(session, prompt)
      scope.log('agent/prompt', { sessionId: session.id, text, scope: scope.kind })
      const result = await withGrace(session.prompt(text, controller.signal), controller.signal, this.config.cancelGrace * 1000)
      if (controller.signal.aborted) throw controller.signal.reason
      return { stopReason: result.stopReason }
    } finally {
      clearTimeout(timer)
      transcript.flush()
      controller.abort()
      scope.signal = signal
      scope.phase = 'setup'
      await session?.close().catch(() => {})
      await exposure.close()
    }
  }

  /** Case không được chạy vì lượt chạy bị chặn; ghi đủ `case/start`, `case/end` để báo cáo liệt kê case. */
  private blockCase(log: RunLog, testCase: TestCase, reasons: string[]) {
    this.endCase(log, testCase, 'blocked', reasons)
  }

  /** Case không được chạy (môi trường chưa đủ điều kiện, lượt chạy bị dừng): ghi kết quả ngay. */
  private endCase(log: RunLog, testCase: TestCase, verdict: 'blocked' | 'error', reasons: string[]) {
    log.append('case/start', { id: testCase.id, title: testCase.title, steps: testCase.steps, expect: testCase.expect }, testCase.id)
    log.append('case/end', { verdict, reasons, durationMs: 0 }, testCase.id)
  }

  private async runCase(
    log: RunLog, plan: TestPlan, testCase: TestCase,
    connection: AgentConnection | undefined, connectError: string | undefined, cwd: string, model: string | undefined,
    runVariables: Record<string, unknown>, env?: string, runSignal?: AbortSignal, caseTimeout?: number,
  ) {
    const started = performance.now()
    const controller = new AbortController()
    const onCancel = () => controller.abort(new Error(`run cancelled: ${errorMessage(runSignal?.reason ?? 'by the user')}`))
    runSignal?.addEventListener('abort', onCancel, { once: true })
    const scope: CaseScope = {
      kind: 'case',
      id: testCase.id,
      runId: log.runId,
      plan,
      case: testCase,
      // Biến của plan là giá trị mặc định; biến của lượt chạy (môi trường, catalog, đầu vào, `$run.*`) ghi đè khi trùng tên.
      vars: { ...fillTemplate(plan.vars, runVariables), ...runVariables, '$case.id': testCase.id },
      phase: 'setup',
      namespaces: new Set(plan.requires),
      env,
      signal: controller.signal,
      log: (type, data) => { log.append(type, data, testCase.id) },
    }
    scope.log('case/start', { id: testCase.id, title: testCase.title, steps: testCase.steps, expect: testCase.expect })
    await this.ctx.parallel('case/start', scope)

    let base: VerdictDecision = { verdict: 'inconclusive', reasons: [] }
    let stopReason: string | undefined
    const transcript = createTranscript(scope)
    const exposure = await this.ctx.gateway.expose(scope)
    let session: AgentSession | undefined
    const timeoutMs = testCase.timeoutMs ?? (caseTimeout ?? this.config.caseTimeout) * 1000
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
        model,
      })
      // Ghi model thật sự dùng, để người xem log biết kết quả đến từ model nào.
      scope.log('agent/session', { sessionId: session.id, model: session.models?.current ?? model, ...fallbackOf(session) })
      const prompt = withInstructions(session, this.ctx.prompt.build(scope, this.ctx.actions.list(scope)))
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
      runSignal?.removeEventListener('abort', onCancel)
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
  private async runFixtures(scope: CaseScope | PrepareScope, steps: FixtureStep[]) {
    for (const [index, step] of steps.entries()) {
      const args = fillTemplate(step.args, scope.vars)
      // Lý do của fixture là `desc` do người soạn plan viết.
      const outcome = await this.ctx.actions.invoke(scope, step.action, args, { reason: step.desc })
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
  private decidePermission(scope: ActionScope, serverName: string, request: { title: string; raw: unknown }) {
    const policy = this.config.permission
    const names = this.ctx.actions.list(scope).map((def) => def.name)
    const text = `${request.title} ${JSON.stringify(request.raw)}`
    const allowed = policy === 'allow-all'
      || (policy === 'gateway-only' && (text.includes(serverName) || names.some((n) => text.includes(n))))
    // Ghi kèm yêu cầu gốc (rút gọn) để chẩn đoán khi agent đặt tên tool theo cách khác.
    scope.log('agent/permission', { title: request.title, allowed, ...(allowed ? {} : { raw: text.slice(0, 2000) }) })
    return allowed
  }
}

export default Runner

/** Bản ghi đang mở của từng scope, để pipeline action ghi tin nhắn còn đệm trước lời gọi tool. */
const transcripts = new WeakMap<ActionScope, { flush(): void }>()

/** Đệm tối đa bao lâu khi agent ngừng gửi tin nhắn; quá thời gian này đoạn đã nhận được ghi vào log. */
const IDLE_FLUSH_MS = 1000

/**
 * Ghép các mẩu tin nhắn, suy nghĩ liên tiếp của agent thành một event `agent/update`, tránh ghi hàng nghìn event nhỏ vào run log.
 * Đoạn đang đệm được ghi khi có cập nhật loại khác, khi agent gọi tool của gateway, hoặc sau 1 s không có mẩu mới.
 */
function createTranscript(scope: ActionScope) {
  let buffer: AgentUpdate | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (idle) clearTimeout(idle)
    idle = undefined
    if (buffer) scope.log('agent/update', { kind: buffer.kind, text: buffer.text })
    buffer = undefined
  }
  const transcript = {
    flush,
    push(update: AgentUpdate) {
      if (update.kind === 'message' || update.kind === 'thought') {
        if (buffer?.kind === update.kind) buffer.text = (buffer.text ?? '') + (update.text ?? '')
        else { flush(); buffer = { ...update } }
        if (idle) clearTimeout(idle)
        idle = setTimeout(flush, IDLE_FLUSH_MS)
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
  transcripts.set(scope, transcript)
  return transcript
}

/** Rút gọn giá trị lớn trước khi ghi log, để log không phình vì kết quả tool của agent. */
function clip(value: unknown, max = 4000): unknown {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= max) return value
  return `${text.slice(0, max)}… [đã cắt ${text.length - max} ký tự]`
}

/** Ghi model mặc định bị bỏ qua vì agent không có, để người xem log biết vì sao model khác cấu hình. */
function fallbackOf(session: AgentSession) {
  const from = session.models?.fallbackFrom
  return from ? { modelFallbackFrom: from } : {}
}

/** Chờ promise; nếu đã huỷ mà agent không dừng sau `graceMs` thì bỏ qua. */
/** Chỉ dẫn riêng của agent (cấu hình driver) đặt trước prompt của nền tảng. */
function withInstructions(session: AgentSession, prompt: string) {
  return session.instructions ? `${session.instructions}\n\n${prompt}` : prompt
}

function withGrace<T>(promise: Promise<T>, signal: AbortSignal, graceMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    promise.then(resolve, reject)
    const onAbort = () => setTimeout(() => reject(signal.reason ?? new Error('aborted')), graceMs).unref()
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
