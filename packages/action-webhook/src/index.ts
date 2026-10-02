import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z, type ActionScope, type Context } from '@aitest/core'

/**
 * Webhook sink: nền tảng tự host endpoint HTTP để nhận callback từ hệ thống đích.
 *
 * - `webhook_create` tạo một URL riêng cho case hiện tại.
 * - `webhook_wait` chờ tới khi URL đó nhận đủ số request rồi trả về nội dung các request.
 * Sink tự đóng khi case kết thúc.
 */
export interface Config {
  host: string
  port: number
  publicBaseUrl?: string
  responseStatus: number
  maxTimeout: number
}

export const name = 'action-webhook'
export const inject = ['actions']

export const Config = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.natural().default(0),
  publicBaseUrl: z.string().description('URL mà hệ thống đích dùng để gọi tới sink, ví dụ khi chạy trong Docker.'),
  responseStatus: z.natural().default(200),
  maxTimeout: z.natural().default(300),
})

interface CapturedRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string | string[] | undefined>
  body: unknown
  receivedAt: string
}

interface Sink {
  id: string
  scope: ActionScope
  requests: CapturedRequest[]
  waiters: Set<() => void>
}

export function apply(ctx: Context, config: Config) {
  const sinks = new Map<string, Sink>()
  let server: Server | undefined
  let baseUrl: Promise<string> | undefined

  const start = () => baseUrl ??= new Promise<string>((resolve, reject) => {
    const http = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const sink = sinks.get(url.pathname.split('/')[2] ?? '')
      if (!url.pathname.startsWith('/hooks/') || !sink) return void res.writeHead(404).end()
      sink.requests.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: await readBody(req),
        receivedAt: new Date().toISOString(),
      })
      for (const wake of sink.waiters) wake()
      res.writeHead(config.responseStatus, { 'content-type': 'application/json' }).end('{"ok":true}')
    })
    http.once('error', reject)
    http.listen(config.port, config.host, () => {
      server = http
      const { port } = http.address() as AddressInfo
      resolve(config.publicBaseUrl ?? `http://${config.host}:${port}`)
    })
  })

  ctx.effect(() => () => {
    sinks.clear()
    server?.close()
    server = undefined
    baseUrl = undefined
  }, 'webhook.http')

  ctx.on('case/end', async (scope) => {
    for (const [id, sink] of sinks) if (sink.scope === scope) sinks.delete(id)
  })

  ctx.actions.register({
    name: 'webhook_create',
    namespace: 'webhook',
    scopes: ['case'],
    evidence: false,
    description: 'Tạo một URL webhook để hệ thống đích gọi callback tới. Trả về `id` và `url`.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, { scope }) {
      const base = await start()
      const id = randomUUID()
      sinks.set(id, { id, scope, requests: [], waiters: new Set() })
      return { id, url: `${base}/hooks/${id}` }
    },
  })

  ctx.actions.register({
    name: 'webhook_wait',
    namespace: 'webhook',
    scopes: ['case'],
    readOnly: true,
    description: [
      'Chờ tới khi webhook nhận đủ `count` request (mặc định 1) hoặc hết thời gian.',
      'Trả về `received` và danh sách `requests` (method, headers, body, receivedAt).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Mã webhook từ `webhook_create`.' },
        count: { type: 'integer', minimum: 1, default: 1 },
        timeoutSec: { type: 'integer', minimum: 1, default: 30 },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args: { id: string; count?: number; timeoutSec?: number }, { scope, signal }) {
      const sink = sinks.get(args.id)
      if (!sink || sink.scope !== scope) throw new Error(`unknown webhook id: ${args.id}`)
      const count = args.count ?? 1
      const timeoutMs = Math.min(args.timeoutSec ?? 30, config.maxTimeout) * 1000
      if (sink.requests.length < count) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            sink.waiters.delete(check)
            signal.removeEventListener('abort', done)
            resolve()
          }
          const check = () => { if (sink.requests.length >= count) done() }
          const timer = setTimeout(done, timeoutMs)
          sink.waiters.add(check)
          signal.addEventListener('abort', done, { once: true })
        })
      }
      return { received: sink.requests.length, satisfied: sink.requests.length >= count, requests: sink.requests }
    },
  })
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}
