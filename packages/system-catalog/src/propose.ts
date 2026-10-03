import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml'
import type {} from '@aitest/authoring'
import { lineDiff, type Context } from '@aitest/core'
import { loadSystem } from './model.ts'
import type {} from './index.ts'

/**
 * `propose_system_knowledge`: agent soạn plan đề xuất đưa một sự thật dùng chung (quy tắc nghiệp vụ, ý nghĩa bảng, cột,
 * giá trị) lên catalog hệ thống thay vì chép vào `context` của từng plan. Người dùng duyệt trên thẻ kèm diff;
 * file `service.yml` được sửa giữ nguyên comment, rồi nạp thử trước khi ghi.
 */
export const name = 'system-catalog-propose'
export const inject = ['actions', 'systems', 'authoring']

type Change =
  | { kind: 'rule'; rule: string; table?: string }
  | { kind: 'table'; table: string; namespace?: string; desc: string }
  | { kind: 'column'; table: string; namespace?: string; column: string; type?: string; desc?: string; values?: Record<string, string> }

export function apply(ctx: Context) {
  ctx.actions.register({
    name: 'propose_system_knowledge',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    selfConfirm: true,
    evidence: false,
    description: [
      'Đề xuất ghi một sự thật dùng chung về hệ thống vào catalog (agent chạy test thấy với mọi plan khai báo hệ thống),',
      'thay vì chép vào `context` của plan: quy tắc nghiệp vụ (`kind: rule`), mô tả bảng (`table`), ý nghĩa và giá trị hợp lệ của cột (`column`).',
      'Người dùng duyệt kèm diff. Chỉ ghi điều đã kiểm chứng (đặc tả, dữ liệu thật, người dùng xác nhận).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', description: 'Mã hệ thống, ví dụ `order-service`.' },
        kind: { type: 'string', enum: ['rule', 'table', 'column'] },
        rule: { type: 'string', description: '`kind: rule`: một câu quy tắc; kèm `table` để gắn vào bảng.' },
        table: { type: 'string', description: 'Tên bảng (`table`, `column`, hoặc quy tắc của bảng).' },
        namespace: { type: 'string', description: 'Namespace dữ liệu, khi bảng chưa có trong catalog.' },
        column: { type: 'string' },
        type: { type: 'string', description: 'Kiểu cột, ví dụ `text`, `integer`.' },
        desc: { type: 'string', description: 'Mô tả bảng hoặc ý nghĩa cột.' },
        values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Giá trị hợp lệ của cột và nghĩa: `{ "NEW": "vừa nhận" }`.' },
        reason: { type: 'string', description: 'Nguồn của sự thật: đặc tả, dữ liệu thật, người dùng xác nhận.' },
      },
      required: ['system', 'kind', 'reason'],
      additionalProperties: false,
    },
    async execute(args: Change & { system: string; reason: string }, { scope }) {
      const catalog = await ctx.systems.load(scope.env)
      const system = catalog.systems.find((s) => s.id === args.system)
      if (!system) throw new Error(`unknown system ${args.system}; systems: ${catalog.systems.map((s) => s.id).join(', ')}`)
      const file = resolve(system.file)
      const before = await readFile(file, 'utf8')
      const doc = parseDocument(before)
      const summary = applyChange(doc, args)
      const after = doc.toString(YAML_FORMAT)
      if (after === before) throw new Error('nothing to change: the catalog already says this')
      // Nạp thử bản mới cạnh file gốc (đường dẫn OpenAPI tương đối vẫn đúng) trước khi hỏi duyệt.
      const check = `${file}.check.tmp`
      await writeFile(check, after)
      try {
        await loadSystem(check)
      } catch (error) {
        throw new Error(`the change makes ${system.file} invalid: ${(error as Error).message}`)
      } finally {
        await rm(check, { force: true })
      }
      if (!scope.confirm) throw new Error('changing the system catalog needs a user to approve it; use the chat interface')
      const approved = await scope.confirm({
        tool: 'propose_system_knowledge',
        title: `Ghi vào catalog ${system.id}: ${summary}`,
        preview: { kind: 'context-change', target: system.file, summary, reason: args.reason, diff: lineDiff(before, after) },
      })
      if (!approved) return { saved: false, reason: 'the user declined' }
      const temp = `${file}.tmp`
      await writeFile(temp, after)
      await rename(temp, file)
      return { saved: true, file: system.file, summary }
    },
    present: (args, outcome) => {
      const value = outcome.value as { saved?: boolean; file?: string; summary?: string } | undefined
      return {
        kind: 'context-change',
        title: outcome.status !== 'ok' ? 'Đề xuất ghi catalog lỗi' : value?.saved ? `Đã ghi vào catalog ${args.system}: ${value.summary}` : `Không ghi vào catalog ${args.system}`,
        target: value?.file, summary: value?.summary, saved: !!value?.saved, reason: args.reason,
      }
    },
  })

  ctx.authoring.guideSection({
    id: 'systems/knowledge',
    order: 32,
    render: () => [
      '## Ngữ cảnh dùng chung của hệ thống',
      '- Agent chạy test thấy mô tả bảng, cột, giá trị hợp lệ và quy tắc nghiệp vụ trong catalog với mọi plan khai báo hệ thống trong `systems`.',
      '- `context` của plan chỉ ghi điều riêng của plan (dữ liệu dùng riêng, lưu ý cho case). Không chép tên cột, mã trạng thái, quy tắc vào đó.',
      '- Thiếu điều cần dùng chung (gói ngữ cảnh báo "Chưa khai báo trong catalog", hoặc bạn vừa xác nhận một quy tắc với người dùng):',
      '  đề xuất bằng `propose_system_knowledge`, mỗi lần một sự thật. Quy trình nghiệp vụ dài thì đề xuất tài liệu bằng `propose_context_doc` và tham chiếu bằng `contextRefs`.',
    ].join('\n'),
  })
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Sửa Document theo đề xuất; trả câu tóm tắt. Ném lỗi khi thiếu tham số hoặc không tìm thấy bảng. */
function applyChange(doc: Document, change: Change): string {
  if (change.kind === 'rule') {
    const rule = change.rule?.replace(/\s+/g, ' ').trim()
    if (!rule) throw new Error('kind rule needs `rule`')
    const path = change.table ? [...tablePath(doc, change.table), 'rules'] : ['rules']
    const existing = doc.getIn(path)
    const rules = isSeq(existing) ? existing.items.map((i) => String(isScalar(i) ? i.value : i)) : []
    if (rules.some((r) => norm(r) === norm(rule))) throw new Error('nothing to change: the catalog already has this rule')
    if (isSeq(existing)) existing.add(doc.createNode(rule))
    else doc.setIn(path, doc.createNode([rule]))
    return change.table ? `quy tắc của bảng ${change.table}` : 'quy tắc nghiệp vụ'
  }
  if (!change.table) throw new Error(`kind ${change.kind} needs \`table\``)
  const path = tablePath(doc, change.table, change.namespace)
  if (change.kind === 'table') {
    if (!change.desc?.trim()) throw new Error('kind table needs `desc`')
    doc.setIn([...path, 'desc'], change.desc.trim())
    return `mô tả bảng ${change.table}`
  }
  if (!change.column) throw new Error('kind column needs `column`')
  if (!change.desc && !change.type && !change.values) throw new Error('kind column needs `desc`, `type` or `values`')
  const columnPath = [...path, 'columns', change.column]
  const current = doc.getIn(columnPath)
  const old = isMap(current) ? (current.toJSON() as { type?: string; desc?: string; values?: Record<string, string> | string[] })
    : isScalar(current) && current.value ? { desc: String(current.value) } : {}
  const oldValues = Array.isArray(old.values) ? Object.fromEntries(old.values.map((v) => [String(v), ''])) : old.values ?? {}
  const merged = {
    ...(change.type ?? old.type ? { type: change.type ?? old.type } : {}),
    ...(change.desc ?? old.desc ? { desc: change.desc ?? old.desc } : {}),
    ...(change.values || Object.keys(oldValues).length ? { values: { ...oldValues, ...(change.values ?? {}) } } : {}),
  }
  doc.setIn(columnPath, doc.createNode(merged))
  return `cột ${change.table}.${change.column}`
}

/**
 * Đường dẫn tới bảng trong `data[].tables[]`; bảng viết gọn (`tables: [orders]`) được đổi sang dạng đầy đủ.
 * Bảng chưa có thì thêm vào namespace được chỉ định.
 */
function tablePath(doc: Document, table: string, namespace?: string): Array<string | number> {
  const data = doc.get('data')
  const stores = isSeq(data) ? data.items : []
  for (const [i, store] of stores.entries()) {
    const tables = isMap(store) ? store.get('tables') : undefined
    if (!isSeq(tables)) continue
    for (const [k, item] of tables.items.entries()) {
      const name = isScalar(item) ? String(item.value) : isMap(item) ? String(item.get('name')) : undefined
      if (name !== table) continue
      if (isScalar(item)) tables.items[k] = doc.createNode({ name: table })
      return ['data', i, 'tables', k]
    }
  }
  const namespaces = stores.map((s) => (isMap(s) ? String(s.get('namespace')) : '')).filter(Boolean)
  if (!namespace) throw new Error(`table ${table} is not in the catalog; set \`namespace\` to add it (namespaces: ${namespaces.join(', ') || 'none'})`)
  const index = namespaces.indexOf(namespace)
  if (index < 0) throw new Error(`namespace ${namespace} is not in the catalog data; namespaces: ${namespaces.join(', ') || 'none'}`)
  const store = stores[index]
  const tables = isMap(store) ? store.get('tables') : undefined
  if (isSeq(tables)) tables.add(doc.createNode({ name: table }))
  else doc.setIn(['data', index, 'tables'], doc.createNode([{ name: table }]))
  const count = (doc.getIn(['data', index, 'tables']) as { items: unknown[] }).items.length
  return ['data', index, 'tables', count - 1]
}

/** Ghi lại YAML giữ định dạng người viết: không tự xuống dòng chuỗi dài, không thêm khoảng trắng trong `[a, b]`. */
const YAML_FORMAT = { lineWidth: 0, flowCollectionPadding: false } as const
