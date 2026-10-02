/**
 * Kiểm thử đầu vào của lượt chạy với Order API thật và agent kịch bản:
 * người chạy điền, fill, agent prepare (giá trị từ evidence, tự đăng ký dọn), default, require, blocked, biến `$run.*`.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseInputs } from '@aitest/cli'
import { promptVars, setupHarness, type Call, type Harness, type Script } from '../../runner/tests/support.ts'

const PORT = 4186
const BASE = `http://127.0.0.1:${PORT}`

const PLAN = `id: TP-INPUTS
name: Đầu vào của lượt chạy
requires: [http, db]
systems: [order-service]
inputs:
  symbol: { desc: Mã chứng khoán, default: FPT }
  side: { desc: Chiều lệnh }
  order_id:
    desc: Lệnh tạo sẵn bằng API
    fill:
      - action: http_request
        args: { method: POST, url: '{{order-service.url}}/orders', body: { symbol: '{{symbol}}', side: BUY, qty: 100, price: 1000 } }
        save: { order_id: $.body.id }
    require: { op: exists }
    cleanup:
      - { action: http_request, args: { method: POST, url: '{{order-service.url}}/orders/{{order_id}}/cancel' } }
  other_order:
    desc: Một lệnh NEW khác của mã {{symbol}}
    prepare: Tìm lệnh NEW của mã {{symbol}} khác {{order_id}}; không có thì đặt lệnh mới qua API.
    uses: [db, http]
    require: { op: gt, value: 0 }
cases:
  - id: IN-01
    title: Dùng đầu vào trong bước
    steps: ["Gọi GET {{order-service.url}}/orders/{{order_id}} (lượt {{$run.short}}, case {{$case.id}})."]
    expect:
      - { id: http-200, desc: API trả 200, check: { op: eq, value: 200 } }
  - id: IN-02
    title: Case thứ hai dùng cùng đầu vào
    steps: ["Gọi GET {{order-service.url}}/orders/{{other_order}}."]
    expect:
      - { id: http-200, desc: API trả 200, check: { op: eq, value: 200 } }
`

const prompts: Record<string, string> = {}
let prepareCalls = 0
const assertGet = async (call: Call, url: string) => {
  const res = await call('http_request', { method: 'GET', url })
  await call('assert_expectation', { expectId: 'http-200', evidenceId: res.evidenceId, path: '$.status' })
}

const scripts: Record<string, Script> = {
  async $prepare(call, prompt) {
    prepareCalls++
    prompts.$prepare = prompt
    // Giá trị không có trong evidence bị từ chối; agent không tự viết được giá trị.
    const bad = await call('provide_input', { name: 'other_order', evidenceId: 'ev99', path: '$.body.id' })
    expect(bad.outcome).toBe('error')
    const created = await call('http_request', {
      method: 'POST', url: `${BASE}/orders`, body: { symbol: 'FPT', side: 'SELL', qty: 200, price: 1000 },
    })
    await call('register_cleanup', {
      action: 'http_request', args: { method: 'POST', url: `${BASE}/orders/${created.result.body.id}/cancel` }, desc: 'Huỷ lệnh tạo để chuẩn bị',
    })
    const unknown = await call('provide_input', { name: 'nope', evidenceId: created.evidenceId, path: '$.body.id' })
    expect(unknown.error).toContain('inputs to prepare: other_order')
    await call('provide_input', { name: 'other_order', evidenceId: created.evidenceId, path: '$.body.id' })
  },
  async 'IN-01'(call, prompt) {
    prompts['IN-01'] = prompt
    const vars = promptVars(prompt)
    await assertGet(call, `${vars['order-service.url']}/orders/${vars.order_id}`)
  },
  async 'IN-02'(call, prompt) {
    prompts['IN-02'] = prompt
    await assertGet(call, `${BASE}/orders/${promptVars(prompt).other_order}`)
  },
}

describe('run inputs', () => {
  let harness: Harness
  let file: string

  beforeAll(async () => {
    harness = await setupHarness({ port: PORT, scripts })
    file = join(harness.dir, 'inputs.plan.yaml')
    await writeFile(file, PLAN)
  }, 60_000)

  afterAll(() => harness?.dispose())

  const orderStatus = async (id: unknown) => (await (await fetch(`${BASE}/orders/${id}`)).json()).status

  it('resolves inputs from the runner, fill, agent and default, then cleans up after all cases', async () => {
    const report = await harness.kernel.ctx.runner.run({ plan: file, agent: 'scripted', inputs: { side: 'SELL' } })
    expect(report.cases.map((c) => [c.id, c.verdict, c.reasons])).toEqual([['IN-01', 'pass', []], ['IN-02', 'pass', []]])
    expect(report.blocked).toEqual([])
    const byName = Object.fromEntries(report.inputs.map((i) => [i.name, i]))
    expect(byName.symbol).toEqual({ name: 'symbol', source: 'default', value: 'FPT' })
    expect(byName.side).toEqual({ name: 'side', source: 'user', value: 'SELL' })
    expect(byName.order_id).toMatchObject({ source: 'fill', value: expect.any(Number) })
    expect(byName.other_order).toMatchObject({ source: 'agent', value: expect.any(Number), evidence: { path: '$.body.id' } })

    // Một phiên agent chuẩn bị cho cả lượt chạy; prompt có mô tả đã thay biến và biến dựng sẵn.
    expect(prepareCalls).toBe(1)
    expect(prompts.$prepare).toContain('Tìm lệnh NEW của mã FPT khác ' + byName.order_id.value)
    expect(prompts.$prepare).toContain('## Đầu vào cần chuẩn bị')
    const vars = promptVars(prompts['IN-01'])
    expect(vars).toMatchObject({ side: 'SELL', symbol: 'FPT', order_id: byName.order_id.value, other_order: byName.other_order.value })
    expect(vars['$run.short']).toMatch(/^[0-9a-f]{6}$/)
    expect(prompts['IN-01']).toContain(`lượt ${vars['$run.short']}, case IN-01`)
    expect(promptVars(prompts['IN-02'])['$case.id']).toBe('IN-02')

    // Dọn sau mọi case: lệnh do fill tạo (cleanup của input) và lệnh do agent tạo (register_cleanup).
    expect(await orderStatus(byName.order_id.value)).toBe('CANCELLED')
    expect(await orderStatus(byName.other_order.value)).toBe('CANCELLED')
  })

  it('blocks every case when an input does not satisfy its requirement, without calling the test agent', async () => {
    const plan = PLAN.replace(`  side: { desc: Chiều lệnh }`, `  side: { desc: Chiều lệnh, require: { op: eq, value: BUY } }`)
    const blockedFile = join(harness.dir, 'blocked.plan.yaml')
    await writeFile(blockedFile, plan)
    const before = { ...prompts }
    const report = await harness.kernel.ctx.runner.run({ plan: blockedFile, agent: 'scripted', inputs: { side: 'SELL', other_order: 1 } })
    expect(report.cases.map((c) => c.verdict)).toEqual(['blocked', 'blocked'])
    expect(report.totals).toMatchObject({ total: 2, blocked: 2, pass: 0 })
    expect(report.blocked).toEqual([expect.stringMatching(/^input side: does not satisfy requirement/)])
    expect(prompts['IN-01']).toBe(before['IN-01'])
    // Lệnh do fill tạo vẫn được dọn dù lượt chạy bị chặn.
    expect(await orderStatus(report.inputs.find((i) => i.name === 'order_id')!.value)).toBe('CANCELLED')
  })

  it('blocks the run when a required input has no source', async () => {
    const plan = PLAN.replace(/  other_order:[\s\S]*?require: \{ op: gt, value: 0 \}\n/, '  account: { desc: Tài khoản thử }\n')
      .replace('{{other_order}}', '{{order_id}}')
    const missingFile = join(harness.dir, 'missing.plan.yaml')
    await writeFile(missingFile, plan)
    const report = await harness.kernel.ctx.runner.run({ plan: missingFile, agent: 'scripted', inputs: { side: 'BUY' } })
    expect(report.blocked).toEqual(['input account: no value: provide it when running, or define fill/prepare/default'])
    expect(report.inputs.find((i) => i.name === 'account')).toMatchObject({ source: 'missing' })
  })

  it('checks inputs when authoring and summarizes them for the interface', async () => {
    const result = await harness.kernel.ctx.authoring.validate(PLAN.replace('uses: [db, http]', 'uses: [db, kafka]'))
    expect(result.issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual([
      'prepare uses namespace kafka, which has no registered action',
    ])
    const ok = await harness.kernel.ctx.authoring.validate(PLAN)
    expect(ok.issues.filter((i) => i.level === 'error')).toEqual([])
    expect(ok.issues.map((i) => i.message)).toContain('input side has no fill, prepare or default; the run is blocked unless the runner provides it')
    const invalid = await harness.kernel.ctx.authoring.validate(PLAN.replace('save: { order_id: $.body.id }', 'save: { other: $.body.id }'))
    expect(invalid.issues.map((i) => i.message)).toContain('input order_id: a fill step must save order_id')
  })

  it('parses --input values from the command line', () => {
    expect(parseInputs(['side=SELL', 'qty=100', 'flag=true', 'account=001C123', 'ids=[1,2]', 'note=a=b'])).toEqual({
      side: 'SELL', qty: 100, flag: true, account: '001C123', ids: [1, 2], note: 'a=b',
    })
    expect(() => parseInputs(['oops'])).toThrow(/expected name=value/)
  })
})
