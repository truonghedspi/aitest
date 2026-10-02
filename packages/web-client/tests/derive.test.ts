/**
 * Kiểm thử trạng thái bản nháp dựng từ log của cuộc chat khi người dùng mở plan có sẵn.
 */
import { describe, expect, it } from 'vitest'
import { draftState, timeline } from '../src/derive.ts'

let seq = 0
const event = (type: string, data: unknown) => ({ seq: ++seq, ts: '2026-10-02T00:00:00Z', type, data }) as any

describe('draftState with opened plans', () => {
  it('treats a plan opened from the save directory as saved, and marks later edits as unsaved', () => {
    const events = [
      event('action/call', { name: 'dry_run', status: 'ok', args: { content: 'old' }, value: { runId: 'r1' } }),
      event('draft/open', { path: 'plans/order/cancel.plan.yaml', content: 'id: A' }),
    ]
    expect(draftState(events)).toMatchObject({
      content: 'id: A', source: 'Bạn mở plans/order/cancel.plan.yaml',
      opened: { path: 'plans/order/cancel.plan.yaml' }, saved: { path: 'plans/order/cancel.plan.yaml', stale: false },
    })
    // Kết quả chạy thử của bản nháp trước không được gắn cho plan vừa mở.
    expect(draftState(events).run).toBeUndefined()
    expect(draftState([...events, event('draft/edit', { content: 'id: B' })]).saved).toEqual({ path: 'plans/order/cancel.plan.yaml', stale: true })
  })

  it('does not treat a plan opened outside the save directory as saved', () => {
    const state = draftState([
      event('action/call', { name: 'save_plan', status: 'ok', args: { content: 'x' }, value: { path: 'plans/x.plan.yaml' } }),
      event('draft/open', { path: 'examples/plans/order.plan.yaml', content: 'id: O' }),
    ])
    expect(state.saved).toBeUndefined()
    expect(state.opened?.path).toBe('examples/plans/order.plan.yaml')
  })

  it('shows the opening in the chat timeline', () => {
    const items = timeline([event('draft/open', { path: 'examples/plans/order.plan.yaml', content: '' })])
    expect(items).toEqual([expect.objectContaining({ kind: 'note', text: 'Bạn đã mở plan examples/plans/order.plan.yaml.' })])
  })
})
