import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type {} from '@aitest/runner'
import type {} from '@aitest/authoring'
import { createToolServer } from '@aitest/mcp-gateway'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { bootFromFile, deriveReport, PlanError, type Kernel } from '@aitest/core'

const USAGE = `aitest — nền tảng AI tự đọc kịch bản và chạy test

Cách dùng:
  aitest run <plan> [--case TC-01,TC-02] [--agent kiro]   Chạy test plan, mã thoát khác 0 nếu có case không pass
  aitest validate <plan>                                  Kiểm tra cú pháp và schema của plan
  aitest actions                                          Liệt kê action đã đăng ký
  aitest report <events.jsonl>                            Dựng lại báo cáo từ run log (replay)
  aitest mcp                                              Chạy MCP server soạn plan qua stdio (cho Kiro chat, Claude Code...)
  aitest -c aitest.web.yml serve                          Chạy giao diện web soạn plan cùng agent

Tuỳ chọn chung:
  -c, --config <file>   File cấu hình plugin (mặc định: aitest.yml)
`

export async function main(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c', default: 'aitest.yml' },
      case: { type: 'string' },
      agent: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, target] = positionals
  if (values.help || !command) {
    process.stdout.write(USAGE)
    return 0
  }

  const configFile = resolve(values.config!)
  if (!existsSync(configFile)) throw new Error(`config file not found: ${configFile}`)
  if (command === 'mcp') return serveMcp(configFile)
  // Web host không dừng vì một plugin lỗi: trang Plugin hiển thị lỗi để người dùng sửa.
  const kernel = await bootFromFile(configFile, [], { strict: command !== 'serve' })
  try {
    switch (command) {
      case 'run': return await run(kernel, need(target, 'plan'), values)
      case 'validate': return await validate(kernel, need(target, 'plan'))
      case 'actions': return listActions(kernel)
      case 'report': return await replay(kernel, need(target, 'events.jsonl'))
      case 'serve': return await serve(kernel)
      default:
        process.stdout.write(USAGE)
        return 2
    }
  } finally {
    await kernel.dispose()
  }
}

async function run(kernel: Kernel, plan: string, values: { case?: string; agent?: string }) {
  const report = await kernel.ctx.runner.run({
    plan,
    agent: values.agent,
    cases: values.case?.split(',').map((s) => s.trim()).filter(Boolean),
  })
  return report.totals.pass === report.totals.total ? 0 : 1
}

async function validate(kernel: Kernel, file: string) {
  const plan = await kernel.ctx.plans.load(file)
  process.stdout.write(`OK ${plan.id} — ${plan.name}\n`)
  process.stdout.write(`  requires: ${plan.requires.join(', ') || '(none)'}\n`)
  for (const c of plan.cases) process.stdout.write(`  ${c.id}: ${c.steps.length} steps, ${c.expect.length} expectations\n`)
  // Khi có plugin soạn plan, dùng chung bộ quy tắc kiểm tra với tool `validate_plan`.
  const authoring = kernel.ctx.get('authoring') as import('@aitest/authoring').AuthoringService | undefined
  if (authoring) {
    const result = await authoring.validate(await readFile(resolve(file), 'utf8'), resolve(file))
    for (const issue of result.issues) {
      process.stdout.write(`  ${issue.level.toUpperCase()}${issue.path ? ` ${issue.path}` : ''}: ${issue.message}\n`)
    }
    return result.valid ? 0 : 1
  }
  const known = new Set(kernel.ctx.actions.list().map((a) => a.namespace))
  const missing = plan.requires.filter((ns) => !known.has(ns))
  if (missing.length) {
    process.stdout.write(`  WARNING: no action registered for namespace: ${missing.join(', ')}\n`)
    return 1
  }
  return 0
}

function listActions(kernel: Kernel) {
  for (const a of kernel.ctx.actions.list()) {
    const flags = [a.always && 'always', a.readOnly && 'read-only'].filter(Boolean).join(', ')
    process.stdout.write(`${a.namespace.padEnd(10)} ${a.name.padEnd(28)} ${flags ? `[${flags}] ` : ''}${a.description.split('\n')[0]}\n`)
  }
  return 0
}

async function replay(kernel: Kernel, file: string) {
  const events = await kernel.ctx.runlog.read(resolve(file))
  const report = { ...deriveReport(events), logFile: resolve(file) }
  await kernel.ctx.parallel('run/report', report)
  return report.totals.pass === report.totals.total ? 0 : 1
}

/**
 * Chạy MCP server soạn plan qua stdio. stdout dành riêng cho giao thức MCP, nên mọi log
 * (kể cả `console.log` của plugin) được chuyển sang stderr và reporter console bị tắt.
 */
async function serveMcp(configFile: string) {
  console.log = console.error
  console.info = console.error
  const kernel = await bootFromFile(configFile, [
    { id: 'reporter-console', name: '@aitest/reporters/console', disabled: true },
  ])
  const session = await kernel.ctx.authoring.createSession()
  const server = createToolServer(kernel.ctx, session.scope, { serverName: 'aitest', maxResultChars: 60000 })
  const transport = new StdioServerTransport()
  const closed = new Promise<void>((done) => { server.onclose = () => done() })
  await server.connect(transport)
  process.stderr.write(`aitest MCP server ready; authoring session ${session.id}\n`)
  await closed
  await session.close()
  await kernel.dispose()
  return 0
}

/** Chạy web host tới khi nhận SIGINT hoặc SIGTERM. */
async function serve(kernel: Kernel) {
  const web = kernel.ctx.get('web') as import('@aitest/web-host').WebHost | undefined
  if (!web) throw new Error('no web host in config; use -c aitest.web.yml')
  process.stdout.write(`aitest web: ${await web.ready()}\n`)
  await new Promise<void>((done) => {
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
  return 0
}

function need(value: string | undefined, label: string) {
  if (!value) throw new Error(`missing argument: <${label}>`)
  return value
}

export function formatError(error: unknown) {
  if (error instanceof PlanError) return error.message
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}
