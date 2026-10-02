import { describe, expect, it } from 'vitest'
import { parseJson } from '@aitest/action-http'

describe('lossless JSON from HTTP responses', () => {
  it('keeps numbers that would lose digits as strings', () => {
    expect(parseJson('{"a": 1.5, "b": 70000, "c": 12345678901234567.89, "d": 0.1234567890123456789, "e": "x"}')).toEqual({
      a: 1.5, b: 70000, c: '12345678901234567.89', d: '0.1234567890123456789', e: 'x',
    })
    expect(parseJson('[1, 2.50, true, null]')).toEqual([1, 2.5, true, null])
  })
})
