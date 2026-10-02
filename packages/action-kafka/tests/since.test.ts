import { describe, expect, it } from 'vitest'
import { parseSince } from '@aitest/action-kafka'

describe('parseSince', () => {
  it('parses relative, absolute and start markers', () => {
    const now = Date.now()
    expect(Math.abs((parseSince('-2m') as number) - (now - 120_000))).toBeLessThan(1000)
    expect(Math.abs((parseSince('-30s') as number) - (now - 30_000))).toBeLessThan(1000)
    expect(parseSince('start')).toBe('earliest')
    expect(parseSince('2026-10-02T00:00:00Z')).toBe(Date.parse('2026-10-02T00:00:00Z'))
    expect(parseSince('1790000000000')).toBe(1790000000000)
    expect(() => parseSince('yesterday')).toThrow(/invalid since/)
  })
})
