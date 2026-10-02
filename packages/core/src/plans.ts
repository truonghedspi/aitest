import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { TestPlan } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    plans: PlanService
  }
}

/** Một định dạng test plan. Mỗi định dạng là một plugin riêng. */
export interface PlanFormat {
  name: string
  /** Phần đuôi file mà format này nhận, ví dụ `.plan.yaml`. */
  extensions: string[]
  /** Hướng dẫn viết plan theo định dạng này, viết cho agent đọc (Markdown). */
  guide?: string
  parse(text: string, source: string): TestPlan
}

export class PlanError extends Error {
  constructor(public readonly source: string, public readonly issues: string[]) {
    super(`invalid test plan ${source}:\n  - ${issues.join('\n  - ')}`)
  }
}

export class PlanService extends Service {
  private readonly formats = new Map<string, PlanFormat>()

  constructor(ctx: Context) {
    super(ctx, 'plans')
  }

  registerFormat(format: PlanFormat) {
    return this.ctx.effect(() => {
      this.formats.set(format.name, format)
      return () => { this.formats.delete(format.name) }
    }, `plans.registerFormat(${format.name})`)
  }

  listFormats() {
    return [...this.formats.values()]
  }

  /** Chọn format theo đuôi file dài nhất khớp, rồi parse nội dung. */
  async load(file: string): Promise<TestPlan> {
    const source = resolve(file)
    return this.parse(await readFile(source, 'utf8'), source)
  }

  /** Parse nội dung plan; `source` quyết định format theo đuôi file và được ghi vào `TestPlan.source`. */
  parse(text: string, source: string): TestPlan {
    const format = this.listFormats()
      .flatMap((f) => f.extensions.map((ext) => ({ f, ext })))
      .filter(({ ext }) => source.endsWith(ext))
      .sort((a, b) => b.ext.length - a.ext.length)[0]?.f
    if (!format) {
      const known = this.listFormats().flatMap((f) => f.extensions).join(', ') || '(none)'
      throw new PlanError(source, [`no plan format accepts this file; known extensions: ${known}`])
    }
    return format.parse(text, source)
  }
}

/**
 * Biến dựng sẵn của một lượt chạy, cố định trong suốt lượt chạy và được ghi vào run log.
 * `$run.short` dùng để gắn vào dữ liệu tạo ra, để mỗi lượt chạy có dữ liệu riêng và chỉ dọn dữ liệu của mình.
 */
export function runVars(runId: string, started = new Date(), timeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone): Record<string, string> {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(started)
  return {
    '$run.id': runId,
    '$run.short': createHash('sha1').update(runId).digest('hex').slice(0, 6),
    '$run.date': date,
    '$run.time': started.toISOString(),
    '$run.epoch': String(started.getTime()),
  }
}

/** Tên biến dựng sẵn; `$case.id` do runner đặt cho từng case. */
export const BUILTIN_VARS = ['$run.id', '$run.short', '$run.date', '$run.time', '$run.epoch', '$case.id']
