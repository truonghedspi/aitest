import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z, type Context, type JsonSchemaObject } from '@aitest/core'

/**
 * Nối một MCP server bên ngoài (Postgres, Kafka, Redis, browser...) vào nền tảng.
 *
 * Tool của server ngoài được đăng ký lại thành action có tiền tố `<namespace>_`.
 * Agent vẫn chỉ thấy một MCP gateway. Vì vậy mọi lời gọi tới server ngoài đều đi qua
 * guard, được ghi evidence và xuất hiện trong run log như action nội bộ.
 */
export interface Config {
  namespace: string
  prefix?: string
  transport: 'stdio' | 'http'
  command?: string
  args: string[]
  env: Record<string, string>
  url?: string
  headers: Record<string, string>
  include: string[]
  exclude: string[]
  readOnly: string[]
}

export const name = 'action-mcp-proxy'
export const inject = ['actions']

export const Config = z.object({
  namespace: z.string().required().description('Namespace của các action, ví dụ `pg`.'),
  prefix: z.string().description('Tiền tố tên action; mặc định là `<namespace>_`. Đặt chuỗi rỗng khi tool đã có tiền tố riêng.'),
  transport: z.union(['stdio', 'http'] as const).default('stdio'),
  command: z.string().description('Lệnh khởi chạy server (transport stdio).'),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  url: z.string().description('URL Streamable HTTP (transport http).'),
  headers: z.dict(z.string()).default({}),
  include: z.array(z.string()).default([]).description('Chỉ nhận các tool này; rỗng nghĩa là nhận tất cả.'),
  exclude: z.array(z.string()).default([]),
  readOnly: z.array(z.string()).default([]).description('Tool được đánh dấu chỉ đọc.'),
})

export async function apply(ctx: Context, config: Config) {
  const client = new Client({ name: 'aitest-proxy', version: '0.1.0' })
  const transport = config.transport === 'http'
    ? new StreamableHTTPClientTransport(new URL(required(config.url, 'url')), { requestInit: { headers: config.headers } })
    : new StdioClientTransport({
      command: required(config.command, 'command'),
      args: config.args,
      env: { ...process.env as Record<string, string>, ...config.env },
      stderr: 'pipe',
    })
  await client.connect(transport)
  ctx.effect(() => () => { client.close().catch(() => {}) }, `mcp-proxy(${config.namespace})`)

  const prefix = config.prefix ?? `${config.namespace}_`
  const { tools } = await client.listTools()
  for (const tool of tools) {
    if (config.include.length && !config.include.includes(tool.name)) continue
    if (config.exclude.includes(tool.name)) continue
    ctx.actions.register({
      name: `${prefix}${tool.name}`.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64),
      namespace: config.namespace,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema as JsonSchemaObject,
      readOnly: config.readOnly.includes(tool.name) || tool.annotations?.readOnlyHint === true,
      async execute(args: Record<string, unknown>, { signal }) {
        const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal })
        const content = result.content as Array<{ type: string; text?: string }>
        if (result.isError) throw new Error(content.map((c) => c.text ?? `[${c.type}]`).join('\n'))
        if (result.structuredContent) return result.structuredContent
        // Kết quả chỉ có một khối text JSON thì parse ra để assertion đọc được theo path.
        if (content.length === 1 && content[0].type === 'text') {
          try { return JSON.parse(content[0].text!) } catch { return content[0].text }
        }
        return { content }
      },
    })
  }
}

function required<T>(value: T | undefined, key: string): T {
  if (value === undefined) throw new Error(`mcp-proxy: missing config.${key}`)
  return value
}
