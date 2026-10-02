import { resolve } from 'node:path'
import type {} from '@aitest/authoring'
import type {} from '@aitest/web-host'
import { z, type Context } from '@aitest/core'
import { NOTE_TYPES, NoteStore, type Note, type NoteType } from './store.ts'

export { NoteStore, type Note, type NoteType } from './store.ts'

/**
 * Tri thức tích luỹ của nhóm: lỗi đã biết, quy ước, bài học. Lưu thành file Markdown trong `dir`.
 *
 * - Agent soạn plan: mọi quy ước tự vào hướng dẫn; tool `kb_list`, `kb_read` để tra; `kb_propose` để đề xuất
 *   ghi chú mới (cần người dùng duyệt vì là tool ghi).
 * - Lượt chạy: case không đạt khớp một `bug` đang mở được đánh dấu "lỗi đã biết"; case đạt khớp `bug` đang mở
 *   được đánh dấu "có thể đã sửa". Đánh dấu ghi vào run log bằng `case/annotation`.
 * - Agent chạy test không đọc tri thức, để lỗi đã biết không ảnh hưởng tới cách agent kiểm tra.
 */
export interface Config {
  dir: string
}

export const name = 'knowledge'
export const inject = ['actions']

export const Config = z.object({
  dir: z.string().default('kb').description('Thư mục chứa ghi chú, tương đối với thư mục làm việc.'),
})

const TYPE_LABEL: Record<NoteType, string> = { bug: 'Lỗi đã biết', convention: 'Quy ước', lesson: 'Bài học' }

export interface KnownIssue {
  id: string
  title: string
}

export async function apply(ctx: Context, config: Config) {
  const store = new NoteStore(resolve(config.dir))
  await store.load()
  const summary = (n: Note) => ({ id: n.id, type: n.type, title: n.title, status: n.status, feature: n.feature, cases: n.cases })

  ctx.actions.register({
    name: 'kb_list',
    namespace: 'knowledge',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Liệt kê ghi chú tri thức của nhóm (lỗi đã biết, quy ước, bài học), lọc theo loại, tính năng, trạng thái.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: NOTE_TYPES },
        feature: { type: 'string' },
        status: { type: 'string', enum: ['open', 'fixed'] },
      },
      additionalProperties: false,
    },
    async execute(args: { type?: NoteType; feature?: string; status?: string }) {
      const notes = (await store.load()).filter((n) => (!args.type || n.type === args.type)
        && (!args.feature || n.feature === args.feature) && (!args.status || n.status === args.status))
      return { notes: notes.map(summary) }
    },
    present: (_args, outcome) => ({
      kind: 'kb-list',
      title: `Tra tri thức (${(outcome.value as { notes?: unknown[] } | undefined)?.notes?.length ?? 0} ghi chú)`,
      notes: (outcome.value as { notes?: unknown[] } | undefined)?.notes ?? [],
    }),
  })

  ctx.actions.register({
    name: 'kb_read',
    namespace: 'knowledge',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: 'Đọc toàn văn một ghi chú tri thức theo `id`.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    async execute(args: { id: string }) {
      const note = await store.get(args.id)
      if (!note) throw new Error(`unknown note: ${args.id}`)
      return note
    },
    present: (args, outcome) => ({ kind: 'kb-note', title: `Đọc ghi chú ${args.id}`, note: outcome.value }),
  })

  ctx.actions.register({
    name: 'kb_propose',
    namespace: 'knowledge',
    scopes: ['authoring'],
    always: true,
    evidence: false,
    description: [
      'Đề xuất ghi một ghi chú tri thức mới, hoặc cập nhật ghi chú có sẵn cùng `id`. Người dùng duyệt trước khi ghi.',
      'Dùng khi phát hiện lỗi thật của hệ thống (`bug`, kèm `cases` dạng `<mã plan>/<mã case>`),',
      'khi người dùng nêu quy ước (`convention`), hoặc khi rút ra bài học khi soạn và chạy thử (`lesson`).',
      'Không ghi điều đã có trong tài liệu đặc tả.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Chữ thường, số, gạch ngang; ví dụ `order-odd-lot-accepted`.' },
        type: { type: 'string', enum: NOTE_TYPES },
        title: { type: 'string' },
        body: { type: 'string', description: 'Nội dung Markdown: hiện tượng, bằng chứng (mã lượt chạy, giá trị thực tế), cách xử lý.' },
        feature: { type: 'string' },
        cases: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['open', 'fixed'], description: 'Chỉ dùng cho `bug`.' },
      },
      required: ['id', 'type', 'title', 'body'],
      additionalProperties: false,
    },
    async execute(args: Partial<Note> & { id: string }, { scope }) {
      const { note, created } = await store.save({ ...args, source: `${scope.kind === 'authoring' ? 'chat' : scope.kind}:${scope.id}` })
      return { created, note: summary(note), path: note.path }
    },
    present: (args, outcome) => ({
      kind: 'kb-note',
      title: outcome.status === 'ok' ? `Đã ghi tri thức ${args.id}` : `Ghi tri thức ${args.id} thất bại`,
      note: args,
    }),
  })

  // Quy ước luôn vào hướng dẫn soạn plan, để agent áp dụng mà không cần tra.
  ctx.inject(['authoring'], (ctx) => {
    ctx.authoring.guideSection({
      id: 'knowledge',
      order: 80,
      render: () => {
        const notes = store.cached()
        const conventions = notes.filter((n) => n.type === 'convention')
        return [
          '## Tri thức của nhóm',
          '- Trước khi soạn plan cho một tính năng, gọi `kb_list` với `feature` để xem lỗi đã biết và bài học.',
          '- Khi chạy thử phát hiện lỗi thật của hệ thống, hoặc rút ra bài học, đề xuất ghi lại bằng `kb_propose`.',
          ...(conventions.length
            ? ['', '### Quy ước bắt buộc', ...conventions.map((n) => `- **${n.title}** (\`${n.id}\`): ${n.body.split('\n')[0]}`)]
            : []),
        ].join('\n')
      },
    })
  })

  // Đánh dấu case theo lỗi đã biết. Ghi vào run log để báo cáo dựng lại được từ log.
  ctx.on('case/end', async (scope, decision) => {
    const key = `${scope.plan.id}/${scope.case.id}`
    const open = (await store.load()).filter((n) => n.type === 'bug' && n.status !== 'fixed' && n.cases?.includes(key))
    if (!open.length) return
    const issues: KnownIssue[] = open.map((n) => ({ id: n.id, title: n.title }))
    const failed = decision.verdict === 'fail' || decision.verdict === 'error'
    scope.log('case/annotation', { key: failed ? 'knownIssues' : 'possiblyFixed', value: issues })
  })

  ctx.inject(['web'], (ctx) => {
    ctx.web.method('kb.list', async () => (await store.load()).map((n) => ({ ...summary(n), updated: n.updated, source: n.source })))
    ctx.web.method('kb.get', async (params: { id: string }) => {
      const note = await store.get(params.id)
      if (!note) throw new Error(`unknown note: ${params.id}`)
      return note
    })
    ctx.web.method('kb.save', async (params: Partial<Note> & { id: string }) => {
      const existing = await store.get(params.id)
      return (await store.save({ ...params, source: existing?.source ?? 'user' })).note
    })
    ctx.web.method('kb.remove', async (params: { id: string }) => {
      await store.remove(params.id)
      return { removed: true }
    })
    ctx.web.method('kb.types', () => NOTE_TYPES.map((type) => ({ type, label: TYPE_LABEL[type] })))
  })
}
