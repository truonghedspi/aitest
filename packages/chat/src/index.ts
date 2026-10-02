import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AGENT_PROMPT, type AuthoringSession } from '@aitest/authoring'
import type {} from '@aitest/mcp-gateway'
import type {} from '@aitest/web-host'
import {
  Service, errorMessage, z,
  type ActionScope, type AgentConnection, type AgentSession, type AgentUpdate, type Context, type RunEvent, type RunLog,
} from '@aitest/core'
import { registerWebMethods } from './web.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    chats: ChatService
  }
  interface Events {
    /** Khung dữ liệu tạm của một cuộc chat (token đang stream, trạng thái); không ghi log. @mode emit */
    'chat/live'(chatId: string, frame: LiveFrame): void
  }
}

export type ChatStatus = 'idle' | 'running' | 'waiting'

export type LiveFrame =
  | { type: 'chunk'; kind: 'message' | 'thought'; text: string }
  | { type: 'status'; status: ChatStatus }

export interface ChatSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  status: ChatStatus
  /** Môi trường của cuộc chat; khảo sát và chạy thử dùng môi trường này. Không có thì dùng môi trường mặc định. */
  env?: string
}

export interface Config {
  agent: string
  model?: string
  dir: string
  cwd?: string
  userTools: string[]
  historyChars: number
}

const DEFAULT_TITLE = 'Cuộc chat mới'

/** Tiêu đề hiện tại: `chat/renamed` gần nhất, nếu không có thì tiêu đề lúc tạo. */
function chatTitle(events: RunEvent[]) {
  const renamed = events.findLast((e) => e.type === 'chat/renamed') ?? events.find((e) => e.type === 'chat/created')
  return (renamed?.data as { title?: string } | undefined)?.title ?? DEFAULT_TITLE
}

/** Tool soạn plan mà người dùng được bấm chạy trực tiếp trên giao diện, không qua agent. */
const DEFAULT_USER_TOOLS = ['validate_plan', 'dry_run', 'get_run_result', 'save_plan']

/**
 * Service quản lý các cuộc chat soạn plan (`ctx.chats`).
 *
 * Mỗi cuộc chat có một log append-only (`<dir>/<chatId>/events.jsonl`). Log này cũng là log của
 * phiên soạn plan, nên mọi lời gọi tool (`action/start`, `action/call` kèm `view`) nằm cùng chỗ với
 * tin nhắn. Giao diện dựng hội thoại hoàn toàn từ log; token đang stream đi qua event `chat/live`.
 * Agent loop chạy ở agent bên ngoài (mặc định Kiro qua ACP), nhận tool soạn plan qua MCP gateway.
 */
export class ChatService extends Service {
  static inject = ['authoring', 'agents', 'gateway', 'runlog', 'actions']
  static Config = z.object({
    agent: z.string().default('kiro').description('Agent driver cho cuộc chat.'),
    model: z.string().description('Model mặc định cho cuộc chat mới; bỏ trống thì dùng mặc định của agent.'),
    dir: z.string().default('.aitest/chats'),
    cwd: z.string().description('Thư mục làm việc truyền cho agent; mặc định là thư mục hiện tại.'),
    userTools: z.array(z.string()).default(DEFAULT_USER_TOOLS),
    historyChars: z.natural().default(20000).description('Độ dài tối đa lịch sử gửi lại khi khôi phục cuộc chat.'),
  })

  private readonly chats = new Map<string, Chat>()
  private connection?: Promise<AgentConnection>

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'chats')
    ctx.inject(['web'], (ctx) => registerWebMethods(ctx, this))
    ctx.effect(() => () => {
      for (const chat of this.chats.values()) void chat.dispose()
      this.chats.clear()
      void this.connection?.then((c) => c.close(), () => {})
      this.connection = undefined
    }, 'chats.dispose')
  }

  get root() {
    return resolve(this.config.dir)
  }

  async create(title?: string): Promise<Chat> {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`
    const log = await this.ctx.runlog.create(id, this.root)
    log.append('chat/created', { title: title?.trim() || DEFAULT_TITLE, agent: this.config.agent })
    return this.attach(new Chat(this.ctx, this, id, log))
  }

  async get(id: string): Promise<Chat> {
    const cached = this.chats.get(id)
    if (cached) return cached
    if (!/^[\w.-]+$/.test(id)) throw new Error(`invalid chat id: ${id}`)
    const log = await this.ctx.runlog.open(id, this.root).catch(() => undefined)
    if (!log?.events.some((e) => e.type === 'chat/created')) throw new Error(`chat not found: ${id}`)
    return this.attach(new Chat(this.ctx, this, id, log))
  }

  async list(): Promise<ChatSummary[]> {
    const ids = await readdir(this.root).catch(() => [] as string[])
    const out: ChatSummary[] = []
    for (const id of ids) {
      const chat = this.chats.get(id)
      if (chat) {
        out.push(chat.summary())
        continue
      }
      const file = join(this.root, id, 'events.jsonl')
      const events = await this.ctx.runlog.read(file).catch(() => undefined)
      const created = events?.find((e) => e.type === 'chat/created')
      if (!events || !created) continue
      out.push({
        id,
        title: chatTitle(events),
        createdAt: created.ts,
        updatedAt: events.at(-1)!.ts ?? (await stat(file)).mtime.toISOString(),
        status: 'idle',
      })
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Một process agent dùng chung cho mọi cuộc chat; mỗi cuộc chat là một session riêng. */
  async agentConnection(): Promise<AgentConnection> {
    this.connection ??= this.ctx.agents.get(this.config.agent).connect({ cwd: this.config.cwd ?? process.cwd() })
    try {
      return await this.connection
    } catch (error) {
      this.connection = undefined
      throw error
    }
  }

  /** Bỏ kết nối agent hiện tại (ví dụ process agent đã thoát); lần dùng sau sẽ kết nối lại. */
  resetConnection() {
    void this.connection?.then((c) => c.close(), () => {})
    this.connection = undefined
  }

  private attach(chat: Chat) {
    this.chats.set(chat.id, chat)
    return chat
  }
}

export default ChatService

interface PendingPermission {
  resolve(allowed: boolean): void
}

export class Chat {
  status: ChatStatus = 'idle'
  private authoring?: AuthoringSession
  private agentSession?: AgentSession
  private closeExposure?: () => Promise<void>
  private controller?: AbortController
  private buffer?: { kind: 'message' | 'thought'; text: string }
  private readonly pending = new Map<string, PendingPermission>()
  /** Ghi chú cho agent về thao tác người dùng làm trực tiếp, gửi kèm lượt tiếp theo. */
  private notes: string[] = []

  constructor(
    private readonly ctx: Context,
    private readonly service: ChatService,
    readonly id: string,
    readonly log: RunLog,
  ) {}

  summary(): ChatSummary {
    const created = this.log.events.find((e) => e.type === 'chat/created')!
    return {
      id: this.id,
      title: chatTitle(this.log.events),
      createdAt: created.ts,
      updatedAt: this.log.events.at(-1)!.ts,
      status: this.status,
      env: this.env(),
    }
  }

  events(afterSeq = 0): RunEvent[] {
    return this.log.events.filter((e) => e.seq > afterSeq)
  }

  /** Gửi tin nhắn của người dùng và chạy một lượt của agent. Trả về khi lượt kết thúc. */
  async send(text: string) {
    if (!text.trim()) throw new Error('message is empty')
    if (this.status !== 'idle') throw new Error('agent is still working on the previous message')
    const isFirstTurn = !this.agentSession
    const untitled = !this.log.events.some((e) => e.type === 'user/message')
    this.log.append('user/message', { text })
    if (untitled && chatTitle(this.log.events) === DEFAULT_TITLE) {
      this.log.append('chat/renamed', { title: text.replace(/\s+/g, ' ').trim().slice(0, 60) })
    }
    this.setStatus('running')
    this.controller = new AbortController()
    try {
      const session = await this.ensureAgentSession()
      const prompt = this.buildPrompt(text, isFirstTurn)
      this.log.append('agent/prompt', { text: prompt })
      this.log.append('turn/start', {})
      const result = await session.prompt(prompt, this.controller.signal)
      this.flush()
      this.log.append('turn/end', { stopReason: result.stopReason })
    } catch (error) {
      this.flush()
      this.log.append('turn/end', { stopReason: 'error', error: errorMessage(error) })
      // Process agent có thể đã thoát; bỏ session để lượt sau mở lại.
      await this.dropAgentSession()
      this.service.resetConnection()
    } finally {
      for (const pending of this.pending.values()) pending.resolve(false)
      this.pending.clear()
      this.controller = undefined
      this.setStatus('idle')
    }
  }

  cancel() {
    this.controller?.abort()
  }

  /** Người dùng trả lời một yêu cầu xin quyền dùng tool của agent. */
  decide(requestId: string, allowed: boolean) {
    const pending = this.pending.get(requestId)
    if (!pending) throw new Error(`no pending permission request: ${requestId}`)
    pending.resolve(allowed)
  }

  /** Người dùng sửa bản nháp trên giao diện; agent nhận nội dung mới ở lượt tiếp theo. */
  editDraft(content: string) {
    this.log.append('draft/edit', { content })
    this.notes.push(`Người dùng đã sửa bản nháp plan trên giao diện. Nội dung hiện tại:\n\`\`\`yaml\n${content}\n\`\`\``)
  }

  /** Danh sách plan có sẵn cho bộ chọn trên giao diện. Không ghi vào log: đây là thao tác duyệt, không phải hành động của cuộc chat. */
  async listPlans() {
    const session = await this.ensureAuthoring()
    const outcome = await this.ctx.actions.invoke({ ...session.scope, phase: 'user', log: () => {} }, 'list_plans', {})
    if (outcome.status !== 'ok') throw new Error(outcome.error)
    return (outcome.value as { plans: unknown[] }).plans
  }

  /**
   * Người dùng mở một plan có sẵn làm bản nháp để sửa hoặc chạy thử.
   * Log ghi `draft/open` kèm nội dung; Host kiểm tra plan ngay để bảng plan có danh sách case.
   * Agent nhận nội dung và đường dẫn ở lượt tiếp theo.
   */
  async openPlan(path: string) {
    if (this.status !== 'idle') throw new Error('agent is still working on the previous message')
    const session = await this.ensureAuthoring()
    const read = await this.ctx.actions.invoke({ ...session.scope, phase: 'user', log: () => {} }, 'read_plan', { path })
    if (read.status !== 'ok') throw new Error(read.error)
    const { content } = read.value as { content: string }
    this.log.append('draft/open', { path, content })
    // Tiêu đề theo plan đang mở, khi tiêu đề chưa do người dùng hay tin nhắn đầu tiên đặt.
    const renamed = this.log.events.findLast((e) => e.type === 'chat/renamed')
    const autoTitle = chatTitle(this.log.events) === DEFAULT_TITLE || (renamed?.data as { from?: string } | undefined)?.from === 'open'
    if (autoTitle && !this.log.events.some((e) => e.type === 'user/message')) {
      this.log.append('chat/renamed', { title: `Plan ${path}`, from: 'open' })
    }
    await this.ctx.actions.invoke({ ...session.scope, phase: 'user' }, 'validate_plan', { content })
    this.notes.push([
      `Người dùng đã mở plan có sẵn \`${path}\` làm bản nháp để sửa hoặc chạy thử. Nội dung hiện tại:`,
      '```yaml', content, '```',
      `Khi lưu thay đổi, gọi \`save_plan\` với \`overwrite: true\` nếu \`${path}\` nằm trong thư mục lưu plan; nếu không, lưu thành file mới và báo người dùng đường dẫn.`,
    ].join('\n'))
    return { path, content }
  }

  /** Người dùng bấm chạy một tool soạn plan trực tiếp (kiểm tra, chạy thử, lưu) mà không qua agent. */
  async invoke(tool: string, args: Record<string, unknown>) {
    if (!this.service.config.userTools.includes(tool)) throw new Error(`tool ${tool} cannot be invoked from the UI`)
    const session = await this.ensureAuthoring()
    const scope: ActionScope = { ...session.scope, phase: 'user' }
    const outcome = await this.ctx.actions.invoke(scope, tool, args)
    const summary = outcome.status === 'ok' ? JSON.stringify(outcome.value).slice(0, 1500) : outcome.error
    this.notes.push(`Người dùng đã tự chạy \`${tool}\` trên giao diện. Kết quả (${outcome.status}): ${summary}`)
    return outcome
  }

  async dispose() {
    this.cancel()
    await this.dropAgentSession()
    await this.authoring?.close()
    await this.log.close()
  }

  private async ensureAuthoring() {
    if (!this.authoring) {
      this.authoring = await this.ctx.authoring.createSession({
        log: this.log,
        confirm: (request) => this.ask({ requestId: randomUUID(), tool: request.tool, title: request.title, preview: request.preview }),
      })
      const env = this.env()
      if (env) {
        this.authoring.scope.env = env
        // Tool của môi trường phải được nạp trước khi agent khảo sát.
        await this.envs()?.ensure(env).catch(() => {})
      }
    }
    return this.authoring
  }

  /** Môi trường đã chọn: lần chọn gần nhất trong log. */
  env(): string | undefined {
    return (this.log.events.findLast((e) => e.type === 'chat/env')?.data as { env?: string } | undefined)?.env
  }

  private envs() {
    return this.ctx.get('envs') as { ensure(name: string): Promise<unknown> } | undefined
  }

  /** Đổi môi trường của cuộc chat: nạp tool của môi trường, ghi log, báo agent ở lượt tiếp theo. */
  async setEnv(env: string) {
    if (this.status !== 'idle') throw new Error('agent is still working on the previous message')
    const envs = this.envs()
    if (!envs) throw new Error('environments are not configured')
    await envs.ensure(env)
    this.log.append('chat/env', { env })
    if (this.authoring) this.authoring.scope.env = env
    this.notes.push(`Người dùng đã chọn môi trường \`${env}\`. Từ giờ \`explore\`, \`dry_run\` và tool theo môi trường dùng môi trường này.`)
    return this.summary()
  }

  /** Model đã chọn cho cuộc chat: lần chọn gần nhất trong log, nếu không có thì mặc định của service. */
  private preferredModel() {
    const chosen = this.log.events.findLast((e) => e.type === 'chat/model')
    return (chosen?.data as { modelId?: string } | undefined)?.modelId ?? this.service.config.model
  }

  /** Model hiện tại và danh sách model; mở session agent nếu chưa có, để lấy danh sách từ agent. */
  async models() {
    const session = await this.ensureAgentSession()
    return {
      current: session.models?.current ?? this.preferredModel(),
      available: session.models?.available ?? [],
      switchable: !!session.setModel,
      ...(session.models?.fallbackFrom ? { fallbackFrom: session.models.fallbackFrom } : {}),
    }
  }

  /** Đổi model cho các lượt sau của cuộc chat. Không đổi được khi agent đang làm việc. */
  async setModel(modelId: string) {
    if (this.status !== 'idle') throw new Error('cannot change the model while the agent is working')
    const session = await this.ensureAgentSession()
    if (!session.setModel) throw new Error('this agent does not support changing the model')
    await session.setModel(modelId)
    this.log.append('chat/model', { modelId })
    return this.models()
  }

  private opening?: Promise<AgentSession>

  /** Mở session agent một lần; các lời gọi đồng thời (đổi model, gửi tin nhắn) dùng chung một lần mở. */
  private ensureAgentSession(): Promise<AgentSession> {
    if (this.agentSession) return Promise.resolve(this.agentSession)
    this.opening ??= this.openAgentSession().finally(() => { this.opening = undefined })
    return this.opening
  }

  private async openAgentSession() {
    const authoring = await this.ensureAuthoring()
    const exposure = await this.ctx.gateway.expose(authoring.scope)
    this.closeExposure = () => exposure.close()
    const connection = await this.service.agentConnection()
    this.agentSession = await connection.newSession({
      cwd: this.service.config.cwd ?? process.cwd(),
      mcpServers: [exposure.endpoint],
      onUpdate: (update) => this.onUpdate(update),
      onPermission: (request) => this.onPermission(request),
      model: this.preferredModel(),
    })
    this.log.append('agent/session', { sessionId: this.agentSession.id, agent: connection.info.name, model: this.agentSession.models?.current })
    return this.agentSession
  }

  private async dropAgentSession() {
    await this.agentSession?.close().catch(() => {})
    await this.closeExposure?.().catch(() => {})
    this.agentSession = undefined
    this.closeExposure = undefined
  }

  /**
   * Lượt đầu của một session agent gửi kèm chỉ dẫn vai trò; nếu cuộc chat đã có lịch sử
   * (khôi phục sau khi Host khởi động lại), gửi kèm lịch sử để agent nối tiếp.
   */
  private buildPrompt(text: string, isFirstTurn: boolean) {
    const parts: string[] = []
    if (isFirstTurn) {
      parts.push(AGENT_PROMPT.trim())
      const history = this.transcript()
      if (history) parts.push(`## Lịch sử hội thoại trước đó\n\n${history}`)
    }
    if (this.notes.length) parts.push(`## Thao tác của người dùng trên giao diện\n\n${this.notes.splice(0).join('\n\n')}`)
    parts.push(isFirstTurn ? `## Tin nhắn của người dùng\n\n${text}` : text)
    return parts.join('\n\n')
  }

  /** Lịch sử tin nhắn trước tin nhắn mới nhất, cắt theo `historyChars` tính từ cuối. */
  private transcript() {
    const lines = this.log.events
      .filter((e) => e.type === 'user/message' || e.type === 'agent/message')
      .slice(0, -1)
      .map((e) => `${e.type === 'user/message' ? 'Người dùng' : 'Trợ lý'}: ${(e.data as { text: string }).text}`)
    let text = lines.join('\n\n')
    if (text.length > this.service.config.historyChars) text = '…' + text.slice(-this.service.config.historyChars)
    return text
  }

  private onUpdate(update: AgentUpdate) {
    if (update.kind === 'message' || update.kind === 'thought') {
      if (!update.text) return
      if (this.buffer && this.buffer.kind !== update.kind) this.flush()
      this.buffer ??= { kind: update.kind, text: '' }
      this.buffer.text += update.text
      this.live({ type: 'chunk', kind: update.kind, text: update.text })
      return
    }
    if (update.kind === 'tool_call' || update.kind === 'tool_update') {
      this.flush()
      const raw = update.raw as { toolCallId?: string; title?: string; status?: string }
      // Chỉ ghi trạng thái đầu và cuối, bỏ các cập nhật trung gian.
      if (update.kind === 'tool_update' && raw.status !== 'completed' && raw.status !== 'failed') return
      this.log.append('agent/tool', { toolCallId: raw.toolCallId, title: raw.title, status: raw.status ?? 'pending' })
    }
  }

  private flush() {
    if (!this.buffer) return
    this.log.append(this.buffer.kind === 'message' ? 'agent/message' : 'agent/thought', { text: this.buffer.text })
    this.buffer = undefined
  }

  /**
   * Tool chỉ đọc của phiên soạn plan được duyệt tự động. Tool khác (chạy thử, lưu plan, tool riêng
   * của agent như ghi file, chạy shell) cần người dùng duyệt trên giao diện.
   */
  private async onPermission(request: { title: string; raw: unknown }): Promise<boolean> {
    this.flush()
    const raw = request.raw as { rawInput?: unknown; toolCallId?: string }
    const tool = /@[\w-]+\/(\w+)/.exec(request.title)?.[1]
    const definition = tool ? this.ctx.actions.get(tool) : undefined
    const requestId = raw.toolCallId ?? randomUUID()
    // Tool tự xin duyệt (`selfConfirm`) hiện thẻ duyệt riêng kèm bản xem trước khi chạy, nên không hỏi ở đây.
    if ((definition?.readOnly || definition?.selfConfirm) && definition.scopes?.includes('authoring')) {
      this.log.append('permission/decision', { requestId, tool, title: request.title, allowed: true, by: 'policy' })
      return true
    }
    return this.ask({ requestId, tool, title: request.title, args: raw.rawInput })
  }

  /** Hiện thẻ duyệt và chờ người dùng quyết định. Ngoài lượt của agent thì từ chối ngay. */
  private async ask(request: { requestId: string; tool?: string; title: string; args?: unknown; preview?: unknown }): Promise<boolean> {
    if (!this.controller) return false
    this.log.append('permission/request', request)
    this.setStatus('waiting')
    const allowed = await new Promise<boolean>((resolve) => this.pending.set(request.requestId, { resolve }))
    this.pending.delete(request.requestId)
    this.log.append('permission/decision', { requestId: request.requestId, tool: request.tool, title: request.title, allowed, by: 'user' })
    if (this.controller) this.setStatus('running')
    return allowed
  }

  private setStatus(status: ChatStatus) {
    this.status = status
    this.live({ type: 'status', status })
  }

  private live(frame: LiveFrame) {
    this.ctx.emit('chat/live', this.id, frame)
  }
}
