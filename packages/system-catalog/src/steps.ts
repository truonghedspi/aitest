import { fillTemplate, readPath, type CaseScope, type Context, type StepCall } from '@aitest/core'
import type { Catalog } from './model.ts'

/** Kết quả một bước `call:` runner đã chạy, cho section prompt của agent. */
interface DoneStep {
  step: number
  call: string
  evidenceId?: string
  status?: number
  saved: Record<string, unknown>
}

/**
 * Chạy các bước `call: <system>.<operation>` liền nhau ở đầu case qua `http_request`, không qua agent (`case/steps`).
 * Lời gọi mang `step` và `reason` (lấy từ `desc`) nên hành trình theo bước, evidence và assertion `from` dùng như
 * lời gọi của agent. Phần còn lại của case (nếu có) do agent làm tiếp, với section prompt liệt kê bước đã xong.
 */
export function registerStepRunner(ctx: Context, catalogOf: (scope: CaseScope) => Promise<Catalog>) {
  const done = new WeakMap<CaseScope, DoneStep[]>()

  ctx.on('case/steps', async (scope, next) => {
    const before = await next()
    const calls = scope.case.calls ?? []
    if (before > 0 || !calls[0]) return before
    const catalog = await catalogOf(scope)
    const results: DoneStep[] = []
    done.set(scope, results)
    let completed = 0
    for (const [index, raw] of calls.entries()) {
      if (!raw) break
      const step = index + 1
      // Giá trị `save` của bước trước được thay vào bước sau.
      const call = fillTemplate(raw, scope.vars)
      const request = toRequest(call, catalog, scope.vars)
      const outcome = await ctx.actions.invoke(scope, 'http_request', request, { reason: call.desc ?? call.call, step })
      if (outcome.status !== 'ok') throw new Error(`step ${step} (${call.call}) failed: ${outcome.error}`)
      await ctx.parallel('case/step-done', scope, step, outcome)
      const saved: Record<string, unknown> = {}
      for (const [name, path] of Object.entries(call.save ?? {})) {
        const value = readPath(outcome.value, path)
        if (value === undefined) throw new Error(`step ${step} (${call.call}): cannot save ${name}, path ${path} has no value`)
        scope.vars[name] = saved[name] = value
      }
      results.push({
        step, call: call.call, evidenceId: outcome.annotations.evidenceId as string | undefined,
        status: (outcome.value as { status?: number } | undefined)?.status, saved,
      })
      completed = step
    }
    if (results.some((r) => Object.keys(r.saved).length)) scope.log('fixture/vars', { phase: 'step', vars: scope.vars })
    return completed
  })

  ctx.prompt.section({
    id: 'systems/steps-done',
    order: 25,
    render: (scope) => {
      const results = done.get(scope as CaseScope)
      if (!results?.length) return undefined
      const last = results[results.length - 1].step
      return [
        '### Bước nền tảng đã chạy',
        `Nền tảng đã thực hiện bước 1 tới ${last} đúng như plan; không gọi lại. Bắt đầu từ bước ${last + 1}, dùng evidence dưới đây khi cần.`,
        ...results.map((r) => `- Bước ${r.step} (\`${r.call}\`): evidence \`${r.evidenceId ?? '—'}\`${r.status !== undefined ? `, HTTP ${r.status}` : ''}`
          + (Object.keys(r.saved).length ? `; lưu ${Object.entries(r.saved).map(([k, v]) => `\`${k}\` = ${JSON.stringify(v)}`).join(', ')}` : '')),
      ].join('\n')
    },
  })
}

/** Dựng tham số `http_request` từ operation trong catalog: URL theo môi trường (biến `{{<system>.url}}`), thay tham số path. */
export function toRequest(call: StepCall, catalog: Catalog, vars: Record<string, unknown>): Record<string, unknown> {
  const dot = call.call.lastIndexOf('.')
  const [systemId, operationId] = [call.call.slice(0, dot), call.call.slice(dot + 1)]
  const system = catalog.systems.find((s) => s.id === systemId)
  if (!system) throw new Error(`call ${call.call}: unknown system ${systemId}`)
  const op = system.operations.find((o) => o.id === operationId)
  if (!op) throw new Error(`call ${call.call}: ${systemId} has no operation ${operationId}`)
  const base = vars[`${systemId}.url`] ?? catalog.env.systems[systemId]?.url
  if (typeof base !== 'string' || !base) throw new Error(`call ${call.call}: environment ${catalog.env.name} has no url for ${systemId}`)
  const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = call.path?.[name]
    if (value === undefined) throw new Error(`call ${call.call}: missing path parameter ${name}`)
    return encodeURIComponent(String(value))
  })
  return {
    method: op.method,
    url: `${base.replace(/\/+$/, '')}${path}`,
    ...(call.query && Object.keys(call.query).length ? { query: call.query } : {}),
    ...(call.headers && Object.keys(call.headers).length ? { headers: call.headers } : {}),
    ...(call.body !== undefined ? { body: call.body } : {}),
  }
}
