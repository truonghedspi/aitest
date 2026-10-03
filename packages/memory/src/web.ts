import type {} from '@aitest/web-host'
import { relative } from 'node:path'
import { toPosix, type Context } from '@aitest/core'
import type { MemoryScope, MemoryType } from './store.ts'
import type {} from './index.ts'

/** Method cho trang Bộ nhớ và thẻ ký ức trong cuộc chat: xem, sửa, xoá, lịch sử, khôi phục, rà soát. */
export const name = 'memory-web'
export const inject = ['memory', 'web']

export function apply(ctx: Context) {
  ctx.web.method('memory.list', async () => ({
    memories: await ctx.memory.list(),
    user: ctx.memory.config.user,
    dirs: { personal: toPosix(relative(process.cwd(), ctx.memory.personal.dir)), team: toPosix(relative(process.cwd(), ctx.memory.team.dir)) },
    review: await ctx.memory.review(),
  }))

  ctx.web.method('memory.get', async (params: { name: string; scope: MemoryScope }) => {
    const memory = await ctx.memory.store(params.scope).get(params.name)
    if (!memory) throw new Error(`unknown memory ${params.name}`)
    return { memory, history: (await ctx.memory.store(params.scope).history(params.name)).map((h) => ({ version: h.version, deleted: h.deleted })) }
  })

  ctx.web.method('memory.save', async (params: {
    name: string; description: string; type: MemoryType; body: string; scope: MemoryScope; expectedVersion?: number
  }) => (await ctx.memory.save({ ...params, source: 'ui', allowSimilar: true })).memory)

  ctx.web.method('memory.delete', async (params: { name: string; scope: MemoryScope }) => {
    await ctx.memory.remove(params.name, params.scope)
    return { deleted: true }
  })

  /** Hoàn tác: khôi phục một bản trong lịch sử (kể cả bản đã xoá). */
  ctx.web.method('memory.restore', (params: { name: string; scope: MemoryScope; version: number }) => ctx.memory.restore(params.name, params.scope, params.version))
}
