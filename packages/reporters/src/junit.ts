import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z, type Context, type RunReport } from '@aitest/core'

/** Xuất JUnit XML để tích hợp CI (GitLab, Jenkins, GitHub Actions). */
export const name = 'reporter-junit'

export const Config = z.object({
  file: z.string().description('Đường dẫn file; mặc định là `junit.xml` cạnh run log.'),
})

export function apply(ctx: Context, config: { file?: string }) {
  ctx.on('run/report', async (report) => {
    const file = config.file ? resolve(config.file) : join(dirname(report.logFile ?? '.'), 'junit.xml')
    await writeFile(file, renderJUnit(report))
    ctx.logger('junit').info('written %s', file)
  })
}

export function renderJUnit(report: RunReport) {
  const t = report.totals
  const cases = report.cases.map((c) => {
    const time = (c.durationMs / 1000).toFixed(3)
    const known = (c.annotations.knownIssues as Array<{ id: string }> | undefined)?.map((i) => i.id)
    const message = esc((known?.length ? `[known: ${known.join(', ')}] ` : '') + c.reasons.join('; '))
    let body = ''
    if (c.verdict === 'fail') body = `<failure message="${message}">${esc(c.reasons.join('\n'))}</failure>`
    else if (c.verdict === 'error') body = `<error message="${message}">${esc(c.reasons.join('\n'))}</error>`
    else if (c.verdict === 'inconclusive' || c.verdict === 'skipped' || c.verdict === 'blocked') body = `<skipped message="${c.verdict}: ${message}"/>`
    const out = c.agentSummary ? `<system-out>${esc(c.agentSummary)}</system-out>` : ''
    return `    <testcase classname="${esc(report.plan.id)}" name="${esc(`${c.id} ${c.title}`)}" time="${time}">${body}${out}</testcase>`
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="aitest" tests="${t.total}" failures="${t.fail}" errors="${t.error}" time="${(report.durationMs / 1000).toFixed(3)}">`,
    `  <testsuite name="${esc(report.plan.name)}" tests="${t.total}" failures="${t.fail}" errors="${t.error}" skipped="${t.inconclusive + t.skipped + t.blocked}" timestamp="${report.startedAt}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n')
}

function esc(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
}
