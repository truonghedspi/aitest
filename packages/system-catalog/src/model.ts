import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { errorMessage, interpolate, toPosix, z } from '@aitest/core'

/**
 * Mô hình hệ thống dưới kiểm thử, tách thành hai phần:
 * - `systems/<id>/service.yml`: hợp đồng của service (HTTP, sự kiện, consumer, dữ liệu), giống nhau mọi môi trường.
 * - `envs/<tên>.yml`: địa chỉ của service và ánh xạ broker → namespace tool cho từng môi trường.
 * Hợp đồng HTTP lấy từ OpenAPI của service khi có, không chép tay.
 */

export interface HttpParam {
  name: string
  in: string
  required: boolean
  description?: string
  schema?: unknown
}

export interface HttpOperation {
  id: string
  method: string
  path: string
  summary?: string
  description?: string
  params: HttpParam[]
  requestBody?: unknown
  responses: Record<string, { description?: string; schema?: unknown }>
  source: 'openapi' | 'inline'
}

export interface EventMessage {
  name: string
  description?: string
  routingKey?: string
  example?: unknown
}

export interface EventChannel {
  id: string
  kind: 'kafka' | 'rabbitmq'
  broker: string
  topic?: string
  exchange?: string
  key?: string
  /** Path tới mã nghiệp vụ trong bản tin, dùng để lọc đúng bản tin của lượt chạy. */
  correlation?: string
  description?: string
  messages: EventMessage[]
}

export interface Consumer {
  group: string
  broker?: string
  description?: string
  consumes: string[]
  effects: string[]
}

export interface DataStore {
  namespace: string
  description?: string
  tables: string[]
}

export interface SystemSpec {
  id: string
  title: string
  description?: string
  owner?: string
  docs: string[]
  operations: HttpOperation[]
  events: EventChannel[]
  consumers: Consumer[]
  data: DataStore[]
  /** File `service.yml`, tương đối với thư mục làm việc. */
  file: string
}

export interface EnvSpec {
  name: string
  systems: Record<string, { url?: string }>
  brokers: Record<string, { namespace: string; description?: string }>
  file?: string
}

export interface CatalogIssue {
  file: string
  error: string
}

export interface Catalog {
  systems: SystemSpec[]
  env: EnvSpec
  issues: CatalogIssue[]
}

const Message = z.object({
  name: z.string().required(),
  description: z.string(),
  routingKey: z.string(),
  example: z.any(),
})

const ServiceSchema = z.object({
  id: z.string().pattern(/^[a-z][a-z0-9-]*$/).required(),
  title: z.string().required(),
  description: z.string(),
  owner: z.string(),
  docs: z.array(z.string()).default([]),
  http: z.object({
    openapi: z.string().description('Đường dẫn OpenAPI 3 (YAML hoặc JSON), tương đối với service.yml.'),
    operations: z.dict(z.object({
      method: z.string(),
      path: z.string(),
      summary: z.string(),
      description: z.string(),
      requestBody: z.any(),
    })).default({}),
  }),
  events: z.array(z.object({
    id: z.string().pattern(/^[a-z][a-z0-9-]*$/).required(),
    kind: z.union(['kafka', 'rabbitmq'] as const).required(),
    broker: z.string().required(),
    topic: z.string(),
    exchange: z.string(),
    key: z.string(),
    correlation: z.string(),
    description: z.string(),
    messages: z.array(Message).default([]),
  })).default([]),
  consumers: z.array(z.object({
    group: z.string().required(),
    broker: z.string(),
    description: z.string(),
    consumes: z.array(z.string()).default([]),
    effects: z.array(z.string()).default([]),
  })).default([]),
  data: z.array(z.object({
    namespace: z.string().required(),
    description: z.string(),
    tables: z.array(z.string()).default([]),
  })).default([]),
})

const EnvSchema = z.object({
  name: z.string(),
  systems: z.dict(z.object({ url: z.string() })).default({}),
  brokers: z.dict(z.object({ namespace: z.string().required(), description: z.string() })).default({}),
})

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

const display = (file: string) => toPosix(relative(process.cwd(), file))

/** Nạp mọi `<dir>/<id>/service.yml`. File lỗi được ghi vào `issues`, không làm hỏng cả catalog. */
export async function loadSystems(dirs: string[]): Promise<{ systems: SystemSpec[]; issues: CatalogIssue[] }> {
  const systems: SystemSpec[] = []
  const issues: CatalogIssue[] = []
  for (const dir of dirs) {
    const root = resolve(dir)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(root, entry.name, 'service.yml')
      if (!(await stat(file).then((s) => s.isFile(), () => false))) continue
      try {
        const system = await loadSystem(file)
        if (system.id !== entry.name) throw new Error(`id ${system.id} must match directory name ${entry.name}`)
        if (systems.some((s) => s.id === system.id)) throw new Error(`duplicate system id ${system.id}`)
        systems.push(system)
      } catch (error) {
        issues.push({ file: display(file), error: errorMessage(error).split('\n')[0] })
      }
    }
  }
  return { systems, issues }
}

export async function loadSystem(file: string): Promise<SystemSpec> {
  const data = ServiceSchema(parseYaml(await readFile(file, 'utf8')))
  const base = dirname(file)
  const operations = data.http?.openapi ? await loadOpenApi(resolve(base, data.http.openapi)) : []
  // Operation khai báo trực tiếp bổ sung hoặc ghi đè operation cùng id từ OpenAPI.
  for (const [id, op] of Object.entries(data.http?.operations ?? {})) {
    const existing = operations.find((o) => o.id === id)
    if (existing) Object.assign(existing, Object.fromEntries(Object.entries(op).filter(([, v]) => v !== undefined)))
    else {
      if (!op.method || !op.path) throw new Error(`operation ${id} needs method and path`)
      operations.push({ id, method: op.method.toUpperCase(), path: op.path, summary: op.summary, description: op.description, params: [], requestBody: op.requestBody, responses: {}, source: 'inline' })
    }
  }
  const ids = new Set<string>()
  for (const op of operations) {
    if (ids.has(op.id)) throw new Error(`duplicate operation id ${op.id}`)
    ids.add(op.id)
  }
  for (const channel of data.events) {
    if (ids.has(channel.id)) throw new Error(`event channel ${channel.id} has the same id as an operation`)
    if (channel.kind === 'kafka' && !channel.topic) throw new Error(`event channel ${channel.id}: kafka needs topic`)
    if (channel.kind === 'rabbitmq' && !channel.exchange) throw new Error(`event channel ${channel.id}: rabbitmq needs exchange`)
    ids.add(channel.id)
  }
  return {
    id: data.id,
    title: data.title,
    description: data.description,
    owner: data.owner,
    docs: data.docs.map((d) => display(resolve(base, d))),
    operations,
    events: data.events as EventChannel[],
    consumers: data.consumers,
    data: data.data,
    file: display(file),
  }
}

/** Đọc operation từ OpenAPI 3: id lấy từ `operationId`, `$ref` nội bộ được thay bằng nội dung. */
export async function loadOpenApi(file: string): Promise<HttpOperation[]> {
  let doc: any
  try {
    doc = parseYaml(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read OpenAPI ${display(file)}: ${errorMessage(error)}`)
  }
  if (!doc?.paths) throw new Error(`${display(file)} has no paths`)
  const deref = (value: unknown, depth = 0): unknown => {
    if (depth > 8 || !value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((v) => deref(v, depth + 1))
    const ref = (value as { $ref?: unknown }).$ref
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      const target = ref.slice(2).split('/').reduce<any>((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc)
      return deref(target, depth + 1)
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deref(v, depth + 1)]))
  }
  const operations: HttpOperation[] = []
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    const shared = (item.parameters ?? []) as unknown[]
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      const params = [...shared, ...(op.parameters ?? [])].map((p) => deref(p) as any).map((p) => ({
        name: p.name, in: p.in, required: !!p.required, description: p.description, schema: p.schema,
      }))
      const body = deref(op.requestBody) as any
      operations.push({
        id: op.operationId ?? `${method}${path.replace(/[^\w]+/g, '_')}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary,
        description: op.description,
        params,
        requestBody: body?.content?.['application/json']?.schema ?? (body?.content && Object.values<any>(body.content)[0]?.schema),
        responses: Object.fromEntries(Object.entries<any>(op.responses ?? {}).map(([code, r]) => {
          const response = deref(r) as any
          return [code, { description: response?.description, schema: response?.content?.['application/json']?.schema }]
        })),
        source: 'openapi',
      })
    }
  }
  return operations
}

/** Nạp `envs/<tên>.yml` và thay `${env.TÊN}`. Thiếu file thì trả môi trường rỗng kèm issue. */
export async function loadEnv(dir: string, name: string): Promise<{ env: EnvSpec; issues: CatalogIssue[] }> {
  const file = resolve(dir, `${name}.yml`)
  try {
    const data = EnvSchema(interpolate(parseYaml(await readFile(file, 'utf8'))))
    return { env: { name: data.name ?? name, systems: data.systems, brokers: data.brokers, file: display(file) }, issues: [] }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return {
      env: { name, systems: {}, brokers: {} },
      issues: [{ file: display(file), error: missing ? `environment ${name} not found` : errorMessage(error).split('\n')[0] }],
    }
  }
}

/** Biến do catalog cung cấp cho plan: `<system>.url`. */
export function systemVars(catalog: Catalog, ids: string[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  for (const id of ids) {
    const url = catalog.env.systems[id]?.url
    if (url) vars[`${id}.url`] = url.replace(/\/+$/, '')
  }
  return vars
}

/** Tên biến mà catalog cung cấp cho mỗi system; dùng để kiểm tra `{{...}}` trong plan. */
export const SYSTEM_VAR_KEYS = ['url']
