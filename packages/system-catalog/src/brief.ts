import { stringify as stringifyYaml } from 'yaml'
import type {} from '@aitest/authoring'
import { errorMessage, type ActionScope, type Context } from '@aitest/core'
import { channelIn, describeKnowledge, type Catalog, type DataStore, type HttpOperation, type SystemSpec } from './model.ts'
import { compactSchema, sampleValue } from './schema.ts'
import type {} from './index.ts'

/**
 * Gói ngữ cảnh của một hệ thống: mọi thứ agent cần để soạn plan, trong một lời gọi, dạng Markdown súc tích.
 * - hợp đồng: operation với schema rút gọn, kênh sự kiện, consumer, công thức;
 * - **hồ sơ dữ liệu thật**: cột, kiểu, giá trị hay gặp (trạng thái, chiều lệnh…), dòng mẫu, đọc bằng tool chỉ đọc;
 * - liên quan: plan đã có (kèm operation chúng dùng, làm mẫu), skill, tài liệu trong thư mục ngữ cảnh, ghi chú kb.
 * Hồ sơ dữ liệu lưu tạm theo hệ thống và môi trường (`profileTtl`), phần còn lại đọc lại mỗi lần.
 * Tool `new_plan_skeleton` sinh khung plan từ catalog, bước có cấu trúc, body mẫu hợp lệ theo schema.
 */
export const name = 'system-catalog-brief'
export const inject = ['systems', 'actions', 'authoring']

const PROFILE_TTL = 10 * 60_000
const MAX_ENUM_VALUES = 12
const MAX_ENUM_COLUMNS = 12

interface TableProfile {
  table: string
  rows?: number
  columns: Array<{ name: string; type?: string }>
  values: Record<string, Array<{ value: unknown; count: number }>>
  sample: unknown[]
  error?: string
}

export function apply(ctx: Context) {
  const profiles = new Map<string, { at: number; value: Promise<TableProfile[]> }>()

  /** Gọi tool truy vấn chỉ đọc của namespace dữ liệu; trả danh sách dòng, lỗi thì ném. */
  const query = async (parent: ActionScope, namespace: string, sql: string): Promise<Array<Record<string, unknown>>> => {
    const scope: ActionScope = {
      kind: 'explore', id: parent.id, env: parent.env, phase: 'agent', signal: parent.signal,
      get namespaces() { return new Set(ctx.actions.list({ kind: 'explore', namespaces: new Set(), phase: 'setup', env: parent.env }).map((a) => a.namespace)) },
      log: () => {},
    }
    const tool = ctx.actions.list({ kind: 'explore', namespaces: new Set([namespace]), phase: 'setup', env: parent.env })
      .find((a) => a.namespace === namespace && /_query$/.test(a.name) && (a.inputSchema.properties as Record<string, unknown> | undefined)?.sql)
    if (!tool) throw new Error(`no read-only query tool for namespace ${namespace}`)
    const outcome = await ctx.actions.invoke(scope, tool.name, { sql })
    if (outcome.status !== 'ok') throw new Error(outcome.error)
    const value = outcome.value as { rows?: unknown } | unknown[]
    const rows = Array.isArray(value) ? value : (value as { rows?: unknown }).rows
    if (!Array.isArray(rows)) throw new Error('query result has no rows')
    return rows as Array<Record<string, unknown>>
  }

  /** Hồ sơ một bảng: cột và kiểu (SQLite, rồi information_schema, rồi suy từ dòng mẫu), số dòng, giá trị hay gặp, dòng mẫu. */
  const profileTable = async (scope: ActionScope, store: DataStore, table: string): Promise<TableProfile> => {
    if (!/^[A-Za-z_][\w.]*$/.test(table)) return { table, columns: [], values: {}, sample: [], error: 'invalid table name' }
    const profile: TableProfile = { table, columns: [], values: {}, sample: [] }
    try {
      profile.sample = await query(scope, store.namespace, `SELECT * FROM ${table} ORDER BY 1 DESC LIMIT 3`)
        .catch(() => query(scope, store.namespace, `SELECT * FROM ${table} LIMIT 3`))
      const pragma = await query(scope, store.namespace, `SELECT name, type FROM pragma_table_info('${table}')`).catch(() => [])
      const info = pragma.length ? pragma : await query(scope, store.namespace,
        `SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = '${table.split('.').pop()}' ORDER BY ordinal_position`).catch(() => [])
      profile.columns = info.length
        ? info.map((c) => ({ name: String(c.name), type: c.type ? String(c.type) : undefined }))
        : Object.keys((profile.sample[0] ?? {}) as object).map((name) => ({ name }))
      const count = await query(scope, store.namespace, `SELECT COUNT(*) AS n FROM ${table}`).catch(() => [])
      profile.rows = count[0] ? Number(Object.values(count[0])[0]) : undefined
      // Giá trị hay gặp của cột dạng chữ: tên trạng thái, chiều lệnh… là thứ agent hay phải đoán.
      const candidates = profile.columns
        .filter((c) => /^[A-Za-z_]\w*$/.test(c.name) && (!c.type || /char|text|string|enum|bool/i.test(c.type)) && !/(^id$|_id$|_at$|url|name|note|desc|email|json)/i.test(c.name))
        .slice(0, MAX_ENUM_COLUMNS)
      for (const column of candidates) {
        const rows = await query(scope, store.namespace,
          `SELECT ${column.name} AS v, COUNT(*) AS n FROM ${table} GROUP BY ${column.name} ORDER BY n DESC LIMIT ${MAX_ENUM_VALUES + 1}`).catch(() => [])
        if (rows.length && rows.length <= MAX_ENUM_VALUES) profile.values[column.name] = rows.map((r) => ({ value: r.v, count: Number(r.n) }))
      }
    } catch (error) {
      profile.error = errorMessage(error).split('\n')[0]
    }
    return profile
  }

  const profilesOf = (scope: ActionScope, system: SystemSpec, refresh: boolean) => {
    const key = `${system.id}@${scope.env ?? ''}`
    const cached = profiles.get(key)
    if (cached && !refresh && Date.now() - cached.at < PROFILE_TTL) return cached.value
    const value = (async () => {
      const out: TableProfile[] = []
      for (const store of system.data.filter((d) => d.profile)) {
        for (const table of store.tables) out.push(await profileTable(scope, store, table.name))
      }
      return out
    })()
    profiles.set(key, { at: Date.now(), value })
    return value
  }

  ctx.actions.register({
    name: 'get_system_context',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: [
      'Lấy toàn bộ ngữ cảnh của một hệ thống trong một lời gọi: API (operation, schema request và response), kênh sự kiện,',
      'consumer, công thức, dữ liệu thật trong DB (cột, giá trị hay gặp như tên trạng thái, dòng mẫu), plan đã có kèm',
      'operation chúng dùng, skill, tài liệu và ghi chú kb liên quan. Gọi đầu tiên khi soạn plan cho một hệ thống.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', description: 'Id hệ thống từ `list_systems`.' },
        refresh: { type: 'boolean', default: false, description: 'Đọc lại dữ liệu thật thay vì dùng bản lưu tạm (10 phút).' },
      },
      required: ['system'],
      additionalProperties: false,
    },
    async execute(args: { system: string; refresh?: boolean }, { scope }) {
      const catalog = await ctx.systems.load(scope.env)
      const system = catalog.systems.find((s) => s.id === args.system)
      if (!system) throw new Error(`unknown system ${args.system}; known: ${catalog.systems.map((s) => s.id).join(', ') || 'none'}`)
      const [tables, related] = await Promise.all([profilesOf(scope, system, !!args.refresh), relatedOf(scope, system)])
      return { system: system.id, env: catalog.env.name, context: renderBrief(system, catalog, tables, related) }
    },
    present: (args) => ({ kind: 'generic', title: `Ngữ cảnh hệ thống ${args.system}` }),
  })

  /** Plan, skill, tài liệu, ghi chú kb gắn với hệ thống; nguồn nào không có thì bỏ qua. */
  const relatedOf = async (scope: ActionScope, system: SystemSpec) => {
    const call = async (tool: string, args: Record<string, unknown>) => {
      if (!ctx.actions.get(tool)) return undefined
      const outcome = await ctx.actions.invoke({ ...scope, log: () => {} }, tool, args)
      return outcome.status === 'ok' ? outcome.value : undefined
    }
    const plans = ((await call('list_plans', {})) as { plans?: Array<{ path: string; id?: string; name?: string; systems?: string[]; operations?: string[]; cases?: Array<{ id: string; title: string }> }> } | undefined)?.plans ?? []
    const notes: Array<{ id: string; type: string; title: string; status?: string }> = []
    for (const feature of system.features) {
      const value = (await call('kb_list', { feature })) as { notes?: typeof notes } | undefined
      notes.push(...(value?.notes ?? []))
    }
    const library = ctx.get('library') as { relatedTo(id: string): Promise<{ docs: Array<{ id: string; title: string; description?: string }>; skills: Array<{ name: string; description: string }> }> } | undefined
    const lib = library ? await library.relatedTo(system.id).catch(() => ({ docs: [], skills: [] })) : { docs: [], skills: [] }
    return { plans: plans.filter((p) => p.systems?.includes(system.id)), notes, ...lib }
  }

  ctx.actions.register({
    name: 'new_plan_skeleton',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: [
      'Sinh khung plan YAML từ catalog: mỗi operation một case, bước có cấu trúc `call:` với body mẫu hợp lệ theo schema,',
      'expectation mã HTTP thành công. Dùng làm điểm bắt đầu rồi sửa theo yêu cầu; thay các giá trị `TODO_…`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string' },
        operations: { type: 'array', items: { type: 'string' }, description: 'Id operation; bỏ trống để lấy mọi operation.' },
        id: { type: 'string', description: 'Mã plan, ví dụ `TP-ORDER-CANCEL-001`.' },
        name: { type: 'string', description: 'Tên plan.' },
      },
      required: ['system'],
      additionalProperties: false,
    },
    async execute(args: { system: string; operations?: string[]; id?: string; name?: string }, { scope }) {
      const catalog = await ctx.systems.load(scope.env)
      const system = catalog.systems.find((s) => s.id === args.system)
      if (!system) throw new Error(`unknown system ${args.system}`)
      const ops = args.operations?.length
        ? args.operations.map((id) => {
          const op = system.operations.find((o) => o.id === id)
          if (!op) throw new Error(`${system.id} has no operation ${id}; operations: ${system.operations.map((o) => o.id).join(', ')}`)
          return op
        })
        : system.operations
      return { yaml: skeleton(system, ops, args.id, args.name) }
    },
    present: (args, outcome) => ({ kind: 'code', title: `Khung plan ${args.system}`, language: 'yaml', text: (outcome.value as { yaml?: string } | undefined)?.yaml }),
  })

  ctx.authoring.guideSection({
    id: 'systems/brief',
    order: 31,
    render: () => [
      '## Nắm ngữ cảnh nhanh',
      '- Bắt đầu bằng `get_system_context` cho hệ thống liên quan: một lời gọi có API, dữ liệu thật (tên trạng thái, cột), plan mẫu, skill, tài liệu, ghi chú.',
      '- Đọc một plan đã có dùng cùng operation (danh sách trong ngữ cảnh) bằng `read_plan` để theo đúng phong cách.',
      '- Plan mới: gọi `new_plan_skeleton` rồi sửa; giữ bước có cấu trúc `call:` cho lời gọi API để plan được kiểm theo OpenAPI.',
    ].join('\n'),
  })
}

interface Related {
  plans: Array<{ path: string; id?: string; name?: string; operations?: string[]; cases?: Array<{ id: string; title: string }> }>
  notes: Array<{ id: string; type: string; title: string; status?: string }>
  docs: Array<{ id: string; title: string; description?: string }>
  skills: Array<{ name: string; description: string }>
}

/** Cột có trong DB nhưng chưa được giải thích, giá trị thật chưa có trong `values` đã khai báo. */
function knowledgeGaps(system: SystemSpec, profile: TableProfile): string[] {
  const declared = system.data.flatMap((d) => d.tables).find((t) => t.name === profile.table)
  if (!declared) return []
  const gaps: string[] = []
  const known = new Map(declared.columns.map((c) => [c.name, c]))
  const missing = profile.columns.map((c) => c.name).filter((n) => !known.has(n))
  if (missing.length && declared.columns.length) gaps.push(`cột ${missing.join(', ')}`)
  for (const [column, values] of Object.entries(profile.values)) {
    const declaredValues = known.get(column)?.values
    if (!declaredValues) continue
    const extra = values.map((v) => String(v.value)).filter((v) => !(v in declaredValues))
    if (extra.length) gaps.push(`giá trị ${extra.join(', ')} của \`${column}\``)
  }
  return gaps
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

export function renderBrief(system: SystemSpec, catalog: Catalog, tables: TableProfile[], related: Related): string {
  const url = catalog.env.systems[system.id]?.url
  const lines = [`# ${system.id}: ${system.title} (môi trường ${catalog.env.name})`]
  if (system.description) lines.push(system.description)
  if (url) lines.push(`Base URL: \`${url}\` (dùng \`{{${system.id}.url}}\` trong plan).`)
  if (system.operations.length) {
    lines.push('', '## API')
    for (const op of system.operations) lines.push(renderOperation(op))
  }
  if (system.events.length) {
    lines.push('', '## Kênh sự kiện')
    for (const raw of system.events) {
      const c = channelIn(raw, system.id, catalog.env)
      lines.push(`- \`${c.id}\` (${c.kind} ${c.topic ?? c.exchange}; tool namespace \`${catalog.env.brokers[c.broker]?.namespace ?? '?'}\`${c.correlation ? `; lọc theo \`${c.correlation}\`` : ''}): ${c.messages.map((m) => m.name).join(', ')}${c.description ? `. ${c.description}` : ''}`)
    }
  }
  if (system.consumers.length) {
    lines.push('', '## Consumer')
    for (const c of system.consumers) lines.push(`- \`${c.group}\`${c.description ? `: ${c.description}` : ''}${c.effects.length ? ` Hệ quả: ${c.effects.join('; ')}.` : ''}`)
  }
  const formulas = Object.entries(system.formulas)
  if (formulas.length) {
    lines.push('', '## Công thức (gọi như hàm trong `check.expr`)')
    for (const [n, f] of formulas) lines.push(`- \`${n}(${f.params.join(', ')})\`${f.desc ? `: ${f.desc}` : ''}`)
  }
  const knowledge = describeKnowledge(system)
  if (knowledge.length) {
    lines.push('', '## Ngữ cảnh dùng chung đã khai báo',
      'Agent chạy test thấy phần này với mọi plan khai báo service trong `systems`; không chép lại vào `context` của plan.', ...knowledge)
  }
  if (system.data.length) {
    lines.push('', '## Dữ liệu thật')
    for (const store of system.data) lines.push(`Namespace \`${store.namespace}\`${store.description ? ` (${store.description})` : ''}:`)
    for (const t of tables) {
      lines.push(`### Bảng \`${t.table}\`${t.rows !== undefined ? ` (${t.rows} dòng)` : ''}`)
      if (t.error) { lines.push(`Không đọc được: ${t.error}`); continue }
      lines.push(`Cột: ${t.columns.map((c) => `${c.name}${c.type ? ` ${c.type.toLowerCase()}` : ''}`).join(', ')}`)
      for (const [column, values] of Object.entries(t.values)) {
        lines.push(`Giá trị \`${column}\`: ${values.map((v) => `${show(v.value)} (${v.count})`).join(', ')}`)
      }
      if (t.sample.length) lines.push('Dòng mẫu:', '```json', ...t.sample.map((r) => JSON.stringify(r)), '```')
      const gaps = knowledgeGaps(system, t)
      if (gaps.length) lines.push(`Chưa khai báo trong catalog (đề xuất bằng \`propose_system_knowledge\` khi biết ý nghĩa): ${gaps.join('; ')}`)
    }
  }
  if (related.plans.length) {
    lines.push('', '## Plan đã có (đọc bằng `read_plan` để làm mẫu)')
    for (const p of related.plans) {
      lines.push(`- \`${p.path}\` ${p.id ?? ''}: ${p.name ?? ''}${p.operations?.length ? `; dùng ${p.operations.map((o) => o.split('.').pop()).join(', ')}` : ''}`)
      if (p.cases?.length) lines.push(`  case: ${p.cases.map((c) => `${c.id} ${c.title}`).join(' · ')}`)
    }
  }
  if (related.skills.length) {
    lines.push('', '## Skill liên quan (nạp bằng `use_skill`)', ...related.skills.map((s) => `- \`${s.name}\`: ${s.description}`))
  }
  if (related.docs.length || system.docs.length) {
    lines.push('', '## Tài liệu (đọc bằng `read_context_source`)')
    for (const d of system.docs) lines.push(`- \`${d}\` (đặc tả của service)`)
    for (const d of related.docs) lines.push(`- \`${d.id}\`: ${d.title}${d.description ? ` — ${d.description}` : ''}`)
  }
  if (related.notes.length) {
    lines.push('', '## Ghi chú kb (đọc bằng `kb_read`)', ...related.notes.map((n) => `- \`${n.id}\` [${n.type}${n.status ? `, ${n.status}` : ''}]: ${n.title}`))
  }
  return lines.join('\n')
}

function renderOperation(op: HttpOperation): string {
  const params = op.params.map((p) => `${p.in === 'path' ? '' : `${p.in} `}${p.name}${p.required ? '*' : ''}: ${compactSchema(p.schema)}`)
  const responses = Object.entries(op.responses).map(([code, r]) => `${code}${r.schema ? ` ${compactSchema(r.schema)}` : ''}${r.description ? ` (${r.description})` : ''}`)
  return [
    `- \`${op.id}\` ${op.method} ${op.path}${op.summary ? `: ${op.summary}` : ''}`,
    params.length ? `  tham số: ${params.join(', ')}` : '',
    op.requestBody ? `  body: ${compactSchema(op.requestBody)}` : '',
    responses.length ? `  trả về: ${responses.join('; ')}` : '',
  ].filter(Boolean).join('\n')
}

/** Khung plan: mỗi operation một case với bước có cấu trúc và body mẫu; expectation mã thành công đầu tiên. */
export function skeleton(system: SystemSpec, ops: HttpOperation[], id?: string, name?: string): string {
  const namespaces = new Set(['http', ...system.data.map((d) => d.namespace)])
  const plan = {
    id: id ?? `TP-${system.id.toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-001`,
    name: name ?? `Kiểm thử ${system.title}`,
    requires: [...namespaces],
    systems: [system.id],
    cases: ops.map((op, i) => {
      const success = Object.keys(op.responses).find((c) => /^2\d\d$/.test(c)) ?? '200'
      const path = Object.fromEntries(op.params.filter((p) => p.in === 'path').map((p) => [p.name, `{{${p.name}}}`]))
      const query = Object.fromEntries(op.params.filter((p) => p.in === 'query' && p.required).map((p) => [p.name, sampleValue(p.schema, p.name)]))
      return {
        id: `C${String(i + 1).padStart(2, '0')}`,
        title: op.summary ?? op.id,
        steps: [{
          call: `${system.id}.${op.id}`,
          ...(Object.keys(path).length ? { path } : {}),
          ...(Object.keys(query).length ? { query } : {}),
          ...(op.requestBody ? { body: sampleValue(op.requestBody) } : {}),
        }],
        expect: [{ id: `http-${success}`, desc: `API trả HTTP ${success}`, check: { op: 'eq', value: Number(success) } }],
      }
    }),
  }
  const pathVars = ops.flatMap((op) => op.params.filter((p) => p.in === 'path').map((p) => p.name))
  const note = pathVars.length ? `# Biến cần chuẩn bị (setup có save hoặc inputs): ${[...new Set(pathVars)].join(', ')}\n` : ''
  return `# yaml-language-server: $schema=../../docs/plan.schema.json\n${note}${stringifyYaml(plan, { lineWidth: 120 })}`
}
