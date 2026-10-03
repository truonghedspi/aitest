import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import type {} from '@aitest/authoring'
import { isInside, lineDiff, toPosix, type Context } from '@aitest/core'
import type {} from './index.ts'

/**
 * Tool cho agent soạn plan:
 * - nạp skill theo ba tầng (progressive disclosure): tầng 1 (tên, mô tả) có trong hướng dẫn; `use_skill` nạp tầng 2
 *   (thân SKILL.md); `read_skill_file` đọc tầng 3;
 * - `propose_context_doc`: đề xuất tạo hoặc thay tài liệu nghiệp vụ dùng chung trong thư mục ngữ cảnh (người dùng duyệt kèm diff).
 */
export const name = 'context-tools'
export const inject = ['actions', 'library']

export function apply(ctx: Context) {
  ctx.actions.register({
    name: 'use_skill',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: [
      'Nạp hướng dẫn đầy đủ của một skill (danh sách skill và mô tả có trong hướng dẫn soạn plan).',
      'Gọi khi yêu cầu của người dùng khớp mô tả của skill, trước khi soạn. Kết quả kèm danh sách file của skill.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Tên skill.' } },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(args: { name: string }) {
      const { skill, body } = await ctx.library.skillBody(args.name)
      return { name: skill.name, description: skill.description, instructions: body, files: skill.files }
    },
    present: (args) => ({ kind: 'generic', title: `Nạp skill ${args.name}` }),
  })

  ctx.actions.register({
    name: 'read_skill_file',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Đọc một file kèm theo skill (plan mẫu, bảng tra cứu, ví dụ), theo đường dẫn trong `files` của `use_skill`.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tên skill.' },
        path: { type: 'string', description: 'Đường dẫn file trong skill, ví dụ `examples/cancel.plan.yaml`.' },
      },
      required: ['name', 'path'],
      additionalProperties: false,
    },
    async execute(args: { name: string; path: string }) {
      return { name: args.name, path: args.path, content: await ctx.library.skillFile(args.name, args.path) }
    },
    present: (args, outcome) => ({
      kind: 'code',
      title: `Đọc ${args.name}/${args.path}`,
      language: /\.ya?ml$/.test(args.path) ? 'yaml' : undefined,
      text: (outcome.value as { content?: string } | undefined)?.content,
    }),
  })

  ctx.actions.register({
    name: 'propose_context_doc',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    selfConfirm: true,
    evidence: false,
    description: [
      'Đề xuất tạo hoặc thay một tài liệu nghiệp vụ dùng chung (quy trình, thuật ngữ, luồng dữ liệu) trong thư mục ngữ cảnh,',
      'để nhiều plan tham chiếu bằng `contextRefs` thay vì chép vào `context`. Quy tắc ngắn về một hệ thống dùng `propose_system_knowledge`.',
      'Người dùng duyệt kèm diff.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Đường dẫn trong thư mục ngữ cảnh, đuôi `.md`, ví dụ `order/cancel-flow.md`.' },
        title: { type: 'string' },
        description: { type: 'string', description: 'Một dòng: tài liệu nói gì, khi nào dùng.' },
        systems: { type: 'array', items: { type: 'string' }, description: 'Hệ thống liên quan trong catalog.' },
        content: { type: 'string', description: 'Nội dung Markdown, không gồm frontmatter.' },
        replace: { type: 'boolean', description: 'Thay tài liệu đã có cùng đường dẫn.' },
        reason: { type: 'string', description: 'Nguồn của nội dung và vì sao cần dùng chung.' },
      },
      required: ['path', 'title', 'description', 'content', 'reason'],
      additionalProperties: false,
    },
    async execute(args: { path: string; title: string; description: string; systems?: string[]; content: string; replace?: boolean; reason: string }, { scope }) {
      const root = resolve(ctx.library.config.dirs[0] ?? 'context')
      const file = resolve(root, args.path.replace(/^context\//, ''))
      if (!isInside(root, file) || !file.endsWith('.md')) throw new Error(`path must be a .md file inside ${toPosix(relative(process.cwd(), root))}`)
      const before = await readFile(file, 'utf8').catch(() => undefined)
      if (before !== undefined && !args.replace) throw new Error(`${args.path} exists; read it with read_context_source and set replace to update it`)
      const meta = { title: args.title.trim(), description: args.description.replace(/\s+/g, ' ').trim(), ...(args.systems?.length ? { systems: args.systems } : {}) }
      const after = `---\n${stringifyYaml(meta).trim()}\n---\n\n${args.content.trim()}\n`
      if (after === before) throw new Error('nothing to change')
      const id = toPosix(relative(process.cwd(), file))
      if (!scope.confirm) throw new Error('writing a context document needs a user to approve it; use the chat interface')
      const approved = await scope.confirm({
        tool: 'propose_context_doc',
        title: `${before === undefined ? 'Tạo' : 'Cập nhật'} tài liệu ngữ cảnh ${id}`,
        preview: { kind: 'context-change', target: id, summary: args.title, reason: args.reason, diff: lineDiff(before ?? '', after) },
      })
      if (!approved) return { saved: false, reason: 'the user declined' }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, after)
      await rename(`${file}.tmp`, file)
      return { saved: true, id, created: before === undefined, hint: `reference it in plans with contextRefs: [${id}]` }
    },
    present: (args, outcome) => {
      const value = outcome.value as { saved?: boolean; id?: string; created?: boolean } | undefined
      return {
        kind: 'context-change',
        title: outcome.status !== 'ok' ? 'Đề xuất tài liệu ngữ cảnh lỗi'
          : value?.saved ? `${value.created ? 'Đã tạo' : 'Đã cập nhật'} tài liệu ${value.id}` : `Không ghi tài liệu ${args.path}`,
        target: value?.id ?? args.path, summary: args.title, saved: !!value?.saved, reason: args.reason,
      }
    },
  })
}
