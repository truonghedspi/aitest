/**
 * Công thức dùng biến của lượt chạy: đầu vào người chạy điền dạng chuỗi JSON, đầu vào dạng object tạo bằng `fill`,
 * trường lồng trong template và công thức. Agent assert mà không truyền `inputs` cho các biến đó; báo cáo ghi giá trị đã dùng.
 * Khi soạn plan, `validate_plan` cho biết nguồn từng biến, tính thử công thức với giá trị có sẵn, cảnh báo biến không có bước thu thập.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AuthoringSession } from '@aitest/authoring'
import { setupHarness, type Harness } from '../../runner/tests/support.ts'

const PORT = 4178
const BASE = `http://127.0.0.1:${PORT}`

const PLAN = `id: TP-RUNVARS
name: Biến của lượt chạy trong công thức
requires: [http]
vars:
  limits: { lot: 100 }
inputs:
  account:
    desc: Tài khoản (JSON) do người chạy điền
    required: true
  order:
    desc: Lệnh tạo riêng cho lượt chạy
    fill:
      - action: http_request
        args: { method: POST, url: "${BASE}/orders", body: { symbol: RVA, side: BUY, qty: "{{account.qty}}", price: "{{account.price}}" } }
        save: { order: $.body }
cases:
  - id: RV-01
    title: Lệnh đọc lại đúng khối lượng và giá trị
    steps:
      - Gọi GET ${BASE}/orders/{{order.id}}.
    expect:
      - { id: qty, desc: Khối lượng bằng của tài khoản, check: { op: eq, expr: "account.qty" } }
      - { id: lots, desc: Số lô, check: { op: eq, expr: "div(order.qty, limits.lot, 0, DOWN)" } }
      - { id: notional, desc: Giá trị lệnh, check: { op: eq, expr: "order.qty * account.price" } }
`

describe('run variables in formulas', () => {
  let harness: Harness
  let session: AuthoringSession

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      scripts: {
        async 'RV-01'(call, prompt) {
          expect(prompt).toContain('nền tảng tự gắn `account` từ dữ liệu của lượt chạy')
          const res = await call('http_request', { method: 'GET', url: `${BASE}/orders/${/orders\/(\d+)/.exec(prompt)![1]}` })
          // Không truyền `inputs`: mọi biến của công thức là biến của lượt chạy.
          await call('assert_expectation', { expectId: 'qty', evidenceId: res.evidenceId, path: '$.body.qty' })
          await call('assert_expectation', { expectId: 'lots', evidenceId: res.evidenceId, path: '$.body.qty' })
          const calc = await call('calc', { expression: 'order.qty * account.price' })
          await call('assert_expectation', { expectId: 'notional', evidenceId: calc.evidenceId, path: '$.result' })
        },
      },
    })
    harness.kernel.ctx.runner.config.agent = 'scripted'
    session = await harness.kernel.ctx.authoring.createSession()
  }, 60_000)

  afterAll(async () => {
    await session?.close()
    await harness?.dispose()
  })

  it('binds input, fill and plan variables in formulas and templates, and records them in the report', async () => {
    const file = join(harness.dir, 'runvars.plan.yaml')
    await writeFile(file, PLAN)
    const report = await harness.kernel.ctx.runner.run({ plan: file, inputs: { account: '{"qty": 300, "price": 25000}' } })
    const c = report.cases[0]
    expect(c.expectations.map((e) => [e.id, e.assertion?.passed, e.assertion?.expected])).toEqual([
      ['qty', true, '300'], ['lots', false, '3'], ['notional', true, '7500000'],
    ])
    expect(c.expectations[0].assertion).toMatchObject({ runVars: { account: { qty: 300, price: 25000 } } })
    expect(c.expectations[2].assertion!.runVars).toMatchObject({ order: { qty: 300 }, account: { price: 25000 } })
  })

  it('tells the planning agent where each formula variable comes from and checks formulas before any run', async () => {
    const ok = await harness.kernel.ctx.actions.invoke(session.scope, 'validate_plan', { content: PLAN })
    expect(ok.value).toMatchObject({
      valid: true,
      // Đầu vào do người chạy điền, không có mặc định: cảnh báo có sẵn từ trước, không liên quan công thức.
      warnings: [expect.objectContaining({ path: 'inputs.account' })],
      summary: { formulas: [
        { case: 'RV-01', expect: 'qty', fromRun: ['account (input)'], fromEvidence: [] },
        { case: 'RV-01', expect: 'lots', fromRun: ['order (input)', 'limits (vars)'], fromEvidence: [] },
        { case: 'RV-01', expect: 'notional', fromRun: ['order (input)', 'account (input)'], fromEvidence: [] },
      ] },
    })
    const broken = PLAN
      .replace('    desc: Tài khoản (JSON) do người chạy điền\n    required: true', '    desc: Tài khoản\n    default: { qty: 100 }')
      .replace('expr: "account.qty" }', 'expr: "account.qtty + 0" }')
      .replace('expr: "order.qty * account.price" }', 'expr: "order.qty * fee_rate" }')
    const result = (await harness.kernel.ctx.actions.invoke(session.scope, 'validate_plan', { content: broken })).value as {
      errors: Array<{ message: string }>; warnings: Array<{ message: string }>
    }
    expect(result.errors.map((e) => e.message)).toEqual(['expectation qty: account has no field qtty; fields: qty'])
    // Công thức chỉ dùng giá trị có sẵn trong plan được tính thử: lỗi kiểu dữ liệu báo ngay khi soạn.
    const wrongType = (await harness.kernel.ctx.actions.invoke(session.scope, 'validate_plan', {
      content: broken.replace('expr: "account.qtty + 0" }', 'expr: "limits.lot + \'x\'" }'),
    })).value as { errors: Array<{ message: string }> }
    expect(wrongType.errors.map((e) => e.message)).toEqual([expect.stringMatching(/^expectation qty: formula fails with the plan's values \(vars, input defaults\): /)])
    expect(result.warnings.map((w) => w.message)).toEqual([expect.stringContaining('expectation notional: formula variables fee_rate must come from evidence the test agent collects, but no step mentions them')])
  })
})
