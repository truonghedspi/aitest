import type { ActionScope, Context } from '@aitest/core'
import type {} from './index.ts'

/**
 * Tool `explore`: khảo sát hệ thống thật bằng lời gọi chỉ đọc, để plan dùng đúng tên bảng, tên cột,
 * mã trạng thái và nhãn giao diện.
 *
 * Lời gọi được chấp nhận khi action khai báo `readOnly`, hoặc `isReadOnlyCall(args)` trả về `true`
 * (ví dụ HTTP GET). Lời gọi vẫn đi qua guard và được ghi vào log của phiên soạn plan.
 */
export const name = 'authoring-explore'
export const inject = ['actions', 'authoring']

export function apply(ctx: Context) {
  // Mỗi phiên soạn plan dùng một scope `explore` riêng, để trạng thái theo scope (evidence...) không lẫn giữa các phiên.
  const exploreScopes = new WeakMap<ActionScope, ActionScope>()
  const exploreScopeOf = (parent: ActionScope) => {
    let scope = exploreScopes.get(parent)
    if (!scope) {
      scope = {
        kind: 'explore',
        id: parent.id,
        namespaces: new Set(ctx.actions.list().map((a) => a.namespace)),
        phase: 'agent',
        signal: parent.signal,
        log: parent.log,
      }
      exploreScopes.set(parent, scope)
    }
    return scope
  }

  ctx.actions.register({
    name: 'explore',
    namespace: 'authoring',
    scopes: ['authoring'],
    always: true,
    readOnly: true,
    evidence: false,
    description: [
      'Gọi một action chạy test ở chế độ chỉ đọc để khảo sát hệ thống thật, ví dụ',
      '`db_query` với câu SELECT, `http_request` với method GET, `browser_snapshot`.',
      'Lời gọi có thể ghi dữ liệu sẽ bị từ chối.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Tên action từ `list_actions`.' },
        args: { type: 'object', description: 'Tham số theo input schema của action đó.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(input: { action: string; args?: Record<string, unknown> }, { scope }) {
      const args = input.args ?? {}
      const target = ctx.actions.list({ kind: 'explore', namespaces: new Set(), phase: 'setup' })
        .find((a) => a.name === input.action)
      if (!target) throw new Error(`action ${input.action} is not available for exploration`)
      const readOnly = target.readOnly === true || target.isReadOnlyCall?.(args) === true
      if (!readOnly) throw new Error(`call to ${input.action} may modify data; explore only allows read-only calls`)
      const outcome = await ctx.actions.invoke(exploreScopeOf(scope), input.action, args)
      if (outcome.status !== 'ok') throw new Error(`${outcome.status}: ${outcome.error}`)
      return outcome.value
    },
    present: (input, outcome) => ({
      kind: 'explore',
      title: `Khảo sát ${input.action}`,
      action: input.action,
      args: input.args ?? {},
      value: outcome.value,
      error: outcome.error,
    }),
  })

  ctx.authoring.guideSection({
    id: 'authoring/explore',
    order: 40,
    render: () => [
      '## Khảo sát hệ thống',
      '- Dùng `explore` trước khi viết bước hoặc expectation liên quan tới dữ liệu.',
      '- Ví dụ: đọc cấu trúc bảng (`db_query` với `SELECT sql FROM sqlite_master` hoặc `information_schema`),',
      '  xem dữ liệu mẫu, gọi API GET để biết cấu trúc response, chụp `browser_snapshot` để biết nhãn trường và nút.',
      '- Chỉ dùng giá trị quan sát được; không tự đoán tên cột, mã trạng thái hay nhãn giao diện.',
    ].join('\n'),
  })
}
