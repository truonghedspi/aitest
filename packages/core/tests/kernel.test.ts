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

  it('resolves nested defaults: the first variable that is set wins', () => {
    process.env.AITEST_T_MODEL = 'claude-haiku-4.5'
    expect(interpolate('${env.AITEST_T_RUN:-${env.AITEST_T_MODEL:-claude-sonnet-5}}')).toBe('claude-haiku-4.5')
    expect(interpolate('${env.AITEST_T_RUN:-${env.AITEST_T_NONE:-claude-sonnet-5}}')).toBe('claude-sonnet-5')
    process.env.AITEST_T_RUN = 'auto'
    expect(interpolate('${env.AITEST_T_RUN:-${env.AITEST_T_MODEL:-claude-sonnet-5}}')).toBe('auto')
    expect(interpolate('${env.AITEST_T_NONE:-${env.AITEST_T_PORT}}')).toBe(4310)
    // Hai placeholder ghép nhau không phải một giá trị đơn: giữ dạng chuỗi.
    expect(interpolate('${env.AITEST_T_PORT}${env.AITEST_T_PORT}')).toBe('43104310')
  })
})
