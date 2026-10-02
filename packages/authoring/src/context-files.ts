import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { z, type Context } from '@aitest/core'
import type {} from './index.ts'

/**
 * Nguồn context từ file cục bộ: đặc tả nghiệp vụ, OpenAPI, mô tả dữ liệu.
 * Mỗi mục trong `sources` thành một nguồn; mỗi file trong `paths` thành một tài liệu.
 */
export interface SourceConfig {
  id: string
  title: string
  description?: string
  paths: string[]
}

export interface Config {
  sources: SourceConfig[]
}

export const name = 'authoring-context-files'
export const inject = ['authoring']

export const Config = z.object({
  sources: z.array(z.object({
    id: z.string().required(),
    title: z.string().required(),
    description: z.string(),
    paths: z.array(z.string()).required(),
  })).default([]),
})

export function apply(ctx: Context, config: Config) {
  for (const source of config.sources) {
    const files = source.paths.map((p) => resolve(p))
    ctx.authoring.registerContextSource({
      id: source.id,
      title: source.title,
      description: source.description,
      async list() {
        return Promise.all(files.map(async (file) => ({
          id: basename(file),
          title: basename(file),
          size: await stat(file).then((s) => s.size, () => undefined),
        })))
      },
      async read(docId) {
        const file = files.find((f) => basename(f) === docId)
        if (!file) throw new Error(`unknown document ${docId} in source ${source.id}`)
        return readFile(file, 'utf8')
      },
    })
  }
}
