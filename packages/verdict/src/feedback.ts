import type {} from '@aitest/runner'
import { z, type CaseScope, type Context, type PlanFeedback } from '@aitest/core'

/**
 * Góp ý của agent chạy test để cải thiện plan: tool `feedback_submit` ghi event `case/feedback` vào run log.
 * Góp ý hiện trong kết quả chạy thử (agent soạn plan đọc để sửa plan), trên màn hình lượt chạy và trong báo cáo.
 * Góp ý không ảnh hưởng verdict: LLM không quyết định pass/fail.
 */
export interface Config {
  maxPerCase: number
}

export const name = 'plan-feedback'
export const inject = ['actions', 'prompt']

export const Config = z.object({
  maxPerCase: z.natural().default(5).description('Số góp ý tối đa của agent trong một case.'),
})

const KINDS: Array<PlanFeedback['kind']> = ['step', 'expectation', 'data', 'environment', 'tool', 'other']

export function apply(ctx: Context, config: Config) {
  const counts = new WeakMap<CaseScope, PlanFeedback[]>()

  ctx.actions.register({
    name: 'feedback_submit',
    namespace: 'verdict',
    always: true,
    scopes: ['case'],
    evidence: false,
    readOnly: true,
    description: [
      'Góp ý để người soạn plan cải thiện plan, khi plan gây khó cho bạn: bước mơ hồ hoặc thiếu thông tin, thiếu dữ liệu chuẩn bị,',
      'expectation khó xác định giá trị hay path, cần chờ lâu hơn, thiếu tool. Nêu vấn đề cụ thể và đề xuất sửa.',
      'Chỉ phục vụ người soạn plan; không thay cho assert và không ảnh hưởng kết quả.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS, description: 'step: bước; expectation: kết quả mong đợi; data: dữ liệu chuẩn bị; environment: môi trường; tool: thiếu hoặc khó dùng tool.' },
        message: { type: 'string', description: 'Vấn đề gặp phải, cụ thể, một hai câu.' },
        suggestion: { type: 'string', description: 'Đề xuất sửa plan, ví dụ câu bước viết lại hoặc path nên dùng.' },
        step: { type: 'integer', minimum: 1, description: 'Bước liên quan.' },
        expectId: { type: 'string', description: 'Expectation liên quan.' },
      },
      required: ['kind', 'message'],
      additionalProperties: false,
    },
    async execute(args: PlanFeedback, { scope }) {
      const caseScope = scope as CaseScope
      const list = counts.get(caseScope) ?? []
      const message = args.message.replace(/\s+/g, ' ').trim()
      if (!message) throw new Error('message is required')
      if (list.some((f) => f.message === message)) return { recorded: false, reason: 'the same feedback was already recorded' }
      if (list.length >= config.maxPerCase) throw new Error(`at most ${config.maxPerCase} feedback items per case; keep the most useful ones`)
      if (args.step !== undefined && caseScope.case && args.step > caseScope.case.steps.length) {
        throw new Error(`step ${args.step} does not exist; the case has ${caseScope.case.steps.length} steps`)
      }
      if (args.expectId && caseScope.case && !caseScope.case.expect.some((e) => e.id === args.expectId)) {
        throw new Error(`unknown expectation ${args.expectId}`)
      }
      const feedback: PlanFeedback = {
        kind: KINDS.includes(args.kind) ? args.kind : 'other', message,
        ...(args.suggestion?.trim() ? { suggestion: args.suggestion.trim() } : {}),
        ...(args.step ? { step: args.step } : {}),
        ...(args.expectId ? { expectId: args.expectId } : {}),
      }
      list.push(feedback)
      counts.set(caseScope, list)
      scope.log('case/feedback', feedback)
      return { recorded: true }
    },
    present: (args) => ({ kind: 'generic', title: `Góp ý cho plan: ${args.message}` }),
  })

  ctx.prompt.section({
    id: 'verdict/feedback',
    order: 65,
    render: () => [
      '## Góp ý cải thiện plan',
      '- Nếu plan làm bạn phải đoán (bước mơ hồ, thiếu dữ liệu, không biết đọc giá trị ở đâu, phải chờ lâu hơn dự kiến, thiếu tool),',
      '  vẫn làm hết sức theo plan, rồi gọi `feedback_submit` với vấn đề cụ thể và đề xuất sửa.',
      '- Không góp ý khi plan rõ ràng và chạy suôn sẻ; không dùng góp ý để báo lỗi của hệ thống (lỗi hệ thống thể hiện qua assert).',
    ].join('\n'),
  })
}
