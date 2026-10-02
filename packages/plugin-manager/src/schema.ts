/**
 * Chuyển `Config.toJSON()` của schemastery (đồ thị `refs`) thành danh sách trường phẳng
 * để giao diện dựng form cấu hình.
 */
export interface ConfigField {
  key: string
  type: string
  description?: string
  default?: unknown
  required?: boolean
  options?: unknown[]
}

interface SchemaNode {
  type: string
  meta?: { description?: string; default?: unknown; required?: boolean }
  dict?: Record<string, number>
  inner?: number
  list?: number[]
  value?: unknown
}

export function describeConfig(json: unknown): ConfigField[] {
  const graph = json as { uid?: number; refs?: Record<string, SchemaNode> } | undefined
  if (!graph?.refs || graph.uid === undefined) return []
  const root = graph.refs[graph.uid]
  if (root?.type !== 'object' || !root.dict) return []
  return Object.entries(root.dict).map(([key, ref]) => {
    const node = graph.refs![ref]
    return {
      key,
      type: typeName(graph.refs!, node),
      description: node.meta?.description,
      default: node.meta?.default,
      required: node.meta?.required,
      options: node.type === 'union' ? node.list?.map((r) => graph.refs![r]?.value) : undefined,
    }
  })
}

function typeName(refs: Record<string, SchemaNode>, node: SchemaNode): string {
  switch (node.type) {
    case 'array': return `${node.inner !== undefined ? typeName(refs, refs[node.inner]) : 'any'}[]`
    case 'dict': return `Record<string, ${node.inner !== undefined ? typeName(refs, refs[node.inner]) : 'any'}>`
    case 'union': return node.list?.map((r) => JSON.stringify(refs[r]?.value)).join(' | ') ?? 'union'
    case 'object': return 'object'
    default: return node.type
  }
}
