/**
 * Plugin mẫu tối giản: thêm một action mới mà không sửa code nền tảng.
 *
 * Bật bằng cách thêm vào `aitest.yml`:
 *   - id: action-clock
 *     name: ./examples/plugins/action-clock.ts
 *     config: { timezone: Asia/Ho_Chi_Minh }
 * rồi khai báo `requires: [clock]` trong test plan.
 */
import { z, type Context } from '@aitest/core'

export const name = 'action-clock'
export const inject = ['actions']
export const Config = z.object({
  timezone: z.string().default('UTC'),
})

export function apply(ctx: Context, config: { timezone: string }) {
  ctx.actions.register({
    name: 'clock_now',
    namespace: 'clock',
    readOnly: true,
    description: `Trả về thời điểm hiện tại theo múi giờ ${config.timezone}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const now = new Date()
      return {
        iso: now.toISOString(),
        local: now.toLocaleString('sv-SE', { timeZone: config.timezone }),
        timezone: config.timezone,
      }
    },
  })
}
