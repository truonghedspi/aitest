import { parse as parseYaml } from 'yaml'

/**
 * Tách frontmatter YAML (`---` ở đầu file) khỏi nội dung Markdown; chấp nhận CRLF.
 * Không có frontmatter thì `meta` rỗng. Frontmatter sai cú pháp thì ném lỗi kèm vị trí.
 */
export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = parseYaml(match[1]) ?? {}
  if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('frontmatter must be a YAML mapping')
  return { meta: meta as Record<string, unknown>, body: text.slice(match[0].length) }
}

/** Tiêu đề và mô tả tự suy từ Markdown: heading đầu tiên, đoạn văn đầu tiên (rút gọn). */
export function summarizeMarkdown(body: string, max = 200): { title?: string; description?: string } {
  const lines = body.split(/\r?\n/)
  const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l))?.replace(/^#+\s+/, '').trim()
  let paragraph = ''
  for (const line of lines) {
    const t = line.trim()
    if (!t) { if (paragraph) break; continue }
    if (/^(#|```|\||[-*] |>|<!--)/.test(t)) { if (paragraph) break; continue }
    paragraph += (paragraph ? ' ' : '') + t
  }
  const description = paragraph ? (paragraph.length > max ? `${paragraph.slice(0, max - 1)}…` : paragraph) : undefined
  return { title: heading, description }
}
