import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

/** Hiển thị Markdown của agent; HTML được làm sạch trước khi đưa vào trang. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string), [text])
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
}
