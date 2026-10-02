import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { z, type Context } from '@aitest/core'
import type {} from './index.ts'

/**
 * Tool `save_plan`: ghi plan đã hợp lệ vào thư mục plan.
 * Đường dẫn bị giới hạn trong `dir`; ghi đè file có sẵn phải khai báo `overwrite`.
 * Plugin thay thế có thể lưu sang nơi khác (nhánh Git, cơ sở dữ liệu) với cùng tên tool.
 */
export interface Config {
  dir: string
}

export const name = 'authoring-save'
export const inject = ['actions', 'authoring']

export const Config = z.object({
  dir: z.string().default('plans').description('Thư mục lưu plan, tương đối với thư mục làm việc.'),
})

export function apply(ctx: Context, config: Config) {
  const root = resolve(config.dir)

  ctx.actions.register({
    name: 'save_plan',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    evidence: false,
    description: [
      `Lưu plan vào thư mục \`${config.dir}\`. Plan phải hợp lệ; tên file kết thúc bằng \`.plan.yaml\`.`,
      'Chỉ gọi khi người dùng đã đồng ý với nội dung plan.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: `Đường dẫn tương đối trong \`${config.dir}\`, ví dụ \`order/cancel.plan.yaml\`.` },
        content: { type: 'string', description: 'Toàn bộ nội dung plan.' },
        overwrite: { type: 'boolean', default: false },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute(args: { path: string; content: string; overwrite?: boolean }) {
      const file = resolve(root, args.path)
      if (relative(root, file).startsWith('..') || !/\.plan\.ya?ml$/.test(file)) {
        throw new Error(`path must be a *.plan.yaml file inside ${config.dir}`)
      }
      const result = await ctx.authoring.validate(args.content, file)
      if (!result.valid) {
        throw new Error(`plan is invalid: ${result.issues.filter((i) => i.level === 'error').map((i) => i.message).join('; ')}`)
      }
      const exists = await stat(file).then(() => true, () => false)
      if (exists && !args.overwrite) throw new Error(`file exists: ${relative(process.cwd(), file)}; set overwrite to replace it`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, args.content.endsWith('\n') ? args.content : args.content + '\n')
      return { path: relative(process.cwd(), file), overwritten: exists, planId: result.plan!.id }
    },
    present: (args, outcome) => ({
      kind: 'plan-saved',
      title: outcome.status === 'ok' ? `Đã lưu ${(outcome.value as { path: string }).path}` : `Lưu ${args.path} thất bại`,
      path: (outcome.value as { path?: string } | undefined)?.path,
    }),
  })

  ctx.authoring.guideSection({
    id: 'authoring/save',
    order: 70,
    render: () => `## Lưu plan\n- Chỉ gọi \`save_plan\` khi người dùng đã đồng ý. Đặt tên file theo tính năng, ví dụ \`order/cancel.plan.yaml\`.`,
  })
}
