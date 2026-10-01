import { z, type Context } from '@aitest/core'

/**
 * Guard cơ bản, chạy trên event `action/before`.
 *
 * - `readOnlyNamespaces`: trong các namespace này, chỉ cho phép action khai báo `readOnly`
 *   và câu SQL bắt đầu bằng SELECT/WITH/EXPLAIN/PRAGMA.
 * - `allowedHosts`: action HTTP chỉ được gọi tới các host trong danh sách (rỗng nghĩa là không giới hạn).
 * - `denyActions`: chặn hẳn một số action theo tên.
 */
export interface Config {
  readOnlyNamespaces: string[]
  allowedHosts: string[]
  denyActions: string[]
}

export const name = 'guard-basic'

export const Config = z.object({
  readOnlyNamespaces: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  denyActions: z.array(z.string()).default([]),
})

const READ_SQL = /^\s*(select|with|explain|pragma)\b/i

export function apply(ctx: Context, config: Config) {
  ctx.on('action/before', async (call, next) => {
    if (config.denyActions.includes(call.name)) {
      return { type: 'deny', reason: `action ${call.name} is denied by guard-basic` }
    }
    if (config.readOnlyNamespaces.includes(call.namespace)) {
      const sql = call.args.sql
      if (typeof sql === 'string' && !READ_SQL.test(sql)) {
        return { type: 'deny', reason: `namespace ${call.namespace} is read-only; only SELECT/WITH/EXPLAIN/PRAGMA allowed` }
      }
      if (typeof sql !== 'string' && !call.definition.readOnly) {
        return { type: 'deny', reason: `namespace ${call.namespace} is read-only; action ${call.name} may have side effects` }
      }
    }
    if (config.allowedHosts.length && typeof call.args.url === 'string' && /^https?:/i.test(call.args.url)) {
      const host = new URL(call.args.url).host
      if (!config.allowedHosts.includes(host)) {
        return { type: 'deny', reason: `host ${host} is not in allowedHosts` }
      }
    }
    return next()
  })
}
