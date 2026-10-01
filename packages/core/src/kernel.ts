import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { parse as parseYaml } from 'yaml'
import { ActionRegistry } from './actions.ts'
import { AgentRegistry } from './agents.ts'
import { PlanService } from './plans.ts'
import { PromptService } from './prompt.ts'
import { RunLogService } from './runlog.ts'

/**
 * Một dòng cấu hình plugin, theo mẫu "row" của dsh.
 * Dòng có cùng `id` với dòng mặc định sẽ thay thế dòng mặc định.
 */
export interface PluginRow {
  id: string
  /** Tên package, đường dẫn tương đối (`./x.ts`) hoặc plugin dựng sẵn (`aitest:<tên>`). */
  name: string
  config?: unknown
  disabled?: boolean
  /** Thư mục dùng để phân giải `name` tương đối; kernel tự gán theo file khai báo row. */
  baseDir?: string
}

export interface KernelConfig {
  plugins: PluginRow[]
}

/** Các service lõi. Bản thân chúng cũng là plugin và thay thế được qua `id`. */
export const builtins: Record<string, Plugin> = {
  'aitest:actions': ActionRegistry,
  'aitest:plans': PlanService,
  'aitest:agents': AgentRegistry,
  'aitest:prompt': PromptService,
  'aitest:runlog': RunLogService,
}

const defaultRows: PluginRow[] = Object.keys(builtins).map((name) => ({ id: name.slice('aitest:'.length), name }))

export interface Kernel {
  ctx: Context
  config: KernelConfig
  configFile?: string
  dispose(): Promise<void>
}

/** Đọc file cấu hình YAML rồi dựng kernel. */
export async function bootFromFile(file: string, overrides: PluginRow[] = []): Promise<Kernel> {
  const configFile = resolve(file)
  const rows = await loadRows(configFile, new Set())
  return boot({ plugins: [...rows, ...overrides] }, configFile)
}

/**
 * Đọc row từ file cấu hình, gồm cả các file trong `extends` (xếp lớp như patch layer của dsh).
 * File sau ghi đè row cùng `id` của file trước; `name` tương đối được phân giải theo file khai báo nó.
 */
async function loadRows(file: string, seen: Set<string>): Promise<PluginRow[]> {
  if (seen.has(file)) throw new Error(`circular extends: ${file}`)
  seen.add(file)
  const raw = parseYaml(await readFile(file, 'utf8')) ?? {}
  const parents = raw.extends === undefined ? [] : [raw.extends].flat()
  let rows: PluginRow[] = []
  for (const parent of parents) {
    rows = mergeRows(rows, await loadRows(resolve(dirname(file), String(parent)), seen))
  }
  const own = (raw.plugins ?? []).map((row: PluginRow) => ({ ...row, baseDir: row.baseDir ?? dirname(file) }))
  return mergeRows(rows, own)
}

/**
 * Dựng context gốc và nạp plugin theo thứ tự dòng cấu hình.
 * Plugin thiếu service phụ thuộc (`inject`) sẽ chờ tới khi service đó xuất hiện.
 */
export async function boot(config: KernelConfig, configFile?: string): Promise<Kernel> {
  const ctx = new Context()
  const baseDir = configFile ? dirname(configFile) : process.cwd()
  const rows = mergeRows(defaultRows, config.plugins)
  const fibers: Fiber[] = []
  for (const row of rows) {
    if (row.disabled) continue
    const plugin = await resolvePlugin(row.name, row.baseDir ?? baseDir)
    fibers.push(ctx.plugin(plugin, interpolate(row.config ?? {})))
  }
  await Promise.all(fibers.map((fiber) => fiber.await()))
  return {
    ctx,
    config: { plugins: rows },
    configFile,
    async dispose() {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

function mergeRows(base: PluginRow[], extra: PluginRow[]) {
  const rows = [...base]
  for (const row of extra) {
    if (!row?.id || !row?.name) throw new Error(`plugin row requires id and name: ${JSON.stringify(row)}`)
    const index = rows.findIndex((r) => r.id === row.id)
    if (index >= 0) rows[index] = row
    else rows.push(row)
  }
  return rows
}

async function resolvePlugin(name: string, baseDir: string): Promise<Plugin> {
  if (builtins[name]) return builtins[name]
  let file: string
  if (name.startsWith('.') || isAbsolute(name)) {
    file = resolve(baseDir, name)
  } else {
    const require = createRequire(resolve(baseDir, 'aitest.yml'))
    file = require.resolve(name)
  }
  const mod = await import(pathToFileURL(file).href)
  const plugin = mod.default ?? mod
  if (typeof plugin !== 'function' && typeof plugin?.apply !== 'function') {
    throw new Error(`module ${name} does not export a cordis plugin`)
  }
  return plugin
}

/** Thay `${env.NAME}` và `${env.NAME:-mặc định}` trong mọi chuỗi của cấu hình. */
export function interpolate<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{env\.([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, key, fallback) => {
      return process.env[key] ?? fallback ?? ''
    }) as T
  }
  if (Array.isArray(value)) return value.map(interpolate) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v)])) as T
  }
  return value
}
