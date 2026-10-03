import type {} from '@aitest/authoring'
import type { Context } from '@aitest/core'
import type {} from './index.ts'

/**
 * Tool cho agent soạn plan: nạp skill theo ba tầng (progressive disclosure).
 * Tầng 1 (tên, mô tả) đã có trong hướng dẫn; `use_skill` nạp tầng 2 (thân SKILL.md); `read_skill_file` đọc tầng 3.
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
}
