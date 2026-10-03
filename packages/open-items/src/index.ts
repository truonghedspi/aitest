import { resolve } from 'node:path'
import type { TurnContext } from '@aitest/authoring'
import { Service, z, type Context } from '@aitest/core'
import { KIND_DESC, OPEN_ITEM_KINDS, OpenItemStore, type OpenItem, type OpenItemKind, type OpenItemStatus } from './store.ts'

export * from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    openItems: OpenItemService
  }
}

/**
 * Việc còn mở của agent soạn plan: câu hỏi chờ người dùng, quyết định bị hoãn, vấn đề chưa xử lý, việc hứa làm sau.
 *
 * Bộ nhớ (`@aitest/memory`) giữ sự thật bền vững; việc còn mở giữ những gì **chưa chốt** và phải được đóng.
 * Agent ghi và đóng việc bằng tool; Host nhắc lại một cách xác định, không dựa vào việc agent tự nhớ:
 * - Đầu mỗi phiên agent mới: danh sách việc còn mở gần nhất của mọi cuộc chat (`introSection`).
 * - Mỗi lượt sau đó: việc còn mở của chính cuộc chat, và việc vừa được đóng ở nơi khác (`turnSection`).
 * Không dùng khi chạy test: tool chỉ có scope `authoring`.
 */
export interface Config {
  file: string
  introMax: number
  staleDays: number
}

export const KIND_LABEL: Record<OpenItemKind, string> = { question: 'câu hỏi', decision: 'quyết định', issue: 'vấn đề', todo: 'việc cần làm' }

export class OpenItemService extends Service {
  static inject = ['authoring']
  static Config = z.object({
    file: z.string().default('.aitest/open-items.json').description('File lưu việc còn mở; không đưa vào git.'),
    introMax: z.natural().default(10).description('Số việc còn mở tối đa đưa vào đầu phiên agent mới.'),
    staleDays: z.natural().default(30).description('Việc mở lâu hơn số ngày này không đưa vào đầu phiên (vẫn hiện trên giao diện).'),
  })

  readonly store: OpenItemStore
  /** Việc còn mở đã báo cho từng phiên ở lượt trước, để phát hiện việc bị đóng ở nơi khác. */
  private readonly shown = new Map<string, Set<string>>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'openItems')
    this.store = new OpenItemStore(resolve(config.file))
    ctx.authoring.introSection({ id: 'open-items/recent', order: 6, render: () => this.intro() })
    ctx.authoring.turnSection({ id: 'open-items/chat', order: 20, render: (turn) => this.turnNote(turn) })
    ctx.authoring.guideSection({ id: 'open-items/guide', order: 9, render: () => GUIDE })
  }

  async list(filter: { status?: OpenItemStatus; chatId?: string; plan?: string; system?: string } = {}): Promise<OpenItem[]> {
    return (await this.store.list())
      .filter((i) => (!filter.status || i.status === filter.status)
        && (!filter.chatId || i.chatId === filter.chatId)
        && (!filter.plan || i.plan === filter.plan)
        && (!filter.system || (i.systems ?? []).includes(filter.system)))
      .sort((a, b) => b.updated.localeCompare(a.updated))
  }

  async add(input: { kind: OpenItemKind; title: string; detail?: string; options?: string[]; plan?: string; systems?: string[] }, chatId: string): Promise<OpenItem> {
    if (!OPEN_ITEM_KINDS.includes(input.kind)) throw new Error(`kind must be one of ${OPEN_ITEM_KINDS.join(', ')}`)
    const title = input.title.replace(/\s+/g, ' ').trim()
    if (!title || title.length > 200) throw new Error('title must be one line of 1-200 characters')
    if (input.detail && input.detail.length > 2000) throw new Error('detail must be at most 2000 characters')
    const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean)
    if (options.length > 6 || options.some((o) => o.length > 200)) throw new Error('options: at most 6, each at most 200 characters')
    return this.store.update((items) => {
      const duplicate = items.find((i) => i.status === 'open' && i.chatId === chatId && i.title.toLowerCase() === title.toLowerCase())
      if (duplicate) throw new Error(`open item ${duplicate.id} already has this title; update it by resolving and adding again, or reuse it`)
      const next = items.reduce((max, i) => Math.max(max, Number(i.id.slice(3)) || 0), 0) + 1
      const now = new Date().toISOString()
      const item: OpenItem = {
        id: `oi-${next}`, kind: input.kind, title, status: 'open', chatId, created: now, updated: now,
        ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
        ...(options.length ? { options } : {}),
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.systems?.length ? { systems: input.systems } : {}),
      }
      items.push(item)
      return item
    })
  }

  /** Đóng việc: `resolved` khi đã chốt, `dropped` khi người dùng không cần nữa. `by` là mã cuộc chat hoặc `ui`. */
  async resolve(id: string, resolution: string, status: 'resolved' | 'dropped' = 'resolved', by = 'ui'): Promise<OpenItem> {
    const text = resolution.trim()
    if (!text) throw new Error('resolution is required: what was decided, or why the item is dropped')
    return this.store.update((items) => {
      const item = items.find((i) => i.id === id)
      if (!item) throw new Error(`unknown open item ${id}`)
      if (item.status !== 'open') throw new Error(`open item ${id} is already ${item.status}: ${item.resolution ?? ''}`)
      Object.assign(item, { status, resolution: text.slice(0, 2000), updated: new Date().toISOString(), closedBy: by })
      return { ...item }
    })
  }

  /** Mở lại việc đã đóng nhầm (từ giao diện). */
  async reopen(id: string): Promise<OpenItem> {
    return this.store.update((items) => {
      const item = items.find((i) => i.id === id)
      if (!item) throw new Error(`unknown open item ${id}`)
      item.status = 'open'
      item.updated = new Date().toISOString()
      delete item.resolution
      delete item.closedBy
      return { ...item }
    })
  }

  /** Đầu phiên mới: việc còn mở gần nhất của mọi cuộc chat, để agent hỏi lại khi yêu cầu mới liên quan. */
  async intro(): Promise<string | undefined> {
    const cutoff = Date.now() - this.config.staleDays * 86_400_000
    const open = (await this.list({ status: 'open' })).filter((i) => Date.parse(i.updated) >= cutoff)
    if (!open.length) return undefined
    const shown = open.slice(0, this.config.introMax)
    return [
      '## Việc còn mở từ các cuộc chat trước',
      'Những điều chưa chốt. Khi yêu cầu của người dùng liên quan tới một việc dưới đây, nhắc lại và hỏi người dùng trước khi làm tiếp;',
      'khi người dùng trả lời hoặc nói không cần nữa, đóng việc bằng `open_item_resolve`.',
      ...shown.map((i) => line(i, true)),
      ...(open.length > shown.length ? [`(còn ${open.length - shown.length} việc khác; xem bằng \`open_item_list\`)`] : []),
    ].join('\n')
  }

  /** Mỗi lượt: việc còn mở của cuộc chat này và việc vừa được đóng ở nơi khác (giao diện, cuộc chat khác). */
  async turnNote(turn: TurnContext): Promise<string | undefined> {
    const items = await this.list({ chatId: turn.sessionId })
    const open = items.filter((i) => i.status === 'open')
    const previously = this.shown.get(turn.sessionId) ?? new Set<string>()
    this.shown.set(turn.sessionId, new Set(open.map((i) => i.id)))
    // Lượt đầu của phiên mới đã có danh sách trong phần đầu phiên.
    if (turn.firstTurn) return undefined
    const closedElsewhere = items.filter((i) => i.status !== 'open' && previously.has(i.id) && i.closedBy !== turn.sessionId)
    if (!open.length && !closedElsewhere.length) return undefined
    const parts = ['## Việc còn mở của cuộc chat này']
    if (open.length) {
      parts.push(...open.map((i) => line(i, false)))
      parts.push('Tin nhắn dưới đây trả lời hoặc bỏ một việc thì đóng việc đó bằng `open_item_resolve` kèm kết luận.')
    }
    if (closedElsewhere.length) {
      parts.push('Đã đóng ngoài lượt trước của bạn:', ...closedElsewhere.map((i) =>
        `- \`${i.id}\` ${i.title} → ${i.status === 'dropped' ? 'bỏ' : 'đã chốt'} ${i.closedBy === 'ui' ? 'trên giao diện' : 'ở cuộc chat khác'}: ${i.resolution ?? ''}`))
    }
    return parts.join('\n')
  }
}

function line(i: OpenItem, withOrigin: boolean) {
  const options = i.options?.length ? ` (phương án: ${i.options.join(' | ')})` : ''
  const where = [i.plan && `plan ${i.plan}`, withOrigin && `ngày ${i.updated.slice(0, 10)}`].filter(Boolean).join(', ')
  return `- \`${i.id}\` [${KIND_LABEL[i.kind]}] ${i.title}${options}${where ? ` — ${where}` : ''}`
}

export default OpenItemService

const GUIDE = [
  '## Việc còn mở',
  'Ghi lại điều **chưa chốt** bằng `open_item_add`, để cuộc chat sau (và lượt sau, kể cả khi phiên của bạn bị khởi động lại) không bỏ sót:',
  ...OPEN_ITEM_KINDS.map((k) => `- \`${k}\`: ${KIND_DESC[k]}.`),
  '',
  '- Ghi khi bạn hỏi người dùng một điều cần biết để hoàn thành plan, khi người dùng nói "để sau", "chưa chốt", khi chạy thử phát hiện vấn đề chưa xử lý, hoặc khi bạn hứa làm sau.',
  '- `title` là một câu hỏi hoặc việc cụ thể, đọc riêng vẫn hiểu; có phương án thì ghi vào `options`. Gắn `plan` (đường dẫn hoặc mã plan) và `systems` khi biết.',
  '- Không ghi câu hỏi đã được trả lời ngay trong cùng lượt, hoặc điều đã có trong bộ nhớ.',
  '- Người dùng trả lời hoặc bỏ việc thì đóng ngay bằng `open_item_resolve` kèm kết luận; điều bền vững rút ra từ câu trả lời thì ghi thêm vào bộ nhớ.',
  '- Đầu cuộc chat mới có danh sách việc còn mở: yêu cầu mới liên quan thì nhắc lại, ví dụ "Lần trước case CAN-02 chưa chốt mã lỗi 409 hay 400, bạn chọn gì?".',
].join('\n')
