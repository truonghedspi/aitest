import type {} from '@aitest/mcp-gateway'
import { fillTemplate, variablesOf, type Context, type Expectation } from '@aitest/core'

/**
 * Các section prompt mặc định của runner.
 * Plugin khác có thể thêm section mới, hoặc thay section này bằng cách đăng ký lại cùng `id`.
 */
export function registerDefaultSections(ctx: Context) {
  ctx.prompt.section({
    id: 'runner/role',
    order: 0,
    render: () => [
      'Bạn là QA agent tự động. Nhiệm vụ: thực hiện đúng một test case theo kịch bản bên dưới.',
      '',
      '## Ràng buộc',
      `- Chỉ dùng các tool của MCP server \`${ctx.gateway.config.serverName}\` (gateway kiểm thử). Không đọc/ghi file, không chạy shell.`,
      '- Không có người dùng tương tác. Không hỏi lại; nếu thiếu thông tin, chọn cách hợp lý nhất và ghi chú lại.',
      '- Thực hiện các bước theo đúng thứ tự. Dùng giá trị thật lấy từ kết quả bước trước cho bước sau.',
      '- Mỗi lần gọi tool, điền `reason` (lấy dữ liệu gì hoặc làm gì, dùng kết quả để làm gì) và `step` (số thứ tự bước đang thực hiện). Người dùng đọc các lý do này để hiểu vì sao test ra kết quả như vậy.',
    ].join('\n'),
  })

  ctx.prompt.section({
    id: 'runner/plan',
    order: 10,
    render: ({ plan, vars }) => {
      const lines = [`## Test plan: ${plan.name} (${plan.id})`]
      if (plan.description) lines.push(plan.description)
      if (plan.context) lines.push('', '### Bối cảnh', fillTemplate(plan.context, vars))
      // Gồm biến của plan và biến lưu từ bước chuẩn bị dữ liệu (fixture).
      if (Object.keys(vars).length) lines.push('', '### Biến', '```json', JSON.stringify(vars, null, 2), '```')
      return lines.join('\n')
    },
  })

  ctx.prompt.section({
    id: 'runner/case',
    order: 20,
    render: ({ case: c }) => [
      `## Test case ${c.id}: ${c.title}`,
      '',
      '### Các bước',
      ...c.steps.map((step, i) => `${i + 1}. ${step}`),
    ].join('\n'),
  })

  ctx.prompt.section({
    id: 'runner/expect',
    order: 30,
    render: ({ case: c }) => {
      if (!c.expect.length) return undefined
      return [
        '### Kết quả mong đợi',
        ...c.expect.map((e) => `- \`${e.id}\`: ${e.desc}${criteria(e)}`),
      ].join('\n')
    },
  })

  ctx.prompt.section({
    id: 'runner/actions',
    order: 40,
    render: (_, actions) => [
      '## Tool khả dụng',
      ...actions.map((a) => `- \`${a.name}\`: ${a.description.split('\n')[0]}`),
    ].join('\n'),
  })

  ctx.prompt.section({
    id: 'runner/finish',
    order: 90,
    render: () => 'Khi đã assert xong mọi expectation, trả lời bằng một đoạn tóm tắt ngắn (tối đa 5 dòng) rồi kết thúc lượt.',
  })
}

function criteria(e: Expectation) {
  if (!e.check) return ''
  if (e.check.expr) {
    return ` — tiêu chí cố định: \`${e.check.op}\` công thức \`${e.check.expr}\`; khi assert, gắn \`inputs\` cho biến: ${variablesOf(e.check.expr).map((v) => `\`${v}\``).join(', ')}`
  }
  return ` — tiêu chí cố định: \`${e.check.op}\`${e.check.value !== undefined ? ` \`${JSON.stringify(e.check.value)}\`` : ''}`
}
