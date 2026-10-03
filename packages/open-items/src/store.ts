import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Kho việc còn mở dạng một file JSON. Mỗi lần ghi viết file tạm rồi đổi tên; các lần ghi xếp hàng tuần tự
 * nên hai cuộc chat ghi cùng lúc không làm mất dữ liệu của nhau.
 */
export const OPEN_ITEM_KINDS = ['question', 'decision', 'issue', 'todo'] as const
export type OpenItemKind = typeof OPEN_ITEM_KINDS[number]
export type OpenItemStatus = 'open' | 'resolved' | 'dropped'

/** Ý nghĩa từng loại, dùng trong mô tả tool và trên giao diện. */
export const KIND_DESC: Record<OpenItemKind, string> = {
  question: 'câu hỏi đang chờ người dùng trả lời',
  decision: 'quyết định người dùng hoãn lại, thường có vài phương án',
  issue: 'vấn đề phát hiện khi chạy thử hoặc khảo sát nhưng chưa xử lý',
  todo: 'việc đã hứa làm sau',
}

export interface OpenItem {
  id: string
  kind: OpenItemKind
  /** Một dòng, đủ để người dùng trả lời mà không phải đọc lại cuộc chat. */
  title: string
  detail?: string
  /** Các phương án đang cân nhắc. */
  options?: string[]
  status: OpenItemStatus
  /** Câu trả lời hoặc kết luận khi đóng. */
  resolution?: string
  /** Cuộc chat đã mở việc. */
  chatId: string
  /** Plan liên quan: đường dẫn hoặc mã plan. */
  plan?: string
  systems?: string[]
  created: string
  updated: string
  /** Ai đóng việc: mã cuộc chat của agent, hoặc `ui`. */
  closedBy?: string
}

export class OpenItemStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly file: string) {}

  async list(): Promise<OpenItem[]> {
    const text = await readFile(this.file, 'utf8').catch(() => undefined)
    if (!text) return []
    const data = JSON.parse(text) as { items?: OpenItem[] }
    return data.items ?? []
  }

  /** Đọc, sửa, ghi trong một bước của hàng đợi. */
  update<T>(fn: (items: OpenItem[]) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const items = await this.list()
      const result = await fn(items)
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await writeFile(temp, `${JSON.stringify({ items }, null, 2)}\n`)
      await rename(temp, this.file)
      return result
    })
    this.queue = run.catch(() => {})
    return run
  }
}
