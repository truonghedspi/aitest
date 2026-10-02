import { randomUUID } from 'node:crypto'
import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { matchesAll, MATCH_SCHEMA, parseMaybeJson, z, type ActionScope, type Context, type MatchCondition } from '@aitest/core'

/**
 * Action RabbitMQ cho kiểm thử theo mô hình "tap".
 *
 * Đọc từ queue có sẵn sẽ lấy mất bản tin của consumer thật. Thay vào đó, `rabbitmq_tap` tạo một queue tạm
 * (exclusive, tự xoá) gắn vào exchange với routing key cần nghe; mọi bản tin tới exchange sau thời điểm đó
 * được sao một bản vào queue tạm. Agent tạo tap **trước** khi gọi API, rồi dùng `rabbitmq_wait_for` để chờ bản tin.
 * Tap tự đóng khi case kết thúc. Gửi bản tin (`rabbitmq_publish`) chỉ đăng ký khi `allowPublish: true`.
 */
export interface Config {
  namespace: string
  url: string
  allowPublish: boolean
  maxMessages: number
  maxTimeout: number
}

export const name = 'action-rabbitmq'
export const inject = ['actions']

export const Config = z.object({
  namespace: z.string().default('rabbitmq'),
  url: z.string().required().description('URL AMQP, ví dụ `amqp://user:${env.RABBITMQ_PASSWORD}@host:5672/vhost`.'),
  allowPublish: z.boolean().default(false).description('Bật tool gửi bản tin. Mặc định tắt: kiểm thử chỉ quan sát.'),
  maxMessages: z.natural().default(500).description('Số bản tin tối đa giữ trong mỗi tap.'),
  maxTimeout: z.natural().default(120).description('Thời gian chờ tối đa, đơn vị giây.'),
})

interface RabbitMessage {
  exchange: string
  routingKey: string
  receivedAt: string
  headers: Record<string, unknown>
  properties: { contentType?: string; messageId?: string; correlationId?: string; type?: string }
  value: unknown
}

interface Tap {
  id: string
  scope: ActionScope
  exchange: string
  routingKey: string
  queue: string
  channel: Channel
  messages: RabbitMessage[]
  waiters: Set<() => void>
  dropped: number
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(`rabbitmq:${config.namespace}`)
  let connection: Promise<ChannelModel> | undefined
  const taps = new Map<string, Tap>()

  const connect = () => connection ??= (async () => {
    const conn = await amqp.connect(config.url)
    conn.on('error', (error) => logger.debug('connection error: %s', error.message))
    conn.on('close', () => { connection = undefined })
    return conn
  })().catch((error) => { connection = undefined; throw error })

  /** Mở channel riêng có xử lý lỗi: lỗi của broker (ví dụ 404) đóng channel, không được làm sập process. */
  const openChannel = async () => {
    const channel = await (await connect()).createChannel()
    channel.on('error', (error) => logger.debug('channel error: %s', error.message))
    return channel
  }

  const closeTap = async (tap: Tap) => {
    taps.delete(tap.id)
    for (const wake of tap.waiters) wake()
    await tap.channel.close().catch(() => {})
  }

  ctx.effect(() => () => {
    for (const tap of [...taps.values()]) void closeTap(tap)
    void connection?.then((c) => c.close()).catch(() => {})
    connection = undefined
  }, `rabbitmq(${config.namespace})`)

  // Tap thuộc về case đã tạo nó; đóng khi case kết thúc.
  ctx.on('case/end', async (scope) => {
    for (const tap of [...taps.values()]) if (tap.scope === scope) await closeTap(tap)
  })

  const prefix = config.namespace === 'rabbitmq' ? 'rabbitmq' : `${config.namespace}_rabbitmq`

  ctx.actions.register({
    name: `${prefix}_tap`,
    namespace: config.namespace,
    readOnly: true,
    description: [
      'Bắt đầu nghe bản tin tới một exchange RabbitMQ bằng queue tạm riêng; không lấy mất bản tin của consumer thật.',
      'Gọi TRƯỚC thao tác khiến hệ thống phát bản tin (ví dụ trước khi gọi API đặt lệnh). Trả về `tapId` để chờ bằng `rabbitmq_wait_for`.',
      'Routing key hỗ trợ ký tự đại diện của topic exchange: `order.*`, `order.#`, `#`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        exchange: { type: 'string' },
        routingKey: { type: 'string', default: '#' },
      },
      required: ['exchange'],
      additionalProperties: false,
    },
    async execute(args: { exchange: string; routingKey?: string }, { scope }) {
      const channel = await openChannel()
      try {
        await channel.checkExchange(args.exchange)
      } catch {
        throw new Error(`exchange ${args.exchange} does not exist`)
      }
      const id = `tap-${randomUUID().slice(0, 8)}`
      const routingKey = args.routingKey ?? '#'
      const { queue } = await channel.assertQueue('', { exclusive: true, autoDelete: true, arguments: { 'x-max-length': config.maxMessages } })
      await channel.bindQueue(queue, args.exchange, routingKey)
      const tap: Tap = { id, scope, exchange: args.exchange, routingKey, queue, channel, messages: [], waiters: new Set(), dropped: 0 }
      await channel.consume(queue, (message: ConsumeMessage | null) => {
        if (!message) return
        if (tap.messages.length < config.maxMessages) tap.messages.push(toMessage(message))
        else tap.dropped++
        for (const wake of tap.waiters) wake()
      }, { noAck: true })
      taps.set(id, tap)
      return { tapId: id, exchange: args.exchange, routingKey, startedAt: new Date().toISOString() }
    },
  })

  ctx.actions.register({
    name: `${prefix}_wait_for`,
    namespace: config.namespace,
    readOnly: true,
    description: [
      'Chờ tới khi tap nhận đủ `count` bản tin khớp điều kiện. Giá trị JSON được parse sẵn trong `value`.',
      'Hết thời gian không phải lỗi: trả `satisfied: false` kèm các bản tin đã khớp.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        tapId: { type: 'string' },
        match: MATCH_SCHEMA,
        count: { type: 'integer', minimum: 1, default: 1 },
        timeoutSec: { type: 'integer', minimum: 1, default: 30 },
      },
      required: ['tapId'],
      additionalProperties: false,
    },
    async execute(args: { tapId: string; match?: MatchCondition[]; count?: number; timeoutSec?: number }, { scope, signal }) {
      const tap = taps.get(args.tapId)
      if (!tap || tap.scope !== scope) throw new Error(`unknown tapId ${args.tapId}; create one with ${prefix}_tap first`)
      const count = args.count ?? 1
      const matching = () => tap.messages.filter((m) => matchesAll(m, args.match))
      if (matching().length < count) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            tap.waiters.delete(check)
            signal.removeEventListener('abort', done)
            resolve()
          }
          const check = () => { if (!taps.has(tap.id) || matching().length >= count) done() }
          const timer = setTimeout(done, Math.min(args.timeoutSec ?? 30, config.maxTimeout) * 1000)
          tap.waiters.add(check)
          signal.addEventListener('abort', done, { once: true })
        })
      }
      const messages = matching()
      return {
        tapId: tap.id, satisfied: messages.length >= count, count: messages.length,
        received: tap.messages.length, dropped: tap.dropped, messages,
      }
    },
  })

  ctx.actions.register({
    name: `${prefix}_queue_info`,
    namespace: config.namespace,
    readOnly: true,
    description: 'Xem số bản tin đang chờ và số consumer của một queue, không lấy bản tin ra khỏi queue.',
    inputSchema: { type: 'object', properties: { queue: { type: 'string' } }, required: ['queue'], additionalProperties: false },
    async execute(args: { queue: string }) {
      const channel = await openChannel()
      try {
        const info = await channel.checkQueue(args.queue)
        return { queue: info.queue, messageCount: info.messageCount, consumerCount: info.consumerCount }
      } catch {
        throw new Error(`queue ${args.queue} does not exist`)
      } finally {
        await channel.close().catch(() => {})
      }
    },
  })

  if (config.allowPublish) {
    ctx.actions.register({
      name: `${prefix}_publish`,
      namespace: config.namespace,
      description: 'Gửi một bản tin tới exchange RabbitMQ. `value` dạng object được gửi dưới dạng JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          exchange: { type: 'string' },
          routingKey: { type: 'string' },
          value: {},
          headers: { type: 'object' },
        },
        required: ['exchange', 'routingKey', 'value'],
        additionalProperties: false,
      },
      async execute(args: { exchange: string; routingKey: string; value: unknown; headers?: Record<string, unknown> }) {
        const channel = await (await connect()).createConfirmChannel()
        channel.on('error', () => {})
        try {
          const json = typeof args.value !== 'string'
          channel.publish(args.exchange, args.routingKey, Buffer.from(json ? JSON.stringify(args.value) : args.value as string), {
            contentType: json ? 'application/json' : 'text/plain', headers: args.headers, persistent: true,
          })
          await channel.waitForConfirms()
          return { exchange: args.exchange, routingKey: args.routingKey, confirmed: true }
        } finally {
          await channel.close().catch(() => {})
        }
      },
    })
  }
}

function toMessage(message: ConsumeMessage): RabbitMessage {
  const p = message.properties
  return {
    exchange: message.fields.exchange,
    routingKey: message.fields.routingKey,
    receivedAt: new Date().toISOString(),
    headers: (p.headers ?? {}) as Record<string, unknown>,
    properties: { contentType: p.contentType, messageId: p.messageId, correlationId: p.correlationId, type: p.type },
    value: parseMaybeJson(message.content.toString('utf8')),
  }
}
