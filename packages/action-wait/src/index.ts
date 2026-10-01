import { setTimeout as sleep } from 'node:timers/promises'
import { compare, readPath, z, type AssertOp, type Context } from '@aitest/core'

/**
 * Action `wait_until`: gọi lặp một action khác cho tới khi điều kiện đúng hoặc hết thời gian.
 *
 * Dùng cho hệ thống xử lý bất đồng bộ (queue, worker, eventual consistency).
 * Điều kiện được đánh giá xác định bằng cùng bộ so khớp với assertion.
 * Mỗi lần gọi đều đi qua guard và được ghi vào run log như action thường.
 */
export interface Config {
  maxTimeout: number
  minInterval: number
}

export const name = 'action-wait'
export const inject = ['actions']

export const Config = z.object({
  maxTimeout: z.natural().default(300).description('Thời gian chờ tối đa agent được yêu cầu, đơn vị giây.'),
  minInterval: z.natural().default(200).description('Khoảng cách tối thiểu giữa hai lần gọi, đơn vị ms.'),
})

const OPS: AssertOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'matches', 'exists', 'not_exists']

interface Args {
  action: string
  args?: Record<string, unknown>
  path: string
  op: AssertOp
  expected?: unknown
  timeoutSec?: number
  intervalMs?: number
}

export function apply(ctx: Context, config: Config) {
  ctx.actions.register({
    name: 'wait_until',
    namespace: 'wait',
    always: true,
    evidence: false,
    readOnly: true,
    description: [
      'Gọi lặp một action cho tới khi giá trị tại `path` trong kết quả thoả điều kiện, hoặc hết thời gian.',
      'Dùng khi hệ thống xử lý bất đồng bộ. Kết quả trả về `evidenceId` của lần gọi cuối để assert.',
      'Hết thời gian không phải lỗi: trả `satisfied: false` kèm giá trị cuối cùng.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Tên action cần gọi lặp, ví dụ `db_query`.' },
        args: { type: 'object', description: 'Tham số của action đó.' },
        path: { type: 'string', description: 'Đường dẫn trong kết quả, ví dụ `$.rows[0].status`.' },
        op: { type: 'string', enum: OPS },
        expected: { description: 'Giá trị mong đợi.' },
        timeoutSec: { type: 'integer', minimum: 1, default: 30 },
        intervalMs: { type: 'integer', minimum: 100, default: 1000 },
      },
      required: ['action', 'path', 'op'],
      additionalProperties: false,
    },
    async execute(args: Args, { scope, signal }) {
      if (args.action === 'wait_until') throw new Error('wait_until cannot wait on itself')
      const timeoutMs = Math.min(args.timeoutSec ?? 30, config.maxTimeout) * 1000
      const interval = Math.max(args.intervalMs ?? 1000, config.minInterval)
      const started = Date.now()
      let attempts = 0
      let last: { actual?: unknown; evidenceId?: unknown; error?: string } = {}

      while (true) {
        attempts++
        const outcome = await ctx.actions.invoke(scope, args.action, args.args ?? {})
        if (outcome.status === 'denied') throw new Error(`action ${args.action} denied: ${outcome.error}`)
        if (outcome.status === 'ok') {
          const actual = readPath(outcome.value, args.path)
          last = { actual, evidenceId: outcome.annotations.evidenceId }
          if (compare(args.op, actual, args.expected).passed) {
            return { satisfied: true, attempts, elapsedMs: Date.now() - started, ...last }
          }
        } else {
          last = { error: outcome.error, evidenceId: outcome.annotations.evidenceId }
        }
        if (Date.now() - started + interval > timeoutMs) {
          return { satisfied: false, attempts, elapsedMs: Date.now() - started, ...last }
        }
        await sleep(interval, undefined, { signal })
      }
    },
  })
}
