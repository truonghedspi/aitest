import { randomUUID } from 'node:crypto'
import { Kafka, logLevel, type Admin, type KafkaConfig, type SASLOptions } from 'kafkajs'
import { matchesAll, MATCH_SCHEMA, parseMaybeJson, z, type Context, type MatchCondition } from '@aitest/core'

/**
 * Action Kafka cho kiểm thử: đọc và chờ bản tin mà không làm thay đổi hệ thống đang test.
 *
 * - Đọc từ một mốc thời gian (`since`) bằng consumer group tạm `aitest-tap-<uuid>`, không commit offset,
 *   và xoá group ngay sau khi đọc; consumer thật của hệ thống không bị ảnh hưởng.
 * - `kafka_wait_for` chờ tới khi có bản tin khớp điều kiện: dùng sau khi gọi API để xác nhận sự kiện đã phát.
 * - Gửi bản tin (`kafka_produce`) chỉ đăng ký khi `allowProduce: true`.
 */
export interface Config {
  namespace: string
  brokers: string[]
  clientId: string
  ssl: boolean
  sasl?: { mechanism: 'plain' | 'scram-sha-256' | 'scram-sha-512'; username: string; password: string }
  allowProduce: boolean
  defaultSince: string
  maxMessages: number
  maxTimeout: number
}

export const name = 'action-kafka'
export const inject = ['actions']

export const Config = z.object({
  namespace: z.string().default('kafka'),
  brokers: z.array(z.string()).required().description('Danh sách broker, ví dụ `["127.0.0.1:9092"]`.'),
  clientId: z.string().default('aitest'),
  ssl: z.boolean().default(false),
  // Không đánh dấu required ở trường con: schemastery điền object rỗng khi thiếu `sasl`; kiểm tra trong `apply`.
  sasl: z.object({
    mechanism: z.union(['plain', 'scram-sha-256', 'scram-sha-512'] as const),
    username: z.string(),
    password: z.string().description('Dùng `${env.TÊN}`, không ghi mật khẩu vào file cấu hình.'),
  }),
  allowProduce: z.boolean().default(false).description('Bật tool gửi bản tin. Mặc định tắt: kiểm thử chỉ quan sát.'),
  defaultSince: z.string().default('-2m').description('Mốc thời gian mặc định khi đọc: `-2m`, `-30s`, `start`, hoặc thời điểm ISO.'),
  maxMessages: z.natural().default(200),
  maxTimeout: z.natural().default(120).description('Thời gian chờ tối đa, đơn vị giây.'),
})

interface KafkaMessage {
  topic: string
  partition: number
  offset: string
  timestamp: string
  key: string | null
  headers: Record<string, string>
  value: unknown
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(`kafka:${config.namespace}`)
  const sasl = config.sasl && Object.values(config.sasl).some(Boolean) ? config.sasl : undefined
  if (sasl && (!sasl.mechanism || !sasl.username || !sasl.password)) {
    throw new Error('sasl requires mechanism, username and password')
  }
  const kafka = new Kafka({
    clientId: config.clientId,
    brokers: config.brokers,
    ssl: config.ssl,
    sasl: sasl as SASLOptions | undefined,
    // Log của kafkajs đi qua logger của nền tảng: không in ra stdout (stdout của `aitest mcp` là kênh MCP).
    logLevel: logLevel.WARN,
    logCreator: () => ({ log }) => { logger.debug(`${log.message}${log.error ? `: ${log.error}` : ''}`) },
    retry: { retries: 5 },
  } as KafkaConfig)

  let admin: Promise<Admin> | undefined
  const getAdmin = () => admin ??= (async () => { const a = kafka.admin(); await a.connect(); return a })()
  ctx.effect(() => () => { void admin?.then((a) => a.disconnect()).catch(() => {}) }, `kafka(${config.namespace})`)

  const prefix = config.namespace === 'kafka' ? 'kafka' : `${config.namespace}_kafka`
  const timeoutOf = (sec: number | undefined, fallback: number) => Math.min(sec ?? fallback, config.maxTimeout) * 1000

  /**
   * Đọc bản tin của một topic từ mốc `since`. Dừng khi đủ `stopAfter` bản tin khớp, khi đã đọc hết tới
   * cuối topic tại thời điểm bắt đầu (`stopAtEnd`), hoặc khi hết thời gian.
   */
  async function read(options: {
    topic: string; since?: string; key?: string; match?: MatchCondition[]; stopAfter: number; stopAtEnd: boolean; timeoutMs: number
    signal: AbortSignal
  }) {
    const a = await getAdmin()
    const topics = await a.listTopics()
    if (!topics.includes(options.topic)) throw new Error(`topic ${options.topic} does not exist`)
    const since = parseSince(options.since ?? config.defaultSince)
    const start = since === 'earliest'
      ? (await a.fetchTopicOffsets(options.topic)).map((p) => ({ partition: p.partition, offset: p.low }))
      : await a.fetchTopicOffsetsByTimestamp(options.topic, since)
    const end = new Map((await a.fetchTopicOffsets(options.topic)).map((p) => [p.partition, BigInt(p.high)]))
    const pending = new Set(start.filter((p) => BigInt(p.offset) < (end.get(p.partition) ?? 0n)).map((p) => p.partition))

    const matched: KafkaMessage[] = []
    let scanned = 0
    const groupId = `aitest-tap-${randomUUID()}`
    const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false })
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const timer = setTimeout(finish, options.timeoutMs)
    options.signal.addEventListener('abort', finish, { once: true })
    try {
      await consumer.connect()
      await consumer.subscribe({ topic: options.topic, fromBeginning: false })
      await consumer.run({
        autoCommit: false,
        eachMessage: async ({ topic, partition, message }) => {
          scanned++
          const msg: KafkaMessage = {
            topic, partition, offset: message.offset,
            timestamp: new Date(Number(message.timestamp)).toISOString(),
            key: message.key?.toString('utf8') ?? null,
            headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(Array.isArray(v) ? v.join(',') : v?.toString('utf8') ?? '')])),
            value: message.value ? parseMaybeJson(message.value.toString('utf8')) : null,
          }
          const keyOk = options.key === undefined || msg.key === options.key
          if (keyOk && matchesAll(msg, options.match) && matched.length < config.maxMessages) matched.push(msg)
          if (BigInt(message.offset) + 1n >= (end.get(partition) ?? 0n)) pending.delete(partition)
          if (matched.length >= options.stopAfter || (options.stopAtEnd && pending.size === 0)) finish()
        },
      })
      for (const p of start) consumer.seek({ topic: options.topic, partition: p.partition, offset: p.offset })
      if (options.stopAtEnd && pending.size === 0) finish()
      await done
    } finally {
      clearTimeout(timer)
      await consumer.disconnect().catch(() => {})
      // Group tạm không để lại trên broker của hệ thống đang test.
      await a.deleteGroups([groupId]).catch(() => {})
    }
    return { matched, scanned, since: since === 'earliest' ? 'start' : new Date(since).toISOString() }
  }

  ctx.actions.register({
    name: `${prefix}_list_topics`,
    namespace: config.namespace,
    readOnly: true,
    description: 'Liệt kê topic Kafka (bỏ topic nội bộ) kèm số partition và offset cuối.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const a = await getAdmin()
      const names = (await a.listTopics()).filter((t) => !t.startsWith('__')).sort()
      const topics = await Promise.all(names.map(async (topic) => {
        const offsets = await a.fetchTopicOffsets(topic)
        return { topic, partitions: offsets.length, messages: offsets.reduce((n, p) => n + Number(BigInt(p.high) - BigInt(p.low)), 0) }
      }))
      return { topics }
    },
  })

  ctx.actions.register({
    name: `${prefix}_read`,
    namespace: config.namespace,
    readOnly: true,
    description: [
      'Đọc bản tin của một topic Kafka từ mốc thời gian `since`, không commit offset, không ảnh hưởng consumer thật.',
      'Giá trị JSON được parse sẵn trong `value`. Dừng khi đọc hết tới cuối topic, đủ `limit`, hoặc hết thời gian.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        since: { type: 'string', description: 'Mốc bắt đầu: `-2m`, `-30s`, `-1h`, `start` (đầu topic), hoặc thời điểm ISO.' },
        key: { type: 'string', description: 'Chỉ lấy bản tin có key này.' },
        match: MATCH_SCHEMA,
        limit: { type: 'integer', minimum: 1, maximum: config.maxMessages, default: 20 },
        timeoutSec: { type: 'integer', minimum: 1, default: 15 },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    async execute(args: { topic: string; since?: string; key?: string; match?: MatchCondition[]; limit?: number; timeoutSec?: number }, { signal }) {
      const result = await read({
        topic: args.topic, since: args.since, key: args.key, match: args.match,
        stopAfter: args.limit ?? 20, stopAtEnd: true, timeoutMs: timeoutOf(args.timeoutSec, 15), signal,
      })
      return { topic: args.topic, since: result.since, count: result.matched.length, scanned: result.scanned, messages: result.matched }
    },
  })

  ctx.actions.register({
    name: `${prefix}_wait_for`,
    namespace: config.namespace,
    readOnly: true,
    description: [
      'Chờ tới khi topic Kafka có đủ `count` bản tin khớp điều kiện, tính từ mốc `since` (mặc định 2 phút trước).',
      'Dùng sau khi gọi API để xác nhận hệ thống đã phát sự kiện. Lọc thật chặt (ví dụ theo mã đơn) để không khớp nhầm bản tin cũ.',
      'Hết thời gian không phải lỗi: trả `satisfied: false` kèm các bản tin đã khớp.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        match: MATCH_SCHEMA,
        key: { type: 'string' },
        count: { type: 'integer', minimum: 1, default: 1 },
        since: { type: 'string', description: 'Mốc bắt đầu: `-2m`, `-30s`, `start`, hoặc thời điểm ISO.' },
        timeoutSec: { type: 'integer', minimum: 1, default: 30 },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    async execute(args: { topic: string; match?: MatchCondition[]; key?: string; count?: number; since?: string; timeoutSec?: number }, { signal }) {
      const count = args.count ?? 1
      const result = await read({
        topic: args.topic, since: args.since, key: args.key, match: args.match,
        stopAfter: count, stopAtEnd: false, timeoutMs: timeoutOf(args.timeoutSec, 30), signal,
      })
      return { topic: args.topic, since: result.since, satisfied: result.matched.length >= count, count: result.matched.length, scanned: result.scanned, messages: result.matched }
    },
  })

  if (config.allowProduce) {
    ctx.actions.register({
      name: `${prefix}_produce`,
      namespace: config.namespace,
      description: 'Gửi một bản tin vào topic Kafka. `value` dạng object được gửi dưới dạng JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          key: { type: 'string' },
          value: {},
          headers: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['topic', 'value'],
        additionalProperties: false,
      },
      async execute(args: { topic: string; key?: string; value: unknown; headers?: Record<string, string> }) {
        const producer = kafka.producer({ allowAutoTopicCreation: false })
        await producer.connect()
        try {
          const value = typeof args.value === 'string' ? args.value : JSON.stringify(args.value)
          const [meta] = await producer.send({ topic: args.topic, messages: [{ key: args.key, value, headers: args.headers }] })
          return { topic: args.topic, partition: meta.partition, offset: meta.baseOffset }
        } finally {
          await producer.disconnect().catch(() => {})
        }
      },
    })
  }
}

/** `-2m`, `-30s`, `-1h`, `start`, số mili giây epoch, hoặc thời điểm ISO → mốc thời gian (ms) hoặc đầu topic. */
export function parseSince(value: string): number | 'earliest' {
  const text = value.trim()
  if (text === 'start' || text === 'earliest') return 'earliest'
  const relative = /^-(\d+)(ms|s|m|h|d)$/.exec(text)
  if (relative) {
    const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 'ms' | 's' | 'm' | 'h' | 'd']
    return Date.now() - Number(relative[1]) * unit
  }
  if (/^\d{12,}$/.test(text)) return Number(text)
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) throw new Error(`invalid since: ${value}; use -2m, -30s, start, or an ISO time`)
  return parsed
}
