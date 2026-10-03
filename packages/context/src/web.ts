import { resolve } from 'node:path'
import type {} from '@aitest/web-host'
import { isInside, z, type Context, type Kernel } from '@aitest/core'
import type {} from './index.ts'

/**
 * Trang Ngữ cảnh trên giao diện: xem tài liệu và skill agent dùng khi soạn plan, thêm hoặc bỏ thư mục.
 * Đổi thư mục là đổi cấu hình row thư viện qua kernel (ghi patch layer), thư viện được nạp lại.
 */
export interface Config {
  row: string
}

export const name = 'context-web'
export const inject = ['library', 'web', 'kernel']

export const Config = z.object({
  row: z.string().default('context').description('Mã row của thư viện ngữ cảnh (`@aitest/context`).'),
})

export function apply(ctx: Context, config: Config) {
  const kernel = ctx.get('kernel') as Kernel

  ctx.web.method('library.list', async () => {
    const [docs, skills] = await Promise.all([ctx.library.docs(), ctx.library.skills()])
    return {
      dirs: ctx.library.config.dirs,
      skillDirs: ctx.library.config.skillDirs,
      docs: docs.docs,
      skills: skills.skills,
      issues: [...docs.issues, ...skills.issues],
    }
  })

  ctx.web.method('library.read', async (params: { doc?: string; skill?: string; path?: string }) => {
    if (params.doc) return { content: await ctx.library.readDoc(params.doc) }
    if (params.skill && params.path) return { content: await ctx.library.skillFile(params.skill, params.path) }
    if (params.skill) return { content: (await ctx.library.skillBody(params.skill)).body }
    throw new Error('specify doc or skill')
  })

  /** Thêm hoặc bỏ một thư mục ngữ cảnh hoặc thư mục skill; thư mục phải nằm trong thư mục làm việc. */
  ctx.web.method('library.setDirs', async (params: { kind: 'context' | 'skills'; dirs: string[] }) => {
    const dirs = [...new Set(params.dirs.map((d) => d.trim()).filter(Boolean))]
    for (const dir of dirs) {
      if (!isInside(process.cwd(), resolve(dir))) throw new Error(`folder ${dir} is outside the working directory`)
    }
    const state = kernel.rows.get(config.row)
    if (!state) throw new Error(`row ${config.row} not found`)
    const current = (state.row.config ?? {}) as Record<string, unknown>
    await kernel.configure(config.row, { ...current, [params.kind === 'skills' ? 'skillDirs' : 'dirs']: dirs })
    return { ok: true }
  })
}
