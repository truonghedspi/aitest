/**
 * Hạ tầng dùng chung cho bài test của runner: khởi chạy Order API mẫu và agent kịch bản.
 *
 * Agent kịch bản kết nối tới MCP gateway thật qua MCP client, gọi action như một agent thật.
 * Nhờ đó, bài test đi qua toàn bộ pipeline mà không cần LLM.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { bootFromFile, type AgentDriver, type Kernel, type PluginRow } from '@aitest/core'

export const root = resolve(import.meta.dirname, '../../..')

/** Gọi một tool qua gateway; trả về payload `{ outcome, evidenceId, result | error }`. */
export type Call = (name: string, args?: Record<string, unknown>) => Promise<any>
export type Script = (call: Call, prompt: string) => Promise<void>

export function scriptedDriver(scripts: Record<string, Script>): AgentDriver {
  return {
    name: 'scripted',
    async connect() {
      return {
        info: { name: 'scripted' },
        async newSession(options) {
          const client = new Client({ name: 'scripted-agent', version: '0' })
          await client.connect(new StreamableHTTPClientTransport(new URL(options.mcpServers[0].url)))
          return {
            id: 'scripted-session',
            async prompt(text) {
              const caseId = /## Test case (\S+):/.exec(text)![1]
              const call: Call = async (name, args = {}) => {
                const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
                return JSON.parse((res.content as Array<{ text: string }>)[0].text)
              }
              await scripts[caseId](call, text)
              return { stopReason: 'end_turn' }
            },
            close: () => client.close(),
          }
        },
        async close() {},
      }
    },
  }
}

/** Đọc biến từ khối JSON "### Biến" trong prompt. */
export function promptVars(prompt: string): Record<string, any> {
  const match = /### Biến\n```json\n([\s\S]*?)\n```/.exec(prompt)
  return match ? JSON.parse(match[1]) : {}
}

export interface Harness {
  kernel: Kernel
  dir: string
  baseUrl: string
  dispose(): Promise<void>
}

/**
 * Khởi chạy Order API với DB tạm và dựng kernel từ file cấu hình.
 * Mỗi file test dùng một cổng riêng vì vitest chạy các file song song.
 */
export async function setupHarness(options: {
  port: number
  config?: string
  scripts: Record<string, Script>
  rows?: PluginRow[]
  env?: Record<string, string>
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'aitest-'))
  const dbFile = join(dir, 'orders.db')
  const baseUrl = `http://127.0.0.1:${options.port}`
  const api: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', '--disable-warning=ExperimentalWarning', join(root, 'examples/order-api/server.ts')],
    {
      env: { ...process.env, ORDER_API_PORT: String(options.port), ORDER_DB: dbFile, ...options.env },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  await new Promise<void>((done) => api.stdout!.once('data', () => done()))

  process.env.ORDER_DB = dbFile
  process.env.ORDER_API_URL = baseUrl
  const kernel = await bootFromFile(join(root, options.config ?? 'aitest.yml'), [
    { id: 'runlog', name: 'aitest:runlog', config: { dir: join(dir, 'runs') } },
    { id: 'logger', name: 'aitest:noop', disabled: true },
    { id: 'reporter-console', name: '@aitest/reporters/console', disabled: true },
    ...(options.rows ?? []),
  ])
  kernel.ctx.agents.register(scriptedDriver(options.scripts))

  return {
    kernel,
    dir,
    baseUrl,
    async dispose() {
      await kernel.dispose()
      api.kill()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
