/**
 * Kiểm thử năng lực test sự kiện qua message broker: Kafka và RabbitMQ.
 *
 * Chỉ chạy khi có broker thật: đặt KAFKA_BROKERS (ví dụ `127.0.0.1:9092`)
 * và RABBITMQ_URL (ví dụ `amqp://guest:guest@127.0.0.1:5672`).
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestPlan } from '@aitest/core'
import { caseScope, root, setupHarness, type Harness, type Script } from './support.ts'

const PORT = 4188
const BASE = `http://127.0.0.1:${PORT}`
const { KAFKA_BROKERS, RABBITMQ_URL } = process.env
const skip = !KAFKA_BROKERS || !RABBITMQ_URL

const scripts: Record<string, Script> = {
  async 'EV-01'(call) {
    const created = await call('http_request', {
      method: 'POST', url: `${BASE}/orders`, body: { symbol: 'SSI', side: 'BUY', qty: 100, price: 30000 },
    })
    const orderId = created.result.body.id
    const event = await call('kafka_wait_for', {
      topic: 'order-events', timeoutSec: 20,
      match: [{ path: '$.value.orderId', op: 'eq', value: orderId }, { path: '$.value.event', op: 'eq', value: 'order.created' }],
    })
    expect(event.result.satisfied).toBe(true)
    await call('assert_expectation', { expectId: 'http-201', evidenceId: created.evidenceId, path: '$.status' })
    await call('assert_expectation', { expectId: 'kafka-event', evidenceId: event.evidenceId, path: '$.messages[0].value.event' })
    await call('assert_expectation', {
      expectId: 'kafka-order-id', evidenceId: event.evidenceId, path: '$.messages[0].value.orderId',
      inputs: { orderId: { evidenceId: created.evidenceId, path: '$.body.id' } },
    })
    await call('assert_expectation', { expectId: 'kafka-qty', evidenceId: event.evidenceId, path: '$.messages[0].value.qty' })
  },
  async 'EV-02'(call) {
    const tap = await call('rabbitmq_tap', { exchange: 'orders', routingKey: 'order.*' })
    const created = await call('http_request', {
      method: 'POST', url: `${BASE}/orders`, body: { symbol: 'SSI', side: 'SELL', qty: 200, price: 30500 },
    })
    const orderId = created.result.body.id
    await call('http_request', { method: 'POST', url: `${BASE}/orders/${orderId}/cancel` })
    const events = await call('rabbitmq_wait_for', {
      tapId: tap.result.tapId, count: 2, timeoutSec: 20, match: [{ path: '$.value.orderId', op: 'eq', value: orderId }],
    })
    expect(events.result.satisfied).toBe(true)
    await call('assert_expectation', { expectId: 'rabbit-first', evidenceId: events.evidenceId, path: '$.messages[0].routingKey' })
    await call('assert_expectation', { expectId: 'rabbit-second', evidenceId: events.evidenceId, path: '$.messages[1].routingKey' })
    await call('assert_expectation', { expectId: 'rabbit-status', evidenceId: events.evidenceId, path: '$.messages[1].value.status' })
  },
}

describe.skipIf(skip)('message broker capabilities (scripted agent)', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await setupHarness({ port: PORT, config: 'aitest.events.yml', scripts, env: { KAFKA_BROKERS: KAFKA_BROKERS!, RABBITMQ_URL: RABBITMQ_URL! } })
  }, 60_000)

  afterAll(() => harness?.dispose())

  it('asserts Kafka and RabbitMQ events produced by the API', async () => {
    const report = await harness.kernel.ctx.runner.run({ plan: join(root, 'examples/plans/order-events.plan.yaml'), agent: 'scripted' })
    expect(Object.fromEntries(report.cases.map((c) => [c.id, [c.verdict, c.reasons]]))).toEqual({
      'EV-01': ['pass', []],
      'EV-02': ['pass', []],
    })
  }, 120_000)

  it('keeps broker tools read-only by default and reports broker errors as tool errors', async () => {
    const { ctx } = harness.kernel
    const plan = await ctx.plans.load(join(root, 'examples/plans/order-events.plan.yaml')) as TestPlan
    const scope = caseScope(plan)
    const names = ctx.actions.list(scope).map((a) => a.name)
    expect(names).toEqual(expect.arrayContaining(['kafka_list_topics', 'kafka_read', 'kafka_wait_for', 'rabbitmq_tap', 'rabbitmq_wait_for', 'rabbitmq_queue_info']))
    expect(names).not.toContain('kafka_produce')
    expect(names).not.toContain('rabbitmq_publish')

    const topics = await ctx.actions.invoke(scope, 'kafka_list_topics', {})
    expect(topics.status).toBe('ok')
    expect((topics.value as { topics: Array<{ topic: string }> }).topics.map((t) => t.topic)).toContain('order-events')

    // Queue không tồn tại: broker đóng channel, tool trả lỗi rõ ràng, process vẫn chạy.
    const missing = await ctx.actions.invoke(scope, 'rabbitmq_queue_info', { queue: 'aitest-missing-queue' })
    expect(missing).toMatchObject({ status: 'error', error: expect.stringContaining('does not exist') })

    // Hết thời gian chờ không phải lỗi: trả satisfied false.
    const tap = await ctx.actions.invoke(scope, 'rabbitmq_tap', { exchange: 'orders', routingKey: 'order.never' })
    const waited = await ctx.actions.invoke(scope, 'rabbitmq_wait_for', { tapId: (tap.value as { tapId: string }).tapId, timeoutSec: 1 })
    expect(waited).toMatchObject({ status: 'ok', value: { satisfied: false, count: 0 } })
    await ctx.parallel('case/end', scope, { verdict: 'pass', reasons: [] } as never)
  }, 60_000)
})
