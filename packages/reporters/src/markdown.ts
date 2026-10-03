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

const ICON = { pass: '✅', fail: '❌', error: '💥', inconclusive: '❔', skipped: '⏭️', blocked: '🚧' } as const

const SOURCE = { user: 'người chạy điền', fill: 'bước fill', agent: 'agent chuẩn bị', default: 'mặc định', missing: 'thiếu' } as const

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
    ...(report.env ? [`| Môi trường | ${report.env} |`] : []),
    `| Bắt đầu | ${report.startedAt} |`,
    `| Thời lượng | ${(report.durationMs / 1000).toFixed(1)} s |`,
    `| Kết quả | ${t.total} case: ${t.pass} pass, ${t.fail} fail, ${t.error} error, ${t.inconclusive} inconclusive${t.blocked ? `, ${t.blocked} blocked` : ''} |`,
    '',
    ...renderInputs(report),
    '## Tổng hợp',
    '',
    '| Case | Tiêu đề | Kết quả | Thời lượng | Ghi chú |',
    '|---|---|---|---|---|',
    ...report.cases.map((c) => `| ${c.id} | ${c.title} | ${ICON[c.verdict]} ${c.verdict} | ${(c.durationMs / 1000).toFixed(1)} s | ${knownLabel(c)} |`),
    '',
    ...report.cases.flatMap(renderCase),
  ]
  return lines.join('\n') + '\n'
}

/** Đầu vào của lượt chạy và nguồn giá trị; lý do bị chặn nếu có. */
function renderInputs(report: RunReport) {
  const lines: string[] = []
  if (report.blocked.length) {
    lines.push('## 🚧 Lượt chạy bị chặn', '', 'Môi trường hoặc dữ liệu chưa đủ điều kiện; các case không được chạy.', '', ...report.blocked.map((r) => `- ${r}`), '')
  }
  if (report.inputs.length) {
    lines.push('## Đầu vào', '', '| Tên | Giá trị | Nguồn | Ghi chú |', '|---|---|---|---|')
    for (const i of report.inputs) {
      const note = i.error ?? (i.evidence ? `từ ${i.evidence.action ?? ''} ${i.evidence.evidenceId} \`${i.evidence.path}\`` : '')
      lines.push(`| ${i.name} | ${i.value === undefined ? '—' : fmt(i.value)} | ${SOURCE[i.source]} | ${note} |`)
    }
    lines.push('')
  }
  return lines
}

type Issue = { id: string; title: string }

/** Phân loại case không đạt: lỗi đã biết (khớp ghi chú `bug` đang mở) hay lỗi mới. */
function knownLabel(c: CaseReport) {
  const known = c.annotations.knownIssues as Issue[] | undefined
  const fixed = c.annotations.possiblyFixed as Issue[] | undefined
  if (known?.length) return `lỗi đã biết: ${known.map((i) => i.id).join(', ')}`
  if (c.verdict === 'fail' || c.verdict === 'error') return '**lỗi mới**'
  if (fixed?.length) return `có thể đã sửa: ${fixed.map((i) => i.id).join(', ')}`
  return ''
}

function renderCase(c: CaseReport) {
  const lines = [`## ${ICON[c.verdict]} ${c.id} — ${c.title}`, '']
  if (c.reasons.length) lines.push('**Lý do:**', '', ...c.reasons.map((r) => `- ${r}`), '')
  const known = c.annotations.knownIssues as Issue[] | undefined
  const fixed = c.annotations.possiblyFixed as Issue[] | undefined
  if (known?.length) lines.push('**Lỗi đã biết:**', '', ...known.map((i) => `- \`${i.id}\`: ${i.title}`), '')
  if (fixed?.length) lines.push('**Có thể đã được sửa** (case đạt nhưng ghi chú lỗi vẫn mở):', '', ...fixed.map((i) => `- \`${i.id}\`: ${i.title}`), '')

  lines.push('### Expectation', '', '| Mã | Mô tả | Tiêu chí | Thực tế | Kết quả |', '|---|---|---|---|---|')
  for (const e of c.expectations) {
    const a = e.assertion
    const formula = a?.expr ?? e.check?.expr
    const inputs = a?.inputs ? ` với ${Object.entries(a.inputs).map(([n, i]) => `${n}=${brief(i.value)}`).join(', ')}` : ''
    const criteria = formula
      ? `${a?.op ?? e.check?.op} \`${formula}\`${a ? ` = ${fmt(a.expected)}${inputs}` : ''}`
      : a ? `${a.op} ${fmt(a.expected)} (${a.criteria})` : e.check ? `${e.check.op} ${fmt(e.check.value)}` : '—'
    const actual = a ? `${fmt(a.actual)} tại ${a.evidenceId} \`${a.path}\`` : '—'
    const retries = e.attempts.length > 1 ? ` (${e.attempts.length} lần thử)` : ''
    lines.push(`| ${e.id} | ${e.desc} | ${criteria} | ${actual} | ${a ? (a.passed ? '✅' : '❌') : 'chưa assert'}${retries} |`)
  }
  lines.push('')

  // Công thức có bước trung gian: giá trị từng bước, để thấy sai lệch bắt đầu từ bước nào.
  for (const e of c.expectations) {
    const steps = e.assertion?.steps
    if (!steps || !Object.keys(steps).length) continue
    const lets = e.check?.let ?? {}
    lines.push(`**Các bước công thức của \`${e.id}\`:**`, '', '| Bước | Biểu thức | Giá trị |', '|---|---|---|')
    for (const [name, value] of Object.entries(steps)) lines.push(`| ${name} | \`${(lets[name] ?? '').replace(/\|/g, '\\|')}\` | ${brief(value)} |`)
    lines.push(`| **kết quả** | \`${e.assertion!.expr}\` | ${brief(e.assertion!.expected)} |`, '')
  }

  if (c.feedback.length) {
    lines.push('### Góp ý của agent để cải thiện plan', '', ...c.feedback.map((f) => {
      const where = [f.step && `bước ${f.step}`, f.expectId && `\`${f.expectId}\``].filter(Boolean).join(', ')
      return `- **${FEEDBACK_KIND[f.kind] ?? f.kind}**${where ? ` (${where})` : ''}: ${f.message}${f.suggestion ? ` Đề xuất: ${f.suggestion}` : ''}`
    }), '')
  }

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

/** Giá trị ngắn gọn cho bảng: danh sách dài chỉ ghi số phần tử và vài phần tử đầu. */
function brief(value: unknown): string {
  if (Array.isArray(value)) {
    const head = value.slice(0, 3).map((v) => (typeof v === 'object' && v !== null ? '{…}' : JSON.stringify(v))).join(', ')
    return `[${value.length} phần tử${value.length ? `: ${head}${value.length > 3 ? ', …' : ''}` : ''}]`
  }
  const text = JSON.stringify(value)
  return text && text.length > 80 ? `${text.slice(0, 77)}…` : String(text)
}

const FEEDBACK_KIND: Record<string, string> = {
  step: 'Bước', expectation: 'Kết quả mong đợi', data: 'Dữ liệu', environment: 'Môi trường', tool: 'Tool', other: 'Khác',
}
