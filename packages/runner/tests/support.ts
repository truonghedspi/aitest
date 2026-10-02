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
import WebSocket from 'ws'
import { bootFromFile, type AgentDriver, type CaseScope, type Kernel, type PluginRow, type TestPlan } from '@aitest/core'

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
  /** Dòng cấu hình bổ sung; dạng hàm nhận thư mục tạm của bài test. */
  rows?: PluginRow[] | ((dir: string) => PluginRow[])
  /** Đường dẫn patch layer trong thư mục tạm; mặc định không dùng patch layer. */
  patchFile?: (dir: string) => string
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
    ...(typeof options.rows === 'function' ? options.rows(dir) : options.rows ?? []),
  ], { patchFile: options.patchFile?.(dir) ?? false })
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

/** Dựng scope của một case để gọi action trực tiếp trong bài test. */
export function caseScope(plan: TestPlan, index = 0, overrides: Partial<CaseScope> = {}): CaseScope {
  return {
    kind: 'case', id: plan.cases[index].id, runId: 'test', plan, case: plan.cases[index], vars: {},
    phase: 'agent', namespaces: new Set(plan.requires), signal: new AbortController().signal, log: () => {},
    ...overrides,
  }
}

/** Client WebSocket tối giản cho bài test: gọi method và chờ message đẩy chủ động. */
export class WsClient {
  private seq = 0
  private readonly waiting = new Map<number, (m: any) => void>()
  readonly pushed: any[] = []
  private readonly listeners = new Set<(m: any) => void>()
  constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      if (m.id !== undefined) return this.waiting.get(m.id)?.(m)
      this.pushed.push(m)
      for (const l of this.listeners) l(m)
    })
  }
  static async open(url: string) {
    const socket = new WebSocket(url)
    await new Promise((r) => socket.once('open', r))
    return new WsClient(socket)
  }
  call(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.seq
    return new Promise<any>((resolve, reject) => {
      this.waiting.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.result)))
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  waitFor(predicate: (m: any) => boolean) {
    const found = this.pushed.find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise<any>((resolve) => {
      const listener = (m: any) => { if (predicate(m)) { this.listeners.delete(listener); resolve(m) } }
      this.listeners.add(listener)
    })
  }
}
