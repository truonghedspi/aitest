import { describe, expect, it } from 'vitest'
import { isInside, toPosix } from '../src/paths.ts'

describe('cross-platform helpers', () => {
  it('isInside rejects parent escapes and accepts nested files', () => {
    expect(isInside('/a/plans', '/a/plans/order/x.plan.yaml')).toBe(true)
    expect(isInside('/a/plans', '/a/plans')).toBe(true)
    expect(isInside('/a/plans', '/a/plans/../secret')).toBe(false)
    expect(isInside('/a/plans', '/a/plans-other/x')).toBe(false)
    expect(isInside('/a/plans', '/etc/passwd')).toBe(false)
  })

  it('toPosix keeps forward slashes', () => {
    expect(toPosix('examples/plugins/a.ts')).toBe('examples/plugins/a.ts')
  })

})
