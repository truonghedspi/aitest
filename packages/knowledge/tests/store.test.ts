import { describe, expect, it } from 'vitest'
import { parseNote } from '../src/store.ts'

describe('note store', () => {
  it('parses knowledge notes saved with CRLF line endings and a BOM', () => {
    const note = parseNote('\uFEFF---\r\nid: x\r\ntype: lesson\r\ntitle: T\r\n---\r\n\r\nNội dung.\r\n', 'lesson', 'x')
    expect(note).toMatchObject({ id: 'x', title: 'T', body: 'Nội dung.' })
  })
})
