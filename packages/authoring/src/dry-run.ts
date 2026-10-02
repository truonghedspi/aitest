import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {} from '@aitest/runner'
import { deriveReport, errorMessage, z, type CaseReport, type Context, type RunReport } from '@aitest/core'
import type {} from './index.ts'

/**
 * Tool `dry_run` và `get_run_result`: chạy thử bản nháp bằng runner thật, rồi trả kết quả rút gọn
 * kèm gợi ý sửa plan.
 *
 * Lượt chạy thử chạy nền vì mất từ vài chục giây tới vài phút; agent đọc kết quả bằng `get_run_result`.
 * Lượt chạy thử thực thi cả fixture `setup`/`teardown`, nên chỉ dùng trên môi trường kiểm thử.
 */
export interface Config {
  maxCases: number
  maxWait: number
}

export const name = 'authoring-dry-run'
export const inject = ['actions', 'authoring', 'runner', 'runlog']

export const Config = z.object({
  maxCases: z.natural().default(3).description('Số case tối đa trong một lượt chạy thử.'),
  maxWait: z.natural().default(45).description('Thời gian tối đa `get_run_result` chờ trong một lần gọi, đơn vị giây.'),
})

interface Tracked {
  promise: Promise<RunReport>
  report?: RunReport
  error?: string
  startedAt: number
}

export function apply(ctx: Context, config: Config) {
  const runs = new Map<string, Tracked>()

  ctx.actions.register({
    name: 'dry_run',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    evidence: false,
    description: [
      'Chạy thử bản nháp plan bằng agent chạy test thật, trên môi trường kiểm thử.',
      `Tối đa ${config.maxCases} case mỗi lần; chọn case bằng \`cases\`.`,
      'Trả về `runId` ngay; đọc kết quả bằng `get_run_result`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Toàn bộ nội dung plan.' },
        cases: { type: 'array', items: { type: 'string' }, description: 'Mã các case cần chạy.' },
        inputs: { type: 'object', description: 'Giá trị đầu vào theo tên input của plan; bỏ trống để dùng fill, prepare hoặc default.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    async execute(args: { content: string; cases?: string[]; inputs?: Record<string, unknown> }, { scope }) {
      const result = await ctx.authoring.validate(args.content)
      if (!result.valid || !result.plan) {
        throw new Error(`plan is invalid: ${result.issues.filter((i) => i.level === 'error').map((i) => i.message).join('; ')}`)
      }
      const plan = result.plan
      const cases = args.cases?.length ? args.cases : plan.cases.map((c) => c.id)
      const unknown = cases.filter((id) => !plan.cases.some((c) => c.id === id))
      if (unknown.length) throw new Error(`unknown case: ${unknown.join(', ')}`)
      if (cases.length > config.maxCases) {
        throw new Error(`at most ${config.maxCases} cases per dry run; choose cases with \`cases\``)
      }
      const runId = `dryrun-${new Date().toISOString().replace(/[:.]/g, '-')}-${plan.id}`.replace(/[^\w.-]/g, '_')
      const tracked: Tracked = {
        startedAt: Date.now(),
        promise: ctx.runner.run({ plan, cases, runId, inputs: args.inputs }),
      }
      tracked.promise.then(
        (report) => { tracked.report = report },
        (error) => { tracked.error = errorMessage(error) },
      )
      runs.set(runId, tracked)
      scope.log('authoring/dry-run', { runId, planId: plan.id, cases })
      return { runId, status: 'running', cases }
    },
    present: (args, outcome) => ({
      kind: 'dry-run-start',
      title: `Chạy thử ${(outcome.value as { cases?: string[] } | undefined)?.cases?.join(', ') ?? ''}`.trim(),
      runId: (outcome.value as { runId?: string } | undefined)?.runId,
    }),
  })

  ctx.actions.register({
    name: 'get_run_result',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: [
      'Đọc kết quả lượt chạy thử. Nếu lượt chạy chưa xong, chờ tối đa `waitSec` giây rồi trả trạng thái `running`.',
      'Kết quả gồm verdict từng case, giá trị thật của từng expectation và gợi ý sửa plan.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        waitSec: { type: 'integer', minimum: 0, maximum: config.maxWait, default: 30 },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    async execute(args: { runId: string; waitSec?: number }, { signal }) {
      const tracked = runs.get(args.runId)
      if (!tracked) {
        // Lượt chạy từ phiên trước: dựng lại từ run log.
        const file = join(resolve(ctx.runlog.config.dir), args.runId, 'events.jsonl')
        const events = await ctx.runlog.read(file).catch(() => undefined)
        if (!events) throw new Error(`unknown runId ${args.runId}`)
        return compact(deriveReport(events))
      }
      if (!tracked.report && !tracked.error) {
        const wait = Math.min(args.waitSec ?? 30, config.maxWait) * 1000
        await Promise.race([tracked.promise.catch(() => {}), sleep(wait, undefined, { signal }).catch(() => {})])
      }
      if (tracked.error) return { runId: args.runId, status: 'error', error: tracked.error }
      if (!tracked.report) {
        return { runId: args.runId, status: 'running', elapsedSec: Math.round((Date.now() - tracked.startedAt) / 1000) }
      }
      return compact(tracked.report)
    },
    present: (_args, outcome) => ({ kind: 'run-result', title: 'Kết quả chạy thử', ...(outcome.value as object | undefined) }),
  })

  ctx.authoring.guideSection({
    id: 'authoring/dry-run',
    order: 60,
    render: () => [
      '## Chạy thử',
      `- \`dry_run\` chạy tối đa ${config.maxCases} case trên môi trường kiểm thử, gồm cả fixture.`,
      '- Gọi `get_run_result` tới khi `status` khác `running`.',
      '- Đọc `hints` và giá trị `actual` của từng expectation. Case không đạt có thể do plan viết chưa rõ,',
      '  hoặc do hệ thống có lỗi thật: phân biệt hai trường hợp và báo người dùng, không sửa plan để che lỗi thật.',
    ].join('\n'),
  })
}

/** Báo cáo rút gọn cho agent, kèm gợi ý sửa plan suy ra từ kết quả. */
export function compact(report: RunReport) {
  return {
    runId: report.runId,
    status: 'done',
    totals: report.totals,
    reportFile: report.logFile?.replace(/events\.jsonl$/, 'report.md'),
    cases: report.cases.map((c) => ({
      id: c.id,
      title: c.title,
      verdict: c.verdict,
      reasons: c.reasons,
      expectations: c.expectations.map((e) => ({
        id: e.id,
        desc: e.desc,
        passed: e.assertion?.passed,
        op: e.assertion?.op ?? e.check?.op,
        expected: e.assertion?.expected ?? e.check?.value,
        actual: e.assertion?.actual,
        path: e.assertion && `${e.assertion.evidenceId} ${e.assertion.path}`,
        attempts: e.attempts.length,
        ...(e.assertion?.expr ? { expr: e.assertion.expr, inputs: e.assertion.inputs } : e.check?.expr ? { expr: e.check.expr } : {}),
      })),
      actions: c.actions.map((a) => `${a.phase ?? 'agent'}:${a.name}:${a.status}`),
      agentSummary: c.agentSummary.trim().slice(0, 800),
      annotations: c.annotations,
      hints: hints(c),
    })),
  }
}

function hints(c: CaseReport): string[] {
  const out: string[] = []
  for (const e of c.expectations) {
    if (!e.assertion) out.push(`Expectation ${e.id} chưa được assert: mô tả có thể mơ hồ, hoặc thiếu bước tạo ra dữ liệu cần kiểm tra.`)
    else if (e.attempts.length > 1) out.push(`Expectation ${e.id} phải assert ${e.attempts.length} lần: nên mô tả rõ dữ liệu cần đối chiếu.`)
    else if (e.assertion.actual === undefined) out.push(`Expectation ${e.id} đọc được giá trị undefined: kiểm tra lại bước truy vấn hoặc mô tả cấu trúc dữ liệu trong context.`)
  }
  for (const a of c.actions) {
    if (a.status === 'denied') out.push(`Action ${a.name} bị guard từ chối: ${a.error}`)
    else if (a.status === 'error' && a.phase !== 'agent') out.push(`Fixture ${a.name} lỗi: ${a.error}`)
  }
  if (c.verdict === 'error') out.push(`Case lỗi: ${c.reasons.join('; ')}`)
  const known = c.annotations.knownIssues as Array<{ id: string }> | undefined
  if (known?.length) out.push(`Case không đạt do lỗi đã biết của hệ thống (${known.map((i) => i.id).join(', ')}); không sửa plan để che lỗi.`)
  return out
}
