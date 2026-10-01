import type { Context, Verdict } from '@aitest/core'

/** In tiến độ và tổng kết ra terminal. */
export const name = 'reporter-console'

const COLOR: Record<Verdict, string> = {
  pass: '\x1b[32m', fail: '\x1b[31m', error: '\x1b[35m', inconclusive: '\x1b[33m', skipped: '\x1b[90m',
}
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

export function apply(ctx: Context, config: { verbose?: boolean } = {}) {
  const out = (line = '') => process.stdout.write(line + '\n')
  const paint = (v: Verdict) => `${COLOR[v]}${v.toUpperCase().padEnd(12)}${RESET}`

  ctx.on('case/start', async (scope) => {
    out(`${DIM}▶ ${scope.case.id} ${scope.case.title}${RESET}`)
  })

  ctx.on('action/result', (call, outcome) => {
    const tag = outcome.status === 'ok' ? '' : ` [${outcome.status}: ${outcome.error}]`
    const evidence = outcome.annotations.evidenceId ? ` → ${outcome.annotations.evidenceId}` : ''
    out(`${DIM}    · ${call.name}${evidence} (${outcome.durationMs} ms)${tag}${RESET}`)
    if (config.verbose) out(`${DIM}      ${JSON.stringify(call.args)}${RESET}`)
  })

  ctx.on('case/end', async (scope, decision) => {
    out(`  ${paint(decision.verdict)} ${scope.case.id}`)
    for (const reason of decision.reasons) out(`    - ${reason}`)
  })

  ctx.on('run/report', async (report) => {
    const t = report.totals
    out()
    out(`Run ${report.runId} — ${report.plan.name}`)
    out(`  total ${t.total} | pass ${t.pass} | fail ${t.fail} | error ${t.error} | inconclusive ${t.inconclusive}`)
    out(`  duration ${(report.durationMs / 1000).toFixed(1)} s`)
    if (report.logFile) out(`  log ${report.logFile}`)
  })
}
