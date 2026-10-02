import { fetch } from 'undici'
import { parseJson, z, type Context } from '@aitest/core'
import { createDispatcher, explainNetworkError, proxyFor, redact, type NetworkConfig } from './network.ts'

export { parseJson }
export { resolveProxy, proxyFor } from './network.ts'

/**
 * Action gọi HTTP API. Namespace mặc định là `http`.
 * Có thể nạp nhiều instance với `namespace` khác nhau để gắn `baseUrl` và header riêng cho từng hệ thống.
 * Mạng đi giống `curl` trên cùng máy: proxy theo biến môi trường, kho chứng chỉ của hệ điều hành (`network.ts`).
 */
export interface Config extends NetworkConfig {
  namespace: string
  baseUrl?: string
  headers: Record<string, string>
  maxBodyChars: number
}

export const name = 'action-http'
export const inject = ['actions']

export const Config = z.object({
  namespace: z.string().default('http'),
  baseUrl: z.string().description('Ghép với `url` tương đối, ví dụ `/orders`.'),
  headers: z.dict(z.string()).default({}).description('Header mặc định, ví dụ token xác thực.'),
  timeout: z.natural().default(30).description('Giới hạn thời gian mỗi request, đơn vị giây.'),
  connectTimeout: z.natural().default(10).description('Giới hạn thời gian mở kết nối (kể cả qua proxy), đơn vị giây.'),
  proxy: z.string().default('env').description(
    '`env`: dùng HTTP_PROXY, HTTPS_PROXY, NO_PROXY như curl; `none`: kết nối thẳng; hoặc URL proxy, ví dụ `http://proxy.corp:8080`.',
  ),
  noProxy: z.array(z.string()).default([]).description('Host không đi qua proxy, cộng thêm với NO_PROXY, ví dụ `.corp.local`, `10.1.2.3`.'),
  systemCa: z.boolean().default(true).description('Tin kho chứng chỉ của hệ điều hành như curl, ngoài kho có sẵn của Node.'),
  ca: z.array(z.string()).default([]).description('File chứng chỉ PEM tin thêm, ví dụ CA nội bộ.'),
  insecure: z.boolean().default(false).description('Bỏ kiểm tra chứng chỉ TLS (như curl -k); chỉ dùng cho môi trường thử nghiệm.'),
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
  const logger = ctx.logger(`http:${config.namespace}`)
  const { dispatcher, proxy } = createDispatcher(config)
  ctx.effect(() => () => { void dispatcher.close().catch(() => {}) }, `http(${config.namespace}).dispatcher`)
  if (proxy.source !== 'none') {
    logger.info('proxy from %s: http=%s https=%s no_proxy=%s', proxy.source, redact(proxy.http ?? '-'), redact(proxy.https ?? '-'), proxy.noProxy || '-')
  }
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
      const via = proxyFor(url, proxy)
      const method = args.method ?? 'GET'
      // Báo lỗi nêu rõ bước bị lỗi (DNS, kết nối, TLS, chờ phản hồi) và đường đi (qua proxy hay kết nối thẳng).
      const fail = (error: Error & { name?: string; cause?: { code?: string; message?: string } }): never => {
        const elapsed = `${Math.round(performance.now() - started)} ms`
        if (error.name === 'TimeoutError') {
          throw new Error(`${method} ${url.href} timed out after ${config.timeout} s (${via ? `via proxy ${redact(via)}` : 'direct connection'})`)
        }
        if (error.name === 'AbortError') throw new Error(`${method} ${url.href} was cancelled after ${elapsed}`)
        // Nguyên nhân thật có thể nằm sâu trong chuỗi `cause` (ví dụ proxy từ chối CONNECT).
        const chain: Array<{ code?: unknown; message?: string }> = []
        for (let c: any = error.cause; c && chain.length < 5; c = c.cause) chain.push(c)
        const code = chain.map((c) => c.code).find((c): c is string => typeof c === 'string' && c !== '0')
        const tunnel = chain.map((c) => /Proxy response \((\d+)\)/.exec(c.message ?? '')).find(Boolean)
        if (tunnel) {
          throw new Error(`${method} ${url.href} failed after ${elapsed}: proxy refused the tunnel (${tunnel[1]}) (via proxy ${redact(via ?? '')}); check proxy credentials and whether the proxy can reach the host`)
        }
        const detail = error.cause?.message && error.cause.message !== code ? `: ${error.cause.message}` : ''
        throw new Error(`${method} ${url.href} failed after ${elapsed}: ${explainNetworkError(code, via)}${detail}`)
      }
      const response = await fetch(url, {
        method,
        headers,
        body,
        dispatcher,
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeout * 1000)]),
      }).catch(fail)
      const text = await response.text().catch(fail)
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
