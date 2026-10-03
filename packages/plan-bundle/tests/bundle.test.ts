/**
 * Gói plan giữa hai aitest có bố cục thư mục khác nhau: xuất plan kèm tài liệu và hệ thống, xem trước, nhập vào
 * thư mục của máy đích (sửa `contextRefs`, gom OpenAPI vào thư mục hệ thống), giữ bản đang có, ghi đè có sao lưu,
 * chặn đường dẫn không an toàn và gói bị sửa.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootFromFile, toPosix, type Kernel } from '@aitest/core'
import { loadSystem } from '@aitest/system-catalog'
import type { PlanBundle } from '@aitest/plan-bundle'

const root = join(import.meta.dirname, '../../..')

describe('plan bundles', () => {
  let source: Kernel
  let target: Kernel
  let dir: string
  let bundle: PlanBundle
  const rel = (p: string) => toPosix(relative(process.cwd(), join(dir, p)))

  beforeAll(async () => {
    dir = await mkdtemp(join(process.cwd(), '.aitest-bundle-'))
    await writeFile(join(dir, 'placeholder'), '')
    source = await bootFromFile(join(root, 'aitest.yml'), [{ id: 'logger', name: 'aitest:noop', disabled: true }], { patchFile: false })
    // Máy đích: thư mục plan, ngữ cảnh, catalog khác tên với máy xuất.
    target = await bootFromFile(join(root, 'aitest.yml'), [
      { id: 'logger', name: 'aitest:noop', disabled: true },
      { id: 'authoring-catalog', name: '@aitest/authoring/catalog', config: { planDirs: [join(dir, 'team-plans')] } },
      { id: 'authoring-save', name: '@aitest/authoring/save', config: { dir: join(dir, 'team-plans') } },
      { id: 'context', name: '@aitest/context', config: { dirs: [join(dir, 'knowledge')], skillDirs: [join(dir, 'skills')] } },
      { id: 'system-catalog', name: '@aitest/system-catalog', config: { dirs: [join(dir, 'catalog')], envDir: join(dir, 'envs') } },
      { id: 'plan-bundle', name: '@aitest/plan-bundle', config: { importDir: join(dir, 'imports') } },
    ], { patchFile: false })
  }, 60_000)

  afterAll(async () => {
    await source?.dispose()
    await target?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('exports a plan with its context documents and systems, paths relative to each kind of folder', async () => {
    bundle = await source.ctx.bundles.export(['examples/plans/order-integration.plan.yaml'])
    expect(bundle).toMatchObject({ format: 'aitest-plan-bundle', version: 1, plans: [{ path: 'order-integration.plan.yaml', id: 'TP-ORDER-INT-001' }] })
    expect(bundle.files.map((f) => `${f.kind}:${f.path}`).sort()).toEqual([
      'context:order/matching-flow.md',
      'plan:order-integration.plan.yaml',
      'system:order-service/docs/SPEC.md',
      'system:order-service/formulas.yml',
      'system:order-service/openapi/openapi.yaml',
      'system:order-service/service.yml',
    ])
    const service = bundle.files.find((f) => f.path === 'order-service/service.yml')!.content
    expect(service).toContain('openapi: openapi/openapi.yaml')
    expect(service).toContain('docs/SPEC.md')
    expect(service).toContain('# Mô hình của một service')
    expect(bundle.requirements).toEqual({ namespaces: ['db', 'http', 'webhook'], systems: ['order-service'] })
    // Không xuất cấu hình môi trường: URL và kết nối thuộc về máy đích.
    expect(bundle.files.some((f) => f.path.includes('envs/'))).toBe(false)
    // Ghi lại service.yml giữ định dạng gốc: không tự xuống dòng, không đổi `[order]` thành `[ order ]`.
    expect(service).toContain('features: [order]')
    expect(service).toContain('  - Lệnh vi phạm ràng buộc đầu vào bị từ chối với HTTP 400 và không được lưu vào bảng orders\n')
    await expect(source.ctx.bundles.export(['package.json'])).rejects.toThrow(/outside plan directories/)
  })

  it('previews and imports into a machine with a different folder layout', async () => {
    const preview = await target.ctx.bundles.preview(bundle)
    expect(preview.items.map((i) => [i.kind, i.target, i.status])).toEqual(expect.arrayContaining([
      ['plan', rel('team-plans/order-integration.plan.yaml'), 'new'],
      ['context', rel('knowledge/order/matching-flow.md'), 'new'],
      ['system', rel('catalog/order-service/service.yml'), 'new'],
    ]))
    expect(preview.warnings).toEqual([expect.stringContaining('has no url for order-service')])

    const result = await target.ctx.bundles.import(bundle)
    expect(result.written).toHaveLength(6)
    // contextRefs trỏ tới thư mục ngữ cảnh của máy đích; plan hợp lệ trên máy đích.
    const plan = await readFile(join(dir, 'team-plans/order-integration.plan.yaml'), 'utf8')
    expect(plan).toContain(rel('knowledge/order/matching-flow.md'))
    expect(plan).not.toContain('contextRefs: [context/order/matching-flow.md]')
    expect(result.plans).toEqual([{ target: rel('team-plans/order-integration.plan.yaml'), id: 'TP-ORDER-INT-001', valid: true, errors: [] }])
    const system = await loadSystem(join(dir, 'catalog/order-service/service.yml'))
    expect(system.operations.map((o) => o.id)).toContain('cancelOrder')
    expect(system.docs).toEqual([rel('catalog/order-service/docs/SPEC.md')])
    expect(await readFile(join(process.cwd(), result.backupDir!, 'import.json'), 'utf8')).toContain('TP-ORDER-INT-001')
  })

  it('keeps changed files unless asked to overwrite, backs them up, and skips dependent files', async () => {
    const servicePath = join(dir, 'catalog/order-service/service.yml')
    await writeFile(servicePath, (await readFile(servicePath, 'utf8')) + '\n# sửa trên máy đích\n')
    const again = await target.ctx.bundles.preview(bundle)
    expect(again.items.find((i) => i.path === 'order-service/service.yml')).toMatchObject({ status: 'changed' })
    expect(again.items.filter((i) => i.status === 'same')).toHaveLength(5)

    const kept = await target.ctx.bundles.import(bundle)
    expect(kept.written).toEqual([])
    expect(await readFile(servicePath, 'utf8')).toContain('# sửa trên máy đích')

    const replaced = await target.ctx.bundles.import(bundle, { overwrite: ['system:order-service/service.yml'] })
    expect(replaced.written).toEqual([expect.objectContaining({ path: 'order-service/service.yml', overwritten: true })])
    expect(await readFile(servicePath, 'utf8')).not.toContain('# sửa trên máy đích')
    expect(await readFile(join(process.cwd(), replaced.backupDir!, rel('catalog/order-service/service.yml')), 'utf8')).toContain('# sửa trên máy đích')
  })

  it('rejects tampered bundles and blocks unsafe paths', async () => {
    const tampered = structuredClone(bundle)
    tampered.files[0].content += 'x'
    await expect(target.ctx.bundles.preview(tampered)).rejects.toThrow(/checksum mismatch/)
    await expect(target.ctx.bundles.preview({ format: 'other' })).rejects.toThrow(/not an aitest plan bundle/)
    const unsafe = structuredClone(bundle)
    const evil = { kind: 'context' as const, path: '../../escape.md', content: 'x', sha256: '' }
    evil.sha256 = (await import('node:crypto')).createHash('sha256').update('x').digest('hex')
    unsafe.files.push(evil)
    const preview = await target.ctx.bundles.preview(unsafe)
    expect(preview.items.find((i) => i.path === '../../escape.md')).toMatchObject({ status: 'blocked', reason: 'unsafe path ../../escape.md' })
    const result = await target.ctx.bundles.import(unsafe)
    expect(result.skipped).toContainEqual({ path: 'context:../../escape.md', reason: 'unsafe path ../../escape.md' })
  })
})
