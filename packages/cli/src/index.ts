import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type {} from '@aitest/runner'
import type {} from '@aitest/authoring'
import type {} from '@aitest/plan-bundle'
import { createToolServer } from '@aitest/mcp-gateway'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { bootFromFile, deriveReport, parseJson, PlanError, type Kernel } from '@aitest/core'

const USAGE = `aitest — nền tảng AI tự đọc kịch bản và chạy test

Cách dùng:
  aitest run <plan> [--env staging] [--case TC-01,TC-02] [--agent kiro] [--model <id>] [--input tên=giá-trị ...]
  aitest envs [check [tên]]                               Liệt kê môi trường; check nạp tool của từng môi trường để kiểm tra
                                                          Chạy test plan, mã thoát khác 0 nếu có case không pass
  aitest validate <plan>                                  Kiểm tra cú pháp và schema của plan
  aitest actions                                          Liệt kê action đã đăng ký
  aitest report <events.jsonl>                            Dựng lại báo cáo từ run log (replay)
  aitest export <plan> [<plan> ...] [-o gói.json]         Đóng gói plan cùng tài liệu contextRefs và hệ thống để chuyển sang aitest khác
  aitest import <gói.json> [--dry-run] [--overwrite]      Nhập gói: xem trước, ghi file mới; --overwrite ghi đè file khác bản đang có
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
      model: { type: 'string' },
      input: { type: 'string', multiple: true },
      env: { type: 'string' },
      output: { type: 'string', short: 'o' },
      'dry-run': { type: 'boolean' },
      overwrite: { type: 'boolean' },
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
      case 'envs': return await envs(kernel, target, positionals[2])
      case 'validate': return await validate(kernel, need(target, 'plan'))
      case 'actions': return listActions(kernel)
      case 'report': return await replay(kernel, need(target, 'events.jsonl'))
      case 'export': return await exportBundle(kernel, positionals.slice(1), values.output)
      case 'import': return await importBundle(kernel, need(target, 'bundle.json'), { dryRun: !!values['dry-run'], overwrite: !!values.overwrite })
      case 'serve': return await serve(kernel)
      default:
        process.stdout.write(USAGE)
        return 2
    }
  } finally {
    await kernel.dispose()
  }
}

async function run(kernel: Kernel, plan: string, values: { case?: string; agent?: string; model?: string; input?: string[]; env?: string }) {
  const report = await kernel.ctx.runner.run({
    plan,
    env: values.env,
    agent: values.agent,
    model: values.model,
    inputs: parseInputs(values.input ?? []),
    cases: values.case?.split(',').map((s) => s.trim()).filter(Boolean),
  })
  return report.totals.pass === report.totals.total ? 0 : 1
}

/** `aitest envs`: danh sách môi trường; `aitest envs check [tên]`: nạp tool của môi trường, báo lỗi cấu hình. */
async function envs(kernel: Kernel, sub?: string, only?: string) {
  const service = kernel.ctx.get('envs') as import('@aitest/environments').EnvironmentService | undefined
  if (!service) throw new Error('plugin @aitest/environments is not loaded')
  const list = await service.list()
  let failed = 0
  for (const env of list.filter((e) => !only || e.name === only)) {
    const flags = [env.default ? 'mặc định' : '', env.readOnly ? 'chỉ đọc' : ''].filter(Boolean).join(', ')
    process.stdout.write(`${env.name}${env.label ? ` — ${env.label}` : ''}${flags ? ` (${flags})` : ''}\n`)
    process.stdout.write(`  file: ${env.file ?? '(không có, dùng cấu hình mặc định)'}\n`)
    if (env.tools.length) process.stdout.write(`  ghi đè: ${env.tools.map((t) => t.enabled ? t.row : `${t.row} (tắt)`).join(', ')}\n`)
    for (const issue of env.issues) process.stdout.write(`  ERROR ${issue.error}\n`)
    failed += env.issues.length
    if (sub === 'check') {
      try {
        await service.ensure(env.name)
        const tools = kernel.ctx.actions.all().map((d) => d.name).filter((n) => kernel.ctx.actions.envsOf(n).includes(env.name))
        process.stdout.write(`  OK nạp được${tools.length ? `; tool riêng: ${tools.join(', ')}` : ''}\n`)
      } catch (error) {
        failed++
        process.stdout.write(`  ERROR ${(error as Error).message}\n`)
      }
    }
  }
  if (only && !list.some((e) => e.name === only)) throw new Error(`unknown environment ${only}`)
  return failed ? 1 : 0
}

/** `--input tên=giá-trị`: giá trị dạng số, `true`/`false`, JSON được giữ kiểu; còn lại là chuỗi. */
export function parseInputs(pairs: string[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {}
  for (const pair of pairs) {
    const index = pair.indexOf('=')
    if (index <= 0) throw new Error(`invalid --input ${pair}; expected name=value`)
    const raw = pair.slice(index + 1)
    let value: unknown = raw
    if (/^(-?\d+(\.\d+)?|true|false|null|[[{"].*)$/s.test(raw)) {
      try { value = parseJson(raw) } catch { value = raw }
    }
    inputs[pair.slice(0, index)] = value
  }
  return inputs
}

async function exportBundle(kernel: Kernel, plans: string[], output?: string) {
  if (!plans.length) throw new Error('missing argument: plan')
  const bundle = await kernel.ctx.bundles.export(plans)
  const file = output ?? `aitest-bundle-${new Date().toISOString().slice(0, 10)}.json`
  const size = await kernel.ctx.bundles.writeBundle(bundle, file)
  process.stdout.write(`Đã đóng gói ${bundle.plans.length} plan, ${bundle.files.length} file (${Math.round(size / 1024)} KB) vào ${file}\n`)
  for (const f of bundle.files) process.stdout.write(`  ${f.kind.padEnd(7)} ${f.path}\n`)
  if (bundle.requirements.namespaces.length) process.stdout.write(`  cần tool cho namespace: ${bundle.requirements.namespaces.join(', ')}\n`)
  return 0
}

const STATUS_LABEL: Record<string, string> = { new: 'mới', same: 'giống hệt', changed: 'khác bản đang có', blocked: 'bị chặn' }

async function importBundle(kernel: Kernel, file: string, options: { dryRun: boolean; overwrite: boolean }) {
  const bundle = JSON.parse(await readFile(resolve(file), 'utf8'))
  const preview = await kernel.ctx.bundles.preview(bundle)
  process.stdout.write(`Gói có ${preview.plans.length} plan: ${preview.plans.map((p) => p.id).join(', ')}\n`)
  for (const i of preview.items) {
    const note = i.status === 'blocked' ? ` — ${i.reason}` : i.dependsOn ? ` — chỉ ghi khi ghi đè ${i.dependsOn.replace(/^system:/, '')}` : ''
    process.stdout.write(`  ${STATUS_LABEL[i.status].padEnd(16)} ${i.kind.padEnd(7)} ${i.target ?? i.path}${note}\n`)
  }
  for (const w of preview.warnings) process.stdout.write(`  WARNING: ${w}\n`)
  if (options.dryRun) return preview.items.some((i) => i.status === 'blocked') ? 1 : 0
  const overwrite = options.overwrite ? preview.items.filter((i) => i.status === 'changed').map((i) => `${i.kind}:${i.path}`) : []
  const result = await kernel.ctx.bundles.import(bundle, { overwrite })
  process.stdout.write(`Đã ghi ${result.written.length} file, bỏ qua ${result.skipped.length}; bản ghi và bản cũ: ${result.backupDir}\n`)
  for (const p of result.plans) process.stdout.write(`  ${p.valid ? 'OK   ' : 'ERROR'} ${p.target}${p.errors.length ? `: ${p.errors.join('; ')}` : ''}\n`)
  return result.plans.every((p) => p.valid) ? 0 : 1
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
