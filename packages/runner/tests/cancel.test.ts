/**
 * Kiểm thử dừng giữa chừng: dừng đúng một lời gọi tool (kể cả action không tự dừng theo signal),
 * dừng lượt chạy (case đang chạy vẫn dọn dẹp, case chưa chạy ghi lỗi), dừng chạy thử khi dừng lời gọi chờ kết quả.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@aitest/core'
import type { AuthoringSession } from '@aitest/authoring'
import { setupHarness, type Harness } from './support.ts'

const PORT = 4179

/** Chờ tới khi điều kiện đúng (tối đa 5 giây). */
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
  if (!check()) throw new Error('condition not met in time')
}

describe('cancelling tools and runs', () => {
  let harness: Harness
  let session: AuthoringSession

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      scripts: {
        // Case 1 gọi tool chạy mãi; case 2 lẽ ra chỉ liệt kê lệnh.
        async 'CN-01'(call) { await call('slow_wait', {}) },
        async 'CN-02'(call) { await call('http_request', { method: 'GET', url: `http://127.0.0.1:${PORT}/orders` }) },
      },
      rows: (dir) => [
        { id: 'authoring-save', name: '@aitest/authoring/save', config: { dir: join(dir, 'plans') } },
        // Giới hạn thời gian của chạy thử đặt ngắn để kiểm tra; mặc định 600 giây.
        { id: 'authoring-dry-run', name: '@aitest/authoring/dry-run', config: { caseTimeout: 2 } },
      ],
    })
    harness.kernel.ctx.runner.config.agent = 'scripted'
    // Action không bao giờ xong và bỏ qua signal: lời gọi vẫn phải trả về khi bị dừng.
    harness.kernel.ctx.plugin({
      name: 'slow-test',
      inject: ['actions'],
      apply(ctx: Context) {
        ctx.actions.register({
          name: 'slow_wait', namespace: 'slow', scopes: ['case', 'authoring'], always: true, evidence: false,
          description: 'Chờ mãi.', inputSchema: { type: 'object', properties: {} },
          execute: () => new Promise(() => {}),
        })
      },
    })
    await until(() => !!harness.kernel.ctx.actions.get('slow_wait'))
    session = await harness.kernel.ctx.authoring.createSession()
  }, 60_000)

  afterAll(async () => {
    await session?.close()
    await harness?.dispose()
  })

  it('cancels one running call and tells the agent not to retry', async () => {
    const { actions } = harness.kernel.ctx
    const pending = actions.invoke(session.scope, 'slow_wait', {})
    await until(() => actions.running(session.id).length === 1)
    const [running] = actions.running(session.id)
    expect(running).toMatchObject({ name: 'slow_wait', scopeId: session.id })
    expect(actions.cancel(running.callId)).toBe(true)
    const outcome = await pending
    expect(outcome).toMatchObject({ status: 'error', annotations: { cancelled: true } })
    expect(outcome.error).toBe('cancelled by the user; do not retry unless the user asks')
    expect(actions.running(session.id)).toEqual([])
    expect(actions.cancel(running.callId)).toBe(false)
    const logged = session.log.events.filter((e) => e.type === 'action/call').at(-1)!.data as { annotations: unknown }
    expect(logged.annotations).toEqual({ cancelled: true })
  })

  it('stops a run: the running case still tears down, later cases are not run', async () => {
    const file = join(harness.dir, 'cancel.plan.yaml')
    await writeFile(file, [
      'id: TP-CANCEL', 'name: Dừng', 'requires: [http, slow]',
      'teardown:', `  - { action: http_request, desc: Dọn dẹp, args: { method: GET, url: "http://127.0.0.1:${PORT}/orders" } }`,
      'cases:',
      '  - { id: CN-01, title: Chờ mãi, steps: [Chờ.], expect: [{ id: e1, desc: d, check: { op: eq, value: 1 } }] }',
      '  - { id: CN-02, title: Liệt kê, steps: [Liệt kê.], expect: [{ id: e1, desc: d, check: { op: eq, value: 1 } }] }', '',
    ].join('\n'))
    const controller = new AbortController()
    const { actions } = harness.kernel.ctx
    const report = harness.kernel.ctx.runner.run({ plan: file, signal: controller.signal })
    await until(() => actions.running().some((c) => c.name === 'slow_wait' && c.scopeId === 'CN-01'))
    controller.abort('cancelled by the user')
    const result = await report
    expect(result.cancelled).toBe('run cancelled: cancelled by the user')
    expect(result.cases.map((c) => [c.id, c.verdict, c.reasons[0]])).toEqual([
      ['CN-01', 'error', 'run cancelled: cancelled by the user'],
      ['CN-02', 'error', 'run cancelled: cancelled by the user'],
    ])
    // Teardown của case đang chạy vẫn chạy; case sau không gọi agent.
    expect(result.cases[0].actions.map((a) => [a.name, a.phase, a.status])).toContainEqual(['http_request', 'teardown', 'ok'])
    expect(result.cases[1].actions).toEqual([])
  })

  it('stops a dry run when the user stops the call waiting for its result', async () => {
    const { actions } = harness.kernel.ctx
    const content = [
      'id: TP-DRY-CANCEL', 'name: Dừng chạy thử', 'requires: [slow]',
      'cases:', '  - { id: CN-01, title: Chờ mãi, steps: [Chờ.], expect: [{ id: e1, desc: d, check: { op: eq, value: 1 } }] }', '',
    ].join('\n')
    const started = await actions.invoke(session.scope, 'dry_run', { content })
    const { runId } = started.value as { runId: string }
    await until(() => actions.running().some((c) => c.name === 'slow_wait' && c.scopeId === 'CN-01'))
    const waiting = actions.invoke(session.scope, 'get_run_result', { runId, waitSec: 60 })
    await until(() => actions.running(session.id).some((c) => c.name === 'get_run_result'))
    actions.cancel(actions.running(session.id).find((c) => c.name === 'get_run_result')!.callId)
    expect((await waiting).annotations).toEqual({ cancelled: true })
    let result: any
    for (let i = 0; i < 20; i++) {
      result = (await actions.invoke(session.scope, 'get_run_result', { runId, waitSec: 1 })).value
      if (result.status !== 'running') break
    }
    expect(result).toMatchObject({ status: 'done', totals: { error: 1 } })
    expect(result.cases[0].reasons[0]).toMatch(/run cancelled/)
  })

  it('stops dry runs of a session on authoring/stop', async () => {
    const { actions } = harness.kernel.ctx
    const content = [
      'id: TP-DRY-STOP', 'name: Dừng phiên', 'requires: [slow]',
      'cases:', '  - { id: CN-01, title: Chờ mãi, steps: [Chờ.], expect: [{ id: e1, desc: d, check: { op: eq, value: 1 } }] }', '',
    ].join('\n')
    const { runId } = (await actions.invoke(session.scope, 'dry_run', { content })).value as { runId: string }
    await until(() => actions.running().some((c) => c.name === 'slow_wait' && c.scopeId === 'CN-01'))
    harness.kernel.ctx.emit('authoring/stop', session.id)
    const result = (await actions.invoke(session.scope, 'get_run_result', { runId, waitSec: 10 })).value as { status: string }
    expect(result.status).toBe('done')
  })

  it('applies the dry-run case timeout to cases without their own timeout', async () => {
    const { actions } = harness.kernel.ctx
    const content = [
      'id: TP-DRY-TIMEOUT', 'name: Quá giờ', 'requires: [slow]',
      'cases:',
      '  - { id: CN-01, title: Chờ mãi, steps: [Chờ.], expect: [{ id: e1, desc: d, check: { op: eq, value: 1 } }] }', '',
    ].join('\n')
    const { runId } = (await actions.invoke(session.scope, 'dry_run', { content })).value as { runId: string }
    let result: any
    for (let i = 0; i < 20; i++) {
      result = (await actions.invoke(session.scope, 'get_run_result', { runId, waitSec: 5 })).value
      if (result.status !== 'running') break
    }
    expect(result.cases[0]).toMatchObject({ verdict: 'error', reasons: [expect.stringContaining('case timeout after 2000 ms')] })
    const guide = ((await actions.invoke(session.scope, 'get_authoring_guide', {})).value as { guide: string }).guide
    expect(guide).toContain('Mỗi case chạy thử tối đa 2 giây')
  }, 60_000)
})
