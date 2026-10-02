/**
 * Kiểm thử lý do gọi tool: gateway thêm `reason`, `step` vào schema, tách khỏi tham số và ghi vào log.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { withIntent } from '@aitest/mcp-gateway'
import { caseScope, root, setupHarness, type Harness } from '../../runner/tests/support.ts'

const PORT = 4189

describe('call intent', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await setupHarness({ port: PORT, scripts: {} })
  })

  afterAll(() => harness?.dispose())

  it('adds a required reason and an optional step to every tool schema', () => {
    const plain = withIntent({ type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, true)
    expect(plain.keys).toEqual({ reason: 'reason', step: 'step' })
    expect(plain.schema.required).toEqual(['url', 'reason'])
    expect(Object.keys(plain.schema.properties!)).toEqual(['url', 'reason', 'step'])

    const clash = withIntent({ type: 'object', properties: { reason: { type: 'string' }, step: { type: 'integer' } } }, true)
    expect(clash.keys).toEqual({ reason: 'agent_reason', step: 'agent_step' })
    expect(clash.schema.required).toEqual(['agent_reason'])
  })

  it('strips reason and step from the arguments and logs them with the call', async () => {
    const { ctx } = harness.kernel
    const plan = await ctx.plans.load(join(root, 'examples/plans/order.plan.yaml'))
    const logged: Array<{ type: string; data: any }> = []
    const scope = caseScope(plan, 0, { log: (type, data) => { logged.push({ type, data }) } })
    const exposure = await ctx.gateway.expose(scope)
    const client = new Client({ name: 'intent-test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(exposure.endpoint.url)))
    try {
      const { tools } = await client.listTools()
      const http = tools.find((t) => t.name === 'http_request')!
      expect(http.inputSchema.required).toContain('reason')

      await client.callTool({
        name: 'http_request',
        arguments: { method: 'GET', url: `http://127.0.0.1:${PORT}/orders`, reason: 'Lấy danh sách lệnh để tìm lệnh vừa đặt', step: 2 },
      })
      const call = logged.find((e) => e.type === 'action/call' && e.data.name === 'http_request')!
      expect(call.data).toMatchObject({ reason: 'Lấy danh sách lệnh để tìm lệnh vừa đặt', step: 2, status: 'ok' })
      expect(call.data.args).toEqual({ method: 'GET', url: `http://127.0.0.1:${PORT}/orders` })
      expect(logged.find((e) => e.type === 'action/start')!.data.reason).toBe('Lấy danh sách lệnh để tìm lệnh vừa đặt')

      // Agent bỏ qua lý do hoặc gửi bước không hợp lệ: lời gọi vẫn chạy, log ghi không có lý do.
      await client.callTool({ name: 'calc', arguments: { expression: '1 + 1', step: 'hai' } })
      const calc = logged.find((e) => e.type === 'action/call' && e.data.name === 'calc')!
      expect(calc.data.reason).toBeUndefined()
      expect(calc.data.step).toBeUndefined()
      expect(calc.data.status).toBe('ok')
    } finally {
      await client.close()
      await exposure.close()
    }
  })
})
