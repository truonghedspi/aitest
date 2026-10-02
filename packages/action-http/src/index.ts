import { isSafeNumber, parse as parseLossless } from 'lossless-json'
import { z, type Context } from '@aitest/core'

/**
 * Action gọi HTTP API. Namespace mặc định là `http`.
 * Có thể nạp nhiều instance với `namespace` khác nhau để gắn `baseUrl` và header riêng cho từng hệ thống.
 */
export interface Config {
  namespace: string
  baseUrl?: string
  headers: Record<string, string>
  timeout: number
  maxBodyChars: number
}

export const name = 'action-http'
export const inject = ['actions']

export const Config = z.object({
  namespace: z.string().default('http'),
  baseUrl: z.string().description('Ghép với `url` tương đối, ví dụ `/orders`.'),
  headers: z.dict(z.string()).default({}).description('Header mặc định, ví dụ token xác thực.'),
  timeout: z.natural().default(30).description('Giới hạn thời gian mỗi request, đơn vị giây.'),
  maxBodyChars: z.natural().default(100000),
})

interface Args {
  method?: string
  url: string
  headers?: Record<string, string>
  query?: Record<string, string | number | boolean>
  body?: unknown
}

export function apply(ctx: Context, config: Config) {
  const actionName = config.namespace === 'http' ? 'http_request' : `${config.namespace}_http_request`
  ctx.actions.register({
    name: actionName,
    namespace: config.namespace,
    description: [
      'Gửi một HTTP request và trả về status, headers, body (đã parse JSON nếu được).',
      config.baseUrl ? `URL tương đối được ghép với ${config.baseUrl}.` : '',
    ].join(' ').trim(),
    isReadOnlyCall: (args) => ['GET', 'HEAD'].includes(String(args.method ?? 'GET').toUpperCase()),
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], default: 'GET' },
        url: { type: 'string', description: 'URL tuyệt đối hoặc đường dẫn tương đối với baseUrl.' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        query: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
        body: { description: 'Body JSON; chuỗi được gửi nguyên văn.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(args: Args, { signal }) {
      const url = new URL(args.url, config.baseUrl)
      for (const [k, v] of Object.entries(args.query ?? {})) url.searchParams.set(k, String(v))
      const headers: Record<string, string> = { ...config.headers, ...args.headers }
      let body: string | undefined
      if (args.body !== undefined) {
        body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body)
        if (typeof args.body !== 'string') headers['content-type'] ??= 'application/json'
      }
      const started = performance.now()
      const response = await fetch(url, {
        method: args.method ?? 'GET',
        headers,
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeout * 1000)]),
      }).catch((error: Error & { cause?: { code?: string; message?: string } }) => {
        // `fetch failed` của Node không nêu nguyên nhân; đưa mã lỗi gốc vào thông báo để log chẩn đoán được.
        const cause = error.cause ? ` (${error.cause.code ?? ''} ${error.cause.message ?? ''})`.replace(/\(\s+/, '(') : ''
        throw new Error(`${args.method ?? 'GET'} ${url.href} failed: ${error.message}${cause}`)
      })
      const text = await response.text()
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: parseBody(text, config.maxBodyChars),
        durationMs: Math.round(performance.now() - started),
      }
    },
  })
}

function parseBody(text: string, max: number) {
  if (!text) return null
  try {
    return parseJson(text)
  } catch {
    return text.length > max ? text.slice(0, max) + '…' : text
  }
}

/**
 * Parse JSON mà không mất chữ số: số đổi sang `number` vẫn giữ nguyên giá trị thì trả về `number`;
 * số vượt độ chính xác của `number` (ví dụ `12345678901234567.89`) được giữ dạng chuỗi để so sánh bằng BigDecimal.
 */
export function parseJson(text: string): unknown {
  return parseLossless(text, null, (value: string) => (isSafeNumber(value) ? Number(value) : value))
}
