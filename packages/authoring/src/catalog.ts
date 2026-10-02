import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { z, type Context } from '@aitest/core'
import type {} from './index.ts'

/**
 * Tool đọc thông tin của nền tảng: action có sẵn và các plan đã có.
 * Plugin chỉ đọc, không có trạng thái riêng.
 */
export interface Config {
  planDirs: string[]
}

export const name = 'authoring-catalog'
export const inject = ['actions', 'plans', 'authoring']

export const Config = z.object({
  planDirs: z.array(z.string()).default(['plans']).description('Các thư mục chứa plan, tương đối với thư mục làm việc.'),
})

export function apply(ctx: Context, config: Config) {
  ctx.actions.register({
    name: 'list_actions',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: [
      'Liệt kê các action mà agent chạy test được dùng, kèm namespace và input schema.',
      'Namespace dùng cho trường `requires` của plan; action có `alwaysAvailable` không cần khai báo.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: { namespace: { type: 'string', description: 'Chỉ liệt kê action của namespace này.' } },
      additionalProperties: false,
    },
    async execute(args: { namespace?: string }) {
      const actions = ctx.actions.list({ kind: 'case', namespaces: new Set(), phase: 'setup' })
        .filter((a) => !args.namespace || a.namespace === args.namespace)
        .map((a) => ({
          name: a.name,
          namespace: a.namespace,
          description: a.description,
          readOnly: a.readOnly ?? false,
          alwaysAvailable: a.always ?? false,
          inputSchema: a.inputSchema,
        }))
      const namespaces = [...new Set(actions.map((a) => a.namespace))]
      return { namespaces, actions }
    },
    present: (_args, outcome) => {
      const value = outcome.value as { actions?: Array<{ name: string; namespace: string }> } | undefined
      return {
        kind: 'action-list',
        title: `Liệt kê action (${value?.actions?.length ?? 0})`,
        actions: value?.actions?.map((a) => ({ name: a.name, namespace: a.namespace })) ?? [],
      }
    },
  })

  ctx.actions.register({
    name: 'list_plans',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Liệt kê các plan đã có: đường dẫn, mã plan, tên, danh sách case. Dùng làm mẫu và tránh trùng mã.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const plans = []
      for (const dir of config.planDirs) {
        for (const file of await planFiles(resolve(dir))) {
          const path = relative(process.cwd(), file)
          try {
            const plan = await ctx.plans.load(file)
            plans.push({ path, id: plan.id, name: plan.name, cases: plan.cases.map((c) => ({ id: c.id, title: c.title })) })
          } catch (error) {
            plans.push({ path, error: (error as Error).message.split('\n')[0] })
          }
        }
      }
      return { plans }
    },
    present: (_args, outcome) => ({
      kind: 'plan-list',
      title: 'Liệt kê plan có sẵn',
      plans: (outcome.value as { plans?: unknown[] } | undefined)?.plans ?? [],
    }),
  })

  ctx.actions.register({
    name: 'read_plan',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Đọc nguyên văn một plan theo đường dẫn từ `list_plans`.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(args: { path: string }) {
      const file = resolve(args.path)
      const allowed = config.planDirs.some((dir) => !relative(resolve(dir), file).startsWith('..'))
      if (!allowed) throw new Error(`path is outside plan directories: ${args.path}`)
      return { path: args.path, content: await readFile(file, 'utf8') }
    },
    present: (args, outcome) => ({
      kind: 'code',
      title: `Đọc plan ${args.path}`,
      language: 'yaml',
      text: (outcome.value as { content?: string } | undefined)?.content,
    }),
  })

  ctx.authoring.guideSection({
    id: 'authoring/catalog',
    order: 30,
    render: () => [
      '## Action và plan có sẵn',
      '- `list_actions`: biết plan được dùng action nào; chỉ khai báo trong `requires` các namespace có thật.',
      '- `list_plans`, `read_plan`: đọc plan có sẵn để theo cùng phong cách và không trùng `id`.',
    ].join('\n'),
  })
}

async function planFiles(dir: string): Promise<string[]> {
  try {
    if (!(await stat(dir)).isDirectory()) return []
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await planFiles(full))
    else if (/\.plan\.ya?ml$/.test(entry.name)) out.push(full)
  }
  return out.sort()
}
