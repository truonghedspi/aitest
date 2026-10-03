import type {} from '@aitest/web-host'
import type { Context } from '@aitest/core'
import type { OpenItemStatus } from './store.ts'
import type {} from './index.ts'

/**
 * Method cho bảng "Việc còn mở" trong cuộc chat và tab cùng tên trên trang Ngữ cảnh.
 * Đóng việc từ giao diện ghi `closedBy: ui`; agent của cuộc chat được báo ở lượt kế tiếp qua `turnSection`.
 */
export const name = 'open-items-web'
export const inject = ['openItems', 'web']

export function apply(ctx: Context) {
  ctx.web.method('openItems.list', (params: { status?: OpenItemStatus; chatId?: string } = {}) => ctx.openItems.list(params))
  ctx.web.method('openItems.resolve', (params: { id: string; resolution: string; status?: 'resolved' | 'dropped' }) =>
    ctx.openItems.resolve(params.id, params.resolution, params.status ?? 'resolved', 'ui'))
  ctx.web.method('openItems.reopen', (params: { id: string }) => ctx.openItems.reopen(params.id))
}
