import type {
  ActionRecord, AgentUpdate, AssertionRecord, CaseReport, Expectation, ResolvedInput, RunEvent, RunReport, StepNote, Verdict,
} from './types.ts'

export interface RunStartData {
  plan: { id: string; name: string; source: string }
  agent: string
}

export interface CaseStartData {
  id: string
  title: string
  steps?: string[]
  expect: Expectation[]
}

export interface CaseEndData {
  verdict: Verdict
  reasons: string[]
  durationMs: number
  stopReason?: string
}

export const VERDICTS: Verdict[] = ['pass', 'fail', 'error', 'inconclusive', 'skipped', 'blocked']

/**
 * Dựng `RunReport` thuần tuý từ danh sách event của run log.
 *
 * Hàm này không có side effect. Mọi reporter nhận cùng một báo cáo,
 * và báo cáo luôn dựng lại được từ file `events.jsonl`.
 */
export function deriveReport(events: RunEvent[]): RunReport {
  const start = events.find((e) => e.type === 'run/start') as RunEvent<RunStartData> | undefined
  if (!start) throw new Error('run log has no run/start event')
  const end = events.find((e) => e.type === 'run/end')
  const cases = new Map<string, CaseReport>()
  let inputs: ResolvedInput[] = []
  let blocked: string[] = []

  for (const event of events) {
    if (event.type === 'inputs/resolved') inputs = (event.data as { inputs: ResolvedInput[] }).inputs
    if (event.type === 'run/blocked') blocked = (event.data as { reasons: string[] }).reasons
    const id = event.caseId
    if (event.type === 'case/start') {
      const data = event.data as CaseStartData
      cases.set(data.id, {
        id: data.id, title: data.title, verdict: 'inconclusive', reasons: [], durationMs: 0,
        expectations: data.expect.map((e) => ({ ...e, attempts: [] })), actions: [], steps: [], agentSummary: '', annotations: {},
      })
      continue
    }
    const report = id ? cases.get(id) : undefined
    if (!report) continue
    switch (event.type) {
      case 'action/call':
        report.actions.push(event.data as ActionRecord)
        break
      case 'assert/result': {
        const data = event.data as AssertionRecord
        const target = report.expectations.find((e) => e.id === data.expectId)
        // Assertion cuối cùng được ghi nhận là lần quyết định; khi tắt retry, plugin verdict từ chối các lần sau.
        if (target) {
          target.attempts.push(data)
          target.assertion = data
        }
        break
      }
      case 'case/annotation': {
        // Plugin gắn thông tin vào case; event sau cùng cho cùng `key` thắng.
        const data = event.data as { key: string; value: unknown }
        report.annotations[data.key] = data.value
        break
      }
      case 'step/note':
        report.steps.push(event.data as StepNote)
        break
      case 'agent/update': {
        const data = event.data as AgentUpdate
        if (data.kind === 'message' && data.text) report.agentSummary += data.text
        break
      }
      case 'case/end': {
        const data = event.data as CaseEndData
        report.verdict = data.verdict
        report.reasons = data.reasons
        report.durationMs = data.durationMs
        report.stopReason = data.stopReason
        break
      }
    }
  }

  const list = [...cases.values()]
  const totals = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as RunReport['totals']
  totals.total = list.length
  for (const c of list) totals[c.verdict]++
  return {
    runId: start.runId,
    plan: start.data.plan,
    agent: start.data.agent,
    startedAt: start.ts,
    finishedAt: end?.ts,
    durationMs: end ? Date.parse(end.ts) - Date.parse(start.ts) : 0,
    totals,
    inputs,
    blocked,
    cases: list,
  }
}
