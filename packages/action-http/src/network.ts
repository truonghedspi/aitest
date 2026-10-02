import { readFileSync } from 'node:fs'
import { getCACertificates, rootCertificates } from 'node:tls'
import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici'

/**
 * Cấu hình mạng của `action-http`, để request đi giống `curl` trên cùng máy:
 * - proxy: đọc `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` như curl (Node `fetch` mặc định bỏ qua các biến này),
 *   hoặc proxy khai báo trong cấu hình, hoặc không dùng proxy;
 * - chứng chỉ: tin cả kho chứng chỉ của hệ điều hành (như curl) và file PEM khai báo thêm;
 * - thời gian chờ kết nối tách khỏi thời gian chờ cả request, để request treo do không kết nối được báo lỗi sớm và rõ.
 */
export interface NetworkConfig {
  /** `env`: theo biến môi trường như curl; `none`: kết nối thẳng; URL: proxy cố định, ví dụ `http://proxy.corp:8080`. */
  proxy: string
  /** Host không đi qua proxy, cộng thêm với `NO_PROXY`; hỗ trợ `.corp.local`, `10.0.0.0`, `*`. */
  noProxy: string[]
  /** Tin kho chứng chỉ của hệ điều hành, ngoài kho có sẵn của Node. */
  systemCa: boolean
  /** File chứng chỉ PEM tin thêm, ví dụ CA nội bộ. */
  ca: string[]
  /** Bỏ kiểm tra chứng chỉ TLS (như `curl -k`); chỉ dùng cho môi trường thử nghiệm. */
  insecure: boolean
  /** Thời gian chờ mở kết nối (gồm qua proxy), giây. */
  connectTimeout: number
  /** Thời gian chờ cả request, giây. */
  timeout: number
}

export interface ProxyPlan {
  /** Proxy cho URL `http:`; không có thì kết nối thẳng. */
  http?: string
  /** Proxy cho URL `https:`. */
  https?: string
  noProxy: string
  /** Nguồn của cấu hình proxy, để báo lỗi. */
  source: 'env' | 'config' | 'none'
}

/** Proxy áp dụng theo cấu hình và biến môi trường (chấp nhận cả tên viết thường như curl). */
export function resolveProxy(config: Pick<NetworkConfig, 'proxy' | 'noProxy'>, env: NodeJS.ProcessEnv = process.env): ProxyPlan {
  const extra = config.noProxy.join(',')
  const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(',')
  if (config.proxy === 'none' || config.proxy === '') return { noProxy: '', source: 'none' }
  if (config.proxy !== 'env') {
    let url: URL
    try {
      url = new URL(config.proxy)
    } catch {
      throw new Error(`invalid proxy ${config.proxy}; use env, none, or a URL like http://proxy:8080`)
    }
    return { http: url.href, https: url.href, noProxy: extra, source: 'config' }
  }
  const http = env.http_proxy || env.HTTP_PROXY || undefined
  const https = env.https_proxy || env.HTTPS_PROXY || http
  if (!http && !https) return { noProxy: '', source: 'none' }
  return { http, https, noProxy: join(env.no_proxy || env.NO_PROXY, extra), source: 'env' }
}

/** Chứng chỉ tin cậy: kho của Node, của hệ điều hành và file khai báo thêm. */
function trustedCas(config: Pick<NetworkConfig, 'systemCa' | 'ca'>): string[] | undefined {
  if (!config.systemCa && !config.ca.length) return undefined
  const cas = [...rootCertificates]
  if (config.systemCa) {
    try {
      cas.push(...getCACertificates('system'))
    } catch {
      // Node cũ không đọc được kho của hệ điều hành: giữ kho của Node.
    }
  }
  for (const file of config.ca) {
    try {
      cas.push(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`cannot read CA file ${file}: ${(error as Error).message}`)
    }
  }
  return cas
}

/** Dispatcher của undici theo cấu hình mạng; một dispatcher dùng chung, giữ kết nối giữa các request. */
export function createDispatcher(config: NetworkConfig): { dispatcher: Dispatcher; proxy: ProxyPlan } {
  const proxy = resolveProxy(config)
  const tls = { ca: trustedCas(config), rejectUnauthorized: !config.insecure, timeout: config.connectTimeout * 1000 }
  const common = {
    connect: tls,
    // Chờ header và body tối đa bằng thời gian của cả request; lỗi riêng cho biết request treo ở bước nào.
    headersTimeout: config.timeout * 1000,
    bodyTimeout: config.timeout * 1000,
  }
  if (proxy.source === 'none') return { dispatcher: new Agent(common), proxy }
  return {
    dispatcher: new EnvHttpProxyAgent({
      ...common,
      httpProxy: proxy.http,
      httpsProxy: proxy.https,
      noProxy: proxy.noProxy,
      requestTls: tls,
      proxyTls: { timeout: tls.timeout },
    }),
    proxy,
  }
}

/** Proxy mà một URL sẽ đi qua, theo `NO_PROXY` (cùng quy tắc với undici, gần với curl). */
export function proxyFor(url: URL, plan: ProxyPlan): string | undefined {
  const proxy = url.protocol === 'https:' ? plan.https : plan.http
  if (!proxy) return undefined
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  for (const raw of plan.noProxy.split(/[,\s]+/).filter(Boolean)) {
    if (raw === '*') return undefined
    const [entryHost, entryPort] = raw.toLowerCase().replace(/^\*?\./, '.').split(':')
    if (entryPort && entryPort !== port) continue
    if (entryHost.startsWith('.') ? host === entryHost.slice(1) || host.endsWith(entryHost) : host === entryHost || host.endsWith(`.${entryHost}`)) {
      return undefined
    }
  }
  return proxy
}

/** Mã lỗi mạng sang bước bị lỗi và gợi ý xử lý. */
export function explainNetworkError(code: string | undefined, via: string | undefined): string {
  const route = via ? `via proxy ${redact(via)}` : 'direct connection'
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `DNS lookup failed (${code}, ${route})`
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'ETIMEDOUT':
      return `connect timed out (${route})${via ? '' : '; if curl works on this machine it may use a proxy: check HTTP_PROXY/HTTPS_PROXY and the proxy setting'}`
    case 'ECONNREFUSED':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ECONNRESET':
      return `connection failed (${code}, ${route})`
    case 'UND_ERR_HEADERS_TIMEOUT':
      return `connected but no response headers before timeout (${route})`
    case 'UND_ERR_BODY_TIMEOUT':
      return `response body did not finish before timeout (${route})`
    case 'UND_ERR_SOCKET':
      return `connection closed by the server or proxy (${route})`
  }
  if (code && /CERT|SELF_SIGNED|UNABLE_TO|DEPTH_ZERO|ERR_TLS/.test(code)) {
    return `TLS certificate rejected (${code}, ${route}); trust the internal CA with the ca setting, or set insecure only on test environments`
  }
  return route
}

/** Ẩn thông tin đăng nhập trong URL proxy. */
export function redact(url: string) {
  return url.replace(/(\w+:\/\/)[^\s/@]+@/, '$1***@')
}
