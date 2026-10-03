import type {} from '@aitest/runner'
import { errorMessage, fillTemplate, parseFrontmatter, z, type CaseScope, type Context, type TestPlan } from '@aitest/core'
import type {} from './index.ts'

/**
 * Tài liệu nghiệp vụ dùng chung mà plan tham chiếu bằng `contextRefs` (tầng tính năng của ngữ cảnh):
 * đọc từ thư mục ngữ cảnh lúc bắt đầu case, đưa vào prompt của agent chạy test, ghi `context/resolved` vào run log.
 * Kiểm tra khi soạn plan: tài liệu phải tồn tại trong thư mục ngữ cảnh và vừa giới hạn độ dài.
 */
export interface Config {
  maxDocChars: number
  maxTotalChars: number
}

export const name = 'context-run'
export const inject = ['library', 'prompt', 'authoring']

export const Config = z.object({
  maxDocChars: z.natural().default(8000).description('Độ dài tối đa của một tài liệu đưa vào prompt chạy test.'),
  maxTotalChars: z.natural().default(20000).description('Tổng độ dài tối đa của các tài liệu một plan tham chiếu.'),
})

export function apply(ctx: Context, config: Config) {
  const resolved = new WeakMap<CaseScope, Array<{ id: string; title: string; body: string }>>()

  ctx.on('case/start', async (scope) => {
    const refs = scope.plan.contextRefs ?? []
    if (!refs.length) return
    const docs: Array<{ id: string; title: string; body: string }> = []
    const missing: string[] = []
    const { docs: index } = await ctx.library.docs()
    for (const id of refs) {
      try {
        const { body } = parseFrontmatter(await ctx.library.readDoc(id))
        const title = index.find((d) => d.id === id)?.title ?? id
        docs.push({ id, title, body: body.trim().slice(0, config.maxDocChars) })
      } catch (error) {
        missing.push(`${id}: ${errorMessage(error)}`)
      }
    }
    resolved.set(scope, docs)
    scope.log('context/resolved', { refs: docs.map((d) => ({ id: d.id, chars: d.body.length })), ...(missing.length ? { missing } : {}) })
  })

  ctx.prompt.section({
    id: 'context/refs',
    order: 12,
    render: (scope) => {
      const docs = resolved.get(scope)
      if (!docs?.length) return undefined
      return [
        '## Tài liệu nghiệp vụ của plan',
        ...docs.map((d) => `### ${d.title} (\`${d.id}\`)\n\n${fillTemplate(d.body, scope.vars)}`),
      ].join('\n\n')
    },
  })

  ctx.on('authoring/lint', async (plan, issues) => {
    await lintRefs(ctx, config, plan, issues)
  })
}

async function lintRefs(ctx: Context, config: Config, plan: TestPlan, issues: Array<{ level: 'error' | 'warning'; message: string; path?: string }>) {
  const refs = plan.contextRefs ?? []
  if (!refs.length) return
  const { docs } = await ctx.library.docs()
  let total = 0
  refs.forEach((id, i) => {
    const doc = docs.find((d) => d.id === id)
    if (!doc) {
      issues.push({ level: 'error', path: `contextRefs[${i}]`, message: `contextRefs: ${id} is not a document in the context folders; documents: ${docs.map((d) => d.id).slice(0, 10).join(', ')}` })
      return
    }
    total += Math.min(doc.size, config.maxDocChars)
    if (doc.size > config.maxDocChars) {
      issues.push({ level: 'warning', path: `contextRefs[${i}]`, message: `contextRefs: ${id} has ${doc.size} characters; only the first ${config.maxDocChars} reach the test agent — split the document` })
    }
  })
  if (total > config.maxTotalChars) {
    issues.push({ level: 'warning', path: 'contextRefs', message: `contextRefs add about ${total} characters to every case prompt (limit ${config.maxTotalChars}); keep only documents the cases need` })
  }
}
