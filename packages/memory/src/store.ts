import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { parseFrontmatter } from '@aitest/core'

/**
 * Kho bộ nhớ dạng file, theo mô hình bộ nhớ của Claude Code: mỗi ký ức là một file Markdown có frontmatter,
 * `MEMORY.md` là mục lục một dòng mỗi ký ức (tự sinh). Mỗi lần sửa, bản cũ được giữ trong `.history/` để hoàn tác.
 */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = typeof MEMORY_TYPES[number]
export type MemoryScope = 'personal' | 'team'

/** Ý nghĩa từng loại, dùng trong hướng dẫn cho agent và trên giao diện. */
export const TYPE_DESC: Record<MemoryType, string> = {
  user: 'người dùng là ai: vai trò, chuyên môn, sở thích làm việc',
  feedback: 'người dùng đã sửa hoặc xác nhận cách làm: làm gì, tránh gì, và vì sao',
  project: 'sự thật về dự án, hệ thống, môi trường mà code và tài liệu không ghi (đổi ngày tương đối thành ngày cụ thể)',
  reference: 'nơi tra cứu bên ngoài: link, dashboard, ticket, người phụ trách',
}

export interface Memory {
  name: string
  description: string
  type: MemoryType
  scope: MemoryScope
  body: string
  version: number
  created: string
  updated: string
  /** Mã cuộc chat đã tạo hoặc sửa gần nhất. */
  source?: string
  /** Ký ức khác được nhắc bằng `[[tên]]` trong nội dung. */
  links: string[]
}

export const NAME = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/

export class MemoryStore {
  constructor(readonly dir: string, readonly scope: MemoryScope) {}

  async list(): Promise<Memory[]> {
    const files = await readdir(this.dir).catch(() => [] as string[])
    const out: Memory[] = []
    for (const file of files.filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')) {
      const memory = await this.get(file.slice(0, -3)).catch(() => undefined)
      if (memory) out.push(memory)
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated))
  }

  async get(name: string): Promise<Memory | undefined> {
    if (!NAME.test(name)) return undefined
    const text = await readFile(join(this.dir, `${name}.md`), 'utf8').catch(() => undefined)
    if (text === undefined) return undefined
    const { meta, body } = parseFrontmatter(text)
    const type = MEMORY_TYPES.includes(meta.type as MemoryType) ? meta.type as MemoryType : 'project'
    return {
      name,
      description: String(meta.description ?? ''),
      type,
      scope: this.scope,
      body: body.trim(),
      version: Number(meta.version ?? 1),
      created: String(meta.created ?? ''),
      updated: String(meta.updated ?? meta.created ?? ''),
      source: meta.source ? String(meta.source) : undefined,
      links: [...new Set([...body.matchAll(/\[\[([a-z0-9-]+)\]\]/g)].map((m) => m[1]))],
    }
  }

  /** Ghi ký ức (tạo mới hoặc thay bản cũ, giữ bản cũ trong lịch sử); dựng lại mục lục. */
  async put(memory: Omit<Memory, 'scope' | 'links'>): Promise<void> {
    await mkdir(join(this.dir, '.history'), { recursive: true })
    const file = join(this.dir, `${memory.name}.md`)
    const previous = await readFile(file, 'utf8').catch(() => undefined)
    if (previous !== undefined) await writeFile(join(this.dir, '.history', `${memory.name}.v${memory.version - 1}.md`), previous)
    const meta = {
      name: memory.name, description: memory.description, type: memory.type,
      version: memory.version, created: memory.created, updated: memory.updated,
      ...(memory.source ? { source: memory.source } : {}),
    }
    // Ghi file tạm rồi đổi tên, để Host dừng giữa chừng không để lại file hỏng.
    const temp = `${file}.tmp`
    await writeFile(temp, `---\n${stringifyYaml(meta).trim()}\n---\n\n${memory.body.trim()}\n`)
    await rename(temp, file)
    await this.writeIndex()
  }

  /** Xoá ký ức; bản cuối được giữ trong lịch sử để khôi phục. */
  async remove(name: string): Promise<Memory | undefined> {
    const memory = await this.get(name)
    if (!memory) return undefined
    await mkdir(join(this.dir, '.history'), { recursive: true })
    await rename(join(this.dir, `${name}.md`), join(this.dir, '.history', `${name}.v${memory.version}.deleted.md`))
    await this.writeIndex()
    return memory
  }

  /** Các bản cũ của một ký ức, mới nhất trước. */
  async history(name: string): Promise<Array<{ version: number; deleted: boolean; text: string }>> {
    const files = await readdir(join(this.dir, '.history')).catch(() => [] as string[])
    const out: Array<{ version: number; deleted: boolean; text: string }> = []
    for (const file of files) {
      const m = new RegExp(`^${name}\\.v(\\d+)(\\.deleted)?\\.md$`).exec(file)
      if (m) out.push({ version: Number(m[1]), deleted: !!m[2], text: await readFile(join(this.dir, '.history', file), 'utf8') })
    }
    return out.sort((a, b) => b.version - a.version || Number(a.deleted) - Number(b.deleted))
  }

  /** Bỏ hẳn lịch sử của một tên (khi ký ức được tạo lại từ đầu). */
  async purgeHistory(name: string) {
    const files = await readdir(join(this.dir, '.history')).catch(() => [] as string[])
    for (const file of files) if (file.startsWith(`${name}.v`)) await rm(join(this.dir, '.history', file), { force: true })
  }

  /** `MEMORY.md`: mục lục một dòng mỗi ký ức, nhóm theo loại; để người đọc nhanh và để git hiện thay đổi gọn. */
  async writeIndex() {
    const all = await this.list()
    const lines = ['# Bộ nhớ', '', `<!-- Tự sinh từ các file trong thư mục này (${this.scope}); sửa từng file ký ức, không sửa file này. -->`, '']
    for (const type of MEMORY_TYPES) {
      const items = all.filter((m) => m.type === type)
      if (!items.length) continue
      lines.push(`## ${type}`, ...items.map((m) => `- [${m.name}](${m.name}.md) — ${m.description}`), '')
    }
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, 'MEMORY.md'), lines.join('\n'))
  }
}

/** Giá trị trông như bí mật: không được lưu vào bộ nhớ. */
export function findSecret(text: string): string | undefined {
  const rules: Array<[RegExp, string]> = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
    [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/, 'AWS access key'],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
    [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, 'bearer token'],
    [/\w+:\/\/[^\s/:@]+:[^\s/@]+@/, 'URL with password'],
    [/\b(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i, 'credential assignment'],
  ]
  return rules.find(([re]) => re.test(text))?.[1]
}

/** Độ giống nhau của hai ký ức theo từ (tên, mô tả), để phát hiện ghi trùng. */
export function similarity(a: { name: string; description: string }, b: { name: string; description: string }): number {
  const words = (m: { name: string; description: string }) => new Set(`${m.name.replace(/-/g, ' ')} ${m.description}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))
  const x = words(a)
  const y = words(b)
  if (!x.size || !y.size) return 0
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / Math.min(x.size, y.size)
}
