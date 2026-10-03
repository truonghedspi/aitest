/**
 * Kiểm thử thư viện ngữ cảnh: mục lục thư mục ngữ cảnh (frontmatter, mô tả tự suy, OpenAPI), tài liệu `always`
 * trong hướng dẫn, skill theo ba tầng (tên và mô tả, thân, file kèm), skill lỗi, chặn đường dẫn ra ngoài.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootFromFile, toPosix, type Kernel } from '@aitest/core'
import type { AuthoringSession } from '@aitest/authoring'

const root = join(import.meta.dirname, '../../..')

describe('context library', () => {
  let dir: string
  let kernel: Kernel
  let session: AuthoringSession
  const rel = (p: string) => toPosix(relative(process.cwd(), join(dir, p)))
  const call = (name: string, args: Record<string, unknown> = {}) => kernel.ctx.actions.invoke(session.scope, name, args)

  beforeAll(async () => {
    dir = await mkdtemp(join(process.cwd(), '.aitest-ctx-'))
    await mkdir(join(dir, 'ctx/order'), { recursive: true })
    await writeFile(join(dir, 'ctx/order/rules.md'), '---\ntitle: Quy tắc lệnh\nsystems: [order-service]\n---\n\n# Bỏ qua\n\nNội dung.\n')
    await writeFile(join(dir, 'ctx/notes.md'), '# Ghi chú vận hành\n\nMôi trường staging reset dữ liệu lúc 2 giờ sáng mỗi ngày.\n\nĐoạn hai.\n')
    await writeFile(join(dir, 'ctx/always.md'), '---\ninclusion: always\ntitle: Luật chung\n---\nLuôn đối chiếu DB.\n')
    await writeFile(join(dir, 'ctx/api.yaml'), 'openapi: 3.0.3\ninfo: { title: Payment API, description: Thanh toán }\npaths: {}\n')
    await writeFile(join(dir, 'ctx/image.png'), 'not text')
    await mkdir(join(dir, 'sk/cancel-order/examples'), { recursive: true })
    await writeFile(join(dir, 'sk/cancel-order/SKILL.md'), '---\nname: cancel-order\ndescription: Soạn case huỷ lệnh.\nmetadata:\n  systems: order-service\n---\n\n# Huỷ lệnh\n\nBước 1.\n')
    await writeFile(join(dir, 'sk/cancel-order/examples/a.plan.yaml'), 'id: X\n')
    await mkdir(join(dir, 'sk/bad-skill'), { recursive: true })
    await writeFile(join(dir, 'sk/bad-skill/SKILL.md'), '---\nname: Bad_Skill\ndescription: x\n---\n')
    kernel = await bootFromFile(join(root, 'aitest.yml'), [
      { id: 'logger', name: 'aitest:noop', disabled: true },
      { id: 'context', name: '@aitest/context', config: { dirs: [join(dir, 'ctx')], skillDirs: [join(dir, 'sk')] } },
      { id: 'memory', name: '@aitest/memory', config: { dir: join(dir, 'mem'), teamDir: join(dir, 'team') } },
    ], { patchFile: false })
    session = await kernel.ctx.authoring.createSession()
  }, 60_000)

  afterAll(async () => {
    await session?.close()
    await kernel?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('indexes context documents with titles, descriptions and systems, skipping non-text files', async () => {
    const { docs } = await kernel.ctx.library.docs()
    expect(docs.map((d) => [d.id, d.title, d.description, d.systems, d.inclusion])).toEqual([
      [rel('ctx/always.md'), 'Luật chung', 'Luôn đối chiếu DB.', [], 'always'],
      [rel('ctx/api.yaml'), 'Payment API', 'OpenAPI 3.0.3: Thanh toán', [], 'auto'],
      [rel('ctx/notes.md'), 'Ghi chú vận hành', 'Môi trường staging reset dữ liệu lúc 2 giờ sáng mỗi ngày.', [], 'auto'],
      [rel('ctx/order/rules.md'), 'Quy tắc lệnh', 'Nội dung.', ['order-service'], 'auto'],
    ])
    const listed = await call('list_context_sources')
    const source = (listed.value as { sources: Array<{ id: string; docs: Array<{ id: string; description?: string }> }> }).sources.find((s) => s.id === 'context')!
    expect(source.docs.find((d) => d.id === rel('ctx/notes.md'))!.description).toContain('reset dữ liệu')
    const read = await call('read_context_source', { source: 'context', doc: rel('ctx/order/rules.md') })
    expect((read.value as { content: string }).content).toContain('Nội dung.')
    const outside = await call('read_context_source', { source: 'context', doc: 'package.json' })
    expect(outside.error).toMatch(/not in the context folders/)
  })

  it('lists skills in the guide and loads them in three tiers', async () => {
    const guide = (await call('get_authoring_guide')).value as { guide: string }
    expect(guide.guide).toContain('- `cancel-order`: Soạn case huỷ lệnh.')
    expect(guide.guide).toContain('## Ngữ cảnh luôn áp dụng')
    expect(guide.guide).toContain('Luôn đối chiếu DB.')
    expect(guide.guide).not.toContain('Bước 1.')

    const used = await call('use_skill', { name: 'cancel-order' })
    expect(used.value).toMatchObject({ name: 'cancel-order', instructions: '# Huỷ lệnh\n\nBước 1.', files: ['examples/a.plan.yaml'] })
    const file = await call('read_skill_file', { name: 'cancel-order', path: 'examples/a.plan.yaml' })
    expect((file.value as { content: string }).content).toBe('id: X\n')
    expect((await call('read_skill_file', { name: 'cancel-order', path: '../../ctx/notes.md' })).error).toMatch(/outside skill/)
    expect((await call('use_skill', { name: 'nope' })).error).toMatch(/unknown skill nope; available: cancel-order/)

    const { issues } = await kernel.ctx.library.skills()
    expect(issues).toEqual([{ path: `${rel('sk/bad-skill')}/SKILL.md`, error: expect.stringMatching(/name must be lowercase/) }])
    expect((await kernel.ctx.library.relatedTo('order-service')).skills.map((s) => s.name)).toEqual(['cancel-order'])
  })
})
