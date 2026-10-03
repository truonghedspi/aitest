/**
 * Yêu cầu xin phép chỉ có `toolCallId` (như Codex): driver ghép tên tool, server và tham số từ update `tool_call` trước đó,
 * để chính sách duyệt của runner và chat nhận diện đúng tool của gateway.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootFromFile } from '@aitest/core'

const root = join(import.meta.dirname, '../../..')

describe('ACP permission requests without a title', () => {
  it('passes the title and input of the earlier tool_call update to onPermission', async () => {
    const kernel = await bootFromFile(join(root, 'aitest.yml'), [
      { id: 'logger', name: 'aitest:noop', disabled: true },
      {
        id: 'agent-fake', name: '@aitest/agent-acp',
        config: { name: 'fake', command: process.execPath, args: ['--import', 'tsx', join(import.meta.dirname, 'fake-agent.ts')] },
      },
    ], { patchFile: false })
    try {
      const requests: Array<{ title: string; raw: any }> = []
      const messages: string[] = []
      const connection = await kernel.ctx.agents.get('fake').connect({ cwd: root })
      const session = await connection.newSession({
        cwd: root, mcpServers: [],
        onUpdate: (u) => { if (u.kind === 'message' && u.text) messages.push(u.text) },
        onPermission: async (request) => { requests.push(request as { title: string; raw: any }); return true },
      })
      await session.prompt('go', new AbortController().signal)
      expect(requests).toHaveLength(1)
      expect(requests[0].title).toBe('mcp.aitest.http_request')
      expect(requests[0].raw).toMatchObject({ toolCallId: 'exec-1', kind: 'execute', rawInput: { server: 'aitest', tool: 'http_request' } })
      expect(messages.join('')).toBe('choice=yes')
      await connection.close()
    } finally {
      await kernel.dispose()
    }
  }, 60_000)
})
