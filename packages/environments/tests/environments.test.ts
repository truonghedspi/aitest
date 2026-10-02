/**
 * Kiểm thử môi trường: hai Order API thật, mỗi môi trường một API và một DB.
 * Hai lượt chạy song song trên hai môi trường phải kết nối đúng hệ thống của mình.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { merge } from '@aitest/environments'
import { promptVars, root, setupHarness, type Harness, type Script } from '../../runner/tests/support.ts'

const PORT = 4184
const OTHER_PORT = 4183
const BASE = `http://127.0.0.1:${PORT}`
const OTHER = `http://127.0.0.1:${OTHER_PORT}`

const PLAN = (extra = '') => `id: TP-ENV
name: Theo môi trường
requires: [http, db]
${extra}
vars:
  base_url: ${BASE}
cases:
  - id: ENV-01
    title: Đọc lệnh của môi trường
    steps: ["Gọi GET {{base_url}}/orders; đếm lệnh trong DB (môi trường {{$env}})."]
    expect:
      - { id: http-200, desc: API trả 200, check: { op: eq, value: 200 } }
`

/** Kết quả mỗi lượt chạy ghi theo môi trường thấy trong prompt. */
const seen: Record<string, { base: string; symbols: string[]; count: number }> = {}

const scripts: Record<string, Script> = {
  async 'ENV-01'(call, prompt) {
    const vars = promptVars(prompt)
    const res = await call('http_request', { method: 'GET', url: `${vars.base_url}/orders` })
    const count = await call('db_query', { sql: 'SELECT COUNT(*) AS n FROM orders' })
    seen[vars.$env] = { base: vars.base_url, symbols: res.result.body.map((o: any) => o.symbol), count: count.result.rows[0].n }
    await call('assert_expectation', { expectId: 'http-200', evidenceId: res.evidenceId, path: '$.status' })
  },
}

describe('environments', () => {
  let harness: Harness
  let other: ChildProcess
  let dir: string
  const plan = async (name: string, extra = '') => {
    const file = join(dir, `${name}.plan.yaml`)
    await writeFile(file, PLAN(extra))
    return file
  }

  beforeAll(async () => {
    harness = await setupHarness({
      port: PORT,
      scripts,
      rows: (tmp) => [{ id: 'envs', name: '@aitest/environments', config: { dir: join(tmp, 'envs'), default: 'local' } }],
    })
    dir = harness.dir
    harness.kernel.ctx.runner.config.agent = 'scripted'
    // Môi trường thứ hai: Order API và DB riêng.
    const otherDb = join(dir, 'other.db')
    other = spawn(process.execPath, ['--import', 'tsx', '--disable-warning=ExperimentalWarning', join(root, 'examples/order-api/server.ts')], {
      env: { ...process.env, ORDER_API_PORT: String(OTHER_PORT), ORDER_DB: otherDb, KAFKA_BROKERS: '', RABBITMQ_URL: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    await new Promise<void>((done) => other.stdout!.once('data', () => done()))
    await fetch(`${OTHER}/orders`, { method: 'POST', body: JSON.stringify({ symbol: 'OTH', side: 'BUY', qty: 100, price: 1000 }) })
    await mkdir(join(dir, 'envs'), { recursive: true })
    await writeFile(join(dir, 'envs/other.yml'), [
      'label: Môi trường khác',
      'tools:',
      `  action-db: { config: { file: '${otherDb.replace(/\\/g, '/')}' } }`,
      'vars:',
      `  base_url: ${OTHER}`,
    ].join('\n'))
    await writeFile(join(dir, 'envs/ro.yml'), 'policy: { readOnly: true }\ntools:\n  action-dbadmin: { enabled: false }\n')
  }, 60_000)

  afterAll(async () => {
    other?.kill()
    await harness?.dispose()
  })

  it('runs the same plan on two environments in parallel, each against its own systems', async () => {
    await fetch(`${BASE}/orders`, { method: 'POST', body: JSON.stringify({ symbol: 'LOC', side: 'BUY', qty: 100, price: 1000 }) })
    const file = await plan('both')
    const [local, otherRun] = await Promise.all([
      harness.kernel.ctx.runner.run({ plan: file, agent: 'scripted' }),
      harness.kernel.ctx.runner.run({ plan: file, agent: 'scripted', env: 'other' }),
    ])
    expect([local.env, local.cases[0].verdict, otherRun.env, otherRun.cases[0].verdict]).toEqual(['local', 'pass', 'other', 'pass'])
    // Biến của môi trường ghi đè biến cùng tên trong plan; db_query của môi trường dùng DB riêng.
    expect(seen.local).toMatchObject({ base: BASE, count: 1 })
    expect(seen.local.symbols).toEqual(['LOC'])
    expect(seen.other).toMatchObject({ base: OTHER, symbols: ['OTH'], count: 1 })
    expect(harness.kernel.rows.get('action-db@other')).toMatchObject({ layer: 'env' })
    expect(harness.kernel.ctx.actions.envsOf('db_query')).toEqual(['other'])
  })

  it('blocks writes on a read-only environment and hides tools it disables', async () => {
    const file = await plan('ro', [
      'setup:',
      '  - action: http_request',
      `    args: { method: POST, url: '${BASE}/orders', body: { symbol: ROX, side: BUY, qty: 100, price: 1 } }`,
    ].join('\n'))
    const report = await harness.kernel.ctx.runner.run({ plan: file, agent: 'scripted', env: 'ro' })
    expect(report.cases[0].verdict).toBe('error')
    expect(report.cases[0].reasons[0]).toContain('environment ro is read-only')
    const names = (env?: string) => harness.kernel.ctx.actions.list({ kind: 'case', namespaces: new Set(), phase: 'setup', env }).map((a) => a.name)
    expect(names('ro')).not.toContain('dbadmin_query')
    expect(names()).toContain('dbadmin_query')
  })

  it('blocks a run on an environment the plan does not allow, or that does not exist', async () => {
    const limited = await harness.kernel.ctx.runner.run({ plan: await plan('limited', 'envs: [other]'), agent: 'scripted' })
    expect(limited.cases[0].verdict).toBe('blocked')
    expect(limited.blocked).toEqual(['plan TP-ENV is limited to environments other; not local'])
    const missing = await harness.kernel.ctx.runner.run({ plan: await plan('missing'), agent: 'scripted', env: 'nope' })
    expect(missing.blocked).toEqual(['environment nope: environment nope not found'])
  })

  it('reloads environment tools when the file changes', async () => {
    await writeFile(join(dir, 'envs/other.yml'), `vars:\n  base_url: ${OTHER}\n`)
    await harness.kernel.ctx.envs.ensure('other')
    expect(harness.kernel.rows.has('action-db@other')).toBe(false)
    expect(harness.kernel.ctx.actions.envsOf('db_query')).toEqual([])
  })

  it('lists environments and checks plan envs when authoring', async () => {
    const list = await harness.kernel.ctx.envs.list()
    expect(list.map((e) => [e.name, e.default, e.readOnly])).toEqual([['local', true, false], ['other', false, false], ['ro', false, true]])
    const result = await harness.kernel.ctx.authoring.validate(PLAN('envs: [other, prod]'))
    expect(result.issues.filter((i) => i.level === 'error').map((i) => i.message)).toEqual(['unknown environment prod; known: other, ro, local'])
  })

  it('merges objects deeply and replaces other values', () => {
    expect(merge({ a: 1, sasl: { mechanism: 'plain', username: 'u' }, brokers: ['x'] }, { sasl: { username: 'v' }, brokers: ['y', 'z'] }))
      .toEqual({ a: 1, sasl: { mechanism: 'plain', username: 'v' }, brokers: ['y', 'z'] })
  })
})
