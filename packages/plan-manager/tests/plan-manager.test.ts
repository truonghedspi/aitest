/**
 * Kiểm thử quản lý plan qua WebSocket thật: danh sách, chi tiết, chạy plan ở nền với agent kịch bản,
 * lọc lượt chạy theo plan.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '@aitest/web-host'
import { toPosix } from '@aitest/core'
import { setupHarness, WsClient, type Harness, type Script } from '../../runner/tests/support.ts'

const PORT = 4185
const BASE = `http://127.0.0.1:${PORT}`

const PLAN = `id: TP-PM
name: Plan quản lý
requires: [http]
inputs:
  symbol: { desc: Mã, default: FPT }
cases:
  - id: PM-01
    title: Liệt kê lệnh
    steps: ["Gọi GET ${BASE}/orders."]
    expect:
      - { id: http-200, desc: API trả 200, check: { op: eq, value: 200 } }
  - id: PM-02
    title: Tra cứu lệnh không tồn tại
    steps: ["Gọi GET ${BASE}/orders/999999."]
    expect:
      - { id: http-404, desc: API trả 404, check: { op: eq, value: 404 } }
`

const scripts: Record<string, Script> = {
  async 'PM-01'(call) {
    const res = await call('http_request', { method: 'GET', url: `${BASE}/orders` })
    await call('assert_expectation', { expectId: 'http-200', evidenceId: res.evidenceId, path: '$.status' })
  },
  async 'PM-02'(call) {
    const res = await call('http_request', { method: 'GET', url: `${BASE}/orders/999999` })
    await call('assert_expectation', { expectId: 'http-404', evidenceId: res.evidenceId, path: '$.status' })
  },
}

describe('plan manager over WebSocket', () => {
  let harness: Harness
  let ws: WsClient
  let planPath: string
  let brokenPath: string

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      config: 'aitest.web.yml',
      scripts,
      rows: (dir) => [
        { id: 'web', name: '@aitest/web-host', config: { port: 0, staticDir: join(dir, 'static') } },
        { id: 'authoring-catalog', name: '@aitest/authoring/catalog', config: { planDirs: [join(dir, 'plans')] } },
        { id: 'envs', name: '@aitest/environments', config: { dir: join(dir, 'envs'), default: 'local' } },
      ],
    })
    harness.kernel.ctx.runner.config.agent = 'scripted'
    await mkdir(join(harness.dir, 'plans/team'), { recursive: true })
    await writeFile(join(harness.dir, 'plans/team/pm.plan.yaml'), PLAN)
    await writeFile(join(harness.dir, 'plans/broken.plan.yaml'), 'id: BROKEN\n')
    await writeFile(join(harness.dir, 'plans/limited.plan.yaml'), PLAN.replace('id: TP-PM', 'id: TP-LIMITED\nenvs: [alt]'))
    await mkdir(join(harness.dir, 'envs'), { recursive: true })
    await writeFile(join(harness.dir, 'envs/alt.yml'), 'label: Thay thế\nvars: { marker: alt }\n')
    planPath = toPosix(relative(process.cwd(), join(harness.dir, 'plans/team/pm.plan.yaml')))
    brokenPath = toPosix(relative(process.cwd(), join(harness.dir, 'plans/broken.plan.yaml')))
    ws = await WsClient.open((await harness.kernel.ctx.web.ready()).replace('http', 'ws') + '/ws')
  }, 60_000)

  afterAll(async () => {
    ws?.socket.close()
    await harness?.dispose()
  })

  it('lists plans, including ones that fail to parse', async () => {
    const plans = await ws.call('plans.list')
    expect(plans).toEqual([
      expect.objectContaining({ path: brokenPath, error: expect.any(String) }),
      expect.objectContaining({ id: 'TP-LIMITED' }),
      expect.objectContaining({ path: planPath, id: 'TP-PM', cases: [{ id: 'PM-01', title: 'Liệt kê lệnh' }, { id: 'PM-02', title: 'Tra cứu lệnh không tồn tại' }] }),
    ])
  })

  it('returns plan detail with cases, inputs and validation', async () => {
    const detail = await ws.call('plans.get', { path: planPath })
    expect(detail).toMatchObject({
      valid: true,
      content: PLAN,
      plan: {
        id: 'TP-PM', requires: ['http'],
        inputs: [{ name: 'symbol', default: 'FPT', mode: 'user' }],
        cases: [{ id: 'PM-01', steps: [`Gọi GET ${BASE}/orders.`], expect: [{ id: 'http-200' }] }, { id: 'PM-02' }],
      },
    })
    const broken = await ws.call('plans.get', { path: brokenPath })
    expect(broken.valid).toBe(false)
    await expect(ws.call('plans.get', { path: 'package.json' })).rejects.toThrow(/outside plan directories/)
  })

  it('previews an unsaved draft for business readers: fixtures, structured steps and criteria', async () => {
    const draft = [
      'id: TP-PREVIEW', 'name: Huỷ lệnh', 'requires: [http]', 'systems: [order-service]',
      'setup:', '  - { action: http_request, desc: Đặt một lệnh mới, args: { method: POST, url: "{{order-service.url}}/orders", body: {} }, save: { order_id: $.body.id } }',
      'teardown:', '  - { action: http_request, args: { method: GET, url: "{{order-service.url}}/orders" } }',
      'cases:', '  - id: C1', '    title: Huỷ lệnh NEW', '    steps:',
      '      - { call: order-service.cancelOrder, path: { id: "{{order_id}}" }, desc: huỷ lệnh vừa đặt }',
      '      - Đọc bảng orders theo id.',
      '    expect:',
      '      - { id: http-200, desc: API trả 200, check: { op: eq, value: 200 } }',
      '      - { id: fee, desc: Phí đúng, check: { op: eq, expr: "qty * price" } }',
      '      - { id: note, desc: Giao diện báo thành công }', '',
    ].join('\n')
    const preview = await ws.call('plans.preview', { content: draft })
    expect(preview.plan).toMatchObject({
      setup: ['Đặt một lệnh mới'],
      teardown: ['Chạy `http_request`'],
      cases: [{
        calls: [{ call: 'order-service.cancelOrder', desc: 'huỷ lệnh vừa đặt', path: { id: '{{order_id}}' } }, null],
        expect: [{ id: 'http-200', op: 'eq', value: 200 }, { id: 'fee', op: 'eq', expr: 'qty * price' }, { id: 'note' }],
      }],
    })
    expect(preview.plan.cases[0].expect[2]).not.toHaveProperty('op')
    const broken = await ws.call('plans.preview', { content: 'id: X' })
    expect(broken.valid).toBe(false)
    expect(broken.plan).toBeUndefined()
  })

  it('runs a plan in the background and lists its runs by plan', async () => {
    await expect(ws.call('plans.run', { path: brokenPath })).rejects.toThrow(/plan is invalid/)
    await expect(ws.call('plans.run', { path: planPath, cases: ['NOPE'] })).rejects.toThrow(/unknown case: NOPE/)

    const { runId } = await ws.call('plans.run', { path: planPath, cases: ['PM-02'], inputs: { symbol: 'VNM', empty: '' } })
    expect(runId).toMatch(/TP-PM$/)
    let runs: any[] = []
    for (let i = 0; i < 100; i++) {
      runs = await ws.call('runs.list', { planId: 'TP-PM' })
      if (runs[0]?.finished) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      runId, finished: true, dryRun: false, plan: { id: 'TP-PM', source: planPath },
      cases: [{ id: 'PM-02', verdict: 'pass' }],
    })
    const subscribed = await ws.call('runs.subscribe', { runId })
    const resolved = subscribed.events.find((e: any) => e.type === 'inputs/resolved')
    expect(resolved.data.inputs).toEqual([{ name: 'symbol', source: 'user', value: 'VNM' }])
    expect(await ws.call('runs.list', { planId: 'OTHER' })).toEqual([])
  })

  it('runs on a chosen environment, filters runs by environment and respects plan envs', async () => {
    const limitedPath = planPath.replace('team/pm.plan.yaml', 'limited.plan.yaml')
    expect((await ws.call('plans.get', { path: limitedPath })).plan.envs).toEqual(['alt'])
    await expect(ws.call('plans.run', { path: limitedPath, env: 'local' })).rejects.toThrow(/limited to environments alt/)

    const { runId } = await ws.call('plans.run', { path: planPath, cases: ['PM-01'], env: 'alt', model: 'fast-model' })
    let runs: any[] = []
    for (let i = 0; i < 100; i++) {
      runs = await ws.call('runs.list', { planId: 'TP-PM', env: 'alt' })
      if (runs[0]?.finished) break
      await new Promise((r) => setTimeout(r, 100))
    }
    // Model chọn khi chạy được truyền cho agent và ghi vào lượt chạy.
    expect(runs.map((r) => [r.runId, r.env, r.model, r.cases[0].verdict])).toEqual([[runId, 'alt', 'fast-model', 'pass']])
    const local = await ws.call('runs.list', { planId: 'TP-PM', env: 'local' })
    expect(local.every((r: any) => r.env === 'local')).toBe(true)
    const events = (await ws.call('runs.subscribe', { runId })).events
    expect(events.find((e: any) => e.type === 'env/resolved').data).toMatchObject({ env: 'alt', vars: ['marker'] })
  })
})
