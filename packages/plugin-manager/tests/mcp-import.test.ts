/**
 * Kiểm thử đọc cấu hình MCP server dán từ công cụ khác: các định dạng, namespace, che bí mật, đổi tham chiếu biến môi trường.
 */
import { describe, expect, it } from 'vitest'
import { buildRow, describeServers, parseMcpConfig, toEnvRef } from '../src/mcp-import.ts'

const none = { ids: new Set<string>(), namespaces: new Set<string>() }

describe('parseMcpConfig', () => {
  it('reads the common config shapes', () => {
    expect(Object.keys(parseMcpConfig('{"mcpServers": {"pg": {"command": "npx"}}}'))).toEqual(['pg'])
    expect(Object.keys(parseMcpConfig('{"servers": {"a": {"url": "http://x/mcp"}}}'))).toEqual(['a'])
    expect(Object.keys(parseMcpConfig('{"mcp": {"servers": {"b": {"command": "uvx"}}}}'))).toEqual(['b'])
    expect(Object.keys(parseMcpConfig('{"command": "node", "args": ["s.js"]}'))).toEqual(['server'])
    // Đoạn cắt ra từ file, có comment và dấu phẩy thừa.
    const fragment = `"github": {
      // token lấy từ biến môi trường
      "command": "docker", "args": ["run", "-i", "ghcr.io/github/github-mcp-server",],
    },`
    expect(parseMcpConfig(fragment).github).toMatchObject({ command: 'docker', args: ['run', '-i', 'ghcr.io/github/github-mcp-server'] })
    expect(Object.keys(parseMcpConfig('mcpServers:\n  fs:\n    command: npx\n'))).toEqual(['fs'])
    expect(() => parseMcpConfig('{"foo": 1}')).toThrow(/no MCP server found/)
    expect(() => parseMcpConfig('   ')).toThrow(/empty/)
  })
})

describe('describeServers and buildRow', () => {
  const raw = parseMcpConfig(JSON.stringify({
    mcpServers: {
      'postgres-mcp': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '${PG_URL}'] },
      github: { command: 'docker', args: ['run'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123', LOG_LEVEL: 'debug' } },
      remote: { type: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'Bearer secret-value-123' }, autoApprove: [] },
      quote: { command: 'node', disabled: true },
    },
  }))

  it('derives namespaces, masks secrets and warns about unsupported fields', () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'set-in-host'
    const list = describeServers(raw, { ids: new Set(['mcp-quote']), namespaces: new Set(['quote']) })
    expect(list.map((c) => [c.name, c.namespace, c.transport])).toEqual([
      ['postgres-mcp', 'postgres', 'stdio'], ['github', 'github', 'stdio'], ['remote', 'remote', 'http'], ['quote', 'quote2', 'stdio'],
    ])
    const github = list.find((c) => c.name === 'github')!
    expect(github.env).toEqual([
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', masked: 'gh••••23 (34 ký tự)', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN', envSet: true, reference: false, secret: true },
      { key: 'LOG_LEVEL', masked: 'debug', envName: 'LOG_LEVEL', envSet: false, reference: false, secret: false },
    ])
    expect(JSON.stringify(list)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(JSON.stringify(list)).not.toContain('secret-value-123')
    const remote = list.find((c) => c.name === 'remote')!
    expect(remote.headers[0]).toMatchObject({ key: 'Authorization', envName: 'REMOTE_AUTHORIZATION', envSet: false })
    expect(remote.warnings).toEqual([expect.stringContaining('SSE'), 'ignored fields: autoApprove'])
    expect(list.find((c) => c.name === 'quote')!.disabled).toBe(true)
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN
  })

  it('builds rows with environment references instead of secrets when chosen', () => {
    const list = describeServers(raw, none)
    const pg = buildRow(raw['postgres-mcp'], list[0], { name: 'postgres-mcp' })
    expect(pg).toEqual({ id: 'mcp-postgres', config: { namespace: 'postgres', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '${env.PG_URL}'] } })
    const github = buildRow(raw.github, list[1], { name: 'github', namespace: 'gh', useEnv: { GITHUB_PERSONAL_ACCESS_TOKEN: true } })
    expect(github).toEqual({
      id: 'mcp-gh',
      config: { namespace: 'gh', transport: 'stdio', command: 'docker', args: ['run'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${env.GITHUB_PERSONAL_ACCESS_TOKEN}', LOG_LEVEL: 'debug' } },
    })
    const remote = buildRow(raw.remote, list[2], { name: 'remote', useEnv: { Authorization: false } })
    expect(remote.config).toEqual({ namespace: 'remote', transport: 'http', url: 'https://example.com/sse', headers: { Authorization: 'Bearer secret-value-123' } })
    expect(() => buildRow(raw.github, list[1], { name: 'github', namespace: 'Bad-NS' })).toThrow(/namespace/)
  })

  it('converts environment references from other tools', () => {
    expect(toEnvRef('${PG_URL}')).toBe('${env.PG_URL}')
    expect(toEnvRef('${env:API_KEY}')).toBe('${env.API_KEY}')
    expect(toEnvRef('x ${env.A:-b} y')).toBe('x ${env.A:-b} y')
  })
})
