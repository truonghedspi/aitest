import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RunEvent } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    runlog: RunLogService
  }
}

/**
 * Một run log dạng append-only, ghi ra `events.jsonl`.
 *
 * Báo cáo luôn được dựng lại từ các event trong log (xem `deriveReport`),
 * nên log là nguồn sự thật duy nhất và có thể phát lại (replay) để dựng lại báo cáo.
 */
export class RunLog {
  readonly events: RunEvent[] = []
  private seq = 0
  private stream: WriteStream

  constructor(private readonly ctx: Context, readonly runId: string, readonly dir: string, existing: RunEvent[] = []) {
    this.events.push(...existing)
    this.seq = existing.at(-1)?.seq ?? 0
    this.stream = createWriteStream(join(dir, 'events.jsonl'), { flags: 'a' })
  }

  get file() {
    return join(this.dir, 'events.jsonl')
  }

  append<T>(type: string, data: T, caseId?: string): RunEvent<T> {
    const event: RunEvent<T> = { seq: ++this.seq, ts: new Date().toISOString(), runId: this.runId, caseId, type, data }
    this.events.push(event)
    this.stream.write(JSON.stringify(event) + '\n')
    this.ctx.emit('run/event', event)
    return event
  }

  close() {
    return new Promise<void>((done) => this.stream.end(done))
  }
}

export class RunLogService extends Service {
  static Config = z.object({
    dir: z.string().default('.aitest/runs').description('Thư mục chứa run log, tương đối với thư mục làm việc.'),
  })

  constructor(ctx: Context, public config: { dir: string } = { dir: '.aitest/runs' }) {
    super(ctx, 'runlog')
  }

  /** Tạo log mới trong `<root>/<runId>`; `root` mặc định là `config.dir`. */
  async create(runId: string, root = this.config.dir) {
    const dir = resolve(root, runId)
    await mkdir(dir, { recursive: true })
    return new RunLog(this.ctx, runId, dir)
  }

  /** Mở lại log đã có trong `<root>/<runId>` để ghi tiếp; `seq` tiếp nối event cuối cùng. */
  async open(runId: string, root = this.config.dir) {
    const dir = resolve(root, runId)
    const existing = await this.read(join(dir, 'events.jsonl'))
    return new RunLog(this.ctx, runId, dir, existing)
  }

  /** Đọc lại một run log đã ghi, phục vụ dựng lại báo cáo. */
  async read(file: string): Promise<RunEvent[]> {
    const text = await readFile(file, 'utf8')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }
}
