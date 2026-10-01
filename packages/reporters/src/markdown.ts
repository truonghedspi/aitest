import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z, type CaseReport, type Context, type RunReport } from '@aitest/core'

/** Xuất báo cáo Markdown cho người đọc: tổng quan, từng case, assertion và chuỗi action. */
export const name = 'reporter-markdown'

export const Config = z.object({
  file: z.string().description('Đường dẫn file; mặc định là `report.md` cạnh run log.'),
})

export function apply(ctx: Context, config: { file?: string }) {
  ctx.on('run/report', async (report) => {
    const file = config.file ? resolve(config.file) : join(dirname(report.logFile ?? '.'), 'report.md')
    await writeFile(file, renderMarkdown(report))
    ctx.logger('markdown').info('written %s', file)
  })
}

const ICON = { pass: '✅', fail: '❌', error: '💥', inconclusive: '❔', skipped: '⏭️' } as const

export function renderMarkdown(report: RunReport) {
  const t = report.totals
  const lines = [
    `# Báo cáo kiểm thử: ${report.plan.name}`,
    '',
    '| Thuộc tính | Giá trị |',
    '|---|---|',
    `| Run | \`${report.runId}\` |`,
    `| Plan | \`${report.plan.id}\` (${report.plan.source}) |`,
    `| Agent | ${report.agent} |`,
    `| Bắt đầu | ${report.startedAt} |`,
    `| Thời lượng | ${(report.durationMs / 1000).toFixed(1)} s |`,
    `| Kết quả | ${t.total} case: ${t.pass} pass, ${t.fail} fail, ${t.error} error, ${t.inconclusive} inconclusive |`,
    '',
    '## Tổng hợp',
    '',
    '| Case | Tiêu đề | Kết quả | Thời lượng |',
    '|---|---|---|---|',
    ...report.cases.map((c) => `| ${c.id} | ${c.title} | ${ICON[c.verdict]} ${c.verdict} | ${(c.durationMs / 1000).toFixed(1)} s |`),
    '',
    ...report.cases.flatMap(renderCase),
  ]
  return lines.join('\n') + '\n'
}

function renderCase(c: CaseReport) {
  const lines = [`## ${ICON[c.verdict]} ${c.id} — ${c.title}`, '']
  if (c.reasons.length) lines.push('**Lý do:**', '', ...c.reasons.map((r) => `- ${r}`), '')

  lines.push('### Expectation', '', '| Mã | Mô tả | Tiêu chí | Thực tế | Kết quả |', '|---|---|---|---|---|')
  for (const e of c.expectations) {
    const a = e.assertion
    const criteria = a ? `${a.op} ${fmt(a.expected)} (${a.criteria})` : e.check ? `${e.check.op} ${fmt(e.check.value)}` : '—'
    const actual = a ? `${fmt(a.actual)} tại ${a.evidenceId} \`${a.path}\`` : '—'
    const retries = e.attempts.length > 1 ? ` (${e.attempts.length} lần thử)` : ''
    lines.push(`| ${e.id} | ${e.desc} | ${criteria} | ${actual} | ${a ? (a.passed ? '✅' : '❌') : 'chưa assert'}${retries} |`)
  }
  lines.push('')

  if (c.steps.length) {
    lines.push('### Ghi chú theo bước', '', ...c.steps.map((s) => `- Bước ${s.step}: ${s.status}${s.note ? ` — ${s.note}` : ''}`), '')
  }

  lines.push('### Chuỗi action', '', '| # | Action | Evidence | Trạng thái | Thời gian |', '|---|---|---|---|---|')
  c.actions.forEach((a, i) => {
    lines.push(`| ${i + 1} | \`${a.name}\` | ${a.annotations.evidenceId ?? ''} | ${a.status}${a.error ? `: ${a.error}` : ''} | ${a.durationMs} ms |`)
  })
  lines.push('')
  if (c.agentSummary.trim()) lines.push('### Tóm tắt của agent', '', '> ' + c.agentSummary.trim().replace(/\n/g, '\n> '), '')
  return lines
}

function fmt(value: unknown) {
  if (value === undefined) return ''
  const s = JSON.stringify(value)
  return '`' + (s.length > 60 ? s.slice(0, 57) + '...' : s).replace(/\|/g, '\\|') + '`'
}
