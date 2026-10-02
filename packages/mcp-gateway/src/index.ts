import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Service, z, type ActionScope, type Context, type McpEndpoint } from '@aitest/core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    gateway: McpGateway
  }
}

export interface Exposure {
  endpoint: McpEndpoint
  close(): Promise<void>
}

interface Binding {
  scope: ActionScope
  transports: Map<string, StreamableHTTPServerTransport>
}

/**
 * MCP gateway chạy trong process, giao tiếp qua Streamable HTTP.
 *
 * Mỗi test case nhận một URL riêng dạng `/mcp/<token>`. Gateway chỉ liệt kê
 * các action được phép trong case đó và chuyển mọi lời gọi tool sang
 * `ctx.actions.invoke`. Nhờ đó, mọi action đều đi qua pipeline guard/evidence,
 * dù agent là Kiro hay agent nào khác.
 */
export class McpGateway extends Service {
  static inject = ['actions']
  static Config = z.object({
    host: z.string().default('127.0.0.1'),
    port: z.natural().default(0).description('0 nghĩa là hệ điều hành tự cấp cổng trống.'),
    serverName: z.string().default('aitest').description('Tên MCP server mà agent nhìn thấy.'),
    maxResultChars: z.natural().default(20000).description('Cắt bớt kết quả tool dài hơn ngưỡng này.'),
  })

  private http?: HttpServer
  private starting?: Promise<string>
  private readonly bindings = new Map<string, Binding>()

  constructor(ctx: Context, public config: { host: string; port: number; serverName: string; maxResultChars: number }) {
    super(ctx, 'gateway')
    ctx.effect(() => () => this.stop(), 'gateway.http')
  }

  /** Mở một endpoint MCP cho case. Gọi `close()` khi case kết thúc. */
  async expose(scope: ActionScope): Promise<Exposure> {
    const baseUrl = await this.start()
    const token = randomUUID()
    const binding: Binding = { scope, transports: new Map() }
    this.bindings.set(token, binding)
    return {
      endpoint: { name: this.config.serverName, url: `${baseUrl}/mcp/${token}`, headers: {} },
      close: async () => {
        this.bindings.delete(token)
        await Promise.all([...binding.transports.values()].map((t) => t.close().catch(() => {})))
      },
    }
  }

  private start() {
    return this.starting ??= new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.ctx.logger('gateway').warn(error)
          if (!res.headersSent) res.writeHead(500).end(String(error))
        })
      })
      server.once('error', reject)
      server.listen(this.config.port, this.config.host, () => {
        this.http = server
        const { port } = server.address() as AddressInfo
        resolve(`http://${this.config.host}:${port}`)
      })
    })
  }

  private async stop() {
    for (const binding of this.bindings.values()) {
      for (const t of binding.transports.values()) await t.close().catch(() => {})
    }
    this.bindings.clear()
    const http = this.http
    this.http = undefined
    this.starting = undefined
    if (http) await new Promise<void>((done) => http.close(() => done()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const match = /^\/mcp\/([\w-]+)\/?$/.exec(new URL(req.url ?? '/', 'http://x').pathname)
    const binding = match && this.bindings.get(match[1])
    if (!binding) return void res.writeHead(404).end('unknown endpoint')

    const body = req.method === 'POST' ? await readJson(req) : undefined
    const sessionId = req.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? binding.transports.get(sessionId) : undefined
    if (existing) return existing.handleRequest(req, res, body)

    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      return void res.writeHead(400).end('missing or unknown mcp-session-id')
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { binding.transports.set(id, transport) },
    })
    transport.onclose = () => {
      if (transport.sessionId) binding.transports.delete(transport.sessionId)
    }
    await this.createServer(binding.scope).connect(transport)
    await transport.handleRequest(req, res, body)
  }

  private createServer(scope: ActionScope) {
    return createToolServer(this.ctx, scope, this.config)
  }
}

/**
 * Dựng một MCP server liệt kê và thực thi action được phép trong `scope`.
 * Dùng chung cho endpoint HTTP của gateway và cho transport stdio (`aitest mcp`).
 */
export function createToolServer(
  ctx: Context, scope: ActionScope, options: { serverName: string; maxResultChars: number },
) {
  const server = new Server({ name: options.serverName, version: '0.1.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ctx.actions.list(scope).map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: { readOnlyHint: def.readOnly ?? false },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const outcome = await ctx.actions.invoke(scope, name, (args ?? {}) as Record<string, unknown>)
    // `outcome` thay vì `status` để không nhầm với HTTP status bên trong `result`.
    const payload = {
      outcome: outcome.status,
      ...outcome.annotations,
      ...(outcome.status === 'ok' ? { result: outcome.value } : { error: outcome.error }),
    }
    let text = JSON.stringify(payload, null, 2)
    if (text.length > options.maxResultChars) {
      text = text.slice(0, options.maxResultChars) + `\n... [truncated ${text.length - options.maxResultChars} chars]`
    }
    return { content: [{ type: 'text' as const, text }], isError: outcome.status !== 'ok' }
  })

  return server
}

export default McpGateway

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : undefined
}
