/**
 * Kiểm thử mạng của `http_request` cho giống `curl` trên cùng máy: proxy (CONNECT), NO_PROXY,
 * CA nội bộ, và thông báo lỗi nêu rõ bước bị lỗi cùng đường đi.
 * Chứng chỉ trong `fixtures/` là chứng chỉ tự ký chỉ dùng cho kiểm thử.
 */
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootFromFile, type ActionScope, type Kernel } from '@aitest/core'
import { proxyFor, resolveProxy } from '@aitest/action-http'

const root = join(import.meta.dirname, '../../..')
const fixtures = join(import.meta.dirname, 'fixtures')

const listen = (server: Server | ReturnType<typeof createTcpServer>) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

describe('proxy resolution', () => {
  it('reads proxy variables like curl, including lower case and NO_PROXY', () => {
    expect(resolveProxy({ proxy: 'env', noProxy: ['.corp.local'] }, { https_proxy: 'http://p:8080', NO_PROXY: 'localhost' })).toEqual({
      http: undefined, https: 'http://p:8080', noProxy: 'localhost,.corp.local', source: 'env',
    })
    expect(resolveProxy({ proxy: 'env', noProxy: [] }, {})).toMatchObject({ source: 'none' })
    expect(resolveProxy({ proxy: 'none', noProxy: [] }, { HTTP_PROXY: 'http://p:1' })).toMatchObject({ source: 'none' })
    expect(resolveProxy({ proxy: 'http://p.corp:3128', noProxy: [] }, {})).toMatchObject({ http: 'http://p.corp:3128/', source: 'config' })
    expect(() => resolveProxy({ proxy: 'p.corp', noProxy: [] }, {})).toThrow(/invalid proxy/)
  })

  it('skips the proxy for NO_PROXY hosts, domains and ports', () => {
    const plan = { http: 'http://p:1', https: 'http://p:1', noProxy: 'localhost,.corp.local,api.internal:8443', source: 'env' as const }
    expect(proxyFor(new URL('http://localhost:4100/x'), plan)).toBeUndefined()
    expect(proxyFor(new URL('https://svc.corp.local/x'), plan)).toBeUndefined()
    expect(proxyFor(new URL('https://api.internal:8443/x'), plan)).toBeUndefined()
    expect(proxyFor(new URL('https://api.internal/x'), plan)).toBe('http://p:1')
    expect(proxyFor(new URL('https://example.com/x'), plan)).toBe('http://p:1')
    expect(proxyFor(new URL('https://example.com/x'), { ...plan, noProxy: '*' })).toBeUndefined()
  })
})

describe('http_request networking', () => {
  let kernel: Kernel
  let api: Server
  let secure: ReturnType<typeof createHttpsServer>
  let proxy: ReturnType<typeof createTcpServer>
  let silent: ReturnType<typeof createTcpServer>
  let apiPort: number
  let securePort: number
  let proxyPort: number
  let silentPort: number
  const tunnels: string[] = []

  const scope: ActionScope = {
    kind: 'explore', id: 'network', namespaces: new Set(['http', 'viaproxy', 'tls', 'tlsca', 'tlsk']), phase: 'user',
    signal: new AbortController().signal, log: () => {},
  }
  const call = (name: string, url: string) => kernel.ctx.actions.invoke(scope, name, { method: 'GET', url })

  beforeAll(async () => {
    api = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'))
    apiPort = await listen(api)
    secure = createHttpsServer({ key: readFileSync(join(fixtures, 'test-key.pem')), cert: readFileSync(join(fixtures, 'test-ca.pem')) }, (_req, res) => res.end('secure'))
    securePort = await new Promise<number>((resolve) => secure.listen(0, '127.0.0.1', () => resolve((secure.address() as AddressInfo).port)))
    // Proxy HTTP tối giản: chỉ hỗ trợ CONNECT (undici đi qua proxy bằng đường hầm CONNECT).
    proxy = createTcpServer((client) => {
      client.once('data', (head) => {
        const match = /^CONNECT ([^:\s]+):(\d+)/.exec(head.toString())
        if (!match) return client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
        tunnels.push(`${match[1]}:${match[2]}`)
        const upstream = connect(Number(match[2]), match[1], () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.pipe(client)
          client.pipe(upstream)
        })
        // Proxy thật trả 502 khi không kết nối được tới đích.
        upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
      })
      client.on('error', () => {})
    })
    proxyPort = await listen(proxy)
    // Server nhận kết nối nhưng không bao giờ trả lời.
    silent = createTcpServer((socket) => socket.on('error', () => {}))
    silentPort = await listen(silent)

    kernel = await bootFromFile(join(root, 'aitest.yml'), [
      { id: 'logger', name: 'aitest:noop', disabled: true },
      { id: 'reporter-console', name: '@aitest/reporters/console', disabled: true },
      { id: 'action-http', name: '@aitest/action-http', config: { proxy: 'none', timeout: 2, connectTimeout: 1 } },
      { id: 'http-proxy', name: '@aitest/action-http', config: { namespace: 'viaproxy', proxy: `http://127.0.0.1:${proxyPort}`, noProxy: ['skip.localhost'], timeout: 3 } },
      { id: 'http-tls', name: '@aitest/action-http', config: { namespace: 'tls', proxy: 'none' } },
      { id: 'http-tls-ca', name: '@aitest/action-http', config: { namespace: 'tlsca', proxy: 'none', ca: [join(fixtures, 'test-ca.pem')] } },
      { id: 'http-tls-k', name: '@aitest/action-http', config: { namespace: 'tlsk', proxy: 'none', insecure: true } },
    ], { patchFile: false })
  }, 60_000)

  afterAll(async () => {
    await kernel?.dispose()
    for (const s of [api, secure, proxy, silent]) s?.close()
  })

  it('sends requests through the configured proxy', async () => {
    const outcome = await call('viaproxy_http_request', `http://127.0.0.1:${apiPort}/ping`)
    expect(outcome).toMatchObject({ status: 'ok', value: { status: 200, body: { ok: true } } })
    expect(tunnels).toContain(`127.0.0.1:${apiPort}`)
  })

  it('reports which step failed and the route taken', async () => {
    const dns = await call('http_request', 'http://does-not-exist.invalid/x')
    expect(dns.error).toMatch(/failed after \d+ ms: DNS lookup failed \((ENOTFOUND|EAI_AGAIN), direct connection\)/)
    const refused = await call('http_request', `http://127.0.0.1:${silentPort + 1}/x`)
    expect(refused.error).toMatch(/connection failed \(ECONNREFUSED, direct connection\)|connect/)
    const silentServer = await call('http_request', `http://127.0.0.1:${silentPort}/x`)
    expect(silentServer.error).toMatch(/no response headers before timeout|timed out after 2 s/)
    const viaProxy = await call('viaproxy_http_request', 'http://does-not-exist.invalid/x')
    expect(viaProxy.error).toContain(`proxy refused the tunnel (502) (via proxy http://127.0.0.1:${proxyPort}/)`)
  })

  it('trusts an internal CA from a file, and only skips verification when insecure is set', async () => {
    const url = `https://localhost:${securePort}/`
    const rejected = await call('tls_http_request', url)
    expect(rejected.error).toMatch(/TLS certificate rejected \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/)
    expect(await call('tlsca_http_request', url)).toMatchObject({ status: 'ok', value: { status: 200, body: 'secure' } })
    expect(await call('tlsk_http_request', url)).toMatchObject({ status: 'ok', value: { body: 'secure' } })
  })
})
