/**
 * Kiểm thử ngữ cảnh dùng chung ba tầng: tri thức dữ liệu và quy tắc trong catalog vào prompt chạy test,
 * tài liệu tham chiếu bằng `contextRefs`, cảnh báo `context` chép lại catalog, và hai tool đề xuất ghi ngữ cảnh
 * (`propose_system_knowledge` giữ comment của service.yml, `propose_context_doc`) qua thẻ duyệt.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toPosix, type ConfirmRequest } from '@aitest/core'
import type { AuthoringSession } from '@aitest/authoring'
import { loadSystem } from '@aitest/system-catalog'
import { promptVars, setupHarness, type Harness } from '../../runner/tests/support.ts'

const PORT = 4180

const SERVICE = `# Comment phải được giữ khi agent đề xuất sửa.
id: shop
title: Shop API
http:
  operations:
    listOrders: { method: GET, path: /orders, summary: Liệt kê lệnh }
data:
  - namespace: db
    description: DB của shop
    tables:
      - name: orders
        desc: Lệnh đặt
        columns:
          id:
            type: integer
            desc: Mã lệnh, trùng id của API
          status:
            type: text
            values:
              NEW: vừa nhận, chưa khớp
              CANCELLED: đã huỷ
      - payments
rules:
  - Chỉ lệnh NEW được huỷ
`

describe('shared context for planning and test runs', () => {
  let harness: Harness
  let session: AuthoringSession
  let rel: (p: string) => string
  const requests: ConfirmRequest[] = []
  let answer = true
  const prompts: string[] = []

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      scripts: {
        async 'KN-01'(call, prompt) {
          prompts.push(prompt)
          const res = await call('http_request', { method: 'GET', url: `${promptVars(prompt)['shop.url'] ?? ''}/orders` })
          await call('assert_expectation', { expectId: 'e1', evidenceId: res.evidenceId, path: '$.status' })
        },
      },
      rows: (dir) => [
        { id: 'system-catalog', name: '@aitest/system-catalog', config: { dirs: [join(dir, 'systems')], envDir: join(dir, 'envs') } },
        { id: 'context', name: '@aitest/context', config: { dirs: [join(dir, 'ctx')], skillDirs: [join(dir, 'skills')] } },
      ],
    })
    rel = (p: string) => toPosix(relative(process.cwd(), join(harness.dir, p)))
    await mkdir(join(harness.dir, 'systems/shop'), { recursive: true })
    await writeFile(join(harness.dir, 'systems/shop/service.yml'), SERVICE)
    await mkdir(join(harness.dir, 'envs'), { recursive: true })
    await writeFile(join(harness.dir, 'envs/local.yml'), `systems:\n  shop: { url: "${harness.baseUrl}" }\n`)
    await mkdir(join(harness.dir, 'ctx/shop'), { recursive: true })
    await writeFile(join(harness.dir, 'ctx/shop/cancel-flow.md'), '---\ntitle: Luồng huỷ lệnh\n---\n\nHuỷ lệnh {{note}} theo ba bước.\n')
    harness.kernel.ctx.runner.config.agent = 'scripted'
    session = await harness.kernel.ctx.authoring.createSession({ confirm: async (r) => { requests.push(r); return answer } })
  }, 60_000)

  afterAll(async () => {
    await session?.close()
    await harness?.dispose()
  })

  it('gives the test agent documented tables, columns, values, rules and referenced documents', async () => {
    const file = join(harness.dir, 'kn.plan.yaml')
    await writeFile(file, [
      'id: TP-KN', 'name: KN', 'requires: [http]', 'systems: [shop]', `contextRefs: [${rel('ctx/shop/cancel-flow.md')}]`,
      'vars: { note: đã khớp }', 'context: Chỉ dùng mã KNA.',
      'cases:', '  - { id: KN-01, title: T, steps: [Gọi shop.listOrders.], expect: [{ id: e1, desc: d, check: { op: eq, value: 200 } }] }', '',
    ].join('\n'))
    const report = await harness.kernel.ctx.runner.run({ plan: file })
    expect(report.cases[0].verdict).toBe('pass')
    const prompt = prompts[0]
    expect(prompt).toContain('  - Bảng `orders`: Lệnh đặt\n    - `id` (integer): Mã lệnh, trùng id của API')
    expect(prompt).toContain('- `status` (text); giá trị: `NEW` = vừa nhận, chưa khớp, `CANCELLED` = đã huỷ')
    expect(prompt).toContain('bảng `orders`, `payments`')
    expect(prompt).toContain('Quy tắc nghiệp vụ:\n- Chỉ lệnh NEW được huỷ')
    expect(prompt).toContain(`## Tài liệu nghiệp vụ của plan\n\n### Luồng huỷ lệnh (\`${rel('ctx/shop/cancel-flow.md')}\`)\n\nHuỷ lệnh đã khớp theo ba bước.`)
    expect(prompt).toContain('### Bối cảnh\nChỉ dùng mã KNA.')
    const events = (await harness.kernel.ctx.runlog.read(report.logFile!)).filter((e) => e.type === 'context/resolved')
    expect(events[0].data).toEqual({ refs: [{ id: rel('ctx/shop/cancel-flow.md'), chars: expect.any(Number) }] })
  })

  it('warns when context repeats the catalog and checks contextRefs', async () => {
    const result = await harness.kernel.ctx.authoring.validate([
      'id: TP-DUP', 'name: Dup', 'requires: [http]', 'systems: [shop]', 'contextRefs: [ctx/none.md]',
      'context: |', '  Bảng orders có cột id, status (NEW|CANCELLED).',
      'cases:', '  - { id: C1, title: T, steps: [s], expect: [{ id: e1, desc: d }] }', '',
    ].join('\n'))
    const messages = result.issues.map((i) => `${i.level}: ${i.message}`).join('\n')
    expect(messages).toContain('warning: context repeats what the shop catalog already tells the test agent about table orders (id, status, status=NEW, status=CANCELLED)')
    expect(messages).toContain('error: contextRefs: ctx/none.md is not a document in the context folders')
    const undeclared = await harness.kernel.ctx.authoring.validate([
      'id: TP-UND', 'name: Und', 'requires: [http]', 'context: Đọc bảng orders.',
      'cases:', '  - { id: C1, title: T, steps: [s], expect: [{ id: e1, desc: d }] }', '',
    ].join('\n'))
    expect(undeclared.issues.map((i) => i.message)).toContain('context mentions table orders of shop; add shop to systems so the test agent gets its documented columns and rules')
  })

  it('proposes system knowledge with a diff, keeps comments, and rejects duplicates and unknown tables', async () => {
    const call = (args: Record<string, unknown>) => harness.kernel.ctx.actions.invoke(session.scope, 'propose_system_knowledge', { system: 'shop', reason: 'đặc tả mục 3', ...args })
    const file = join(harness.dir, 'systems/shop/service.yml')

    answer = false
    expect((await call({ kind: 'rule', rule: 'Lệnh FILLED không huỷ được' })).value).toEqual({ saved: false, reason: 'the user declined' })
    expect(await readFile(file, 'utf8')).toBe(SERVICE)
    answer = true

    expect((await call({ kind: 'rule', rule: 'Lệnh FILLED không huỷ được' })).value).toMatchObject({ saved: true, summary: 'quy tắc nghiệp vụ' })
    expect(requests.at(-1)).toMatchObject({ tool: 'propose_system_knowledge', preview: { kind: 'context-change', diff: expect.stringContaining('+   - Lệnh FILLED không huỷ được') } })
    expect((await call({ kind: 'rule', rule: 'chỉ lệnh NEW  được huỷ' })).error).toMatch(/already has this rule/)

    // Cột của bảng viết gọn: bảng được đổi sang dạng đầy đủ; giá trị mới gộp với giá trị cũ.
    expect((await call({ kind: 'column', table: 'payments', column: 'state', type: 'text', values: { PAID: 'đã trả, đủ tiền' } })).value).toMatchObject({ saved: true })
    expect((await call({ kind: 'column', table: 'orders', column: 'status', values: { FILLED: 'đã khớp' } })).value).toMatchObject({ saved: true })
    expect((await call({ kind: 'table', table: 'refunds', desc: 'Hoàn tiền' })).error).toMatch(/not in the catalog; set `namespace`/)
    expect((await call({ kind: 'table', table: 'refunds', namespace: 'db', desc: 'Hoàn tiền' })).value).toMatchObject({ saved: true })

    const text = await readFile(file, 'utf8')
    expect(text.startsWith('# Comment phải được giữ khi agent đề xuất sửa.')).toBe(true)
    const system = await loadSystem(file)
    expect(system.rules).toEqual(['Chỉ lệnh NEW được huỷ', 'Lệnh FILLED không huỷ được'])
    const tables = system.data[0].tables
    expect(tables.find((t) => t.name === 'payments')!.columns).toEqual([{ name: 'state', type: 'text', values: { PAID: 'đã trả, đủ tiền' } }])
    expect(tables.find((t) => t.name === 'orders')!.columns.find((c) => c.name === 'status')!.values).toEqual({ NEW: 'vừa nhận, chưa khớp', CANCELLED: 'đã huỷ', FILLED: 'đã khớp' })
    expect(tables.find((t) => t.name === 'refunds')).toMatchObject({ desc: 'Hoàn tiền' })
  })

  it('proposes shared context documents inside the context folder only', async () => {
    const call = (args: Record<string, unknown>) => harness.kernel.ctx.actions.invoke(session.scope, 'propose_context_doc', {
      title: 'Hoàn tiền', description: 'Luồng hoàn tiền', content: '# Hoàn tiền\n\nBa bước.', reason: 'người dùng mô tả', ...args,
    })
    expect((await call({ path: '../escape.md' })).error).toMatch(/inside/)
    expect((await call({ path: 'shop/cancel-flow.md' })).error).toMatch(/exists; read it/)
    const created = await call({ path: 'shop/refund.md', systems: ['shop'] })
    expect(created.value).toMatchObject({ saved: true, created: true, id: rel('ctx/shop/refund.md'), hint: expect.stringContaining('contextRefs') })
    expect(await readFile(join(harness.dir, 'ctx/shop/refund.md'), 'utf8')).toBe('---\ntitle: Hoàn tiền\ndescription: Luồng hoàn tiền\nsystems:\n  - shop\n---\n\n# Hoàn tiền\n\nBa bước.\n')
    expect((await call({ path: 'shop/refund.md', replace: true, content: '# Hoàn tiền\n\nBốn bước.' })).value).toMatchObject({ saved: true, created: false })
    expect(requests.at(-1)!.preview).toMatchObject({ kind: 'context-change', diff: expect.stringMatching(/- Ba bước\.\n\+ Bốn bước\./) })
  })

  it('rejects column specs that YAML split at a comma', async () => {
    const flow = SERVICE.replace(/ {10}id:\n {12}type: integer\n {12}desc: Mã lệnh, trùng id của API\n/, '          id: { type: integer, desc: Mã lệnh, trùng id }\n')
    await writeFile(join(harness.dir, 'flow.yml'), flow)
    await expect(loadSystem(join(harness.dir, 'flow.yml'))).rejects.toThrow(/column id: unknown key "trùng id"; quote text containing commas/)
    const values = SERVICE.replace(/ {12}values:\n {14}NEW: vừa nhận, chưa khớp\n {14}CANCELLED: đã huỷ\n/, '            values: { NEW: vừa nhận, chưa khớp, CANCELLED: đã huỷ }\n')
    await writeFile(join(harness.dir, 'values.yml'), values)
    await expect(loadSystem(join(harness.dir, 'values.yml'))).rejects.toThrow(/column status: value "chưa khớp" has no meaning/)
  })
})
