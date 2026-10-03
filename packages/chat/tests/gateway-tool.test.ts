/** Nhận diện tool của gateway trong yêu cầu xin phép theo cách đặt tên của Kiro và Codex. */
import { describe, expect, it } from 'vitest'
import { gatewayTool } from '@aitest/chat'

describe('gatewayTool', () => {
  it('reads Kiro and Codex tool names and ignores other servers and agent tools', () => {
    expect(gatewayTool('Running: @aitest/validate_plan', {}, 'aitest')).toBe('validate_plan')
    expect(gatewayTool('Running: @other/validate_plan', {}, 'aitest')).toBeUndefined()
    expect(gatewayTool('mcp.aitest.save_plan', {}, 'aitest')).toBe('save_plan')
    expect(gatewayTool('mcp.github.create_issue', {}, 'aitest')).toBeUndefined()
    expect(gatewayTool('', { rawInput: { server: 'aitest', tool: 'dry_run', arguments: {} } }, 'aitest')).toBe('dry_run')
    expect(gatewayTool('', { rawInput: { command: 'rm -rf /tmp/x' } }, 'aitest')).toBeUndefined()
    expect(gatewayTool('Write file', {}, 'aitest')).toBeUndefined()
  })
})
