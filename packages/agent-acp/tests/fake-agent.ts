/**
 * Agent ACP giả cho kiểm thử: gửi `tool_call` có tên tool và server như Codex, rồi xin phép chỉ với `toolCallId`;
 * trả lời bằng tin nhắn ghi lựa chọn mà client đã chọn.
 */
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>)
new acp.AgentSideConnection((conn) => ({
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: true } } }
  },
  async newSession() {
    return { sessionId: 'fake-1' }
  },
  async authenticate() {
    return {}
  },
  async prompt(params) {
    const toolCallId = 'exec-1'
    await conn.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call', toolCallId, title: 'mcp.aitest.http_request', kind: 'execute', status: 'in_progress',
        rawInput: { server: 'aitest', tool: 'http_request', arguments: { method: 'GET' } },
      },
    })
    const answer = await conn.requestPermission({
      sessionId: params.sessionId,
      toolCall: { toolCallId, kind: 'execute', status: 'pending' },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
    })
    const choice = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled'
    await conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `choice=${choice}` } } })
    return { stopReason: 'end_turn' }
  },
  async cancel() {},
}), stream)
