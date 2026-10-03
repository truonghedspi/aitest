/**
 * Bước `call:` đầu case do runner chạy không qua agent; expectation có `from` do nền tảng tự đối chiếu.
 * Case chỉ gồm bước `call:` và expectation `from` không mở phiên agent.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deriveReport } from '@aitest/core'
import { setupHarness, type Harness } from '../../runner/tests/support.ts'

const PORT = 4175

const PLAN = `
id: TP-STEPS
name: Bước do nền tảng chạy
requires: [http, db]
systems: [order-service]
cases:
  - id: AUTO-01
    title: Đặt lệnh, chỉ dùng bước call
    steps:
      - call: order-service.createOrder
        body: { symbol: STA, side: BUY, qty: 100, price: 10000 }
        save: { order_id: '$.body.id' }
        desc: đặt lệnh mua
      - call: order-service.getOrder
        path: { id: '{{order_id}}' }
    expect:
      - { id: http-201, desc: API nhận lệnh, check: { op: eq, value: 201 }, from: { step: 1, path: $.status } }
      - { id: status-new, desc: Lệnh ở trạng thái NEW, check: { op: eq, value: NEW }, from: { step: 2, path: $.body.status } }
  - id: MIX-01
    title: Đặt lệnh bằng call, agent đối chiếu DB
    steps:
      - call: order-service.createOrder
        body: { symbol: STB, side: BUY, qty: 200, price: 10000 }
        save: { order_id: '$.body.id' }
      - Truy vấn bảng orders theo id {{order_id}}.
    expect:
      - { id: http-201, desc: API nhận lệnh, check: { op: eq, value: 201 }, from: { step: 1, path: $.status } }
      - { id: db-qty, desc: Khối lượng lưu bằng 200, check: { op: eq, value: 200 } }
`

describe('platform-run call steps', () => {
  let harness: Harness
  let prompt = ''
  const errors: string[] = []

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      scripts: {
        async 'MIX-01'(call, text) {
          prompt = text
          const id = Number(/Truy vấn bảng orders theo id (\d+)/.exec(text)?.[1])
          const row = await call('db_query', { sql: 'SELECT qty FROM orders WHERE id = ?', params: [id] })
          // Expectation có `from` chỉ nền tảng đối chiếu.
          const denied = await call('assert_expectation', { expectId: 'http-201', evidenceId: 'ev1', path: '$.status' })
          errors.push(denied.error ?? '')
          await call('assert_expectation', { assertions: [{ expectId: 'db-qty', evidenceId: row.evidenceId, path: '$.rows[0].qty' }] })
        },
      },
    })
    await writeFile(join(harness.dir, 'steps.plan.yaml'), PLAN)
  })

  afterAll(() => harness?.dispose())

  it('runs leading call steps without the agent and asserts from-expectations', async () => {
    const report = await harness.kernel.ctx.runner.run({ plan: join(harness.dir, 'steps.plan.yaml'), agent: 'scripted' })
    expect(Object.fromEntries(report.cases.map((c) => [c.id, c.verdict]))).toEqual({ 'AUTO-01': 'pass', 'MIX-01': 'pass' })
    const events = await harness.kernel.ctx.runlog.read(report.logFile!)
    const of = (id: string) => events.filter((e) => e.caseId === id)

    // AUTO-01: không có phiên agent; hai lời gọi pha `step`, bước 2 dùng id lưu từ bước 1.
    const auto = of('AUTO-01')
    expect(auto.some((e) => e.type === 'agent/session')).toBe(false)
    expect(auto.find((e) => e.type === 'case/no-agent')!.data).toEqual({ completedSteps: 2 })
    const calls = auto.filter((e) => e.type === 'action/call').map((e) => e.data as { phase: string; step: number; reason: string; args: { method: string; url: string } })
    expect(calls.map((c) => [c.phase, c.step, c.args.method])).toEqual([['step', 1, 'POST'], ['step', 2, 'GET']])
    expect(calls[0].reason).toBe('đặt lệnh mua')
    expect(calls[1].args.url).toMatch(new RegExp(`127.0.0.1:${PORT}/orders/\\d+$`))
    // Assertion tự động nằm ngay sau lời gọi của bước trong log.
    expect(auto.filter((e) => ['action/call', 'assert/result'].includes(e.type)).map((e) => e.type))
      .toEqual(['action/call', 'assert/result', 'action/call', 'assert/result'])
    const asserts = auto.filter((e) => e.type === 'assert/result').map((e) => e.data as { expectId: string; passed: boolean; auto?: boolean })
    expect(asserts).toEqual([
      expect.objectContaining({ expectId: 'http-201', passed: true, auto: true }),
      expect.objectContaining({ expectId: 'status-new', passed: true, auto: true }),
    ])

    // MIX-01: agent nhận bước còn lại với id thật, biết bước 1 đã xong và không assert được expectation `from`.
    expect(prompt).toContain('### Bước nền tảng đã chạy')
    expect(prompt).toMatch(/Bắt đầu từ bước 2/)
    expect(prompt).toMatch(/Truy vấn bảng orders theo id \d+\./)
    expect(prompt).toContain('Nền tảng đã tự đối chiếu các expectation sau')
    expect(errors[0]).toMatch(/asserted by the platform from step 1/)

    // Báo cáo dựng lại từ log trùng với báo cáo gốc.
    expect(deriveReport(events).cases.map((c) => c.verdict)).toEqual(['pass', 'pass'])
  })

  it('rejects from on a step the platform does not run', () => {
    const bad = PLAN.replace('from: { step: 2, path: $.body.status }', 'from: { step: 3, path: $.body.status }')
      .replace("      - { id: db-qty, desc: Khối lượng lưu bằng 200, check: { op: eq, value: 200 } }",
        "      - { id: db-qty, desc: Khối lượng lưu bằng 200, check: { op: eq, value: 200 }, from: { step: 2, path: '$.rows[0].qty' } }")
    expect(() => harness.kernel.ctx.plans.parse(bad, join(harness.dir, 'bad.plan.yaml')))
      .toThrow(/cases\[0\]\.expect\[1\]\.from: step 3 is not run by the platform[\s\S]*cases\[1\]\.expect\[1\]\.from: step 2 is not run/)
    const noCheck = PLAN.replace('check: { op: eq, value: 201 }, from: { step: 1', 'from: { step: 1')
    expect(() => harness.kernel.ctx.plans.parse(noCheck, join(harness.dir, 'bad.plan.yaml'))).toThrow(/from: requires check/)
    // `save` chỉ có nghĩa với bước nền tảng chạy.
    const lateSave = PLAN.replace('      - Truy vấn bảng orders theo id {{order_id}}.', '      - Truy vấn bảng orders theo id {{order_id}}.\n      - { call: order-service.getOrder, path: { id: 1 }, save: { x: $.body.id } }')
    expect(() => harness.kernel.ctx.plans.parse(lateSave, join(harness.dir, 'bad.plan.yaml'))).toThrow(/cases\[1\]\.steps\[2\]\.save: only the leading call steps/)
  })
})
