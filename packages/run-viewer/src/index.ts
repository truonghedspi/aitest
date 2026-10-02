import { open, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {} from '@aitest/web-host'
import { deriveReport, z, type Context, type RunEvent } from '@aitest/core'
import type { WebConnection } from '@aitest/web-host'

/**
 * Xem log của các lượt chạy trên giao diện: danh sách lượt chạy và toàn bộ event của từng lượt.
 *
 * Log là `<runlog.dir>/<runId>/events.jsonl`, gồm cả lượt chạy từ CLI (process khác) và lượt chạy thử từ cuộc chat.
 * `runs.subscribe` gửi snapshot rồi đọc tiếp phần mới của file theo vị trí byte cho tới khi gặp `run/end`,
 * nên theo dõi được cả lượt chạy đang diễn ra ở process khác.
 */
export interface Config {
  limit: number
  pollMs: number
}

export const name = 'run-viewer'
export const inject = ['runlog', 'web']

export const Config = z.object({
  limit: z.natural().default(200).description('Số lượt chạy gần nhất hiển thị trong danh sách.'),
  pollMs: z.natural().default(1000).description('Chu kỳ đọc phần mới của log khi lượt chạy chưa kết thúc, đơn vị ms.'),
})

export interface RunSummary {
  runId: string
  plan?: { id: string; name: string }
  agent?: string
  startedAt?: string
  finished: boolean
  dryRun: boolean
  durationMs: number
  totals?: Record<string, number>
  cases: Array<{ id: string; title: string; verdict: string }>
}

const RUN_ID = /^[\w.-]+$/

export function apply(ctx: Context, config: Config) {
  // Mọi luồng theo dõi đang mở; dừng hết khi plugin bị gỡ.
  const followers = new Set<() => void>()
  ctx.effect(() => () => { for (const stop of [...followers]) stop() }, 'run-viewer.followers')
  const root = () => resolve(ctx.runlog.config.dir)
  const fileOf = (runId: string) => {
    if (!RUN_ID.test(runId)) throw new Error(`invalid run id: ${runId}`)
    return join(root(), runId, 'events.jsonl')
  }

  ctx.web.method('runs.list', async () => {
    const ids = (await readdir(root()).catch(() => [] as string[])).filter((id) => RUN_ID.test(id))
    const dated = await Promise.all(ids.map(async (id) => ({ id, mtime: (await stat(fileOf(id)).catch(() => undefined))?.mtimeMs })))
    const recent = dated.filter((d) => d.mtime).sort((a, b) => b.mtime! - a.mtime!).slice(0, config.limit)
    const out: RunSummary[] = []
    for (const { id } of recent) {
      const events = await ctx.runlog.read(fileOf(id)).catch(() => [] as RunEvent[])
      if (!events.some((e) => e.type === 'run/start')) continue
      out.push(summarize(id, events))
    }
    return out
  })

  ctx.web.method('runs.subscribe', async (params: { runId: string; afterSeq?: number }, connection: WebConnection) => {
    const file = fileOf(params.runId)
    const { events, offset } = await readFrom(file, 0)
    const snapshot = events.filter((e) => e.seq > (params.afterSeq ?? 0))
    if (!events.some((e) => e.type === 'run/end')) follow(connection, params.runId, file, offset)
    return { summary: summarize(params.runId, events), events: snapshot }
  })

  /** Đọc phần mới của file theo chu kỳ, đẩy từng event cho client, dừng khi gặp `run/end` hoặc mất kết nối. */
  function follow(connection: WebConnection, runId: string, file: string, start: number) {
    let offset = start
    let stopped = false
    const timer = setInterval(async () => {
      if (stopped) return
      const next = await readFrom(file, offset).catch(() => undefined)
      if (!next) return
      offset = next.offset
      for (const event of next.events) connection.push({ type: 'run-event', runId, event })
      if (next.events.some((e) => e.type === 'run/end')) stop()
    }, config.pollMs)
    const stop = () => {
      stopped = true
      clearInterval(timer)
      followers.delete(stop)
    }
    followers.add(stop)
    connection.onClose(stop)
  }
}

/** Đọc các dòng hoàn chỉnh từ vị trí `offset`; dòng đang ghi dở được để lại cho lần đọc sau. */
async function readFrom(file: string, offset: number): Promise<{ events: RunEvent[]; offset: number }> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= offset) return { events: [], offset }
    const buffer = Buffer.alloc(size - offset)
    await handle.read(buffer, 0, buffer.length, offset)
    const text = buffer.toString('utf8')
    const end = text.lastIndexOf('\n') + 1
    const events = text.slice(0, end).split('\n').filter(Boolean).map((line) => JSON.parse(line) as RunEvent)
    return { events, offset: offset + Buffer.byteLength(text.slice(0, end)) }
  } finally {
    await handle.close()
  }
}

function summarize(runId: string, events: RunEvent[]): RunSummary {
  const start = events.find((e) => e.type === 'run/start')?.data as { plan?: { id: string; name: string }; agent?: string } | undefined
  const finished = events.some((e) => e.type === 'run/end')
  let report: ReturnType<typeof deriveReport> | undefined
  try {
    report = deriveReport(events)
  } catch {
    report = undefined
  }
  const last = events.at(-1)?.ts
  const first = events[0]?.ts
  return {
    runId,
    plan: start?.plan && { id: start.plan.id, name: start.plan.name },
    agent: start?.agent,
    startedAt: first,
    finished,
    dryRun: runId.startsWith('dryrun-'),
    durationMs: first && last ? Date.parse(last) - Date.parse(first) : 0,
    totals: report?.totals,
    cases: report?.cases.map((c) => ({
      id: c.id, title: c.title,
      verdict: finished || events.some((e) => e.caseId === c.id && e.type === 'case/end') ? c.verdict : 'running',
    })) ?? [],
  }
}
