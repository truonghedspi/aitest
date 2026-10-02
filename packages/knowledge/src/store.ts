import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Loại ghi chú: lỗi đã biết, quy ước của nhóm, bài học. */
export type NoteType = 'bug' | 'convention' | 'lesson'
export const NOTE_TYPES: NoteType[] = ['bug', 'convention', 'lesson']

export interface Note {
  id: string
  type: NoteType
  title: string
  /** Chỉ dùng cho `bug`: `open` khi còn lỗi, `fixed` khi đã sửa. */
  status?: 'open' | 'fixed'
  feature?: string
  /** Case liên quan, dạng `<mã plan>/<mã case>`. Dùng để đánh dấu lỗi đã biết trong báo cáo. */
  cases?: string[]
  /** Nguồn gốc ghi chú, ví dụ `chat:<mã>`, `run:<mã>`, `user`. */
  source?: string
  created?: string
  updated?: string
  body: string
  /** Đường dẫn file, tương đối với thư mục làm việc. */
  path?: string
}

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/

/**
 * Kho ghi chú dạng file: mỗi ghi chú là `<dir>/<type>/<id>.md` gồm frontmatter YAML và nội dung Markdown.
 * File nằm trong git nên được xem lại qua pull request và có lịch sử thay đổi.
 */
export class NoteStore {
  private cache = new Map<string, Note>()

  constructor(readonly dir: string) {}

  /** Ghi chú đã nạp gần nhất; dùng ở nơi cần đồng bộ như hướng dẫn cho agent. */
  cached() {
    return [...this.cache.values()]
  }

  /** Đọc lại toàn bộ thư mục, để thấy cả ghi chú sửa trực tiếp trong file. */
  async load(): Promise<Note[]> {
    const next = new Map<string, Note>()
    for (const type of NOTE_TYPES) {
      const folder = join(this.dir, type)
      for (const file of await readdir(folder).catch(() => [] as string[])) {
        if (!file.endsWith('.md')) continue
        const path = join(folder, file)
        const note = parseNote(await readFile(path, 'utf8'), type, file.slice(0, -3))
        next.set(note.id, { ...note, path: relative(process.cwd(), path) })
      }
    }
    this.cache = next
    return this.cached()
  }

  async get(id: string) {
    await this.load()
    return this.cache.get(id)
  }

  /** Tạo hoặc cập nhật ghi chú. Trường không truyền giữ giá trị cũ; đổi `type` thì file được chuyển thư mục. */
  async save(input: Partial<Note> & { id: string }): Promise<{ note: Note; created: boolean }> {
    if (!ID.test(input.id)) throw new Error(`invalid note id ${input.id}: use lowercase letters, digits and dashes`)
    const existing = await this.get(input.id)
    const today = new Date().toISOString().slice(0, 10)
    const note: Note = {
      ...existing,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      id: input.id,
      type: (input.type ?? existing?.type) as NoteType,
      title: (input.title ?? existing?.title ?? '').trim(),
      body: (input.body ?? existing?.body ?? '').trim(),
      created: existing?.created ?? today,
      updated: today,
    }
    if (!NOTE_TYPES.includes(note.type)) throw new Error(`invalid note type ${note.type}; use ${NOTE_TYPES.join(', ')}`)
    if (!note.title) throw new Error('note title is required')
    if (note.type === 'bug') note.status ??= 'open'
    else delete note.status
    if (existing?.path && existing.type !== note.type) await rm(existing.path, { force: true })
    const folder = join(this.dir, note.type)
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${note.id}.md`)
    await writeFile(path, renderNote(note))
    await this.load()
    return { note: this.cache.get(note.id)!, created: !existing }
  }

  async remove(id: string) {
    const note = await this.get(id)
    if (!note?.path) throw new Error(`unknown note: ${id}`)
    await rm(note.path)
    await this.load()
  }
}

export function parseNote(text: string, type: NoteType, fallbackId: string): Note {
  // Chấp nhận cả dòng kết thúc CRLF (file sửa trên Windows).
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ''))
  const meta = (match ? parseYaml(match[1]) : {}) ?? {}
  return {
    ...meta,
    id: String(meta.id ?? fallbackId),
    type: (NOTE_TYPES.includes(meta.type) ? meta.type : type) as NoteType,
    title: String(meta.title ?? fallbackId),
    cases: Array.isArray(meta.cases) ? meta.cases.map(String) : undefined,
    body: (match ? match[2] : text).trim(),
  }
}

function renderNote(note: Note) {
  const { body, path: _path, ...meta } = note
  const ordered = Object.fromEntries(
    ['id', 'type', 'title', 'status', 'feature', 'cases', 'source', 'created', 'updated']
      .filter((k) => (meta as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, (meta as Record<string, unknown>)[k]]),
  )
  return `---\n${stringifyYaml(ordered).trim()}\n---\n\n${body}\n`
}
