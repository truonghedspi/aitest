import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { z, type Context } from '@aitest/core'

/**
 * Action truy vấn cơ sở dữ liệu SQLite, dùng cho demo và môi trường cục bộ.
 *
 * Driver Postgres/MySQL/Oracle triển khai theo cùng mẫu: một plugin đăng ký action `<namespace>_query`.
 * Mỗi instance plugin ứng với một cơ sở dữ liệu.
 */
export interface Config {
  namespace: string
  file: string
  readonly: boolean
  maxRows: number
}

export const name = 'action-sqlite'
export const inject = ['actions']

export const Config = z.object({
  namespace: z.string().default('db'),
  file: z.string().required().description('Đường dẫn file SQLite.'),
  readonly: z.boolean().default(true).description('Mở kết nối chỉ đọc.'),
  maxRows: z.natural().default(200),
})

export function apply(ctx: Context, config: Config) {
  const file = resolve(config.file)
  let db: DatabaseSync | undefined
  const open = () => db ??= new DatabaseSync(file, { readOnly: config.readonly })
  ctx.effect(() => () => { db?.close(); db = undefined }, `sqlite(${file})`)

  ctx.actions.register({
    name: `${config.namespace}_query`,
    namespace: config.namespace,
    readOnly: config.readonly,
    description: `Chạy một câu SQL trên cơ sở dữ liệu SQLite \`${config.namespace}\` và trả về các dòng kết quả. Dùng tham số \`?\` cho giá trị.`,
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        params: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    async execute(args: { sql: string; params?: Array<string | number | boolean | null> }) {
      const statement = open().prepare(args.sql)
      const params = (args.params ?? []).map((p) => (typeof p === 'boolean' ? Number(p) : p))
      if (statement.columns().length === 0) {
        const info = statement.run(...params)
        return { changes: Number(info.changes) }
      }
      const rows = statement.all(...params).map((row) => ({ ...row }))
      return { rowCount: rows.length, rows: rows.slice(0, config.maxRows), truncated: rows.length > config.maxRows }
    },
  })
}
