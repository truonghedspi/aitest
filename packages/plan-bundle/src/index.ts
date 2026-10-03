import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { isScalar, isSeq, parseDocument } from 'yaml'
import type {} from '@aitest/authoring'
import { isInside, Service, toPosix, z, type Context, type Kernel, type TestPlan } from '@aitest/core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    bundles: PlanBundles
  }
}

/**
 * Gói plan để chuyển giữa các aitest (máy, nhóm, môi trường khác nhau): plan cùng những gì plan cần để chạy được.
 *
 * - Mỗi file lưu theo loại và đường dẫn tương đối với thư mục gốc của loại đó, không theo đường dẫn của máy xuất:
 *   `plan` theo thư mục plan, `context` theo thư mục ngữ cảnh, `system` theo thư mục catalog hệ thống.
 *   File OpenAPI, tài liệu mà `service.yml` tham chiếu được gom vào thư mục của hệ thống và `service.yml` được sửa theo.
 * - Không xuất `envs/` và bí mật: URL, kết nối thuộc về môi trường đích.
 * - Nhập có bước xem trước: file mới, giống hệt, khác bản đang có (mặc định giữ), bị chặn; kiểm tra tool, hệ thống, URL
 *   của môi trường đích. Bản bị ghi đè được giữ trong thư mục nhập để hoàn tác; plan nhập xong được kiểm tra lại.
 */
export const BUNDLE_FORMAT = 'aitest-plan-bundle'
export const BUNDLE_VERSION = 1

export type BundleFileKind = 'plan' | 'context' | 'system'

export interface BundleFile {
  kind: BundleFileKind
  /** Đường dẫn tương đối với thư mục gốc của loại file, dạng `/`: `order/cancel.plan.yaml`, `order-service/service.yml`. */
  path: string
  content: string
  sha256: string
}

export interface PlanBundle {
  format: typeof BUNDLE_FORMAT
  version: number
  exportedAt: string
  /** Plan trong gói (đường dẫn của file loại `plan`). */
  plans: Array<{ path: string; id: string; name: string }>
  files: BundleFile[]
  /** Điều môi trường đích phải có để chạy plan: namespace tool, hệ thống trong catalog. */
  requirements: { namespaces: string[]; systems: string[] }
}

export type ImportStatus = 'new' | 'same' | 'changed' | 'blocked'

export interface ImportItem {
  kind: BundleFileKind
  path: string
  /** File chỉ ghi khi file này cũng được ghi (OpenAPI, tài liệu của hệ thống phụ thuộc `service.yml`). */
  dependsOn?: string
  /** Đường dẫn sẽ ghi trên máy đích, tương đối với thư mục làm việc. */
  target?: string
  status: ImportStatus
  reason?: string
}

export interface ImportPreview {
  plans: PlanBundle['plans']
  items: ImportItem[]
  /** Điều môi trường đích còn thiếu: không chặn việc nhập, nhưng plan chưa chạy được cho tới khi bổ sung. */
  warnings: string[]
}

export interface ImportResult {
  written: Array<{ kind: BundleFileKind; path: string; target: string; overwritten: boolean }>
  skipped: Array<{ path: string; reason: string }>
  plans: Array<{ target: string; id: string; valid: boolean; errors: string[] }>
  /** Thư mục giữ bản cũ của file bị ghi đè và bản ghi của lần nhập. */
  backupDir?: string
}

export interface Config {
  maxBytes: number
  importDir: string
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

export class PlanBundles extends Service {
  static inject = ['authoring', 'actions']
  static Config = z.object({
    maxBytes: z.natural().default(10_000_000).description('Kích thước tối đa của một gói, đơn vị byte.'),
    importDir: z.string().default('.aitest/imports').description('Thư mục giữ bản cũ của file bị ghi đè và bản ghi mỗi lần nhập.'),
  })

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'bundles')
  }

  /** Thư mục gốc theo loại file, lấy từ cấu hình của plugin tương ứng (thứ tự: thư mục đầu tiên là nơi ghi khi nhập). */
  roots(): Record<BundleFileKind, string[]> {
    const kernel = this.ctx.get('kernel') as Kernel | undefined
    const rowConfig = (id: string) => (kernel?.rows.get(id)?.row.config ?? {}) as Record<string, unknown>
    const saveDir = String(rowConfig('authoring-save').dir ?? 'plans')
    const planDirs = (rowConfig('authoring-catalog').planDirs as string[] | undefined) ?? [saveDir]
    const library = this.ctx.get('library') as { config: { dirs: string[] } } | undefined
    const systems = this.ctx.get('systems') as { config: { dirs: string[] } } | undefined
    return {
      plan: [saveDir, ...planDirs.filter((d) => resolve(d) !== resolve(saveDir))].map((d) => resolve(d)),
      context: (library?.config.dirs ?? ['context']).map((d) => resolve(d)),
      system: (systems?.config.dirs ?? ['systems']).map((d) => resolve(d)),
    }
  }

  /** Đóng gói các plan (đường dẫn như `list_plans` trả về) cùng tài liệu và hệ thống plan dùng. */
  async export(paths: string[]): Promise<PlanBundle> {
    if (!paths.length) throw new Error('choose at least one plan to export')
    const roots = this.roots()
    const files = new Map<string, BundleFile>()
    const add = (kind: BundleFileKind, path: string, content: string) => {
      files.set(`${kind}:${path}`, { kind, path, content, sha256: sha(content) })
    }
    const plans: PlanBundle['plans'] = []
    const namespaces = new Set<string>()
    const systemIds = new Set<string>()
    const contextRefs = new Map<string, string>()

    for (const path of paths) {
      const file = resolve(path)
      const root = roots.plan.find((r) => isInside(r, file))
      if (!root) throw new Error(`plan ${path} is outside plan directories`)
      const content = await readFile(file, 'utf8')
      const result = await this.ctx.authoring.validate(content, file)
      if (!result.plan) throw new Error(`plan ${path} cannot be parsed: ${result.issues.map((i) => i.message).join('; ')}`)
      const plan: TestPlan = result.plan
      const rel = toPosix(relative(root, file))
      add('plan', rel, content)
      plans.push({ path: rel, id: plan.id, name: plan.name })
      for (const ns of plan.requires) namespaces.add(ns)
      for (const id of plan.systems ?? []) systemIds.add(id)
      for (const ref of plan.contextRefs ?? []) contextRefs.set(ref, ref)
    }

    // Tài liệu ngữ cảnh: lưu theo đường dẫn trong thư mục ngữ cảnh chứa nó.
    for (const ref of contextRefs.keys()) {
      const file = resolve(ref)
      const root = roots.context.find((r) => isInside(r, file))
      if (!root) throw new Error(`context document ${ref} is outside the context folders`)
      add('context', toPosix(relative(root, file)), await readFile(file, 'utf8'))
    }

    // Hệ thống: service.yml, formulas.yml, và file service.yml tham chiếu (OpenAPI, tài liệu), gom vào thư mục hệ thống.
    const catalog = (this.ctx.get('systems') as { load(): Promise<{ systems: Array<{ id: string; file: string }> }> } | undefined)
    const known = catalog ? (await catalog.load()).systems : []
    for (const id of systemIds) {
      const system = known.find((s) => s.id === id)
      if (!system) throw new Error(`system ${id} is not in the catalog`)
      const serviceFile = resolve(system.file)
      const systemDir = dirname(serviceFile)
      const root = roots.system.find((r) => isInside(r, serviceFile))
      if (!root) throw new Error(`system ${id} is outside the catalog folders`)
      const prefix = toPosix(relative(root, systemDir))
      const doc = parseDocument(await readFile(serviceFile, 'utf8'))
      const bring = async (raw: unknown, into: string): Promise<string | undefined> => {
        if (typeof raw !== 'string' || /^[a-z]+:\/\//i.test(raw)) return undefined
        const source = resolve(systemDir, raw)
        if (!isInside(process.cwd(), source)) throw new Error(`system ${id} references ${raw}, outside the working directory`)
        const inside = isInside(systemDir, source)
        const local = inside ? toPosix(relative(systemDir, source)) : `${into}/${basename(source)}`
        add('system', `${prefix}/${local}`, await readFile(source, 'utf8'))
        return local
      }
      const openapi = doc.getIn(['http', 'openapi'])
      const newOpenapi = await bring(openapi, 'openapi')
      if (newOpenapi && newOpenapi !== openapi) doc.setIn(['http', 'openapi'], newOpenapi)
      const docs = doc.get('docs')
      if (isSeq(docs)) {
        for (const [i, item] of docs.items.entries()) {
          const raw = isScalar(item) ? item.value : item
          const local = await bring(raw, 'docs')
          if (local && local !== raw) docs.items[i] = doc.createNode(local)
        }
      }
      add('system', `${prefix}/service.yml`, doc.toString(YAML_FORMAT))
      const formulas = await readFile(join(systemDir, 'formulas.yml'), 'utf8').catch(() => undefined)
      if (formulas !== undefined) add('system', `${prefix}/formulas.yml`, formulas)
    }

    const bundle: PlanBundle = {
      format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: new Date().toISOString(), plans,
      files: [...files.values()],
      requirements: { namespaces: [...namespaces].sort(), systems: [...systemIds].sort() },
    }
    const size = Buffer.byteLength(JSON.stringify(bundle))
    if (size > this.config.maxBytes) throw new Error(`bundle is ${size} bytes, over the limit of ${this.config.maxBytes}`)
    return bundle
  }

  /** Kiểm tra gói và so với môi trường đích; không ghi gì. */
  async preview(raw: unknown): Promise<ImportPreview> {
    const bundle = this.parse(raw)
    const roots = this.roots()
    const items: ImportItem[] = []
    const existing = await this.existingPlans()
    for (const f of bundle.files) {
      const item: ImportItem = { kind: f.kind, path: f.path, status: 'new' }
      // Plan cùng mã đã có trên máy đích: cập nhật tại chỗ, không tạo bản thứ hai cùng mã.
      const id = f.kind === 'plan' ? bundle.plans.find((p) => p.path === f.path)?.id : undefined
      const target = id && existing.has(id) ? resolve(existing.get(id)!) : this.targetOf(f, roots)
      if (typeof target !== 'string') {
        items.push({ ...item, status: 'blocked', reason: target.error })
        continue
      }
      item.target = toPosix(relative(process.cwd(), target))
      const current = await readFile(target, 'utf8').catch(() => undefined)
      const incoming = f.kind === 'plan' ? this.rewritePlan(f.content, bundle, roots) : f.content
      items.push(current === undefined ? item : { ...item, status: current === incoming ? 'same' : 'changed', ...(current === incoming ? {} : { reason: 'a different version exists on this machine; kept unless you choose to overwrite' }) })
    }

    // OpenAPI, tài liệu của một hệ thống chỉ có nghĩa khi `service.yml` của gói được ghi.
    for (const item of items) {
      if (item.kind !== 'system' || item.path.endsWith('/service.yml') || item.path.endsWith('/formulas.yml')) continue
      const service = `${item.path.split('/')[0]}/service.yml`
      const owner = items.find((i) => i.kind === 'system' && i.path === service)
      if (owner && owner.status !== 'new' && item.status === 'new') item.dependsOn = `system:${service}`
    }

    const warnings: string[] = []
    const namespaces = new Set(this.ctx.actions.list({ kind: 'case', namespaces: new Set(), phase: 'setup' }).map((a) => a.namespace))
    const missingNs = bundle.requirements.namespaces.filter((n) => !namespaces.has(n))
    if (missingNs.length) warnings.push(`no tool for namespaces ${missingNs.join(', ')}: add them on the Plugin page or with propose_tool before running`)
    const catalog = this.ctx.get('systems') as { load(): Promise<{ systems: Array<{ id: string }>; env: { name: string; systems: Record<string, { url?: string }> } }> } | undefined
    if (catalog && bundle.requirements.systems.length) {
      const loaded = await catalog.load()
      for (const id of bundle.requirements.systems) {
        const inBundle = bundle.files.some((f) => f.kind === 'system' && f.path.startsWith(`${id}/`))
        if (!inBundle && !loaded.systems.some((s) => s.id === id)) warnings.push(`system ${id} is neither in the bundle nor in this catalog`)
        if (!loaded.env.systems[id]?.url) warnings.push(`environment ${loaded.env.name} has no url for ${id}: add it to envs/${loaded.env.name}.yml`)
      }
    }
    return { plans: bundle.plans, items, warnings }
  }

  /**
   * Nhập gói. File mới được ghi; file giống hệt bỏ qua; file khác bản đang có chỉ ghi khi nằm trong `overwrite`
   * (theo `kind:path`); file bị chặn luôn bỏ qua. Bản cũ được giữ trong thư mục nhập.
   */
  async import(raw: unknown, options: { overwrite?: string[] } = {}): Promise<ImportResult> {
    const bundle = this.parse(raw)
    const roots = this.roots()
    const preview = await this.preview(bundle)
    const overwrite = new Set(options.overwrite ?? [])
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = resolve(this.config.importDir, stamp)
    const result: ImportResult = { written: [], skipped: [], plans: [] }

    for (const item of preview.items) {
      const file = bundle.files.find((f) => f.kind === item.kind && f.path === item.path)!
      const key = `${item.kind}:${item.path}`
      if (item.status === 'blocked') { result.skipped.push({ path: key, reason: item.reason ?? 'blocked' }); continue }
      if (item.status === 'same') { result.skipped.push({ path: key, reason: 'identical' }); continue }
      if (item.status === 'changed' && !overwrite.has(key)) { result.skipped.push({ path: key, reason: 'kept the version on this machine' }); continue }
      if (item.dependsOn && !result.written.some((w) => `${w.kind}:${w.path}` === item.dependsOn) && !overwrite.has(item.dependsOn)) {
        result.skipped.push({ path: key, reason: `only needed when ${item.dependsOn} is written` })
        continue
      }
      const target = resolve(item.target!)
      if (item.status === 'changed') {
        await mkdir(dirname(join(backupDir, item.target!)), { recursive: true })
        await writeFile(join(backupDir, item.target!), await readFile(target, 'utf8'))
      }
      const content = item.kind === 'plan' ? this.rewritePlan(file.content, bundle, roots) : file.content
      await mkdir(dirname(target), { recursive: true })
      await writeFile(`${target}.tmp`, content)
      await rename(`${target}.tmp`, target)
      result.written.push({ kind: item.kind, path: item.path, target: item.target!, overwritten: item.status === 'changed' })
    }

    // Kiểm tra lại plan trên môi trường đích (đã có tài liệu và hệ thống vừa nhập).
    for (const p of bundle.plans) {
      const item = preview.items.find((i) => i.kind === 'plan' && i.path === p.path)
      if (!item?.target) continue
      const content = await readFile(resolve(item.target), 'utf8').catch(() => undefined)
      if (content === undefined) continue
      const validation = await this.ctx.authoring.validate(content, resolve(item.target))
      result.plans.push({ target: item.target, id: p.id, valid: validation.valid, errors: validation.issues.filter((i) => i.level === 'error').map((i) => i.message) })
    }

    await mkdir(backupDir, { recursive: true })
    await writeFile(join(backupDir, 'import.json'), `${JSON.stringify({ importedAt: new Date().toISOString(), bundlePlans: bundle.plans, ...result }, null, 2)}\n`)
    result.backupDir = toPosix(relative(process.cwd(), backupDir))
    return result
  }

  /** Plan đang có trên máy đích theo mã (đọc qua `list_plans`, cùng thư mục plan với agent soạn plan). */
  private async existingPlans(): Promise<Map<string, string>> {
    const scope = { kind: 'authoring' as const, id: 'plan-bundle', namespaces: new Set(['authoring']), phase: 'user' as const, signal: new AbortController().signal, log: () => {} }
    const outcome = await this.ctx.actions.invoke(scope, 'list_plans', {}).catch(() => undefined)
    const plans = (outcome?.value as { plans?: Array<{ path: string; id?: string }> } | undefined)?.plans ?? []
    return new Map(plans.filter((p) => p.id).map((p) => [p.id!, p.path]))
  }

  private parse(raw: unknown): PlanBundle {
    const bundle = (typeof raw === 'string' ? JSON.parse(raw) : raw) as PlanBundle
    if (!bundle || bundle.format !== BUNDLE_FORMAT) throw new Error('not an aitest plan bundle')
    if (bundle.version !== BUNDLE_VERSION) throw new Error(`bundle version ${bundle.version} is not supported (expected ${BUNDLE_VERSION})`)
    if (!Array.isArray(bundle.files) || !Array.isArray(bundle.plans)) throw new Error('bundle has no files')
    if (Buffer.byteLength(JSON.stringify(bundle)) > this.config.maxBytes) throw new Error('bundle is too large')
    for (const f of bundle.files) {
      if (!['plan', 'context', 'system'].includes(f.kind) || typeof f.path !== 'string' || typeof f.content !== 'string') throw new Error('bundle has an invalid file entry')
      if (sha(f.content) !== f.sha256) throw new Error(`file ${f.kind}:${f.path} is corrupted (checksum mismatch)`)
    }
    return bundle
  }

  /** Nơi ghi một file trên máy đích; đường dẫn không an toàn hoặc sai loại thì trả lỗi. */
  private targetOf(f: BundleFile, roots: Record<BundleFileKind, string[]>): string | { error: string } {
    if (!f.path || f.path.startsWith('/') || /^[a-z]:/i.test(f.path) || f.path.split('/').some((s) => s === '..' || s === '')) {
      return { error: `unsafe path ${f.path}` }
    }
    if (f.kind === 'plan' && !f.path.endsWith('.plan.yaml')) return { error: 'plan files must end with .plan.yaml' }
    const root = roots[f.kind][0]
    if (!root) return { error: `this machine has no folder for ${f.kind} files` }
    const target = resolve(root, f.path)
    if (!isInside(root, target)) return { error: `unsafe path ${f.path}` }
    return target
  }

  /** `contextRefs` của plan trỏ tới vị trí tài liệu trên máy đích (thư mục ngữ cảnh có thể khác máy xuất). */
  private rewritePlan(content: string, bundle: PlanBundle, roots: Record<BundleFileKind, string[]>): string {
    const contextRoot = roots.context[0]
    if (!contextRoot) return content
    const doc = parseDocument(content)
    const refs = doc.get('contextRefs')
    if (!isSeq(refs)) return content
    let changed = false
    refs.items.forEach((item, i) => {
      const ref = String(isScalar(item) ? item.value : item)
      // Tài liệu trong gói: khớp theo phần đuôi đường dẫn (đường dẫn trong thư mục ngữ cảnh của máy xuất).
      const match = bundle.files.filter((f) => f.kind === 'context' && (ref === f.path || ref.endsWith(`/${f.path}`)))
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (!match) return
      const next = toPosix(relative(process.cwd(), resolve(contextRoot, match.path)))
      if (next !== ref) { refs.items[i] = doc.createNode(next); changed = true }
    })
    return changed ? doc.toString(YAML_FORMAT) : content
  }

  /** Ghi gói ra file JSON. */
  async writeBundle(bundle: PlanBundle, file: string) {
    await mkdir(dirname(resolve(file)), { recursive: true })
    await writeFile(resolve(file), `${JSON.stringify(bundle, null, 2)}\n`)
    return (await stat(resolve(file))).size
  }
}

export default PlanBundles

/** Ghi lại YAML giữ định dạng người viết: không tự xuống dòng chuỗi dài, không thêm khoảng trắng trong `[a, b]`. */
const YAML_FORMAT = { lineWidth: 0, flowCollectionPadding: false } as const
