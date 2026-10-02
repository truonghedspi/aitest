/**
 * Kiểm thử danh mục tool: dựng cấu hình từ mẫu, ràng buộc tham số bí mật, luồng đề xuất cần người dùng duyệt,
 * row mới ghi vào patch layer và nạp lại được ở lần khởi động sau.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootFromFile, type ConfirmRequest, type Kernel, type PluginRow } from '@aitest/core'
import type { AuthoringSession } from '@aitest/authoring'
import { loadCatalog, redactCredentials, renderTemplate, resolveParams } from '@aitest/tool-catalog'

const root = join(import.meta.dirname, '../../..')

describe('catalog templates', () => {
  it('renders params, keeps types and drops keys without value', async () => {
    const { entries, errors } = await loadCatalog([join(root, 'tool-catalog')])
    expect(errors).toEqual([])
    expect(entries.map((e) => e.id)).toEqual(['browser', 'kafka', 'postgres', 'rabbitmq'])
    const kafka = entries.find((e) => e.id === 'kafka')!
    const values = resolveParams(kafka, { brokers: 'a:9092, b:9092' })
    expect(renderTemplate(kafka.config, values)).toEqual({ namespace: 'kafka', brokers: ['a:9092', 'b:9092'] })
    const sasl = resolveParams(kafka, { brokers: ['a:9092'], ssl: true, saslMechanism: 'plain', saslUsername: 'u', saslPassword: '${env.KAFKA_PASSWORD}' })
    expect(renderTemplate(kafka.config, sasl)).toMatchObject({ ssl: true, sasl: { mechanism: 'plain', username: 'u', password: '${env.KAFKA_PASSWORD}' } })
    expect(renderTemplate({ args: ['-x', 'v={{missing}}', '{{none}}'] }, {})).toEqual({ args: ['-x'] })
  })

  it('rejects secret values, unknown and missing params', async () => {
    const { entries } = await loadCatalog([join(root, 'tool-catalog')])
    const rabbit = entries.find((e) => e.id === 'rabbitmq')!
    expect(() => resolveParams(rabbit, { url: 'amqp://guest:guest@host' })).toThrow(/secret/)
    expect(() => resolveParams(rabbit, { url: '${env.RABBITMQ_URL:-amqp://guest:guest@host}' })).toThrow(/secret/)
    expect(() => resolveParams(rabbit, {})).toThrow(/missing required param url/)
    expect(() => resolveParams(rabbit, { url: '${env.X}', host: 'h' })).toThrow(/unknown params/)
    expect(() => resolveParams(rabbit, { url: '${env.X}', namespace: 'Bad-NS' })).toThrow(/namespace/)
  })

  it('redacts URL credentials copied into free text', () => {
    expect(redactCredentials('kết nối tới amqp://guest:secret@127.0.0.1:5672 và postgres://u@db/x'))
      .toBe('kết nối tới amqp://***@127.0.0.1:5672 và postgres://***@db/x')
    expect(redactCredentials('http://host:8080/path')).toBe('http://host:8080/path')
  })
})

describe('propose_tool', () => {
  let dir: string
  let patchFile: string
  let kernel: Kernel
  let session: AuthoringSession
  /** Quyết định của "người dùng" cho lần duyệt tiếp theo, và các yêu cầu duyệt đã nhận. */
  let decision = true
  const requests: ConfirmRequest[] = []

  const rows = (): PluginRow[] => [
    { id: 'runlog', name: 'aitest:runlog', config: { dir: join(dir, 'runs') } },
    { id: 'logger', name: 'aitest:noop', disabled: true },
    { id: 'reporter-console', name: '@aitest/reporters/console', disabled: true },
    { id: 'authoring', name: '@aitest/authoring', config: { dir: join(dir, 'authoring') } },
    { id: 'tool-catalog', name: '@aitest/tool-catalog', config: { auditDir: join(dir, 'audit') } },
  ]
  const call = (name: string, args: Record<string, unknown> = {}) => kernel.ctx.actions.invoke(session.scope, name, args)

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aitest-catalog-'))
    patchFile = join(dir, 'aitest.patch.yml')
    process.env.AITEST_TEST_RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@127.0.0.1:5672'
    kernel = await bootFromFile(join(root, 'aitest.yml'), rows(), { patchFile })
    session = await kernel.ctx.authoring.createSession({
      confirm: async (request) => { requests.push(request); return decision },
    })
  })

  afterAll(async () => {
    await session?.close()
    await kernel?.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  it('lists catalog entries with their install state', async () => {
    const outcome = await call('list_tool_catalog')
    expect(outcome.status).toBe('ok')
    const entries = (outcome.value as { entries: Array<{ id: string; installed: unknown }> }).entries
    expect(entries.find((e) => e.id === 'kafka')).toMatchObject({ installed: false })
    // aitest.yml có sẵn row `action-pg` (đang tắt) dùng mcp-proxy với namespace pg.
    expect(entries.find((e) => e.id === 'postgres')).toMatchObject({ installed: { rowId: 'action-pg', disabled: true } })
  })

  it('refuses to run without a user to approve, and validates before asking', async () => {
    const headless = { ...session.scope, confirm: undefined }
    const outcome = await kernel.ctx.actions.invoke(headless, 'propose_tool', { catalogId: 'kafka', params: { brokers: ['x:9092'] }, reason: 'r' })
    expect(outcome).toMatchObject({ status: 'error', error: expect.stringContaining('needs a user to approve') })

    const plain = await call('propose_tool', { catalogId: 'rabbitmq', params: { url: 'amqp://guest:secret@host' }, reason: 'r' })
    expect(plain).toMatchObject({ status: 'error', error: expect.stringContaining('secret') })
    const unset = await call('propose_tool', { catalogId: 'rabbitmq', params: { url: '${env.AITEST_UNSET_VAR}' }, reason: 'r' })
    expect(unset).toMatchObject({ status: 'error', error: expect.stringContaining('AITEST_UNSET_VAR') })
    const installed = await call('propose_tool', { catalogId: 'postgres', params: { url: '${env.AITEST_TEST_RABBITMQ_URL}' }, reason: 'r' })
    expect(installed).toMatchObject({ status: 'error', error: expect.stringContaining('already installed as row action-pg') })
    expect(requests).toEqual([])
  })

  it('adds nothing when the user declines', async () => {
    decision = false
    const outcome = await call('propose_tool', { catalogId: 'rabbitmq', params: { url: '${env.AITEST_TEST_RABBITMQ_URL}' }, reason: 'Kiểm tra sự kiện lệnh' })
    expect(outcome).toMatchObject({ status: 'ok', value: { added: false } })
    expect(requests).toHaveLength(1)
    expect(kernel.rows.has('rabbitmq')).toBe(false)
    expect(kernel.ctx.actions.get('rabbitmq_tap')).toBeUndefined()
  })

  it('adds a read-only tool after approval, with the exact config shown to the user', async () => {
    decision = true
    requests.length = 0
    const outcome = await call('propose_tool', { catalogId: 'rabbitmq', params: { url: '${env.AITEST_TEST_RABBITMQ_URL}' }, reason: 'Kiểm tra sự kiện lệnh' })
    expect(outcome.status).toBe('ok')
    expect(requests[0]).toMatchObject({
      tool: 'propose_tool',
      title: 'Thêm tool RabbitMQ',
      preview: {
        kind: 'tool-proposal', rowId: 'rabbitmq', plugin: '@aitest/action-rabbitmq', access: 'read', reason: 'Kiểm tra sự kiện lệnh',
        config: { namespace: 'rabbitmq', url: '${env.AITEST_TEST_RABBITMQ_URL}' },
        tools: { read: ['rabbitmq_tap', 'rabbitmq_wait_for', 'rabbitmq_queue_info'], write: [] },
        env: [{ name: 'AITEST_TEST_RABBITMQ_URL', set: true }],
      },
    })
    // Bản xem trước không chứa giá trị thật của biến môi trường.
    expect(JSON.stringify(requests[0])).not.toContain(process.env.AITEST_TEST_RABBITMQ_URL)
    const value = outcome.value as { added: boolean; tools: Array<{ name: string }> }
    expect(value.added).toBe(true)
    expect(value.tools.map((t) => t.name).sort()).toEqual(['rabbitmq_queue_info', 'rabbitmq_tap', 'rabbitmq_wait_for'])
    expect(kernel.ctx.actions.get('rabbitmq_publish')).toBeUndefined()

    const patch = parseYaml(await readFile(patchFile, 'utf8')).plugins
    expect(patch).toContainEqual({ id: 'rabbitmq', name: '@aitest/action-rabbitmq', config: { namespace: 'rabbitmq', url: '${env.AITEST_TEST_RABBITMQ_URL}' } })

    const again = await call('propose_tool', { catalogId: 'rabbitmq', params: { url: '${env.AITEST_TEST_RABBITMQ_URL}' }, reason: 'r' })
    expect(again).toMatchObject({ status: 'error', error: expect.stringContaining('already installed') })
  })

  it('enables write tools only when proposed explicitly', async () => {
    const outcome = await call('propose_tool', { catalogId: 'kafka', params: { brokers: ['127.0.0.1:9092'] }, write: true, reason: 'Gửi bản tin giả lập' })
    expect(outcome.status).toBe('ok')
    expect(requests.at(-1)!.preview).toMatchObject({
      access: 'write',
      config: { namespace: 'kafka', brokers: ['127.0.0.1:9092'], allowProduce: true },
      tools: { write: ['kafka_produce'] },
    })
    expect(requests.at(-1)!.preview.config).not.toHaveProperty('sasl')
    expect(kernel.ctx.actions.get('kafka_produce')).toBeDefined()
  })

  it('explores a newly added tool in the same session', async () => {
    const outcome = await call('explore', { action: 'rabbitmq_queue_info', args: { queue: 'aitest-missing-queue' } })
    // Không có broker thì lỗi kết nối; có broker thì queue không tồn tại. Cả hai đều cho thấy lời gọi đã tới tool.
    expect(outcome.status).toBe('error')
    expect(outcome.error).not.toContain('not available for exploration')
  })

  it('restores the added rows from the patch layer on the next boot', async () => {
    const next = await bootFromFile(join(root, 'aitest.yml'), rows(), { patchFile })
    try {
      expect(next.status('rabbitmq')).toBe('active')
      expect(next.ctx.actions.get('rabbitmq_tap')).toBeDefined()
      expect(next.ctx.actions.get('kafka_produce')).toBeDefined()
    } finally {
      await next.dispose()
    }
  })

  it('writes an audit trail of proposals', async () => {
    const lines = (await readFile(join(dir, 'audit', 'audit', 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).type)
    expect(lines.filter((t) => t.startsWith('tool/'))).toEqual(['tool/declined', 'tool/approved', 'tool/added', 'tool/approved', 'tool/added'])
  })
})
