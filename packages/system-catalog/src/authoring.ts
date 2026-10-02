import type {} from '@aitest/authoring'
import type { Context, TestPlan } from '@aitest/core'
import { channelIn, SYSTEM_VAR_KEYS, type Catalog, type EventChannel, type SystemSpec } from './model.ts'
import type {} from './index.ts'

/**
 * Catalog hệ thống trong phiên soạn plan:
 * - tool `list_systems`, `describe_system` để agent viết bước theo operation và kênh sự kiện có thật;
 * - quy tắc kiểm tra plan: system tồn tại, biến `{{system.url}}` hợp lệ, tham chiếu `system.operation` có thật,
 *   kênh sự kiện được dùng có namespace tool tương ứng trong `requires`.
 */
export const name = 'system-catalog-authoring'
export const inject = ['systems', 'actions', 'authoring']

/** Namespace của tool nội bộ, không phải hệ thống dưới kiểm thử. */
const INTERNAL = new Set(['authoring', 'verdict', 'wait', 'webhook', 'math', 'inputs', 'knowledge'])

export function apply(ctx: Context) {
  /** Namespace đang có tool cho agent chạy test; tool bị tắt bằng `restrict` không được tính. */
  const installed = (env?: string) => new Set(ctx.actions.list({ kind: 'case', namespaces: new Set(), phase: 'setup', env }).map((a) => a.namespace))

  ctx.actions.register({
    name: 'list_systems',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: [
      'Liệt kê các hệ thống (service) trong catalog: operation HTTP, kênh sự kiện, consumer, dữ liệu, và địa chỉ ở môi trường hiện tại.',
      'Plan khai báo hệ thống trong `systems` để dùng biến `{{<system>.url}}` và tham chiếu `<system>.<operation>`.',
    ].join(' '),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args: Record<string, never>, { scope }) {
      const catalog = await ctx.systems.load(scope.env)
      const available = installed(scope.env)
      // Namespace có tool nhưng không gắn với hệ thống nào trong catalog (ví dụ MCP server cơ sở dữ liệu người dùng tự thêm).
      const described = new Set(catalog.systems.flatMap((sys) => [
        ...sys.data.map((d) => d.namespace),
        ...sys.events.map((e) => catalog.env.brokers[e.broker]?.namespace).filter((n): n is string => !!n),
      ]))
      const otherNamespaces = [...available].filter((ns) => !described.has(ns) && !INTERNAL.has(ns)).sort()
      return {
        note: 'Catalog chỉ mô tả các service đã khai báo. Hệ thống, cơ sở dữ liệu, bảng không có ở đây vẫn dùng được nếu list_actions có tool; khảo sát bằng explore.',
        otherNamespaces,
        env: catalog.env.name,
        systems: catalog.systems.map((s) => ({
          id: s.id,
          title: s.title,
          description: s.description,
          owner: s.owner,
          url: catalog.env.systems[s.id]?.url,
          operations: s.operations.map((o) => `${o.id}: ${o.method} ${o.path}`),
          events: s.events.map((raw) => channelIn(raw, s.id, catalog.env)).map((e) => ({
            id: e.id, kind: e.kind, broker: e.broker, topic: e.topic, exchange: e.exchange,
            tool: toolStatus(e, catalog, available), messages: e.messages.map((m) => m.name),
          })),
          consumers: s.consumers.map((c) => c.group),
          data: s.data.map((d) => ({ namespace: d.namespace, tables: d.tables })),
          formulas: Object.entries(s.formulas).map(([name, f]) => `${name}(${f.params.join(', ')})${f.desc ? `: ${f.desc}` : ''}`),
          docs: s.docs,
        })),
        ...(catalog.issues.length ? { issues: catalog.issues } : {}),
      }
    },
    present: (_args, outcome) => {
      const value = outcome.value as { env?: string; systems?: Array<{ id: string; title: string }> } | undefined
      return {
        kind: 'system-list',
        title: `Hệ thống (${value?.systems?.length ?? 0}, môi trường ${value?.env ?? '?'})`,
        systems: value?.systems?.map((s) => ({ id: s.id, title: s.title })) ?? [],
      }
    },
  })

  ctx.actions.register({
    name: 'describe_system',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: [
      'Xem chi tiết một hệ thống. Truyền `item` là id của operation hoặc kênh sự kiện để xem schema request, response',
      'hoặc danh sách bản tin; bỏ trống để xem toàn bộ hệ thống.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        system: { type: 'string', description: 'Id hệ thống từ `list_systems`.' },
        item: { type: 'string', description: 'Id operation hoặc kênh sự kiện.' },
      },
      required: ['system'],
      additionalProperties: false,
    },
    async execute(args: { system: string; item?: string }, { scope }) {
      const catalog = await ctx.systems.load(scope.env)
      const system = catalog.systems.find((s) => s.id === args.system)
      if (!system) throw new Error(`unknown system ${args.system}; known: ${catalog.systems.map((s) => s.id).join(', ') || 'none'}`)
      const url = catalog.env.systems[system.id]?.url
      if (!args.item) return { ...system, events: system.events.map((e) => channelIn(e, system.id, catalog.env)), env: catalog.env.name, url }
      const operation = system.operations.find((o) => o.id === args.item)
      if (operation) return { system: system.id, env: catalog.env.name, url, operation }
      const found = system.events.find((e) => e.id === args.item)
      const channel = found && channelIn(found, system.id, catalog.env)
      if (channel) return { system: system.id, env: catalog.env.name, channel: { ...channel, tool: toolStatus(channel, catalog, installed(scope.env)) } }
      const formula = Object.hasOwn(system.formulas, args.item) ? system.formulas[args.item] : undefined
      if (formula) return { system: system.id, formula: { name: args.item, ...formula } }
      throw new Error(`${system.id} has no operation, event channel or formula ${args.item}; items: ${[...itemIds(system), ...Object.keys(system.formulas)].join(', ')}`)
    },
    present: (args) => ({ kind: 'code', title: `Hệ thống ${args.system}${args.item ? `.${args.item}` : ''}` }),
  })

  ctx.on('authoring/lint', async (plan, issues) => {
    const catalog = await ctx.systems.load()
    issues.push(...lintSystems(plan, catalog, installed()))
  })

  ctx.authoring.guideSection({
    id: 'systems/catalog',
    order: 32,
    render: () => [
      '## Catalog hệ thống',
      '- Gọi `list_systems` trước khi viết bước gọi API hoặc chờ sự kiện. Khai báo hệ thống dùng tới trong `systems` của plan.',
      '- Catalog không bắt buộc: hệ thống, cơ sở dữ liệu chưa khai báo vẫn dùng được qua tool trong `list_actions` (xem `otherNamespaces`).',
      '- Dùng `{{<system>.url}}` thay cho URL cố định, để plan chạy được ở mọi môi trường.',
      '- Viết bước theo tên trong catalog, ví dụ "Gọi order-service.createOrder (POST {{order-service.url}}/orders) với body ...",',
      '  "Chờ sự kiện order-service.order-events order.created của lệnh vừa tạo". Xem schema bằng `describe_system`.',
      '- Mỗi kênh sự kiện có `tool`: namespace cần dùng và `available`. Khi `available: false`, tìm mục cùng namespace trong',
      '  `list_tool_catalog` và đề xuất qua `propose_tool` trước khi viết bước; khi có rồi, thêm namespace vào `requires`.',
      '- Lọc bản tin theo path `correlation` của kênh.',
    ].join('\n'),
  })
}

/**
 * Tool cần cho một kênh sự kiện ở môi trường hiện tại: namespace từ ánh xạ broker, và namespace đó đã có tool chưa.
 * Không trỏ tới mục danh mục cụ thể: agent tra `list_tool_catalog` theo namespace, để plugin này không phụ thuộc `tool-catalog`.
 */
export function toolStatus(channel: EventChannel, catalog: Catalog, available: ReadonlySet<string>) {
  const namespace = catalog.env.brokers[channel.broker]?.namespace
  if (!namespace) return { namespace: undefined, available: false, hint: `broker ${channel.broker} is not mapped in environment ${catalog.env.name}` }
  return available.has(namespace)
    ? { namespace, available: true }
    : { namespace, available: false, hint: `no tool with namespace ${namespace}; find an entry with namespace ${namespace} in list_tool_catalog and propose it` }
}

function itemIds(system: SystemSpec) {
  return [...system.operations.map((o) => o.id), ...system.events.map((e) => e.id)]
}

/** Quy tắc kiểm tra tham chiếu tới catalog trong plan. Hàm thuần, tách riêng để kiểm thử. */
export function lintSystems(plan: TestPlan, catalog: Catalog, available: ReadonlySet<string>) {
  const issues: Array<{ level: 'error' | 'warning'; message: string; path?: string }> = []
  const declared = plan.systems ?? []
  const byId = new Map(catalog.systems.map((s) => [s.id, s]))

  declared.forEach((id, i) => {
    if (byId.has(id)) return
    const broken = catalog.issues.find((issue) => issue.file.includes(`/${id}/`))
    issues.push({
      level: 'error', path: `systems[${i}]`,
      message: broken ? `system ${id} failed to load: ${broken.error}` : `unknown system ${id}; known: ${[...byId.keys()].join(', ') || 'none'}`,
    })
  })

  // Biến `{{system.key}}` ở mọi nơi trong plan.
  const text = JSON.stringify({ vars: plan.vars, context: plan.context, setup: plan.setup, teardown: plan.teardown, cases: plan.cases })
  for (const [, id, key] of text.matchAll(/\{\{\s*([a-z][a-z0-9-]*)\.([\w-]+)\s*\}\}/g)) {
    if (!byId.has(id) || `${id}.${key}` in plan.vars) continue
    if (!declared.includes(id)) issues.push({ level: 'error', path: 'systems', message: `{{${id}.${key}}} needs ${id} in systems` })
    else if (!SYSTEM_VAR_KEYS.includes(key)) issues.push({ level: 'error', message: `{{${id}.${key}}} is not provided; available: ${SYSTEM_VAR_KEYS.map((k) => `{{${id}.${k}}}`).join(', ')}` })
  }

  for (const id of declared) {
    const system = byId.get(id)
    if (!system) continue
    if (system.operations.length && !catalog.env.systems[id]?.url && !(`${id}.url` in plan.vars)) {
      issues.push({ level: 'warning', path: 'systems', message: `environment ${catalog.env.name} has no url for ${id}` })
    }
    // Tham chiếu dạng chữ `system.item` trong các bước.
    const pattern = new RegExp(`(?<![\\w{./-])${id.replace(/-/g, '\\-')}\\.([A-Za-z][\\w-]*)`, 'g')
    const usedChannels = new Set<string>()
    plan.cases.forEach((c, ci) => c.steps.forEach((step, si) => {
      for (const [, item] of step.matchAll(pattern)) {
        if (SYSTEM_VAR_KEYS.includes(item)) continue
        const channel = system.events.find((e) => e.id === item)
        if (channel) usedChannels.add(channel.id)
        else if (!system.operations.some((o) => o.id === item)) {
          issues.push({ level: 'warning', path: `cases[${ci}].steps[${si}]`, message: `${id}.${item} is not an operation or event channel of ${id}; items: ${itemIds(system).join(', ')}` })
        }
      }
    }))
    for (const channelId of usedChannels) {
      const channel = system.events.find((e) => e.id === channelId)!
      const namespace = catalog.env.brokers[channel.broker]?.namespace
      if (!namespace) issues.push({ level: 'warning', message: `broker ${channel.broker} of ${id}.${channelId} is not mapped in environment ${catalog.env.name}` })
      // Namespace đã có trong `requires` mà chưa có tool thì quy tắc chung của authoring đã báo lỗi.
      else if (!available.has(namespace) && !plan.requires.includes(namespace)) {
        issues.push({ level: 'error', message: `${id}.${channelId} needs a tool with namespace ${namespace}, which is not installed; add it from list_tool_catalog with propose_tool` })
      } else if (available.has(namespace) && !plan.requires.includes(namespace)) issues.push({ level: 'warning', path: 'requires', message: `${id}.${channelId} needs namespace ${namespace} in requires` })
    }
  }
  return issues
}
