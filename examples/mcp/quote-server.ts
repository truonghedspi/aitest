/**
 * MCP server mẫu qua stdio: bảng giá chứng khoán giả lập.
 *
 * Dùng để thử tính năng thêm MCP server từ giao diện quản lý plugin:
 * transport `stdio`, lệnh `node`, tham số `--import tsx examples/mcp/quote-server.ts`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const QUOTES: Record<string, { ref: number; ceiling: number; floor: number }> = {
  VNM: { ref: 70000, ceiling: 74900, floor: 65100 },
  FPT: { ref: 120000, ceiling: 128400, floor: 111600 },
  HPG: { ref: 25000, ceiling: 26750, floor: 23250 },
  VCB: { ref: 90000, ceiling: 96300, floor: 83700 },
}

const server = new Server({ name: 'quote', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get',
      description: 'Lấy giá tham chiếu, giá trần, giá sàn của một mã chứng khoán.',
      inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list',
      description: 'Liệt kê các mã chứng khoán có giá.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  if (name === 'list') return { content: [{ type: 'text', text: JSON.stringify({ symbols: Object.keys(QUOTES) }) }] }
  const symbol = String(args?.symbol ?? '').toUpperCase()
  const quote = QUOTES[symbol]
  if (!quote) return { content: [{ type: 'text', text: `unknown symbol: ${symbol}` }], isError: true }
  return { content: [{ type: 'text', text: JSON.stringify({ symbol, ...quote }) }] }
})

await server.connect(new StdioServerTransport())
