import type {} from '@aitest/web-host'
import type { Context } from '@aitest/core'
import type {} from './index.ts'

/** Method cho nút Export, Import trên trang Plan. */
export const name = 'plan-bundle-web'
export const inject = ['bundles', 'web']

export function apply(ctx: Context) {
  ctx.web.method('bundles.export', (params: { paths: string[] }) => ctx.bundles.export(params.paths))
  ctx.web.method('bundles.preview', (params: { bundle: unknown }) => ctx.bundles.preview(params.bundle))
  ctx.web.method('bundles.import', (params: { bundle: unknown; overwrite?: string[] }) => ctx.bundles.import(params.bundle, { overwrite: params.overwrite }))
}
