/**
 * Kiểm thử quản lý plugin và tool qua WebSocket thật, với patch layer trong thư mục tạm.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootFromFile } from '@aitest/core'
import type {} from '@aitest/web-host'
import { root, setupHarness, WsClient, type Harness } from '../../runner/tests/support.ts'

const QUOTE_SERVER = {
  id: 'mcp-quote',
  namespace: 'quote',
  transport: 'stdio',
  command: process.execPath,
  args: ['--import', 'tsx', join(root, 'examples/mcp/quote-server.ts')],
}

describe('plugin manager', () => {
  let harness: Harness
  let ws: WsClient
  let patchFile: string
  const plugin = async (id: string) => (await ws.call('plugins.list')).find((p: any) => p.id === id)
  const tool = async (name: string) => (await ws.call('tools.list')).find((t: any) => t.name === name)
  const patch = async () => parseYaml(await readFile(patchFile, 'utf8')).plugins as any[]

  beforeAll(async () => {
    harness = await setupHarness({
      port: 4194,
      config: 'aitest.web.yml',
      scripts: {},
      patchFile: (dir) => (patchFile = join(dir, 'aitest.web.patch.yml')),
      rows: (dir) => [
        { id: 'web', name: '@aitest/web-host', config: { port: 0, staticDir: join(dir, 'static') } },
        { id: 'plugin-manager', name: '@aitest/plugin-manager', config: { auditDir: join(dir, 'manager') } },
      ],
    })
    ws = await WsClient.open((await harness.kernel.ctx.web.ready()).replace('http', 'ws') + '/ws')
  })

  afterAll(async () => {
    ws?.socket.close()
    await harness?.dispose()
  })

  it('lists plugins with status, layer, config fields and the tools each one owns', async () => {
    const http = await plugin('action-http')
    expect(http).toMatchObject({ status: 'active', layer: 'config', locked: false, tools: ['http_request'] })
    expect(http.fields.map((f: any) => f.key)).toContain('baseUrl')
    // Hai instance của cùng plugin sở hữu tool riêng.
    expect((await plugin('action-db')).tools).toEqual(['db_query'])
    expect((await plugin('action-dbadmin')).tools).toEqual(['dbadmin_query'])
    expect((await plugin('authoring-dry-run')).tools).toEqual(['dry_run', 'get_run_result'])
    expect(await plugin('web')).toMatchObject({ locked: true, layer: 'override' })
  })

  it('disables and re-enables a plugin, writing the patch layer', async () => {
    await ws.call('plugins.setEnabled', { id: 'action-http', enabled: false })
    expect(await plugin('action-http')).toMatchObject({ status: 'disabled', disabled: true, tools: [] })
    expect(await tool('http_request')).toBeUndefined()
    expect((await patch()).find((r) => r.id === 'action-http')).toMatchObject({ disabled: true })

    await ws.call('plugins.setEnabled', { id: 'action-http', enabled: true })
    expect(await plugin('action-http')).toMatchObject({ status: 'active', tools: ['http_request'] })
    await expect(ws.call('plugins.setEnabled', { id: 'chat', enabled: false })).rejects.toThrow(/locked/)
  })

  it('rejects an invalid config and keeps the previous one running', async () => {
    await expect(ws.call('plugins.configure', { id: 'action-http', config: { timeout: 'slow' } })).rejects.toThrow(/timeout/)
    expect(await plugin('action-http')).toMatchObject({ status: 'active', config: {} })
    const updated = await ws.call('plugins.configure', { id: 'action-http', config: { timeout: 5 } })
    expect(updated).toMatchObject({ status: 'active', config: { timeout: 5 } })
  })

  it('adds a plugin from the catalog and removes it again', async () => {
    const catalog = await ws.call('plugins.catalog')
    expect(catalog.find((c: any) => c.name === '@aitest/authoring/catalog')).toMatchObject({ loaded: true })
    const clock = catalog.find((c: any) => c.name === './examples/plugins/action-clock.ts')
    expect(clock).toMatchObject({ loaded: false, source: 'local' })
    expect(clock.fields).toEqual([expect.objectContaining({ key: 'timezone', default: 'UTC' })])

    const added = await ws.call('plugins.add', { id: 'clock', name: clock.name, config: { timezone: 'Asia/Ho_Chi_Minh' } })
    expect(added).toMatchObject({ status: 'active', layer: 'patch', removable: true, tools: ['clock_now'] })
    await ws.call('plugins.remove', { id: 'clock' })
    expect(await tool('clock_now')).toBeUndefined()
    expect((await patch()).some((r) => r.id === 'clock')).toBe(false)
    await expect(ws.call('plugins.remove', { id: 'action-http' })).rejects.toThrow(/disable it instead/)
  })

  it('adds an MCP server, exposes its tools and runs a read-only call', async () => {
    await expect(ws.call('mcp.add', { ...QUOTE_SERVER, id: 'mcp-broken', command: '/nonexistent/server' })).rejects.toThrow()
    expect(await plugin('mcp-broken')).toBeUndefined()

    const added = await ws.call('mcp.add', QUOTE_SERVER)
    expect(added.tools).toEqual(['quote_get', 'quote_list'])
    expect(await tool('quote_get')).toMatchObject({ owner: 'mcp-quote', readOnly: true, tryable: true })
    const result = await ws.call('tools.try', { name: 'quote_get', args: { symbol: 'vnm' } })
    expect(result).toMatchObject({ status: 'ok', value: { symbol: 'VNM', ref: 70000 } })
  })

  it('disables a tool, hides it from test cases and refuses to try write calls', async () => {
    await ws.call('tools.setEnabled', { name: 'quote_list', enabled: false })
    expect(await tool('quote_list')).toMatchObject({ enabled: false })
    const names = harness.kernel.ctx.actions.list({ kind: 'case', namespaces: new Set(['quote']), phase: 'agent' })
      .filter((a) => a.namespace === 'quote').map((a) => a.name)
    expect(names).toEqual(['quote_get'])
    expect((await patch()).find((r) => r.id === 'plugin-manager').config.disabledTools).toEqual(['quote_list'])

    await expect(ws.call('tools.try', { name: 'http_request', args: { method: 'POST', url: 'http://127.0.0.1:1/' } }))
      .rejects.toThrow(/read-only/)
    const get = await ws.call('tools.try', { name: 'list_actions', args: { namespace: 'quote' } })
    expect(get.value.actions.map((a: any) => a.name)).toEqual(['quote_get'])
  })

  it('restores plugins and tool state from the patch layer on the next boot', async () => {
    const kernel = await bootFromFile(join(root, 'aitest.web.yml'), [
      { id: 'web', name: '@aitest/web-host', config: { port: 0, staticDir: join(harness.dir, 'static') } },
      { id: 'logger', name: 'aitest:noop', disabled: true },
      { id: 'reporter-console', name: '@aitest/reporters/console', disabled: true },
    ], { patchFile })
    try {
      expect(kernel.status('mcp-quote')).toBe('active')
      expect(kernel.ctx.actions.get('quote_get')).toBeDefined()
      expect(kernel.ctx.actions.isRestricted('quote_list')).toBe(true)
      expect(kernel.rows.get('action-http')!.row.config).toEqual({ timeout: 5 })
    } finally {
      await kernel.dispose()
    }
  })

  it('imports MCP servers from a pasted config without writing secrets that exist in the environment', async () => {
    process.env.AITEST_QUOTE_TOKEN = 'tok_0123456789abcdefghijkl'
    const text = JSON.stringify({
      mcpServers: {
        'price-feed': { command: process.execPath, args: QUOTE_SERVER.args, env: { AITEST_QUOTE_TOKEN: 'tok_0123456789abcdefghijkl', QUOTE_NO_HINTS: '1' } },
        broken: { command: '/nonexistent/server' },
      },
    })
    const preview = await ws.call('mcp.parse', { text })
    expect(preview.map((c: any) => [c.name, c.namespace])).toEqual([['price-feed', 'pricefeed'], ['broken', 'broken']])
    expect(JSON.stringify(preview)).not.toContain('tok_0123456789abcdefghijkl')

    const results = await ws.call('mcp.import', { text, select: [{ name: 'price-feed' }, { name: 'broken' }] })
    expect(results).toEqual([
      { name: 'price-feed', id: 'mcp-pricefeed', ok: true, tools: ['pricefeed_get', 'pricefeed_list'] },
      expect.objectContaining({ name: 'broken', id: 'mcp-broken', ok: false }),
    ])
    const row = (await patch()).find((r) => r.id === 'mcp-pricefeed')
    expect(row.config.env).toEqual({ AITEST_QUOTE_TOKEN: '${env.AITEST_QUOTE_TOKEN}', QUOTE_NO_HINTS: '1' })
    expect(await readFile(patchFile, 'utf8')).not.toContain('tok_0123456789abcdefghijkl')
    expect((await patch()).some((r) => r.id === 'mcp-broken')).toBe(false)

    // Server không khai báo readOnlyHint: tool chưa chỉ đọc; người dùng đánh dấu thì agent soạn plan gọi thử được.
    expect(await ws.call('mcp.tools', { id: 'mcp-pricefeed' })).toEqual([
      expect.objectContaining({ name: 'pricefeed_get', raw: 'get', readOnly: false }),
      expect.objectContaining({ name: 'pricefeed_list', raw: 'list', readOnly: false }),
    ])
    await expect(ws.call('tools.try', { name: 'pricefeed_get', args: { symbol: 'vnm' } })).rejects.toThrow(/read-only/)
    await ws.call('mcp.setReadOnly', { id: 'mcp-pricefeed', tools: ['pricefeed_get'] })
    expect(await ws.call('mcp.tools', { id: 'mcp-pricefeed' })).toEqual([
      expect.objectContaining({ name: 'pricefeed_get', readOnly: true, source: 'config' }),
      expect.objectContaining({ name: 'pricefeed_list', readOnly: false }),
    ])
    expect((await ws.call('tools.try', { name: 'pricefeed_get', args: { symbol: 'vnm' } })).status).toBe('ok')
    expect((await patch()).find((r) => r.id === 'mcp-pricefeed').config.readOnly).toEqual(['get'])
    expect((await ws.call('tools.list')).find((t: any) => t.name === 'pricefeed_get')).toMatchObject({ mcp: true, readOnly: true })
    await expect(ws.call('mcp.tools', { id: 'action-http' })).rejects.toThrow(/not an MCP server/)
  })
})
