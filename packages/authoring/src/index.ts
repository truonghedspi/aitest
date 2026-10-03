import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  PlanError, Service, errorMessage, z,
  type ActionScope, type Context, type RunLog, type TestPlan,
} from '@aitest/core'

/**
 * Service soạn plan cùng agent (`ctx.authoring`).
 *
 * Service gồm ba điểm mở rộng:
 * - phiên soạn plan: scope loại `authoring`, có log append-only riêng;
 * - nguồn context: registry tài liệu về hệ thống đích (đặc tả, OpenAPI...);
 * - hướng dẫn cho agent: ghép từ các section do từng plugin đóng góp.
 * Kiểm tra plan đi qua event `authoring/lint` để plugin khác bổ sung quy tắc.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    authoring: AuthoringService
  }
  interface Events {
    /** Bổ sung lỗi/cảnh báo cho một plan đã parse thành công. Listener ghi vào `issues`. @mode parallel */
    'authoring/lint'(plan: TestPlan, issues: LintIssue[]): Promise<void>
    /**
     * Người dùng dừng lượt hiện tại của phiên soạn plan (nút Dừng của cuộc chat). Plugin dừng việc chạy nền của phiên,
     * ví dụ lượt chạy thử. Lời gọi tool đang chạy đã được huỷ qua `ctx.actions.cancel`. @mode emit
     */
    'authoring/stop'(sessionId: string): void
  }
}

/** Chỉ dẫn vai trò cho agent soạn plan; dùng chung cho Kiro profile và cuộc chat trên giao diện. */
export const AGENT_PROMPT = readFileSync(new URL('../agent-prompt.md', import.meta.url), 'utf8')

export interface ContextDoc {
  id: string
  title: string
  size?: number
  /** Một câu mô tả, để agent chọn tài liệu cần đọc mà không phải mở từng tài liệu. */
  description?: string
  /** Hệ thống liên quan trong catalog. */
  systems?: string[]
}

/** Một nguồn tài liệu về hệ thống đích. */
export interface ContextSource {
  id: string
  title: string
  description?: string
  list(): Promise<ContextDoc[]>
  read(docId: string): Promise<string>
}

export interface GuideSection {
  id: string
  order: number
  /** Nội dung của phần hướng dẫn; được phép bất đồng bộ (ví dụ đọc danh sách skill từ thư mục). */
  render(): string | undefined | Promise<string | undefined>
}

/** Một lượt của phiên agent soạn plan, truyền cho `turnSection`. */
export interface TurnContext {
  /** Mã phiên soạn plan (trùng mã cuộc chat). */
  sessionId: string
  /** Tin nhắn của người dùng ở lượt này. */
  text: string
  /** Lượt đầu của một phiên agent mới; khi đó `introSection` đã được gửi. */
  firstTurn: boolean
}

export interface TurnSection {
  id: string
  order: number
  render(turn: TurnContext): string | undefined | Promise<string | undefined>
}

export interface LintIssue {
  level: 'error' | 'warning'
  message: string
  /** Vị trí trong plan, ví dụ `cases[0].expect[1]`. */
  path?: string
}

export interface ValidationResult {
  valid: boolean
  issues: LintIssue[]
  plan?: TestPlan
}

export interface AuthoringScope extends ActionScope {
  kind: 'authoring'
}

export interface AuthoringSession {
  id: string
  scope: AuthoringScope
  log: RunLog
  close(): Promise<void>
}

export interface Config {
  dir: string
}

export class AuthoringService extends Service {
  static inject = ['actions', 'plans', 'runlog']
  static Config = z.object({
    dir: z.string().default('.aitest/authoring').description('Thư mục chứa log của các phiên soạn plan.'),
  })

  private readonly sources = new Map<string, ContextSource>()
  private readonly sections = new Map<string, GuideSection>()
  private readonly intros = new Map<string, GuideSection>()
  private readonly turns = new Map<string, TurnSection>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'authoring')
    registerCoreTools(ctx, this)
  }

  registerContextSource(source: ContextSource) {
    return this.ctx.effect(() => {
      if (this.sources.has(source.id)) throw new Error(`duplicate context source: ${source.id}`)
      this.sources.set(source.id, source)
      return () => { this.sources.delete(source.id) }
    }, `authoring.registerContextSource(${source.id})`)
  }

  contextSources() {
    return [...this.sources.values()]
  }

  /** Thêm một đoạn vào hướng dẫn cho agent. Plugin cung cấp tool nên mô tả cách dùng tool của mình tại đây. */
  guideSection(section: GuideSection) {
    return this.ctx.effect(() => {
      this.sections.set(section.id, section)
      return () => { this.sections.delete(section.id) }
    }, `authoring.guideSection(${section.id})`)
  }

  /**
   * Thêm một đoạn vào lượt đầu của mỗi phiên agent soạn plan (cuộc chat mới, hoặc phiên mở lại không khôi phục được),
   * ví dụ mục lục bộ nhớ. Khác `guideSection`: agent không phải gọi tool mới thấy.
   */
  introSection(section: GuideSection) {
    return this.ctx.effect(() => {
      this.intros.set(section.id, section)
      return () => { this.intros.delete(section.id) }
    }, `authoring.introSection(${section.id})`)
  }

  /**
   * Thêm một đoạn vào mỗi lượt của phiên agent, đặt trước tin nhắn của người dùng, ví dụ việc còn mở của cuộc chat
   * hoặc thay đổi của bộ nhớ từ lượt trước. `render` trả `undefined` khi lượt này không có gì cần báo.
   */
  turnSection(section: TurnSection) {
    return this.ctx.effect(() => {
      this.turns.set(section.id, section)
      return () => { this.turns.delete(section.id) }
    }, `authoring.turnSection(${section.id})`)
  }

  /** Ghi chú cho một lượt từ mọi `turnSection`, theo thứ tự `order`. */
  async turnNotes(turn: TurnContext): Promise<string[]> {
    const sections = [...this.turns.values()].sort((a, b) => a.order - b.order)
    const rendered = await Promise.all(sections.map(async (s) => (await s.render(turn))?.trim()))
    return rendered.filter((r): r is string => !!r)
  }

  /** Nội dung đầu phiên từ mọi `introSection`. */
  async intro() {
    const sections = [...this.intros.values()].sort((a, b) => a.order - b.order)
    const rendered = await Promise.all(sections.map(async (s) => (await s.render())?.trim()))
    return rendered.filter(Boolean).join('\n\n')
  }

  /** Hướng dẫn đầy đủ: các section của plugin cộng hướng dẫn của từng định dạng plan. */
  /**
   * Dấu vân tay của những gì agent soạn plan nhìn thấy: hướng dẫn và tool (tên, mô tả, schema) của scope `authoring`.
   * Chat ghi lại khi mở phiên agent; khôi phục phiên cũ mà dấu vân tay đã khác thì báo agent đọc lại hướng dẫn.
   */
  async fingerprint(): Promise<string> {
    const scope = { kind: 'authoring' as const, namespaces: new Set(['authoring']), phase: 'agent' as const }
    const tools = this.ctx.actions.list(scope)
      .map((a) => ({ name: a.name, description: a.description, inputSchema: a.inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return createHash('sha256').update(await this.guide()).update(JSON.stringify(tools)).digest('hex').slice(0, 16)
  }

  async guide() {
    const formats = this.ctx.plans.listFormats()
      .filter((f) => f.guide)
      .map((f) => ({ id: `format/${f.name}`, order: 20, render: () => f.guide }))
    const sections = [...this.sections.values(), ...formats].sort((a, b) => a.order - b.order)
    const rendered = await Promise.all(sections.map(async (s) => (await s.render())?.trim()))
    return rendered.filter(Boolean).join('\n\n')
  }


  /**
   * Mở một phiên soạn plan. Mọi lời gọi tool trong phiên được ghi vào log của phiên.
   * Truyền `log` để ghi chung vào log có sẵn, ví dụ log của một cuộc chat; khi đó `close()` không đóng log.
   * Truyền `confirm` khi phiên có người dùng trực tiếp để duyệt thao tác có tác động lâu dài.
   */
  async createSession(options: { id?: string; log?: RunLog; confirm?: ActionScope['confirm'] } = {}): Promise<AuthoringSession> {
    const id = options.id ?? options.log?.runId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    const ownsLog = !options.log
    const log = options.log ?? await this.ctx.runlog.create(id, this.config.dir)
    const controller = new AbortController()
    const scope: AuthoringScope = {
      kind: 'authoring',
      id,
      namespaces: new Set(['authoring']),
      phase: 'agent',
      signal: controller.signal,
      log: (type, data) => { log.append(type, data) },
      confirm: options.confirm,
    }
    return {
      id,
      scope,
      log,
      async close() {
        controller.abort()
        if (ownsLog) await log.close()
      },
    }
  }

  /**
   * Kiểm tra nội dung plan: parse theo định dạng (chọn theo đuôi của `source`), rồi chạy các quy tắc
   * đăng ký qua `authoring/lint`. Plan hợp lệ khi không có issue mức `error`.
   */
  async validate(content: string, source = 'draft.plan.yaml'): Promise<ValidationResult> {
    let plan: TestPlan
    try {
      plan = this.ctx.plans.parse(content, source)
    } catch (error) {
      const issues = error instanceof PlanError
        ? error.issues.map((message) => ({ level: 'error' as const, message }))
        : [{ level: 'error' as const, message: errorMessage(error) }]
      return { valid: false, issues }
    }
    const issues: LintIssue[] = []
    await this.ctx.parallel('authoring/lint', plan, issues)
    return { valid: !issues.some((i) => i.level === 'error'), issues, plan }
  }
}

export default AuthoringService

/** Tool dùng các điểm mở rộng của service: hướng dẫn và nguồn context. */
function registerCoreTools(ctx: Context, service: AuthoringService) {
  ctx.actions.register({
    name: 'get_authoring_guide',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Lấy hướng dẫn soạn test plan: định dạng, quy tắc, cách dùng các tool soạn plan. Gọi một lần ở đầu phiên.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { guide: await service.guide() }
    },
    present: () => ({ kind: 'generic', title: 'Đọc hướng dẫn soạn plan' }),
  })

  ctx.actions.register({
    name: 'list_context_sources',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Liệt kê tài liệu về hệ thống đích (đặc tả nghiệp vụ, API, dữ liệu) để đọc trước khi soạn plan.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const sources = service.contextSources()
      return {
        sources: await Promise.all(sources.map(async (s) => ({
          id: s.id, title: s.title, description: s.description, docs: await s.list(),
        }))),
      }
    },
    present: (_args, outcome) => ({
      kind: 'context-list',
      title: 'Liệt kê tài liệu hệ thống',
      sources: (outcome.value as { sources?: unknown[] } | undefined)?.sources ?? [],
    }),
  })

  ctx.actions.register({
    name: 'read_context_source',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Đọc một tài liệu từ `list_context_sources`, theo khoảng dòng. Tài liệu dài thì đọc tiếp bằng `nextOffset`.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        doc: { type: 'string' },
        offset: { type: 'integer', minimum: 1, default: 1, description: 'Dòng bắt đầu, đánh số từ 1.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 300 },
      },
      required: ['source', 'doc'],
      additionalProperties: false,
    },
    async execute(args: { source: string; doc: string; offset?: number; limit?: number }) {
      const source = service.contextSources().find((s) => s.id === args.source)
      if (!source) throw new Error(`unknown context source: ${args.source}`)
      const lines = (await source.read(args.doc)).split('\n')
      const offset = args.offset ?? 1
      const limit = args.limit ?? 300
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const next = offset - 1 + limit < lines.length ? offset + limit : undefined
      return { source: args.source, doc: args.doc, totalLines: lines.length, offset, nextOffset: next, content: slice.join('\n') }
    },
    present: (args) => ({ kind: 'generic', title: `Đọc tài liệu ${args.doc}` }),
  })

  service.guideSection({
    id: 'authoring/workflow',
    order: 0,
    render: () => [
      '# Hướng dẫn soạn test plan cho aitest',
      '',
      'aitest để một AI agent khác đọc plan, tự thực hiện các bước qua action, rồi đối chiếu kết quả với expectation.',
      'Kết luận pass/fail do nền tảng tính từ dữ liệu thật, không do agent tự đánh giá.',
      '',
      '## Quy trình',
      '1. Nắm ngữ cảnh trước khi hỏi: áp dụng bộ nhớ (mục lục ở đầu phiên); gọi `get_system_context` cho hệ thống liên quan',
      '   (API, dữ liệu thật, plan mẫu, skill, tài liệu trong một lần gọi); nếu yêu cầu khớp một skill, gọi `use_skill`.',
      '2. Chỉ hỏi người dùng điều ngữ cảnh chưa trả lời được: luồng chính, trường hợp biên, kết quả mong đợi.',
      '3. Đọc một plan mẫu dùng cùng operation (`read_plan`); đọc thêm tài liệu (`read_context_source`) hoặc khảo sát (`explore`) khi còn thiếu.',
      '4. Soạn bản nháp (plan mới: bắt đầu từ `new_plan_skeleton`), gọi `validate_plan` và sửa tới khi không còn lỗi.',
      '5. Trình bày bản nháp cho người dùng, giải thích từng case. Chỉnh theo góp ý.',
      '6. Chạy thử bằng `dry_run` rồi `get_run_result`; sửa bước hoặc expectation chưa rõ.',
      '7. Khi người dùng đồng ý, lưu bằng `save_plan`.',
      '',
      'Luôn gửi toàn bộ nội dung plan (không gửi phần thay đổi) khi gọi `validate_plan`, `dry_run`, `save_plan`.',
      'Mỗi lần gọi tool, điền `reason`: vì sao gọi và dùng kết quả để làm gì; người dùng xem lý do này trên giao diện.',
      'Trao đổi với người dùng bằng tiếng Việt.',
    ].join('\n'),
  })
}
