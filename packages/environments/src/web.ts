import type {} from '@aitest/web-host'
import { errorMessage, type Context } from '@aitest/core'
import type {} from './index.ts'

/**
 * Method cho giao diện: danh sách môi trường và kiểm tra một môi trường
 * (nạp tool theo môi trường, liệt kê tool có bản riêng).
 */
export const name = 'environments-web'
export const inject = ['envs', 'web', 'actions']

export function apply(ctx: Context) {
  ctx.web.method('envs.list', () => ctx.envs.list())

  ctx.web.method('envs.check', async (params: { name: string }) => {
    try {
      await ctx.envs.ensure(params.name)
    } catch (error) {
      return { name: params.name, ok: false, error: errorMessage(error) }
    }
    const tools = ctx.actions.all().map((d) => d.name).filter((n) => ctx.actions.envsOf(n).includes(params.name))
    return { name: params.name, ok: true, tools }
  })
}
