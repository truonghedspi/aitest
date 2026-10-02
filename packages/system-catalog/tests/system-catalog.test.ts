/**
 * Kiểm thử catalog hệ thống: nạp service.yml và OpenAPI, môi trường, quy tắc kiểm tra plan,
 * biến `{{system.url}}` và section prompt trong lượt chạy thật với agent kịch bản.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthoringSession } from '@aitest/authoring'
import { loadEnv, loadSystems, type Catalog } from '@aitest/system-catalog'
import { lintSystems } from '@aitest/system-catalog/authoring'
import { promptVars, root, setupHarness, type Harness } from '../../runner/tests/support.ts'

const PORT = 4187

describe('catalog model', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aitest-systems-'))
    await mkdir(join(dir, 'systems/broken'), { recursive: true })
    await writeFile(join(dir, 'systems/broken/service.yml'), 'id: broken\n')
    await mkdir(join(dir, 'systems/other-name'), { recursive: true })
    await writeFile(join(dir, 'systems/other-name/service.yml'), 'id: mismatch\ntitle: X\n')
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('loads operations from OpenAPI with local $ref resolved', async () => {
    const { systems, issues } = await loadSystems([join(root, 'systems')])
    expect(issues).toEqual([])
    const order = systems.find((s) => s.id === 'order-service')!
    expect(order.operations.map((o) => `${o.id} ${o.method} ${o.path}`)).toEqual([
      'listOrders GET /orders', 'createOrder POST /orders', 'getOrder GET /orders/{id}', 'cancelOrder POST /orders/{id}/cancel',
    ])
    const create = order.operations.find((o) => o.id === 'createOrder')!
    expect(create.requestBody).toMatchObject({ required: ['symbol', 'side', 'qty', 'price'], properties: { qty: { multipleOf: 100 } } })
    expect(create.responses['201'].schema).toMatchObject({ properties: { status: { enum: ['NEW', 'FILLED', 'CANCELLED'] } } })
    expect(order.operations.find((o) => o.id === 'cancelOrder')!.params).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    ])
    expect(order.events.map((e) => e.id)).toEqual(['order-events', 'order-exchange'])
    expect(order.docs).toEqual(['examples/order-api/SPEC.md'])
  })

  it('reports broken files without failing the whole catalog', async () => {
    const { systems, issues } = await loadSystems([join(dir, 'systems'), join(root, 'systems')])
    expect(systems.map((s) => s.id)).toEqual(['order-service'])
    expect(issues.map((i) => i.error)).toEqual([
      expect.stringContaining('title'),
      'id mismatch must match directory name other-name',
    ])
  })

  it('interpolates environment files and reports a missing environment', async () => {
    process.env.AITEST_TEST_ORDER_URL = 'http://orders.staging:8080'
    await mkdir(join(dir, 'envs'), { recursive: true })
    await writeFile(join(dir, 'envs/staging.yml'), 'systems:\n  order-service:\n    url: ${env.AITEST_TEST_ORDER_URL}\nbrokers:\n  kafka-main: { namespace: kafka }\n')
    const { env, issues } = await loadEnv(join(dir, 'envs'), 'staging')
    expect(issues).toEqual([])
    expect(env).toMatchObject({ name: 'staging', systems: { 'order-service': { url: 'http://orders.staging:8080' } }, brokers: { 'kafka-main': { namespace: 'kafka' } } })
    const missing = await loadEnv(join(dir, 'envs'), 'prod')
    expect(missing.issues[0].error).toBe('environment prod not found')
  })
})

describe('plan lint against the catalog', () => {
  let catalog: Catalog
  beforeAll(async () => {
    const { systems, issues } = await loadSystems([join(root, 'systems')])
    catalog = { systems, issues, env: { name: 'local', systems: { 'order-service': { url: 'http://127.0.0.1:4100' } }, brokers: { 'kafka-main': { namespace: 'kafka' } } } }
  })

  const tools = new Set(['http', 'kafka'])
  const plan = (overrides: Record<string, unknown>) => ({
    id: 'P', name: 'P', source: 'p.plan.yaml', format: 'yaml', requires: ['http'], vars: {}, setup: [], teardown: [],
    systems: ['order-service'],
    cases: [{ id: 'C', title: 'C', tags: [], steps: ['Gọi order-service.createOrder (POST {{order-service.url}}/orders).'], expect: [], setup: [], teardown: [] }],
    ...overrides,
  }) as any

  it('accepts valid references', () => {
    expect(lintSystems(plan({}), catalog, tools)).toEqual([])
  })

  it('flags unknown systems, undeclared or unknown variables, unknown items and missing namespaces', () => {
    const issues = lintSystems(plan({
      systems: ['order-service', 'billing'],
      context: 'Xem {{payment-gw.url}}.',
      cases: [{
        id: 'C', title: 'C', tags: [], expect: [], setup: [], teardown: [],
        steps: [
          'Gọi order-service.creatOrder tại {{order-service.host}}/orders.',
          'Chờ order-service.order-events; bỏ qua http://order-service.internal/x.',
        ],
      }],
    }), { ...catalog, systems: [...catalog.systems, { ...catalog.systems[0], id: 'payment-gw' }] }, tools)
    expect(issues.map((i) => `${i.level}: ${i.message}`)).toEqual([
      'error: unknown system billing; known: order-service, payment-gw',
      'error: {{payment-gw.url}} needs payment-gw in systems',
      'error: {{order-service.host}} is not provided; available: {{order-service.url}}',
      expect.stringMatching(/^warning: order-service.creatOrder is not an operation/),
      'warning: order-service.order-events needs namespace kafka in requires',
    ])
  })

  it('warns when the environment has no url for a declared system', () => {
    const issues = lintSystems(plan({}), { ...catalog, env: { name: 'empty', systems: {}, brokers: {} } }, tools)
    expect(issues).toEqual([{ level: 'warning', path: 'systems', message: 'environment empty has no url for order-service' }])
  })

  it('reports an error when a used event channel has no installed tool', () => {
    // Khi `kafka` đã có trong `requires`, quy tắc chung của authoring báo lỗi thay cho quy tắc này.
    const issues = lintSystems(plan({
      requires: ['http'],
      cases: [{ id: 'C', title: 'C', tags: [], expect: [], setup: [], teardown: [], steps: ['Chờ order-service.order-events.'] }],
    }), catalog, new Set(['http']))
    expect(issues).toEqual([{
      level: 'error',
      message: 'order-service.order-events needs a tool with namespace kafka, which is not installed; add it from list_tool_catalog with propose_tool',
    }])
  })
})

describe('catalog in runs and authoring', () => {
  let harness: Harness
  let dir: string
  let session: AuthoringSession
  const prompts: string[] = []

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      scripts: {
        async 'SC-01'(call, prompt) {
          prompts.push(prompt)
          const vars = promptVars(prompt)
          const res = await call('http_request', { method: 'GET', url: `${vars['order-service.url']}/orders/${vars.order_id}` })
          await call('assert_expectation', { expectId: 'http-200', evidenceId: res.evidenceId, path: '$.status' })
        },
      },
    })
    dir = harness.dir
    session = await harness.kernel.ctx.authoring.createSession()
  }, 60_000)

  afterAll(async () => {
    await session?.close()
    await harness?.dispose()
  })

  it('provides {{system.url}} to fixtures and steps, and describes the system in the prompt', async () => {
    const file = join(dir, 'catalog.plan.yaml')
    await writeFile(file, [
      'id: TP-CATALOG',
      'name: Catalog',
      'requires: [http]',
      'systems: [order-service]',
      'setup:',
      '  - action: http_request',
      '    args: { method: POST, url: "{{order-service.url}}/orders", body: { symbol: FPT, side: BUY, qty: 100, price: 1000 } }',
      '    save: { order_id: $.body.id }',
      'cases:',
      '  - id: SC-01',
      '    title: Tra cứu lệnh vừa tạo',
      '    steps: ["Gọi order-service.getOrder (GET {{order-service.url}}/orders/{{order_id}})."]',
      '    expect:',
      '      - { id: http-200, desc: API trả 200, check: { op: eq, value: 200 } }',
      '',
    ].join('\n'))
    const report = await harness.kernel.ctx.runner.run({ plan: file, agent: 'scripted' })
    expect(report.cases.map((c) => [c.id, c.verdict, c.reasons])).toEqual([['SC-01', 'pass', []]])
    const prompt = prompts[0]
    expect(prompt).toContain(`GET ${harness.baseUrl}/orders/`)
    expect(prompt).toContain('## Hệ thống liên quan (môi trường local)')
    expect(prompt).toContain('- `createOrder`: POST /orders: Đặt lệnh')
    expect(prompt).toContain('`order-events`: Kafka topic `order-events`; dùng tool namespace `kafka`; lọc theo `$.value.orderId`')
    expect(promptVars(prompt)['order-service.url']).toBe(harness.baseUrl)
  })

  it('lists and describes systems for the authoring agent', async () => {
    const { ctx } = harness.kernel
    const list = await ctx.actions.invoke(session.scope, 'list_systems', {})
    expect(list.value).toMatchObject({
      note: expect.stringContaining('list_actions'),
      otherNamespaces: expect.arrayContaining(['http', 'dbadmin']),
      env: 'local',
      systems: [{ id: 'order-service', url: harness.baseUrl, operations: expect.arrayContaining(['createOrder: POST /orders']) }],
    })
    // aitest.yml chưa có tool Kafka, RabbitMQ: kênh sự kiện báo thiếu tool và cách bổ sung.
    const events = (list.value as { systems: Array<{ events: Array<{ id: string; tool: unknown }> }> }).systems[0].events
    expect(events).toEqual([
      expect.objectContaining({ id: 'order-events', tool: { namespace: 'kafka', available: false, hint: expect.stringContaining('list_tool_catalog') } }),
      expect.objectContaining({ id: 'order-exchange', tool: { namespace: 'rabbitmq', available: false, hint: expect.stringContaining('list_tool_catalog') } }),
    ])
    const op = await ctx.actions.invoke(session.scope, 'describe_system', { system: 'order-service', item: 'createOrder' })
    expect(op.value).toMatchObject({ operation: { method: 'POST', requestBody: { required: ['symbol', 'side', 'qty', 'price'] } } })
    const channel = await ctx.actions.invoke(session.scope, 'describe_system', { system: 'order-service', item: 'order-exchange' })
    expect(channel.value).toMatchObject({ channel: { exchange: 'orders', tool: { namespace: 'rabbitmq', available: false } } })
    const missing = await ctx.actions.invoke(session.scope, 'describe_system', { system: 'order-service', item: 'nope' })
    expect(missing.error).toContain('items: listOrders, createOrder')

    // Thêm tool lúc đang chạy (như propose_tool): kênh RabbitMQ chuyển sang có tool ngay.
    await harness.kernel.add({ id: 'rabbitmq', name: '@aitest/action-rabbitmq', config: { url: 'amqp://guest:guest@127.0.0.1:5672' } })
    const after = await ctx.actions.invoke(session.scope, 'describe_system', { system: 'order-service', item: 'order-exchange' })
    expect(after.value).toMatchObject({ channel: { tool: { namespace: 'rabbitmq', available: true } } })
    await harness.kernel.remove('rabbitmq')
  })

  it('runs catalog rules in validate_plan', async () => {
    const result = await harness.kernel.ctx.authoring.validate([
      'id: TP-X', 'name: X', 'requires: [http]', 'systems: [order-service]', 'cases:',
      '  - { id: C1, title: T, steps: ["Gọi GET {{order-service.url}}/orders và {{order-service.port}}."] }', '',
    ].join('\n'))
    expect(result.issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual(['{{order-service.port}} is not provided; available: {{order-service.url}}'])
  })
})
