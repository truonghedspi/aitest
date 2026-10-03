import { describe, expect, it } from 'vitest'
import { interpolate } from '../src/kernel.ts'

describe('interpolate', () => {
  it('replaces env placeholders and infers scalar types for whole-string placeholders', () => {
    process.env.AITEST_T_PORT = '4310'
    expect(interpolate({ port: '${env.AITEST_T_PORT}', missing: '${env.AITEST_T_NONE:-80}' })).toEqual({ port: 4310, missing: 80 })
    expect(interpolate('${env.AITEST_T_NONE:-true}')).toBe(true)
    expect(interpolate('http://h:${env.AITEST_T_PORT}/x')).toBe('http://h:4310/x')
    expect(interpolate('${env.AITEST_T_NONE:-examples/a.db}')).toBe('examples/a.db')
  })

  it('resolves nested defaults: the first variable that is set wins', () => {
    process.env.AITEST_T_MODEL = 'claude-haiku-4.5'
    expect(interpolate('${env.AITEST_T_RUN:-${env.AITEST_T_MODEL:-claude-sonnet-5}}')).toBe('claude-haiku-4.5')
    expect(interpolate('${env.AITEST_T_RUN:-${env.AITEST_T_NONE:-claude-sonnet-5}}')).toBe('claude-sonnet-5')
    process.env.AITEST_T_RUN = 'auto'
    expect(interpolate('${env.AITEST_T_RUN:-${env.AITEST_T_MODEL:-claude-sonnet-5}}')).toBe('auto')
    expect(interpolate('${env.AITEST_T_NONE:-${env.AITEST_T_PORT}}')).toBe(4310)
    // Hai placeholder ghép nhau không phải một giá trị đơn: giữ dạng chuỗi.
    expect(interpolate('${env.AITEST_T_PORT}${env.AITEST_T_PORT}')).toBe('43104310')
  })
})

describe('config extends', () => {
  it('loads a file shared by several parents once (diamond) and still rejects real cycles', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { bootFromFile } = await import('@aitest/core')
    const dir = await mkdtemp(join(tmpdir(), 'aitest-extends-'))
    try {
      // base có row x (cấu hình gốc); web sửa x; codex thêm row y. Bản gộp phải giữ x của web, có y của codex.
      await writeFile(join(dir, 'base.yml'), "plugins:\n  - { id: x, name: 'aitest:noop', disabled: true, config: { v: base } }\n")
      await writeFile(join(dir, 'web.yml'), "extends: ./base.yml\nplugins:\n  - { id: x, name: 'aitest:noop', disabled: true, config: { v: web } }\n")
      await writeFile(join(dir, 'codex.yml'), "extends: ./base.yml\nplugins:\n  - { id: y, name: 'aitest:noop', disabled: true, config: { v: codex } }\n")
      await writeFile(join(dir, 'both.yml'), 'extends: [./web.yml, ./codex.yml]\n')
      const kernel = await bootFromFile(join(dir, 'both.yml'), [], { patchFile: false })
      expect(kernel.rows.get('x')!.row.config).toEqual({ v: 'web' })
      expect(kernel.rows.get('y')!.row.config).toEqual({ v: 'codex' })
      await kernel.dispose()
      await writeFile(join(dir, 'a.yml'), 'extends: ./b.yml\n')
      await writeFile(join(dir, 'b.yml'), 'extends: ./a.yml\n')
      await expect(bootFromFile(join(dir, 'a.yml'), [], { patchFile: false })).rejects.toThrow(/circular extends/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
