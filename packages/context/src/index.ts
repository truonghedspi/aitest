import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {} from '@aitest/authoring'
import { errorMessage, isInside, parseFrontmatter, Service, summarizeMarkdown, toPosix, z, type Context } from '@aitest/core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    library: ContextLibrary
  }
}

/**
 * Thư viện ngữ cảnh cho agent soạn plan, theo hai chuẩn phổ biến:
 *
 * - **Thư mục ngữ cảnh** (`context/`): tài liệu bất kỳ (Markdown, OpenAPI, SQL, CSV…). Agent thấy một mục lục gọn
 *   (đường dẫn, tiêu đề, mô tả, hệ thống liên quan) rồi đọc từng tài liệu khi cần (just-in-time). Frontmatter
 *   `inclusion: always` đưa tài liệu vào thẳng hướng dẫn, như steering `always` của Kiro.
 * - **Skill** (`skills/<tên>/SKILL.md`, chuẩn Agent Skills): hướng dẫn cách làm một loại việc, nạp theo ba tầng
 *   (progressive disclosure): tên và mô tả luôn có trong hướng dẫn; thân SKILL.md nạp bằng `use_skill`;
 *   file kèm theo (ví dụ plan mẫu) đọc bằng `read_skill_file`. Script trong skill không được chạy.
 */
export interface Config {
  dirs: string[]
  skillDirs: string[]
  alwaysMaxChars: number
}

export interface ContextDocInfo {
  /** Đường dẫn tương đối với thư mục làm việc, dạng `/`. */
  id: string
  title: string
  description?: string
  systems: string[]
  features: string[]
  inclusion: 'always' | 'auto'
  size: number
}

export interface SkillInfo {
  name: string
  description: string
  /** Thư mục skill, tương đối với thư mục làm việc. */
  path: string
  systems: string[]
  features: string[]
  /** File kèm theo (tương đối với thư mục skill), trừ SKILL.md. */
  files: string[]
}

export interface LibraryIssue {
  path: string
  error: string
}

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.yaml', '.yml', '.json', '.sql', '.csv', '.tsv', '.feature', '.graphql', '.proto', '.xml', '.html', '.ts', '.js', '.java', '.py'])
const MAX_FILE_BYTES = 2_000_000
/** Độ dài tối đa của một skill nạp theo lời gọi `/tên-skill`. */
const MAX_INVOKED_CHARS = 20_000
const MAX_FILES = 2000
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export class ContextLibrary extends Service {
  static inject = ['authoring']
  static Config = z.object({
    dirs: z.array(z.string()).default(['context']).description('Thư mục ngữ cảnh, tương đối với thư mục làm việc; mỗi file văn bản là một tài liệu.'),
    skillDirs: z.array(z.string()).default(['skills']).description('Thư mục chứa skill, mỗi skill là `<tên>/SKILL.md` theo chuẩn Agent Skills.'),
    alwaysMaxChars: z.natural().default(12000).description('Tổng độ dài tối đa của tài liệu `inclusion: always` đưa vào hướng dẫn.'),
  })

  /** Kết quả đọc theo đường dẫn và thời điểm sửa file, để không đọc lại file không đổi. */
  private readonly cache = new Map<string, { mtime: number; doc?: ContextDocInfo; error?: string }>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'library')

    ctx.authoring.registerContextSource({
      id: 'context',
      title: 'Thư mục ngữ cảnh',
      description: `Tài liệu trong ${config.dirs.join(', ')}; mỗi tài liệu có mô tả và hệ thống liên quan.`,
      list: async () => (await this.docs()).docs.map((d) => ({
        id: d.id, title: d.title, size: d.size,
        ...(d.description ? { description: d.description } : {}),
        ...(d.systems.length ? { systems: d.systems } : {}),
      })),
      read: (id) => this.readDoc(id),
    })

    ctx.authoring.guideSection({
      id: 'context/skills',
      order: 12,
      render: () => this.guide(),
    })
    // Người dùng gọi skill chủ động bằng `/tên-skill` ở đầu tin nhắn: nạp nội dung skill vào chính lượt đó.
    ctx.authoring.turnSection({ id: 'context/skill-invoke', order: 15, render: (turn) => this.invocation(turn.text) })
  }

  /**
   * Skill người dùng gọi ở đầu tin nhắn, như lệnh `/` của Claude Code và Kiro: `/api-input-validation soạn case cho qty`.
   * Gọi được nhiều skill liên tiếp (`/a /b …`). Tên không phải skill thì bỏ qua (có thể là đường dẫn API).
   */
  async invokedSkills(text: string): Promise<string[]> {
    const names: string[] = []
    let rest = text.trimStart()
    for (let m = /^\/([a-z0-9][a-z0-9-]*)(?=\s|$)/.exec(rest); m; m = /^\/([a-z0-9][a-z0-9-]*)(?=\s|$)/.exec(rest)) {
      names.push(m[1])
      rest = rest.slice(m[0].length).trimStart()
    }
    if (!names.length) return []
    const { skills } = await this.skills()
    return [...new Set(names)].filter((n) => skills.some((s) => s.name === n))
  }

  /** Nội dung các skill người dùng gọi, đặt trước tin nhắn của lượt đó. */
  async invocation(text: string): Promise<string | undefined> {
    const names = await this.invokedSkills(text)
    if (!names.length) return undefined
    const blocks: string[] = []
    for (const name of names) {
      const { skill, body } = await this.skillBody(name)
      const shown = body.length > MAX_INVOKED_CHARS ? `${body.slice(0, MAX_INVOKED_CHARS)}\n…(còn tiếp; đọc phần còn lại bằng \`use_skill\`)` : body
      blocks.push([
        `## Skill người dùng chọn: \`${skill.name}\``,
        `Người dùng gọi skill này cho tin nhắn dưới đây; làm theo hướng dẫn của skill, không cần gọi \`use_skill\` lại.`,
        ...(skill.files.length ? [`File kèm theo (đọc bằng \`read_skill_file\`): ${skill.files.map((f) => `\`${f}\``).join(', ')}`] : []),
        '',
        shown,
      ].join('\n'))
    }
    return blocks.join('\n\n')
  }

  /** Phần hướng dẫn: danh sách skill (tầng 1) và tài liệu `inclusion: always`. Đọc lại thư mục mỗi lần. */
  async guide() {
    const [{ skills }, { docs }] = await Promise.all([this.skills(), this.docs()])
    const parts: string[] = []
    if (skills.length) {
      parts.push(
        '## Skill',
        'Skill là hướng dẫn cách làm một loại việc. Khi yêu cầu khớp mô tả của skill, gọi `use_skill` để nạp hướng dẫn đầy đủ trước khi soạn,',
        'rồi đọc file kèm theo (ví dụ plan mẫu) bằng `read_skill_file` khi cần. Người dùng có thể gọi skill bằng `/tên-skill`; khi đó nội dung skill có sẵn trong tin nhắn.',
        ...skills.map((s) => `- \`${s.name}\`: ${s.description}`),
      )
    }
    const always = docs.filter((d) => d.inclusion === 'always')
    if (always.length) {
      let budget = this.config.alwaysMaxChars
      const blocks: string[] = []
      for (const doc of always) {
        const { body } = parseFrontmatter(await this.readDoc(doc.id).catch(() => ''))
        if (budget <= 0) { blocks.push(`(${doc.id}: vượt giới hạn, đọc bằng read_context_source)`); continue }
        const text = body.trim().slice(0, budget)
        budget -= text.length
        blocks.push(`### ${doc.title} (\`${doc.id}\`)\n\n${text}`)
      }
      parts.push('## Ngữ cảnh luôn áp dụng', ...blocks)
    }
    return parts.join('\n') || undefined
  }

  /** Mục lục tài liệu trong các thư mục ngữ cảnh. */
  async docs(): Promise<{ docs: ContextDocInfo[]; issues: LibraryIssue[] }> {
    const docs: ContextDocInfo[] = []
    const issues: LibraryIssue[] = []
    for (const dir of this.config.dirs) {
      for (const file of await walk(resolve(dir))) {
        const id = toPosix(relative(process.cwd(), file))
        const info = await stat(file).catch(() => undefined)
        if (!info) continue
        let entry = this.cache.get(file)
        if (!entry || entry.mtime !== info.mtimeMs) {
          entry = { mtime: info.mtimeMs }
          try {
            entry.doc = await describeDoc(file, id, info.size)
          } catch (error) {
            entry.error = errorMessage(error).split('\n')[0]
          }
          this.cache.set(file, entry)
        }
        if (entry.doc) docs.push(entry.doc)
        if (entry.error) issues.push({ path: id, error: entry.error })
      }
    }
    return { docs, issues }
  }

  /** Đọc nguyên văn một tài liệu theo `id` (đường dẫn trong mục lục); chặn đường dẫn ra ngoài thư mục ngữ cảnh. */
  async readDoc(id: string): Promise<string> {
    const file = resolve(id)
    if (!this.config.dirs.some((d) => isInside(resolve(d), file))) throw new Error(`document ${id} is not in the context folders`)
    return readFile(file, 'utf8')
  }

  /** Mọi skill hợp lệ trong các thư mục skill; skill lỗi (thiếu tên, mô tả) được báo trong `issues`. */
  async skills(): Promise<{ skills: SkillInfo[]; issues: LibraryIssue[] }> {
    const skills: SkillInfo[] = []
    const issues: LibraryIssue[] = []
    for (const dir of this.config.skillDirs) {
      const root = resolve(dir)
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const folder = join(root, entry.name)
        const path = toPosix(relative(process.cwd(), folder))
        const text = await readFile(join(folder, 'SKILL.md'), 'utf8').catch(() => undefined)
        if (text === undefined) continue
        try {
          const { meta } = parseFrontmatter(text)
          const name = String(meta.name ?? '')
          const description = String(meta.description ?? '').trim()
          if (!SKILL_NAME.test(name)) throw new Error('name must be lowercase letters, digits and hyphens (max 64)')
          if (name !== entry.name) throw new Error(`name ${name} must match the folder name ${entry.name}`)
          if (!description) throw new Error('description is required')
          if (description.length > 1024) throw new Error('description must be at most 1024 characters')
          if (skills.some((s) => s.name === name)) throw new Error(`duplicate skill ${name}`)
          const metadata = (meta.metadata ?? {}) as Record<string, unknown>
          skills.push({
            name, description, path,
            systems: list(meta.systems ?? metadata.systems),
            features: list(meta.features ?? metadata.features),
            files: (await walk(folder, 200)).map((f) => toPosix(relative(folder, f))).filter((f) => f !== 'SKILL.md'),
          })
        } catch (error) {
          issues.push({ path: `${path}/SKILL.md`, error: errorMessage(error).split('\n')[0] })
        }
      }
    }
    return { skills, issues }
  }

  /** Thân SKILL.md (bỏ frontmatter) của một skill. */
  async skillBody(name: string): Promise<{ skill: SkillInfo; body: string }> {
    const skill = await this.skill(name)
    const { body } = parseFrontmatter(await readFile(resolve(skill.path, 'SKILL.md'), 'utf8'))
    return { skill, body: body.trim() }
  }

  /** Một file kèm theo của skill; chặn đường dẫn ra ngoài thư mục skill. */
  async skillFile(name: string, path: string): Promise<string> {
    const skill = await this.skill(name)
    const folder = resolve(skill.path)
    const file = resolve(folder, path)
    if (!isInside(folder, file) || file === folder) throw new Error(`path ${path} is outside skill ${name}`)
    return readFile(file, 'utf8').catch(() => {
      throw new Error(`skill ${name} has no file ${path}; files: ${skill.files.join(', ') || 'none'}`)
    })
  }

  private async skill(name: string) {
    const { skills } = await this.skills()
    const skill = skills.find((s) => s.name === name)
    if (!skill) throw new Error(`unknown skill ${name}; available: ${skills.map((s) => s.name).join(', ') || 'none'}`)
    return skill
  }

  /** Tài liệu và skill gắn với một hệ thống (theo `systems` trong frontmatter), cho gói ngữ cảnh của hệ thống. */
  async relatedTo(system: string) {
    const [{ docs }, { skills }] = await Promise.all([this.docs(), this.skills()])
    return {
      docs: docs.filter((d) => d.systems.includes(system)),
      skills: skills.filter((s) => s.systems.includes(system)),
    }
  }
}

export default ContextLibrary

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

/** File văn bản trong thư mục (đệ quy), bỏ file và thư mục ẩn, `node_modules`. */
async function walk(dir: string, limit = MAX_FILES): Promise<string[]> {
  const out: string[] = []
  const visit = async (current: string) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(full)
    }
  }
  await visit(dir)
  return out
}

/** Tiêu đề, mô tả, hệ thống liên quan của một tài liệu: từ frontmatter, rồi từ nội dung (heading, `info` của OpenAPI). */
async function describeDoc(file: string, id: string, size: number): Promise<ContextDocInfo> {
  const ext = extname(file).toLowerCase()
  const name = basename(file)
  if (size > MAX_FILE_BYTES) {
    return { id, title: name, description: `File lớn (${Math.round(size / 1024)} KB), đọc theo đoạn`, systems: [], features: [], inclusion: 'auto', size }
  }
  const text = await readFile(file, 'utf8')
  let meta: Record<string, unknown> = {}
  let title: string | undefined
  let description: string | undefined
  if (ext === '.md' || ext === '.markdown') {
    const parsed = parseFrontmatter(text)
    meta = parsed.meta
    ;({ title, description } = summarizeMarkdown(parsed.body))
  } else if (ext === '.yaml' || ext === '.yml' || ext === '.json') {
    try {
      const data = (ext === '.json' ? JSON.parse(text) : parseYaml(text)) as Record<string, any> | null
      const info = data?.info ?? data
      title = typeof info?.title === 'string' ? info.title : undefined
      description = typeof info?.description === 'string' ? info.description.split('\n')[0].slice(0, 200) : undefined
      if (data?.openapi || data?.swagger) description = `OpenAPI ${data.openapi ?? data.swagger}${description ? `: ${description}` : ''}`
      if (data?.asyncapi) description = `AsyncAPI ${data.asyncapi}${description ? `: ${description}` : ''}`
    } catch {
      // Không phải YAML/JSON hợp lệ: vẫn là tài liệu văn bản.
    }
  }
  const inclusion = meta.inclusion === 'always' ? 'always' : 'auto'
  return {
    id,
    title: typeof meta.title === 'string' ? meta.title : title ?? name,
    description: typeof meta.description === 'string' ? meta.description : description,
    systems: list(meta.systems),
    features: list(meta.features),
    inclusion,
    size,
  }
}
