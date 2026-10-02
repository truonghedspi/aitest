import type { Context, Verdict } from '@aitest/core'

/** In tiến độ và tổng kết ra terminal. */
export const name = 'reporter-console'

const COLOR: Record<Verdict, string> = {
  pass: '\x1b[32m', fail: '\x1b[31m', error: '\x1b[35m', inconclusive: '\x1b[33m', skipped: '\x1b[90m', blocked: '\x1b[36m',
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

  // Đánh dấu của plugin khác (ví dụ lỗi đã biết) tới qua run log, sau `case/end`.
  ctx.on('run/event', (event) => {
    if (event.type === 'inputs/resolved') {
      const inputs = (event.data as { inputs: Array<{ name: string; source: string; value?: unknown; error?: string }> }).inputs
      out(`${DIM}▶ Đầu vào${RESET}`)
      for (const i of inputs) out(`    ${i.name} = ${i.value === undefined ? '—' : JSON.stringify(i.value)} ${DIM}(${i.source}${i.error ? `: ${i.error}` : ''})${RESET}`)
      return
    }
    if (event.type === 'run/blocked') {
      out(`  ${paint('blocked')} lượt chạy không đủ điều kiện`)
      for (const reason of (event.data as { reasons: string[] }).reasons) out(`    - ${reason}`)
      return
    }
    if (event.type !== 'case/annotation') return
    const data = event.data as { key: string; value: Array<{ id: string }> }
    const label = data.key === 'knownIssues' ? 'lỗi đã biết' : data.key === 'possiblyFixed' ? 'có thể đã sửa' : data.key
    out(`    ${DIM}${label}: ${data.value.map((i) => i.id).join(', ')}${RESET}`)
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
