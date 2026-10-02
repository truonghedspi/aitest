import { parse as parseYaml } from 'yaml'

/**
 * Đọc cấu hình MCP server mà người dùng dán từ công cụ khác và chuyển thành row `@aitest/action-mcp-proxy`.
 *
 * Định dạng nhận được:
 * - `{ "mcpServers": { tên: {...} } }` (Claude Desktop, Claude Code, Cursor, Kiro, Windsurf);
 * - `{ "servers": {...} }`, `{ "mcp": { "servers": {...} } }` (VS Code);
 * - một server `{ "command": ... }` hoặc `{ "url": ... }`, hoặc đoạn `"tên": { ... }` cắt ra từ file;
 * - JSON có comment, dấu phẩy thừa; YAML.
 * Giá trị bí mật trong `env`, `headers` không bao giờ trả về giao diện nguyên văn.
 */

export interface SecretField {
  key: string
  /** Giá trị đã che, để người dùng nhận ra. */
  masked: string
  /** Tên biến môi trường đề xuất khi thay bằng `${env.TÊN}`. */
  envName: string
  /** Biến môi trường đó đã có trong process của Host. */
  envSet: boolean
  /** Giá trị đã là tham chiếu `${env...}`/`${...}`, không cần xử lý. */
  reference: boolean
}

export interface McpCandidate {
  name: string
  namespace: string
  id: string
  transport: 'stdio' | 'http'
  command?: string
  args: string[]
  url?: string
  env: SecretField[]
  headers: SecretField[]
  disabled: boolean
  warnings: string[]
}

interface RawServer {
  command?: string
  args?: unknown[]
  env?: Record<string, unknown>
  url?: string
  serverUrl?: string
  httpUrl?: string
  type?: string
  transport?: string
  headers?: Record<string, unknown>
  disabled?: boolean
  [key: string]: unknown
}

/** Chọn của người dùng cho một server khi thêm. */
export interface McpSelection {
  name: string
  namespace?: string
  id?: string
  /** Khoá env/header được thay bằng `${env.TÊN}`; mặc định theo `envSet`. */
  useEnv?: Record<string, boolean>
}

const SECRET_KEY = /token|secret|password|passwd|pwd|key|auth|credential|cookie|session/i

export function parseMcpConfig(text: string): Record<string, RawServer> {
  const data = parseLoose(text)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('expected a JSON or YAML object with MCP servers')
  const root = data as Record<string, any>
  const servers = root.mcpServers ?? root.servers ?? root.mcp?.servers ?? root.mcp_servers
  if (servers && typeof servers === 'object') return servers
  if (isServer(root)) return { server: root }
  // Đoạn `"tên": {...}` đã được bọc lại thành object các server.
  if (Object.values(root).length && Object.values(root).every(isServer)) return root
  throw new Error('no MCP server found; paste a config containing "mcpServers" or a server with "command" or "url"')
}

/** Danh sách server kèm namespace, cảnh báo và trường bí mật đã che. */
export function describeServers(servers: Record<string, RawServer>, existing: { ids: Set<string>; namespaces: Set<string> }): McpCandidate[] {
  const used = new Set(existing.namespaces)
  return Object.entries(servers).map(([name, raw]) => {
    let namespace = toNamespace(name)
    for (let n = 2; used.has(namespace); n++) namespace = `${toNamespace(name)}${n}`
    used.add(namespace)
    const url = raw.url ?? raw.serverUrl ?? raw.httpUrl
    const kind = String(raw.type ?? raw.transport ?? (url ? 'http' : 'stdio')).toLowerCase()
    const warnings: string[] = []
    if (kind === 'sse') warnings.push('SSE transport is not supported; the server is added as Streamable HTTP and may fail if it only speaks SSE')
    if (!raw.command && !url) warnings.push('no command or url')
    if (raw.disabled) warnings.push('disabled in the source config')
    const ignored = Object.keys(raw).filter((k) => !['command', 'args', 'env', 'url', 'serverUrl', 'httpUrl', 'type', 'transport', 'headers', 'disabled'].includes(k))
    if (ignored.length) warnings.push(`ignored fields: ${ignored.join(', ')}`)
    const id = `mcp-${namespace}`
    if (existing.ids.has(id)) warnings.push(`row ${id} already exists; choose another namespace`)
    return {
      name,
      namespace,
      id,
      transport: url ? 'http' : 'stdio',
      command: raw.command,
      args: (raw.args ?? []).map(String),
      url,
      env: secretFields(raw.env, namespace, true),
      headers: secretFields(raw.headers, namespace, false),
      disabled: !!raw.disabled,
      warnings,
    }
  })
}

/** Cấu hình row cho một server được chọn; giá trị bí mật được thay bằng `${env.TÊN}` khi người dùng chọn. */
export function buildRow(raw: RawServer, candidate: McpCandidate, selection: McpSelection) {
  const namespace = selection.namespace?.trim() || candidate.namespace
  if (!/^[a-z][a-z0-9]*$/.test(namespace)) throw new Error(`namespace ${namespace} must match ^[a-z][a-z0-9]*$`)
  const resolve = (fields: SecretField[], values: Record<string, unknown> | undefined) => Object.fromEntries(fields.map((f) => {
    const use = selection.useEnv?.[f.key] ?? f.envSet
    return [f.key, f.reference || !use ? toEnvRef(String(values?.[f.key] ?? '')) : `\${env.${f.envName}}`]
  }))
  const config: Record<string, unknown> = { namespace, transport: candidate.transport }
  if (candidate.transport === 'stdio') {
    if (!candidate.command) throw new Error(`${candidate.name}: missing command`)
    config.command = candidate.command
    if (candidate.args.length) config.args = candidate.args.map(toEnvRef)
    if (candidate.env.length) config.env = resolve(candidate.env, raw.env)
  } else {
    config.url = toEnvRef(candidate.url ?? '')
    if (candidate.headers.length) config.headers = resolve(candidate.headers, raw.headers)
  }
  return { id: selection.id?.trim() || `mcp-${namespace}`, config }
}

/** Đổi tham chiếu biến môi trường của công cụ khác (`${TÊN}`, `${env:TÊN}`) sang cú pháp của aitest `${env.TÊN}`. */
export function toEnvRef(text: string) {
  return text.replace(/\$\{(?:env[.:])?([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g, (_, name, fallback) => `\${env.${name}${fallback ?? ''}}`)
}

function secretFields(values: Record<string, unknown> | undefined, namespace: string, isEnv: boolean): SecretField[] {
  return Object.entries(values ?? {}).map(([key, value]) => {
    const text = String(value ?? '')
    const envName = isEnv ? key : `${namespace.toUpperCase()}_${key.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
    return {
      key,
      masked: mask(key, text),
      envName,
      envSet: process.env[envName] !== undefined,
      reference: /^\$\{[^}]+\}$/.test(text.trim()),
    }
  })
}

/** Che giá trị: chỉ hiện nguyên văn giá trị ngắn, không giống bí mật (ví dụ `LOG_LEVEL=debug`). */
function mask(key: string, value: string) {
  if (/^\$\{[^}]+\}$/.test(value.trim())) return value
  if (!SECRET_KEY.test(key) && value.length <= 24 && !/[A-Za-z0-9+/_-]{20,}/.test(value)) return value
  if (value.length <= 4) return '••••'
  return `${value.slice(0, 2)}••••${value.slice(-2)} (${value.length} ký tự)`
}

function toNamespace(name: string) {
  const cleaned = name.toLowerCase().replace(/^@[^/]+\//, '').replace(/(^|[-_.\s/])(mcp|server)(?=$|[-_.\s/])/g, '').replace(/[^a-z0-9]/g, '')
  const ns = /^[a-z]/.test(cleaned) ? cleaned : `mcp${cleaned}`
  return ns.slice(0, 24) || 'mcp'
}

function isServer(value: unknown): value is RawServer {
  return !!value && typeof value === 'object' && ('command' in value || 'url' in value || 'serverUrl' in value || 'httpUrl' in value)
}

/** JSON có comment, dấu phẩy thừa, đoạn `"tên": {...}` không có ngoặc ngoài; nếu không phải JSON thì thử YAML. */
function parseLoose(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('config is empty')
  const cleaned = stripJsonComments(trimmed).replace(/,\s*([}\]])/g, '$1')
  for (const candidate of [cleaned, `{${cleaned.replace(/,\s*$/, '')}}`]) {
    try {
      return JSON.parse(candidate)
    } catch { /* thử cách tiếp theo */ }
  }
  try {
    return parseYaml(trimmed)
  } catch (error) {
    throw new Error(`cannot parse config: ${(error as Error).message.split('\n')[0]}`)
  }
}

/** Bỏ comment `//` và `/* *\/` ngoài chuỗi JSON. */
function stripJsonComments(text: string) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else out += c
  }
  return out
}
