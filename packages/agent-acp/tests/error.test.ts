/** Kiểm thử gộp lý do thật trong `data` của lỗi JSON-RPC từ agent vào thông báo lỗi. */
import { describe, expect, it } from 'vitest'
import { describeAcpError } from '@aitest/agent-acp'

describe('describeAcpError', () => {
  it('appends the detail that agents put in data', () => {
    const quota = Object.assign(new Error('Internal error'), { code: -32603, data: 'The monthly usage limit has been reached' })
    expect(describeAcpError(quota).message).toBe('Internal error: The monthly usage limit has been reached')
    expect(describeAcpError({ code: -32603, data: { message: 'token expired' } }).message).toBe('agent error -32603: token expired')
  })

  it('keeps errors without detail unchanged', () => {
    const plain = new Error('process exited')
    expect(describeAcpError(plain)).toBe(plain)
    expect(describeAcpError('boom').message).toBe('boom')
    expect(describeAcpError(Object.assign(new Error('bad: x'), { data: 'x' })).message).toBe('bad: x')
  })
})
