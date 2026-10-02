import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type {} from '@aitest/web-host'
import {
  errorMessage, toPosix, z,
  type ActionDefinition, type ActionScope, type Context, type Plugin, type PluginRow, type RunLog,
} from '@aitest/core'
import { describeConfig, type ConfigField } from './schema.ts'
import { buildRow, describeServers, parseMcpConfig, type McpSelection } from './mcp-import.ts'

/**
 * Quản lý plugin và tool từ giao diện, theo mẫu Plugin Manager và `ctx.tools.restrict()` của dsh.
 *
 * - Plugin: liệt kê row, trạng thái, tool đóng góp; bật, tắt, sửa cấu hình, thêm từ danh mục, gỡ.
 *   Thay đổi do kernel ghi vào patch layer, không sửa file cấu hình gốc.
 * - Tool: liệt kê toàn bộ action kèm schema và plugin sở hữu; bật, tắt từng tool bằng `restrict`;
 *   chạy thử lời gọi chỉ đọc.
 * - MCP server: thêm một row `@aitest/action-mcp-proxy` từ form.
 * Mọi thao tác được ghi vào log kiểm toán `<auditDir>/events.jsonl`.
 */
export interface Config {
  disabledTools: string[]
  lockedRows: string[]
  catalogDirs: string[]
  auditDir: string
}

export const name = 'plugin-manager'
export const inject = ['kernel', 'actions', 'runlog', 'web']

export const Config = z.object({
  disabledTools: z.array(z.string()).default([]).description('Tool đang bị tắt; giao diện tự cập nhật trường này.'),
  lockedRows: z.array(z.string()).default([
    'actions', 'plans', 'agents', 'prompt', 'runlog', 'gateway', 'authoring', 'chat', 'web', 'plugin-manager',
  ]).description('Row không được tắt hoặc gỡ từ giao diện vì giao diện phụ thuộc vào chúng.'),
  catalogDirs: z.array(z.string()).default(['examples/plugins']).description('Thư mục chứa plugin cục bộ hiển thị trong danh mục.'),
  auditDir: z.string().default('.aitest/manager'),
})

export interface PluginInfo {
  id: string
  name: string
  layer: string
  status: string
  error?: string
  disabled: boolean
  locked: boolean
  removable: boolean
  config: unknown
  fields: ConfigField[]
  tools: string[]
}

export interface ToolInfo {
  name: string
  namespace: string
  description: string
  scopes: string[]
  readOnly: boolean
  always: boolean
  owner?: string
  enabled: boolean
  tryable: boolean
  inputSchema: unknown
}

export function apply(ctx: Context, config: Config) {
  const kernel = ctx.kernel
  const disabled = new Map<string, () => unknown>()
  for (const tool of config.disabledTools) disabled.set(tool, ctx.actions.restrict(tool))

  let audit: Promise<RunLog> | undefined
  const log = async (type: string, data: unknown) => {
    audit ??= existsSync(join(resolve(config.auditDir), 'audit', 'events.jsonl'))
      ? ctx.runlog.open('audit', config.auditDir)
      : ctx.runlog.create('audit', config.auditDir)
    ;(await audit).append(type, data)
  }
  ctx.effect(() => () => { void audit?.then((l) => l.close()) }, 'plugin-manager.audit')

  const ownRow = () => kernel.ownerOf(ctx.fiber)
  const toolOwners = () => {
    const owners = new Map<string, string | undefined>()
    for (const def of ctx.actions.all()) owners.set(def.name, kernel.ownerOf(ctx.actions.ownerOf(def.name)))
    return owners
  }

  const pluginInfo = (id: string, owners: Map<string, string | undefined>): PluginInfo => {
    const state = kernel.rows.get(id)!
    const schema = (state.plugin as { Config?: { toJSON?(): unknown } } | undefined)?.Config
    return {
      id,
      name: state.row.name,
      layer: state.layer,
      status: kernel.status(id),
      error: state.error,
      disabled: !!state.row.disabled,
      locked: config.lockedRows.includes(id),
      removable: state.layer === 'patch' && !config.lockedRows.includes(id),
      config: state.row.config ?? {},
      fields: describeConfig(schema?.toJSON?.()),
      tools: [...owners].filter(([, owner]) => owner === id).map(([tool]) => tool).sort(),
    }
  }

  const toolInfo = (def: ActionDefinition, owner?: string): ToolInfo => ({
    name: def.name,
    namespace: def.namespace,
    description: def.description,
    scopes: def.scopes ?? ['case', 'explore'],
    readOnly: def.readOnly ?? false,
    always: def.always ?? false,
    owner,
    enabled: !disabled.has(def.name),
    tryable: def.readOnly === true || typeof def.isReadOnlyCall === 'function',
    inputSchema: def.inputSchema,
  })

  const guard = (id: string) => {
    if (config.lockedRows.includes(id)) throw new Error(`plugin ${id} is locked: the web interface depends on it`)
  }

  ctx.web.method('plugins.list', () => {
    const owners = toolOwners()
    return [...kernel.rows.keys()].map((id) => pluginInfo(id, owners))
  })

  ctx.web.method('plugins.setEnabled', async (params: { id: string; enabled: boolean }) => {
    guard(params.id)
    await kernel.setEnabled(params.id, params.enabled)
    await log('plugin/enabled', params)
    return pluginInfo(params.id, toolOwners())
  })

  ctx.web.method('plugins.configure', async (params: { id: string; config: unknown }) => {
    if (params.id === ownRow()) throw new Error('configure the plugin manager through its own pages')
    try {
      await kernel.configure(params.id, params.config)
    } catch (error) {
      await log('plugin/configure-failed', { id: params.id, error: errorMessage(error) })
      throw error
    }
    await log('plugin/configured', params)
    return pluginInfo(params.id, toolOwners())
  })

  ctx.web.method('plugins.add', async (params: PluginRow) => {
    const row = { id: params.id, name: params.name, config: params.config ?? {} }
    try {
      await kernel.add(row)
    } catch (error) {
      await log('plugin/add-failed', { ...row, error: errorMessage(error) })
      throw error
    }
    await log('plugin/added', row)
    return pluginInfo(row.id, toolOwners())
  })

  ctx.web.method('plugins.remove', async (params: { id: string }) => {
    guard(params.id)
    await kernel.remove(params.id)
    await log('plugin/removed', params)
    return { removed: true }
  })

  ctx.web.method('plugins.catalog', async () => {
    const used = new Set([...kernel.rows.values()].map((s) => s.row.name))
    const items: Array<{ name: string; source: string; loaded: boolean; fields: ConfigField[] }> = []
    for (const name of await catalogNames(kernel.baseDir, config.catalogDirs)) {
      let plugin: Plugin | undefined
      try {
        plugin = await kernel.resolve(name.module)
      } catch {
        continue
      }
      const schema = (plugin as { Config?: { toJSON?(): unknown } }).Config
      items.push({ name: name.module, source: name.source, loaded: used.has(name.module), fields: describeConfig(schema?.toJSON?.()) })
    }
    return items
  })

  ctx.web.method('mcp.add', async (params: {
    id: string; namespace: string; transport: 'stdio' | 'http'; command?: string; args?: string[]
    url?: string; prefix?: string; include?: string[]; env?: Record<string, string>
  }) => {
    const { id, ...rest } = params
    const configValue = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== ''))
    const row = { id, name: '@aitest/action-mcp-proxy', config: configValue }
    try {
      await kernel.add(row)
    } catch (error) {
      await log('mcp/add-failed', { ...row, error: errorMessage(error) })
      throw error
    }
    await log('mcp/added', row)
    return pluginInfo(id, toolOwners())
  })

  /** Rows `action-mcp-proxy` hiện có: mã row và namespace, để tránh trùng khi nhập cấu hình. */
  const existingMcp = () => {
    const ids = new Set(kernel.rows.keys())
    const namespaces = new Set(ctx.actions.all().map((def) => def.namespace))
    for (const state of kernel.rows.values()) {
      const ns = (state.row.config as { namespace?: string } | undefined)?.namespace
      if (ns) namespaces.add(ns)
    }
    return { ids, namespaces }
  }

  // Dán cấu hình MCP server từ công cụ khác: xem trước rồi thêm các server được chọn.
  ctx.web.method('mcp.parse', (params: { text: string }) => describeServers(parseMcpConfig(params.text), existingMcp()))

  ctx.web.method('mcp.import', async (params: { text: string; select: McpSelection[] }) => {
    const raw = parseMcpConfig(params.text)
    const candidates = describeServers(raw, existingMcp())
    const results: Array<{ name: string; id?: string; ok: boolean; tools?: string[]; error?: string }> = []
    for (const selection of params.select) {
      const candidate = candidates.find((c) => c.name === selection.name)
      if (!candidate) {
        results.push({ name: selection.name, ok: false, error: 'server not found in the pasted config' })
        continue
      }
      let row: { id: string; name: string; config: Record<string, unknown> } | undefined
      try {
        const built = buildRow(raw[selection.name], candidate, selection)
        row = { id: built.id, name: '@aitest/action-mcp-proxy', config: built.config }
        await kernel.add(row)
        await log('mcp/imported', { id: row.id, source: selection.name, namespace: row.config.namespace })
        results.push({ name: selection.name, id: row.id, ok: true, tools: pluginInfo(row.id, toolOwners()).tools })
      } catch (error) {
        await log('mcp/import-failed', { source: selection.name, id: row?.id, error: errorMessage(error) })
        results.push({ name: selection.name, id: row?.id, ok: false, error: errorMessage(error) })
      }
    }
    return results
  })

  ctx.web.method('tools.list', () => {
    const owners = toolOwners()
    return ctx.actions.all().map((def) => toolInfo(def, owners.get(def.name)))
  })

  ctx.web.method('tools.setEnabled', async (params: { name: string; enabled: boolean }) => {
    if (!ctx.actions.get(params.name)) throw new Error(`unknown tool: ${params.name}`)
    if (params.enabled) {
      disabled.get(params.name)?.()
      disabled.delete(params.name)
    } else if (!disabled.has(params.name)) {
      disabled.set(params.name, ctx.actions.restrict(params.name))
    }
    // Chỉ ghi `disabledTools` vào patch layer, giữ nguyên các trường cấu hình khác của row.
    const own = ownRow()
    if (own) {
      const current = (kernel.rows.get(own)?.row.config ?? {}) as Record<string, unknown>
      await kernel.saveConfig(own, { ...current, disabledTools: [...disabled.keys()] })
    }
    await log('tool/enabled', params)
    return { name: params.name, enabled: params.enabled }
  })

  ctx.web.method('tools.try', async (params: { name: string; args?: Record<string, unknown> }) => {
    const def = ctx.actions.get(params.name)
    if (!def) throw new Error(`unknown tool: ${params.name}`)
    const args = params.args ?? {}
    const readOnly = def.readOnly === true || def.isReadOnlyCall?.(args) === true
    if (!readOnly) throw new Error(`only read-only calls can be tried from the interface`)
    const scopes = def.scopes ?? ['case', 'explore']
    const scope: ActionScope = {
      kind: scopes.includes('explore') ? 'explore' : scopes.includes('authoring') ? 'authoring' : 'case',
      id: 'plugin-manager',
      namespaces: new Set([def.namespace]),
      phase: 'user',
      signal: AbortSignal.timeout(60_000),
      log: (type, data) => { void log(type, data) },
    }
    if (scope.kind === 'case') throw new Error(`tool ${def.name} only runs inside a test case`)
    const outcome = await ctx.actions.invoke(scope, def.name, args)
    return { status: outcome.status, value: outcome.value, error: outcome.error, durationMs: outcome.durationMs }
  })
}

/** Plugin có thể thêm: subpath export của các package `@aitest/*` cài ở thư mục gốc, và file trong `catalogDirs`. */
async function catalogNames(baseDir: string, dirs: string[]) {
  const out: Array<{ module: string; source: string }> = []
  const root = JSON.parse(await readFile(join(baseDir, 'package.json'), 'utf8').catch(() => '{}'))
  for (const dep of Object.keys(root.dependencies ?? {})) {
    if (!dep.startsWith('@aitest/') || ['@aitest/core', '@aitest/cli'].includes(dep)) continue
    const manifest = JSON.parse(await readFile(join(baseDir, 'node_modules', dep, 'package.json'), 'utf8').catch(() => '{}'))
    const exports = typeof manifest.exports === 'object' ? Object.keys(manifest.exports) : []
    for (const key of exports) out.push({ module: key === '.' ? dep : `${dep}/${key.replace(/^\.\//, '')}`, source: 'package' })
  }
  for (const dir of dirs) {
    const full = resolve(baseDir, dir)
    for (const file of await readdir(full).catch(() => [] as string[])) {
      if (/\.(ts|js|mjs)$/.test(file)) out.push({ module: `./${toPosix(relative(baseDir, join(full, file)))}`, source: 'local' })
    }
  }
  return out
}
