import type {} from '@aitest/authoring'
import type { Context } from '@aitest/core'
import { MEMORY_TYPES, type MemoryScope, type MemoryType } from './store.ts'
import type {} from './index.ts'

/**
 * Tool bộ nhớ cho agent soạn plan (chỉ scope `authoring`, agent chạy test không thấy):
 * `memory_search`, `memory_read`, `memory_save`, `memory_delete`.
 * Ghi bộ nhớ nhóm hoặc khi tắt `autoSave` cần người dùng duyệt qua `scope.confirm`.
 */
export const name = 'memory-tools'
export const inject = ['actions', 'memory']

export function apply(ctx: Context) {
  ctx.actions.register({
    name: 'memory_search',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Tìm trong bộ nhớ giữa các phiên theo từ khoá (tên, mô tả, nội dung). Dùng trước khi ghi ký ức mới để tránh trùng.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Từ khoá; bỏ trống để liệt kê mới nhất.' },
        type: { type: 'string', enum: [...MEMORY_TYPES] },
      },
      additionalProperties: false,
    },
    async execute(args: { query?: string; type?: MemoryType }) {
      return { memories: await ctx.memory.search(args.query, args.type) }
    },
    present: (args, outcome) => ({
      kind: 'generic',
      title: `Tìm bộ nhớ${args.query ? ` "${args.query}"` : ''} (${(outcome.value as { memories?: unknown[] } | undefined)?.memories?.length ?? 0})`,
    }),
  })

  ctx.actions.register({
    name: 'memory_read',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Đọc nội dung một ký ức theo tên (trong mục lục đầu phiên hoặc kết quả `memory_search`). Kết quả có `version` để cập nhật.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    async execute(args: { name: string }) {
      const memory = await ctx.memory.find(args.name)
      if (!memory) throw new Error(`unknown memory ${args.name}; search with memory_search`)
      return memory
    },
    present: (args) => ({ kind: 'generic', title: `Đọc ký ức ${args.name}` }),
  })

  ctx.actions.register({
    name: 'memory_save',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    selfConfirm: true,
    evidence: false,
    description: [
      'Ghi hoặc cập nhật một ký ức bền vững để dùng ở các phiên sau (xem mục "Bộ nhớ giữa các phiên" trong hướng dẫn).',
      'Cùng `name` là cập nhật: đọc trước bằng `memory_read` rồi gửi `expectedVersion`. Không ghi bí mật.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tên dạng kebab-case, ví dụ `order-status-names`.' },
        description: { type: 'string', description: 'Một dòng: ký ức nói về gì, khi nào cần đọc.' },
        type: { type: 'string', enum: [...MEMORY_TYPES] },
        body: { type: 'string', description: 'Nội dung; feedback và project ghi thêm **Vì sao:** và **Áp dụng khi:**. Liên kết bằng [[tên]].' },
        scope: { type: 'string', enum: ['personal', 'team'], default: 'personal' },
        expectedVersion: { type: 'integer', description: 'Version đã đọc, khi cập nhật ký ức có sẵn.' },
        allowSimilar: { type: 'boolean', description: 'Đặt khi chắc chắn là sự thật khác với ký ức gần giống.' },
      },
      required: ['name', 'description', 'type', 'body'],
      additionalProperties: false,
    },
    async execute(args: {
      name: string; description: string; type: MemoryType; body: string; scope?: MemoryScope; expectedVersion?: number; allowSimilar?: boolean
    }, { scope }) {
      const target = args.scope ?? 'personal'
      const existing = await ctx.memory.store(target).get(args.name)
      // Bộ nhớ nhóm, hoặc khi tắt tự ghi: người dùng duyệt kèm nội dung sẽ ghi.
      if (target === 'team' || !ctx.memory.config.autoSave) {
        if (!scope.confirm) throw new Error('saving this memory needs a user to approve it; use the chat interface')
        const approved = await scope.confirm({
          tool: 'memory_save',
          title: `${existing ? 'Cập nhật' : 'Ghi'} ký ức ${target === 'team' ? 'nhóm' : 'cá nhân'} ${args.name}`,
          preview: { kind: 'memory', name: args.name, type: args.type, scope: target, description: args.description, body: args.body, previous: existing?.body },
        })
        if (!approved) return { saved: false, reason: 'the user declined' }
      }
      const result = await ctx.memory.save({ ...args, scope: target, source: scope.id })
      return {
        saved: true, created: result.created, name: result.memory.name, scope: result.memory.scope, version: result.memory.version,
        ...(result.memory.version > 1 ? { previousVersion: result.memory.version - 1 } : {}),
      }
    },
    present: (args, outcome) => {
      const value = outcome.value as { saved?: boolean; created?: boolean; version?: number; scope?: string } | undefined
      return {
        kind: 'memory-saved',
        title: outcome.status !== 'ok' ? `Ghi ký ức ${args.name} lỗi`
          : value?.saved === false ? `Không ghi ký ức ${args.name}` : `${value?.created ? 'Đã ghi' : 'Đã cập nhật'} ký ức ${args.name}`,
        name: args.name, type: args.type, scope: value?.scope ?? args.scope ?? 'personal', description: args.description, body: args.body,
        saved: value?.saved ?? false, created: value?.created ?? false, version: value?.version,
      }
    },
  })

  ctx.actions.register({
    name: 'memory_delete',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    selfConfirm: true,
    evidence: false,
    description: 'Xoá một ký ức sai hoặc lỗi thời (khôi phục được trên giao diện). Người dùng nói "quên…" thì xoá ký ức tương ứng.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, reason: { type: 'string', description: 'Vì sao xoá.' } },
      required: ['name', 'reason'],
      additionalProperties: false,
    },
    async execute(args: { name: string; reason: string }, { scope }) {
      const memory = await ctx.memory.find(args.name)
      if (!memory) throw new Error(`unknown memory ${args.name}`)
      if (memory.scope === 'team' || !ctx.memory.config.autoSave) {
        if (!scope.confirm) throw new Error('deleting this memory needs a user to approve it; use the chat interface')
        const approved = await scope.confirm({
          tool: 'memory_delete', title: `Xoá ký ức ${memory.scope === 'team' ? 'nhóm' : 'cá nhân'} ${memory.name}`,
          preview: { kind: 'memory', name: memory.name, type: memory.type, scope: memory.scope, description: memory.description, body: memory.body, deleting: true, reason: args.reason },
        })
        if (!approved) return { deleted: false, reason: 'the user declined' }
      }
      await ctx.memory.remove(memory.name, memory.scope, scope.id)
      return { deleted: true, name: memory.name, scope: memory.scope, version: memory.version }
    },
    present: (args, outcome) => {
      const value = outcome.value as { deleted?: boolean; scope?: string; version?: number } | undefined
      return {
        kind: 'memory-saved',
        title: outcome.status !== 'ok' ? `Xoá ký ức ${args.name} lỗi` : value?.deleted ? `Đã xoá ký ức ${args.name}` : `Không xoá ký ức ${args.name}`,
        name: args.name, scope: value?.scope, deleted: !!value?.deleted, version: value?.version, reason: args.reason,
      }
    },
  })
}
