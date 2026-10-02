import { describe, expect, it } from 'vitest'
import { interpolate } from '../src/kernel.ts'

describe('interpolate', () => {
  it('replaces env placeholders and infers scalar types for whole-string placeholders', () => {
    process.env.AITEST_T_PORT = '4310'
    expect(interpolate({ port: '${env.AITEST_T_PORT}', missing: '${env.AITEST_T_NONE:-80}' })).toEqual({ port: 4310, missing: 80 })
    expect(interpolate('${env.AITEST_T_NONE:-true}')).toBe(true)
    expect(interpolate('http://h:${env.AITEST_T_PORT}/x')).toBe('http://h:4310/x')
    expect(interpolate('${env.AITEST_T_NONE:-examples/a.db}')).toBe('examples/a.db')
  })
})
