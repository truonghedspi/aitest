import { resolve } from 'node:path'
import type {} from '@aitest/authoring'
import { parseFrontmatter, Service, z, type ActionScope, type Context } from '@aitest/core'
import { findSecret, MEMORY_TYPES, MemoryStore, NAME, similarity, TYPE_DESC, type Memory, type MemoryScope, type MemoryType } from './store.ts'

export * from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/**
 * Bộ nhớ giữa các phiên của agent soạn plan, theo mô hình bộ nhớ của Claude Code.
 *
 * - **Hai phạm vi.** `personal` (`.aitest/memory/<user>/`, không vào git): người dùng là ai, họ đã sửa agent thế nào.
 *   `team` (`memory/`, vào git, xem lại qua pull request): sự thật về dự án, nơi tra cứu, dùng chung cả nhóm.
 * - **Nhớ lại.** Mục lục (tên, loại, mô tả một dòng) được đưa vào đầu mỗi phiên agent mới; nội dung đọc khi cần
 *   (`memory_read`). Phiên đang chạy được báo khi phiên khác vừa sửa bộ nhớ.
 * - **Ghi.** Agent tự ghi ký ức cá nhân (hiện thẻ trong cuộc chat, hoàn tác được); ghi vào bộ nhớ nhóm cần người dùng duyệt.
 *   Không lưu bí mật; ký ức gần trùng phải cập nhật bản có sẵn thay vì tạo mới; mỗi lần sửa giữ bản cũ để hoàn tác.
 * - **Không dùng khi chạy test.** Tool bộ nhớ chỉ có scope `authoring`, để kết quả lượt chạy không phụ thuộc người chạy.
 * Khác `kb/`: kb là tri thức kiểm thử đã duyệt (lỗi đã biết, quy ước, bài học); bộ nhớ là ngữ cảnh làm việc với người dùng.
 */
export interface Config {
  dir: string
  teamDir: string
  user: string
  indexMaxChars: number
  autoSave: boolean
}

export class MemoryService extends Service {
  static inject = ['authoring']
  static Config = z.object({
    dir: z.string().default('.aitest/memory').description('Thư mục bộ nhớ cá nhân; mỗi người dùng một thư mục con. Không đưa vào git.'),
    teamDir: z.string().default('memory').description('Thư mục bộ nhớ nhóm, đưa vào git.'),
    user: z.string().default('default').description('Người dùng của bộ nhớ cá nhân; giao diện chưa đăng nhập thì dùng `default`.'),
    indexMaxChars: z.natural().default(6000).description('Độ dài tối đa của mục lục đưa vào đầu phiên agent.'),
    autoSave: z.boolean().default(true).description('Agent tự ghi ký ức cá nhân không cần duyệt (vẫn hiện thẻ, hoàn tác được).'),
  })

  readonly personal: MemoryStore
  readonly team: MemoryStore
  /** Tăng mỗi khi bộ nhớ đổi, để phiên agent đang chạy biết cần đọc lại. */
  revision = 0
  /** Revision bộ nhớ mà từng phiên agent đã biết. */
  private readonly seen = new Map<string, number>()
  private readonly changes: Array<{ revision: number; action: 'saved' | 'deleted'; name: string; scope: MemoryScope; description?: string; source?: string }> = []

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'memory')
    if (!/^[\w.-]+$/.test(config.user)) throw new Error(`invalid memory user ${config.user}`)
    this.personal = new MemoryStore(resolve(config.dir, config.user), 'personal')
    this.team = new MemoryStore(resolve(config.teamDir), 'team')

    // Mục lục vào đầu mỗi phiên agent soạn plan mới.
    ctx.authoring.introSection({ id: 'memory/index', order: 5, render: () => this.index() })
    ctx.authoring.guideSection({ id: 'memory/guide', order: 8, render: () => GUIDE })
    // Mỗi lượt: báo bộ nhớ vừa đổi (phiên khác ghi, người dùng sửa trên giao diện) và nhắc ghi nhớ khi tin nhắn yêu cầu.
    ctx.authoring.turnSection({ id: 'memory/changes', order: 10, render: (turn) => this.changeNote(turn.sessionId, turn.firstTurn) })
    ctx.authoring.turnSection({ id: 'memory/hint', order: 90, render: (turn) => this.hint(turn.text) })
  }

  store(scope: MemoryScope) {
    return scope === 'team' ? this.team : this.personal
  }

  async list(scope?: MemoryScope): Promise<Memory[]> {
    const lists = await Promise.all((scope ? [scope] : ['personal', 'team'] as const).map((s) => this.store(s).list()))
    return lists.flat()
  }

  /** Tìm ký ức theo tên ở cả hai phạm vi; cá nhân trước. */
  async find(name: string): Promise<Memory | undefined> {
    return (await this.personal.get(name)) ?? (await this.team.get(name))
  }

  /** Mục lục cho đầu phiên: ký ức `user`, `feedback` luôn có; loại khác mới nhất trước, trong giới hạn độ dài. */
  async index(): Promise<string> {
    const all = await this.list()
    if (!all.length) return `## Bộ nhớ từ các phiên trước\nChưa có ký ức nào. ${SAVE_RULE}`
    const line = (m: Memory) => `- \`${m.name}\` [${m.type}${m.scope === 'team' ? ', nhóm' : ''}] ${m.description}`
    const pinned = all.filter((m) => m.type === 'user' || m.type === 'feedback')
    const rest = all.filter((m) => m.type !== 'user' && m.type !== 'feedback')
    const lines: string[] = []
    let size = 0
    let omitted = 0
    for (const m of [...pinned, ...rest]) {
      const l = line(m)
      if (size + l.length > this.config.indexMaxChars && !pinned.includes(m)) { omitted++; continue }
      lines.push(l)
      size += l.length
    }
    return [
      '## Bộ nhớ từ các phiên trước',
      'Ngữ cảnh đã biết về người dùng và dự án. Đọc nội dung bằng `memory_read` khi một mục liên quan tới việc đang làm; áp dụng `feedback` ngay.',
      SAVE_RULE,
      ...lines,
      ...(omitted ? [`(còn ${omitted} ký ức khác; tìm bằng \`memory_search\`)`] : []),
    ].join('\n')
  }

  /**
   * Lời nhắc cho một tin nhắn có yêu cầu ghi nhớ ("nhớ là…", "lần sau…", "quên…").
   * Agent hay bỏ qua quy tắc chung khi đang tập trung soạn plan; lời nhắc gắn vào đúng lượt đó.
   */
  hint(text: string): string | undefined {
    if (REMEMBER.test(text)) return '## Nhắc về bộ nhớ\n\nTin nhắn này có thể chứa yêu cầu ghi nhớ. Nếu người dùng muốn bạn nhớ một điều cho các lần sau, gọi `memory_search` rồi `memory_save` (hoặc cập nhật ký ức gần giống) ngay trong lượt này, trước khi làm việc khác. Nếu không, bỏ qua lời nhắc này.'
    if (FORGET.test(text)) return '## Nhắc về bộ nhớ\n\nTin nhắn này có thể yêu cầu quên một điều. Nếu đúng, tìm ký ức tương ứng bằng `memory_search` rồi xoá bằng `memory_delete` (hoặc sửa nếu chỉ một phần sai).'
    return undefined
  }

  /** Thay đổi bộ nhớ từ lượt trước của phiên; lượt đầu đã có mục lục nên chỉ ghi nhận revision. */
  changeNote(sessionId: string, firstTurn: boolean): string | undefined {
    const known = this.seen.get(sessionId)
    this.seen.set(sessionId, this.revision)
    if (firstTurn || known === undefined) return undefined
    // Thay đổi do chính phiên này ghi thì agent đã biết.
    const changes = this.changesSince(known).filter((c) => c.source !== sessionId)
    if (!changes.length) return undefined
    return `## Bộ nhớ vừa thay đổi\n\n${changes.map((c) => `- ${c.action === 'deleted' ? 'Đã xoá' : 'Đã ghi'} \`${c.name}\` (${c.scope})${c.description ? `: ${c.description}` : ''}`).join('\n')}`
  }

  /** Thay đổi sau một revision, để báo cho phiên agent đang chạy. */
  changesSince(revision: number) {
    return this.changes.filter((c) => c.revision > revision)
  }

  /** Kiểm tra và ghi một ký ức. `expectedVersion` chặn ghi đè thay đổi của phiên khác. */
  async save(input: {
    name: string; description: string; type: MemoryType; body: string; scope?: MemoryScope
    expectedVersion?: number; source?: string; allowSimilar?: boolean
  }): Promise<{ memory: Memory; created: boolean; similar: Memory[] }> {
    const scope = input.scope ?? 'personal'
    if (!NAME.test(input.name)) throw new Error('name must be kebab-case: lowercase letters, digits, hyphens (2-64 chars)')
    if (!MEMORY_TYPES.includes(input.type)) throw new Error(`type must be one of ${MEMORY_TYPES.join(', ')}`)
    const description = input.description.replace(/\s+/g, ' ').trim()
    if (!description || description.length > 200) throw new Error('description must be one line of 1-200 characters')
    const body = input.body.trim()
    if (!body) throw new Error('body is required')
    if (body.length > 4000) throw new Error('body must be at most 4000 characters; keep one fact per memory')
    const secret = findSecret(`${description}\n${body}`)
    if (secret) throw new Error(`memory looks like it contains a secret (${secret}); never store secrets — refer to them by environment variable name`)

    const store = this.store(scope)
    const existing = await store.get(input.name)
    const other = await this.store(scope === 'team' ? 'personal' : 'team').get(input.name)
    if (!existing && other) throw new Error(`memory ${input.name} already exists in ${other.scope} memory; update it there or choose another name`)
    if (existing && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw new Error(`memory ${input.name} changed (version ${existing.version}, expected ${input.expectedVersion}); read it again and merge`)
    }
    const similar = existing ? [] : (await this.list()).filter((m) => m.name !== input.name && similarity(m, { name: input.name, description }) >= 0.6)
    if (similar.length && !input.allowSimilar) {
      throw new Error(`similar memories exist: ${similar.map((m) => `${m.name} (${m.description})`).join('; ')}; update one of them instead, or set allowSimilar if this is a different fact`)
    }
    const now = new Date().toISOString()
    if (!existing) await store.purgeHistory(input.name)
    await store.put({
      name: input.name, description, type: input.type, body,
      version: (existing?.version ?? 0) + 1, created: existing?.created || now, updated: now, source: input.source,
    })
    const memory = (await store.get(input.name))!
    this.changes.push({ revision: ++this.revision, action: 'saved', name: memory.name, scope, description, source: input.source })
    return { memory, created: !existing, similar }
  }

  async remove(name: string, scope?: MemoryScope, source?: string): Promise<Memory> {
    const memory = scope ? await this.store(scope).get(name) : await this.find(name)
    if (!memory) throw new Error(`unknown memory ${name}`)
    await this.store(memory.scope).remove(name)
    this.changes.push({ revision: ++this.revision, action: 'deleted', name, scope: memory.scope, source })
    return memory
  }

  /** Khôi phục một bản trong lịch sử (hoàn tác sửa hoặc xoá). */
  async restore(name: string, scope: MemoryScope, version: number): Promise<Memory> {
    const store = this.store(scope)
    const entry = (await store.history(name)).find((h) => h.version === version)
    if (!entry) throw new Error(`memory ${name} has no version ${version}`)
    const { meta, body } = parseFrontmatter(entry.text)
    const current = await store.get(name)
    await store.put({
      name, description: String(meta.description ?? ''), type: (meta.type as MemoryType) ?? 'project', body,
      version: (current?.version ?? Number(meta.version ?? version)) + 1, created: String(meta.created ?? new Date().toISOString()),
      updated: new Date().toISOString(), source: meta.source ? String(meta.source) : undefined,
    })
    const memory = (await store.get(name))!
    this.changes.push({ revision: ++this.revision, action: 'saved', name, scope, description: memory.description })
    return memory
  }

  /** Tìm theo từ khoá trong tên, mô tả, nội dung; xếp theo số từ khớp. */
  async search(query = '', type?: MemoryType, limit = 20) {
    const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1)
    const scored = (await this.list())
      .filter((m) => !type || m.type === type)
      .map((m) => {
        const text = `${m.name} ${m.description} ${m.body}`.toLowerCase()
        return { m, score: terms.length ? terms.filter((t) => text.includes(t)).length : 1 }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.updated.localeCompare(a.m.updated))
      .slice(0, limit)
    return scored.map(({ m }) => ({ name: m.name, type: m.type, scope: m.scope, description: m.description, updated: m.updated, snippet: m.body.slice(0, 200) }))
  }

  /** Rà soát bộ nhớ: ký ức gần trùng, liên kết `[[tên]]` tới ký ức không tồn tại, ký ức lâu không cập nhật. */
  async review() {
    const all = await this.list()
    const names = new Set(all.map((m) => m.name))
    const duplicates: Array<[string, string]> = []
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) if (similarity(all[i], all[j]) >= 0.6) duplicates.push([all[i].name, all[j].name])
    }
    const brokenLinks = all.flatMap((m) => m.links.filter((l) => !names.has(l)).map((l) => ({ name: m.name, link: l })))
    const stale = all.filter((m) => m.updated && Date.now() - Date.parse(m.updated) > 180 * 86_400_000).map((m) => m.name)
    return { duplicates, brokenLinks, stale }
  }

  /** Scope hiện tại có người duyệt không (cuộc chat); dùng để quyết định ghi bộ nhớ nhóm. */
  canConfirm(scope: ActionScope) {
    return typeof scope.confirm === 'function'
  }
}

export default MemoryService

const SAVE_RULE = 'Khi người dùng nói "nhớ…", "lần sau…", "từ nay…" hoặc sửa cách bạn làm, gọi `memory_save` ngay trong lượt đó.'
const REMEMBER = /(^|[^\p{L}])(nhớ|ghi nhớ|lần sau|từ nay|từ giờ|remember)([^\p{L}]|$)/iu
const FORGET = /(^|[^\p{L}])(quên|forget)([^\p{L}]|$)/iu

const GUIDE = [
  '## Bộ nhớ giữa các phiên',
  'Bộ nhớ giữ ngữ cảnh về người dùng và dự án qua các cuộc chat. Mục lục có ở đầu phiên; đọc nội dung bằng `memory_read`.',
  '',
  'Ghi bằng `memory_save` khi biết một điều **bền vững** sẽ có ích ở phiên sau:',
  ...MEMORY_TYPES.map((t) => `- \`${t}\`: ${TYPE_DESC[t]}.`),
  '',
  '- Người dùng nói "nhớ…", "lần sau…", hoặc sửa cách bạn làm (ví dụ "đừng dùng dbadmin trong requires", "tên trạng thái là FILLED") → ghi `feedback` ngay, kèm dòng **Vì sao:** và **Áp dụng khi:**.',
  '- Mỗi ký ức một sự thật; `description` một dòng đủ để biết lúc nào cần đọc. Liên kết ký ức liên quan bằng `[[tên]]`.',
  '- Trước khi tạo mới, tìm bằng `memory_search`; có ký ức gần giống thì cập nhật ký ức đó (đọc trước, gửi `expectedVersion`).',
  '- Không ghi: bí mật (chỉ ghi tên biến môi trường), điều chỉ đúng trong cuộc chat này, điều đã có trong plan, kb hay tài liệu.',
  '- Ký ức sai hoặc lỗi thời: sửa hoặc xoá (`memory_delete`). Ký ức có thể đã cũ: kiểm tra lại tên file, tên tool trước khi dựa vào.',
  '- `scope: team` (dùng chung cả nhóm, cần người dùng duyệt) cho sự thật về dự án mà cả nhóm cần; mặc định `personal`.',
].join('\n')
