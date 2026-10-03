import type {} from '@aitest/authoring'
import type { Context } from '@aitest/core'
import { OPEN_ITEM_KINDS, type OpenItem, type OpenItemKind, type OpenItemStatus } from './store.ts'
import type {} from './index.ts'

/**
 * Tool việc còn mở cho agent soạn plan (chỉ scope `authoring`): `open_item_add`, `open_item_resolve`, `open_item_list`.
 * Ghi và đóng việc không cần duyệt: chỉ ảnh hưởng tới danh sách nhắc việc, người dùng mở lại được trên giao diện.
 */
export const name = 'open-items-tools'
export const inject = ['actions', 'openItems']

export function apply(ctx: Context) {
  ctx.actions.register({
    name: 'open_item_add',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    selfConfirm: true,
    evidence: false,
    description: 'Ghi một việc chưa chốt (câu hỏi chờ người dùng, quyết định hoãn, vấn đề chưa xử lý, việc hứa làm sau) để được nhắc lại ở lượt sau và ở cuộc chat sau.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...OPEN_ITEM_KINDS] },
        title: { type: 'string', description: 'Một câu, đọc riêng vẫn hiểu, ví dụ "Case CAN-02 mong đợi mã 409 hay 400?".' },
        detail: { type: 'string', description: 'Bối cảnh cần để trả lời.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Các phương án đang cân nhắc.' },
        plan: { type: 'string', description: 'Đường dẫn hoặc mã plan liên quan.' },
        systems: { type: 'array', items: { type: 'string' }, description: 'Hệ thống liên quan trong catalog.' },
      },
      required: ['kind', 'title'],
      additionalProperties: false,
    },
    async execute(args: { kind: OpenItemKind; title: string; detail?: string; options?: string[]; plan?: string; systems?: string[] }, { scope }) {
      const item = await ctx.openItems.add(args, scope.id)
      return { id: item.id, item }
    },
    present: (args, outcome) => ({
      kind: 'open-item',
      title: outcome.status === 'ok' ? `Việc còn mở: ${args.title}` : 'Ghi việc còn mở lỗi',
      action: 'added',
      item: (outcome.value as { item?: OpenItem } | undefined)?.item,
    }),
  })

  ctx.actions.register({
    name: 'open_item_resolve',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    selfConfirm: true,
    evidence: false,
    description: 'Đóng một việc còn mở khi người dùng đã trả lời (`resolved`) hoặc không cần nữa (`dropped`), kèm kết luận.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Mã việc, dạng `oi-3`.' },
        resolution: { type: 'string', description: 'Kết luận: người dùng chọn gì, hoặc vì sao bỏ.' },
        status: { type: 'string', enum: ['resolved', 'dropped'], default: 'resolved' },
      },
      required: ['id', 'resolution'],
      additionalProperties: false,
    },
    async execute(args: { id: string; resolution: string; status?: 'resolved' | 'dropped' }, { scope }) {
      const item = await ctx.openItems.resolve(args.id, args.resolution, args.status ?? 'resolved', scope.id)
      return { id: item.id, status: item.status, item }
    },
    present: (args, outcome) => ({
      kind: 'open-item',
      title: outcome.status === 'ok' ? `Đã chốt: ${(outcome.value as { item?: OpenItem } | undefined)?.item?.title ?? args.id}` : `Đóng việc ${args.id} lỗi`,
      action: 'resolved',
      item: (outcome.value as { item?: OpenItem } | undefined)?.item,
    }),
  })

  ctx.actions.register({
    name: 'open_item_list',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Liệt kê việc còn mở (mặc định) hoặc đã đóng; lọc theo plan, hệ thống, hoặc chỉ cuộc chat này.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'resolved', 'dropped'], default: 'open' },
        plan: { type: 'string' },
        system: { type: 'string' },
        thisChat: { type: 'boolean', description: 'Chỉ việc của cuộc chat này.' },
      },
      additionalProperties: false,
    },
    async execute(args: { status?: OpenItemStatus; plan?: string; system?: string; thisChat?: boolean }, { scope }) {
      const items = await ctx.openItems.list({ status: args.status ?? 'open', plan: args.plan, system: args.system, chatId: args.thisChat ? scope.id : undefined })
      return { items: items.slice(0, 50), total: items.length }
    },
    present: (args, outcome) => ({ kind: 'generic', title: `Việc ${args.status === 'resolved' ? 'đã chốt' : args.status === 'dropped' ? 'đã bỏ' : 'còn mở'} (${(outcome.value as { total?: number } | undefined)?.total ?? 0})` }),
  })
}
