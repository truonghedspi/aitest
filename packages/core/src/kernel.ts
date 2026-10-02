import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { ActionRegistry } from './actions.ts'
import { AgentRegistry } from './agents.ts'
import { PlanService } from './plans.ts'
import { PromptService } from './prompt.ts'
import { RunLogService } from './runlog.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    kernel: Kernel
  }
}

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
  /** Chỉ dùng trong patch layer: gỡ row do patch layer thêm vào. */
  removed?: boolean
  /** Thư mục dùng để phân giải `name` tương đối; kernel tự gán theo file khai báo row. */
  baseDir?: string
  /** Row là bản theo môi trường (`<row gốc>@<môi trường>`); action của row chỉ dùng cho scope cùng môi trường. */
  env?: string
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

/** Giá trị của `FiberState` trong cordis; enum gốc chỉ có trong file khai báo kiểu, không có lúc chạy. */
const FiberState = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3 } as const

const defaultRows: PluginRow[] = Object.keys(builtins).map((name) => ({ id: name.slice('aitest:'.length), name }))

/** Tầng khai báo row: cấu hình mặc định, file cấu hình, patch layer, hoặc ghi đè lúc khởi động. */
export type RowLayer = 'builtin' | 'config' | 'patch' | 'override' | 'env'

export type RowStatus = 'active' | 'loading' | 'pending' | 'failed' | 'disabled'

export interface RowState {
  row: PluginRow
  layer: RowLayer
  plugin?: Plugin
  fiber?: Fiber
  error?: string
}

export interface BootOptions {
  /** Plugin lỗi khi khởi động thì dừng và ném lỗi. Mặc định `true`; web host dùng `false`. */
  strict?: boolean
  /** File patch layer. Mặc định `<tên cấu hình>.patch.yml` cạnh file cấu hình. */
  patchFile?: string | false
}

/**
 * Kernel: dựng context gốc, nạp plugin theo row và quản lý row lúc đang chạy.
 *
 * Thay đổi lúc chạy (bật, tắt, sửa cấu hình, thêm, gỡ) được ghi vào **patch layer**, theo mẫu
 * `cordis.patch.yml` của dsh: file cấu hình gốc không bị sửa; patch layer nạp sau cùng và ghi đè
 * row cùng `id`. Thay đổi chỉ được ghi khi plugin nạp thành công.
 */
export class Kernel {
  readonly ctx = new Context()
  readonly rows = new Map<string, RowState>()
  readonly baseDir: string
  private patch: PluginRow[] = []
  /** Row đang được nạp; plugin đăng ký đồng bộ trong `apply` thì fiber của row chưa được gán. */
  private loading?: RowState

  constructor(readonly configFile?: string, readonly patchFile?: string) {
    this.baseDir = configFile ? dirname(configFile) : process.cwd()
    this.ctx.provide('kernel', this)
  }

  get config(): KernelConfig {
    return { plugins: [...this.rows.values()].map((s) => s.row) }
  }

  /** Nạp toàn bộ row theo thứ tự. Row lỗi được ghi `error`; chế độ `strict` ném lỗi đầu tiên. */
  async start(entries: Array<{ row: PluginRow; layer: RowLayer }>, patch: PluginRow[], strict: boolean) {
    this.patch = patch
    for (const entry of entries) this.rows.set(entry.row.id, { ...entry })
    for (const state of this.rows.values()) {
      if (!state.row.disabled) await this.load(state, false)
    }
    await Promise.all([...this.rows.values()].map((s) => this.settle(s)))
    const failed = [...this.rows.values()].find((s) => s.error)
    if (strict && failed) {
      await this.dispose()
      throw new Error(`plugin ${failed.row.id} (${failed.row.name}) failed: ${failed.error}`)
    }
  }

  status(id: string): RowStatus {
    const state = this.rows.get(id)
    if (!state || state.row.disabled || !state.fiber) return state?.error ? 'failed' : 'disabled'
    if (state.error) return 'failed'
    switch (state.fiber.state as number) {
      case FiberState.PENDING: return 'pending'
      case FiberState.LOADING: return 'loading'
      case FiberState.ACTIVE: return 'active'
      case FiberState.FAILED: return 'failed'
      default: return 'disabled'
    }
  }

  /**
   * Row sở hữu một fiber: đi ngược theo context cha tới fiber gốc của row.
   * So sánh theo `uid` vì `ctx.fiber` bên trong plugin là proxy theo dõi của cordis, khác tham chiếu với fiber trả về.
   */
  ownerOf(fiber: Fiber | undefined): string | undefined {
    const byUid = new Map<number, string>()
    for (const [id, state] of this.rows) if (state.fiber?.uid) byUid.set(state.fiber.uid, id)
    for (let current = fiber, depth = 0; current?.uid && depth < 32; current = current.parent?.fiber, depth++) {
      const id = byUid.get(current.uid)
      if (id) return id
    }
    return undefined
  }

  async setEnabled(id: string, enabled: boolean) {
    const state = this.require(id)
    if (enabled === !state.row.disabled && (!enabled || this.status(id) === 'active')) return
    if (enabled) {
      state.row = { ...state.row, disabled: false }
      await this.load(state, true)
    } else {
      await this.unload(state)
      state.row = { ...state.row, disabled: true }
    }
    await this.persist(state)
  }

  /** Đổi cấu hình và nạp lại plugin. Cấu hình mới lỗi thì quay về cấu hình cũ và ném lỗi. */
  async configure(id: string, config: unknown) {
    const state = this.require(id)
    const previous = state.row
    state.row = { ...previous, config }
    if (!state.row.disabled) {
      await this.unload(state)
      try {
        await this.load(state, true)
      } catch (error) {
        state.row = previous
        await this.unload(state)
        await this.load(state, false).then(() => this.settle(state))
        throw error
      }
    }
    await this.persist(state)
  }

  /** Thêm row mới vào patch layer. Plugin lỗi khi nạp thì row bị bỏ và lỗi được ném ra. */
  async add(row: PluginRow) {
    if (!/^[\w.-]+$/.test(row.id)) throw new Error(`invalid row id: ${row.id}`)
    if (this.rows.has(row.id)) throw new Error(`row id already exists: ${row.id}`)
    const state: RowState = { row: { ...row, baseDir: row.baseDir ?? this.baseDir }, layer: 'patch' }
    this.rows.set(row.id, state)
    try {
      if (!row.disabled) await this.load(state, true)
    } catch (error) {
      await this.unload(state)
      this.rows.delete(row.id)
      throw error
    }
    await this.persist(state)
    return state
  }

  /** Gỡ row do patch layer thêm vào. Row của file cấu hình chỉ tắt được, không gỡ được. */
  async remove(id: string) {
    const state = this.require(id)
    if (state.layer !== 'patch') throw new Error(`row ${id} comes from ${state.layer}; disable it instead`)
    await this.unload(state)
    this.rows.delete(id)
    this.patch = this.patch.filter((r) => r.id !== id)
    await this.writePatch()
  }

  /** Ghi cấu hình của row vào patch layer mà không nạp lại plugin; dùng khi plugin tự cập nhật trạng thái lúc chạy. */
  async saveConfig(id: string, config: unknown) {
    const state = this.require(id)
    state.row = { ...state.row, config }
    await this.persist(state)
  }

  /** Môi trường của row sở hữu fiber; `undefined` với row mặc định. */
  envOf(fiber: Fiber | undefined): string | undefined {
    const id = this.ownerOf(fiber)
    return id ? this.rows.get(id)?.row.env : this.loading?.row.env
  }

  /**
   * Nạp một row theo môi trường, không ghi patch layer: bản sao của row mặc định với cấu hình của môi trường.
   * Row lỗi khi nạp thì bị bỏ và lỗi được ném ra.
   */
  async spawn(row: PluginRow & { env: string }) {
    if (this.rows.has(row.id)) throw new Error(`row id already exists: ${row.id}`)
    const state: RowState = { row: { ...row, baseDir: row.baseDir ?? this.baseDir }, layer: 'env' }
    this.rows.set(row.id, state)
    try {
      await this.load(state, true)
    } catch (error) {
      await this.unload(state)
      this.rows.delete(row.id)
      throw error
    }
    return state
  }

  /** Gỡ row theo môi trường do `spawn` tạo. */
  async despawn(id: string) {
    const state = this.require(id)
    if (state.layer !== 'env') throw new Error(`row ${id} is not an environment row`)
    await this.unload(state)
    this.rows.delete(id)
  }

  /** Nạp module plugin theo tên, không gắn vào cây; dùng để đọc `Config` khi thêm plugin mới. */
  resolve(name: string, baseDir = this.baseDir) {
    return resolvePlugin(name, baseDir)
  }

  async dispose() {
    for (const state of [...this.rows.values()].reverse()) await this.unload(state)
  }

  private require(id: string) {
    const state = this.rows.get(id)
    if (!state) throw new Error(`unknown plugin row: ${id}`)
    return state
  }

  private async load(state: RowState, settle: boolean) {
    state.error = undefined
    try {
      state.plugin ??= await resolvePlugin(state.row.name, state.row.baseDir ?? this.baseDir)
      this.loading = state
      try {
        state.fiber = this.ctx.plugin(state.plugin, interpolate(state.row.config ?? {}))
      } finally {
        this.loading = undefined
      }
    } catch (error) {
      state.error = (error as Error).message
      if (settle) throw error
      return
    }
    if (settle) {
      await this.settle(state)
      if (state.error) throw new Error(state.error)
    }
  }

  private async settle(state: RowState) {
    if (!state.fiber) return
    try {
      await state.fiber.await()
    } catch (error) {
      state.error = (error as Error).message
    }
    if ((state.fiber.state as number) === FiberState.FAILED) state.error ??= 'plugin failed to start'
  }

  private async unload(state: RowState) {
    const fiber = state.fiber
    state.fiber = undefined
    if (fiber) await fiber.dispose().catch(() => {})
  }

  private async persist(state: RowState) {
    if (!this.patchFile) return
    const { baseDir: _base, ...row } = state.row
    const index = this.patch.findIndex((r) => r.id === row.id)
    if (index >= 0) this.patch[index] = row
    else this.patch.push(row)
    await this.writePatch()
  }

  private async writePatch() {
    if (!this.patchFile) return
    const header = '# Patch layer do giao diện quản lý plugin ghi. Nạp sau file cấu hình và ghi đè row cùng id.\n'
    await writeFile(this.patchFile, header + stringifyYaml({ plugins: this.patch }))
  }
}

/** Đọc file cấu hình YAML (kèm `extends` và patch layer) rồi dựng kernel. */
export async function bootFromFile(file: string, overrides: PluginRow[] = [], options: BootOptions = {}): Promise<Kernel> {
  const configFile = resolve(file)
  const patchFile = options.patchFile === false ? undefined
    : resolve(options.patchFile ?? join(dirname(configFile), `${basename(configFile, extname(configFile))}.patch.yml`))
  const configRows = await loadRows(configFile, new Set())
  const patch = patchFile && existsSync(patchFile) ? await readPatch(patchFile) : []
  const kernel = new Kernel(configFile, patchFile)
  const entries = layer(configRows, 'config')
  for (const row of patch) {
    if (row.removed) continue
    // Row của patch layer phân giải đường dẫn tương đối theo thư mục cấu hình, giống row thêm từ giao diện.
    upsert(entries, { row: { ...row, baseDir: row.baseDir ?? dirname(configFile) }, layer: entries.some((e) => e.row.id === row.id) ? layerOf(entries, row.id) : 'patch' })
  }
  for (const row of overrides) upsert(entries, { row, layer: 'override' })
  await kernel.start(withDefaults(entries), patch, options.strict ?? true)
  return kernel
}

/** Dựng kernel từ danh sách row trong bộ nhớ, không có file cấu hình và patch layer. */
export async function boot(config: KernelConfig, configFile?: string, options: BootOptions = {}): Promise<Kernel> {
  const kernel = new Kernel(configFile)
  await kernel.start(withDefaults(layer(config.plugins, 'config')), [], options.strict ?? true)
  return kernel
}

function layer(rows: PluginRow[], name: RowLayer) {
  return rows.map((row) => ({ row, layer: name }))
}

function layerOf(entries: Array<{ row: PluginRow; layer: RowLayer }>, id: string) {
  return entries.find((e) => e.row.id === id)!.layer
}

function upsert(entries: Array<{ row: PluginRow; layer: RowLayer }>, entry: { row: PluginRow; layer: RowLayer }) {
  if (!entry.row?.id || !entry.row?.name) throw new Error(`plugin row requires id and name: ${JSON.stringify(entry.row)}`)
  const index = entries.findIndex((e) => e.row.id === entry.row.id)
  if (index >= 0) entries[index] = entry
  else entries.push(entry)
}

function withDefaults(entries: Array<{ row: PluginRow; layer: RowLayer }>) {
  const out = layer(defaultRows, 'builtin')
  for (const entry of entries) upsert(out, entry)
  return out
}

async function readPatch(file: string): Promise<PluginRow[]> {
  const raw = parseYaml(await readFile(file, 'utf8')) ?? {}
  return raw.plugins ?? []
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
  const entries: Array<{ row: PluginRow; layer: RowLayer }> = []
  for (const parent of parents) {
    for (const row of await loadRows(resolve(dirname(file), String(parent)), seen)) upsert(entries, { row, layer: 'config' })
  }
  for (const row of raw.plugins ?? []) upsert(entries, { row: { ...row, baseDir: row.baseDir ?? dirname(file) }, layer: 'config' })
  return entries.map((e) => e.row)
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

/**
 * Thay `${env.NAME}` và `${env.NAME:-mặc định}` trong mọi chuỗi của cấu hình.
 * Chuỗi chỉ gồm đúng một placeholder được suy kiểu như YAML: số và `true`/`false` thành giá trị tương ứng.
 */
export function interpolate<T>(value: T): T {
  if (typeof value === 'string') {
    const whole = /^\$\{env\.([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/.exec(value)
    if (whole) {
      const raw = process.env[whole[1]] ?? whole[2] ?? ''
      if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw) as T
      if (raw === 'true' || raw === 'false') return (raw === 'true') as T
      return raw as T
    }
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
