/**
 * Kiểm thử bộ nhớ giữa các phiên qua cấu hình thật: ghi, cập nhật có `expectedVersion`, chặn trùng và bí mật,
 * bộ nhớ nhóm cần duyệt, xoá và khôi phục, mục lục đầu phiên, rà soát; agent chạy test không thấy tool bộ nhớ.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootFromFile, type ConfirmRequest, type Kernel } from '@aitest/core'
import type { AuthoringSession } from '@aitest/authoring'

const root = join(import.meta.dirname, '../../..')

describe('cross-session memory', () => {
  let dir: string
  let kernel: Kernel
  let session: AuthoringSession
  let approving: AuthoringSession
  const requests: ConfirmRequest[] = []
  let answer = true
  const call = (name: string, args: Record<string, unknown> = {}, s = session) => kernel.ctx.actions.invoke(s.scope, name, args)
  const save = (name: string, description: string, extra: Record<string, unknown> = {}, s = session) =>
    call('memory_save', { name, description, type: 'feedback', body: `${description}\n\n**Vì sao:** người dùng yêu cầu.`, ...extra }, s)

  beforeAll(async () => {
    dir = await mkdtemp(join(process.cwd(), '.aitest-mem-'))
    kernel = await bootFromFile(join(root, 'aitest.yml'), [
      { id: 'logger', name: 'aitest:noop', disabled: true },
      { id: 'memory', name: '@aitest/memory', config: { dir: join(dir, 'personal'), teamDir: join(dir, 'team'), user: 'qa1' } },
    ], { patchFile: false })
    session = await kernel.ctx.authoring.createSession()
    approving = await kernel.ctx.authoring.createSession({ confirm: async (r) => { requests.push(r); return answer } })
  }, 60_000)

  afterAll(async () => {
    await session?.close()
    await approving?.close()
    await kernel?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('saves personal memories without approval and lists them in the next session intro', async () => {
    const saved = await save('status-names', 'Trạng thái lệnh khớp là FILLED, không phải MATCHED')
    expect(saved.value).toMatchObject({ saved: true, created: true, scope: 'personal', version: 1 })
    const logged = session.log.events.filter((e) => e.type === 'action/call').at(-1)!.data as { view: unknown }
    expect(logged.view).toMatchObject({ kind: 'memory-saved', title: 'Đã ghi ký ức status-names', saved: true, created: true })
    const file = await readFile(join(dir, 'personal/qa1/status-names.md'), 'utf8')
    expect(file).toMatch(/^---\nname: status-names\n/)
    expect(await readFile(join(dir, 'personal/qa1/MEMORY.md'), 'utf8')).toContain('- [status-names](status-names.md) — Trạng thái lệnh khớp')

    const intro = await kernel.ctx.authoring.intro()
    expect(intro).toContain('## Bộ nhớ từ các phiên trước')
    expect(intro).toContain('- `status-names` [feedback] Trạng thái lệnh khớp là FILLED')
    expect((await call('memory_read', { name: 'status-names' })).value).toMatchObject({ version: 1, body: expect.stringContaining('**Vì sao:**') })
  })

  it('rejects invalid names, secrets, near duplicates and stale updates', async () => {
    expect((await save('Bad Name', 'x')).error).toMatch(/kebab-case/)
    expect((await save('api-access', 'Cách gọi API', { body: 'Header Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' })).error).toMatch(/secret \(bearer token\)/)
    expect((await save('filled-status', 'Trạng thái lệnh khớp là FILLED')).error).toMatch(/similar memories exist: status-names/)
    expect((await save('filled-status', 'Trạng thái lệnh khớp là FILLED', { allowSimilar: true })).value).toMatchObject({ saved: true })
    await call('memory_delete', { name: 'filled-status', reason: 'trùng' })

    const updated = await save('status-names', 'Trạng thái lệnh khớp là FILLED; huỷ là CANCELLED', { expectedVersion: 1 })
    expect(updated.value).toMatchObject({ saved: true, created: false, version: 2, previousVersion: 1 })
    expect((await save('status-names', 'ghi đè', { expectedVersion: 1 })).error).toMatch(/changed \(version 2, expected 1\)/)
  })

  it('needs approval for team memory and refuses without a reviewer', async () => {
    expect((await save('order-limits', 'Giới hạn khối lượng lệnh', { type: 'project', scope: 'team' })).error).toMatch(/needs a user to approve/)
    answer = false
    expect((await save('order-limits', 'Giới hạn khối lượng lệnh', { type: 'project', scope: 'team' }, approving)).value).toEqual({ saved: false, reason: 'the user declined' })
    answer = true
    const saved = await save('order-limits', 'Giới hạn khối lượng lệnh', { type: 'project', scope: 'team' }, approving)
    expect(saved.value).toMatchObject({ saved: true, scope: 'team' })
    expect(requests.at(-1)).toMatchObject({ tool: 'memory_save', preview: { kind: 'memory', name: 'order-limits', scope: 'team' } })
    expect((await save('order-limits', 'Giới hạn khối lượng lệnh khác', { type: 'project' })).error).toMatch(/already exists in team memory/)
  })

  it('deletes, restores and tracks changes for running sessions', async () => {
    const before = kernel.ctx.memory.revision
    const deleted = await call('memory_delete', { name: 'status-names', reason: 'thử' })
    expect(deleted.value).toMatchObject({ deleted: true, version: 2 })
    expect(await kernel.ctx.memory.find('status-names')).toBeUndefined()
    expect(kernel.ctx.memory.changesSince(before)).toEqual([expect.objectContaining({ action: 'deleted', name: 'status-names' })])

    const history = await kernel.ctx.memory.personal.history('status-names')
    expect(history.map((h) => [h.version, h.deleted])).toEqual([[2, true], [1, false]])
    const restored = await kernel.ctx.memory.restore('status-names', 'personal', 2)
    expect(restored).toMatchObject({ version: 3, description: 'Trạng thái lệnh khớp là FILLED; huỷ là CANCELLED' })
    expect((await call('memory_search', { query: 'cancelled' })).value).toMatchObject({ memories: [expect.objectContaining({ name: 'status-names' })] })
  })

  it('reviews broken links and hides memory tools from test runs', async () => {
    await save('use-db-check', 'Luôn đối chiếu DB sau khi gọi API', { body: 'Xem [[status-names]] và [[missing-note]].' })
    const review = await kernel.ctx.memory.review()
    expect(review.brokenLinks).toEqual([{ name: 'use-db-check', link: 'missing-note' }])
    const caseTools = kernel.ctx.actions.list({ kind: 'case', namespaces: new Set(['authoring']), phase: 'agent' }).map((a) => a.name)
    expect(caseTools.filter((n) => n.startsWith('memory_'))).toEqual([])
  })
})
