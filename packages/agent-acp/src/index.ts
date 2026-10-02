// cross-spawn chạy được lệnh dạng `.cmd` trên Windows (npm shim) mà không cần bật shell.
import spawn from 'cross-spawn'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import {
  z, type AgentConnection, type AgentDriver, type AgentSession, type AgentSessionOptions, type AgentUpdate, type Context,
} from '@aitest/core'

/**
 * Driver cho mọi agent nói Agent Client Protocol qua stdio. Mặc định là Kiro (`kiro-cli acp`).
 *
 * Driver khởi chạy một process agent cho mỗi run, mở một session ACP cho mỗi test case
 * và truyền MCP gateway của case vào `session/new` dưới dạng MCP server HTTP.
 */
export interface Config {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  mode?: string
  model?: string
  stderrLines: number
}

export const name = 'agent-acp'
export const inject = ['agents']

export const Config = z.object({
  name: z.string().default('kiro').description('Tên driver, dùng trong `runner.agent` hoặc cờ `--agent`.'),
  command: z.string().default('kiro-cli'),
  args: z.array(z.string()).default(['acp']),
  env: z.dict(z.string()).default({}),
  mode: z.string().description('Session mode của agent, ví dụ `kiro_default`.'),
  model: z.string().description('Model mặc định cho mọi session, ví dụ `claude-sonnet-4.5`; bỏ trống thì dùng mặc định của agent.'),
  stderrLines: z.natural().default(50).description('Số dòng stderr cuối cùng giữ lại để chẩn đoán lỗi.'),
})

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(`acp:${config.name}`)
  const driver: AgentDriver = {
    name: config.name,
    connect: (options) => connect(config, options.cwd, logger),
  }
  ctx.agents.register(driver)
}

async function connect(config: Config, cwd: string, logger: ReturnType<Context['logger']>): Promise<AgentConnection> {
  // stdio đều là `pipe` nên stdin, stdout, stderr luôn tồn tại.
  const child = spawn(config.command, config.args, {
    cwd, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  const stderr: string[] = []
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      stderr.push(line)
      if (stderr.length > config.stderrLines) stderr.shift()
      logger.debug(line)
    }
  })
  const exited = new Promise<never>((_, reject) => {
    child.once('error', (error) => reject(new Error(`cannot start ${config.command}: ${error.message}`)))
    child.once('exit', (code, signal) => {
      reject(new Error(`agent process exited (code=${code}, signal=${signal})\n${stderr.join('\n')}`))
    })
  })
  exited.catch(() => {})

  const sessions = new Map<string, AgentSessionOptions>()
  const conn = new acp.ClientSideConnection(() => ({
    async sessionUpdate(params) {
      sessions.get(params.sessionId)?.onUpdate(toUpdate(params.update))
    },
    async requestPermission(params) {
      const options = sessions.get(params.sessionId)
      const title = params.toolCall.title ?? ''
      const allowed = (await options?.onPermission?.({ title, raw: params.toolCall })) ?? false
      const pick = params.options.find((o) => o.kind === (allowed ? 'allow_once' : 'reject_once'))
        ?? params.options.find((o) => o.kind.startsWith(allowed ? 'allow' : 'reject'))
      if (!pick) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: pick.optionId } }
    },
  }), acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>))

  const init = await Promise.race([
    conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'aitest', version: '0.1.0' },
    }),
    exited,
  ])
  if (!init.agentCapabilities?.mcpCapabilities?.http) {
    child.kill()
    throw new Error(`agent ${init.agentInfo?.name ?? config.command} does not support MCP over HTTP`)
  }

  return {
    info: { name: init.agentInfo?.name ?? config.name, version: init.agentInfo?.version, raw: init },
    async newSession(options): Promise<AgentSession> {
      const created = await Promise.race([
        conn.newSession({
          cwd: options.cwd,
          mcpServers: options.mcpServers.map((s) => ({
            type: 'http' as const,
            name: s.name,
            url: s.url,
            headers: Object.entries(s.headers).map(([name, value]) => ({ name, value })),
          })),
        }),
        exited,
      ])
      const { sessionId } = created
      sessions.set(sessionId, options)
      if (config.mode) await conn.setSessionMode({ sessionId, modeId: config.mode })

      // Danh sách model nằm trong phần mở rộng chưa ổn định của ACP (`models`); Kiro đổi model bằng `session/set_model`.
      const announced = (created as { models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name?: string; description?: string }> } }).models
      const models = announced?.availableModels
        ? {
          current: announced.currentModelId,
          available: announced.availableModels.map((m) => ({ id: m.modelId, name: m.name ?? m.modelId, description: m.description ?? undefined })),
        }
        : undefined
      const setModel = async (modelId: string) => {
        if (models && !models.available.some((m) => m.id === modelId)) {
          throw new Error(`model ${modelId} is not offered by the agent; available: ${models.available.map((m) => m.id).join(', ')}`)
        }
        await conn.extMethod('session/set_model', { sessionId, modelId })
        if (models) models.current = modelId
      }
      const initial = options.model ?? config.model
      if (initial && initial !== models?.current) await setModel(initial)

      return {
        id: sessionId,
        models,
        setModel,
        async prompt(text, signal) {
          const onAbort = () => { conn.cancel({ sessionId }).catch(() => {}) }
          signal.addEventListener('abort', onAbort, { once: true })
          try {
            const result = await Promise.race([
              conn.prompt({ sessionId, prompt: [{ type: 'text', text }] }),
              exited,
            ])
            return { stopReason: result.stopReason }
          } finally {
            signal.removeEventListener('abort', onAbort)
          }
        },
        async close() {
          sessions.delete(sessionId)
        },
      }
    },
    async close() {
      sessions.clear()
      child.stdin.end()
      child.kill()
    },
  }
}

function toUpdate(update: acp.SessionNotification['update']): AgentUpdate {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return { kind: 'message', text: update.content.type === 'text' ? update.content.text : undefined, raw: update }
    case 'agent_thought_chunk':
      return { kind: 'thought', text: update.content.type === 'text' ? update.content.text : undefined, raw: update }
    case 'tool_call':
      return { kind: 'tool_call', text: update.title, raw: update }
    case 'tool_call_update':
      return { kind: 'tool_update', text: update.status ?? undefined, raw: update }
    case 'plan':
      return { kind: 'plan', raw: update }
    default:
      return { kind: 'other', raw: update }
  }
}
