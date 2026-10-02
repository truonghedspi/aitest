/**
 * Kiểm thử năng lực test E2E qua trình duyệt: Playwright MCP nối qua action-mcp-proxy.
 *
 * Cần Google Chrome (hoặc đặt AITEST_BROWSER=chromium khi đã cài trình duyệt của Playwright).
 * Bỏ qua bằng biến môi trường AITEST_SKIP_BROWSER=1.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { root, setupHarness, type Call, type Harness, type Script } from './support.ts'

const PORT = 4197
const BASE = `http://127.0.0.1:${PORT}`
/** Vị trí cài Google Chrome thường gặp trên macOS, Linux, Windows. */
const CHROME_PATHS = [
  '/Applications/Google Chrome.app',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
]
const hasBrowser = process.env.AITEST_BROWSER !== undefined || CHROME_PATHS.some((p) => existsSync(p))
const skip = process.env.AITEST_SKIP_BROWSER === '1' || !hasBrowser

/** Tìm `ref` của phần tử theo vai trò và tên trong snapshot, giống cách agent thật đọc snapshot. */
function ref(snapshot: string, role: string, name: string) {
  const match = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(\\w+)\\]`).exec(snapshot)
  if (!match) throw new Error(`no ${role} "${name}" in snapshot:\n${snapshot}`)
  return match[1]
}

async function submitOrder(call: Call, order: { symbol: string; side: string; qty: string; price: string }) {
  await call('browser_navigate', { url: `${BASE}/` })
  const page = (await call('browser_snapshot')).result as string
  await call('browser_type', { element: 'Mã chứng khoán', target: ref(page, 'textbox', 'Mã chứng khoán'), text: order.symbol })
  await call('browser_select_option', { element: 'Chiều', target: ref(page, 'combobox', 'Chiều'), values: [order.side] })
  await call('browser_type', { element: 'Khối lượng', target: ref(page, 'spinbutton', 'Khối lượng'), text: order.qty })
  await call('browser_type', { element: 'Giá', target: ref(page, 'spinbutton', 'Giá'), text: order.price })
  await call('browser_click', { element: 'Đặt lệnh', target: ref(page, 'button', 'Đặt lệnh') })
}

const scripts: Record<string, Script> = {
  async 'E2E-01'(call) {
    await submitOrder(call, { symbol: 'VCB', side: 'Mua', qty: '100', price: '90000' })
    await call('browser_wait_for', { text: 'Đã đặt lệnh số' })
    const after = await call('browser_snapshot')
    const row = await call('db_query', { sql: "SELECT * FROM orders WHERE symbol = 'VCB' ORDER BY id DESC LIMIT 1" })
    await call('assert_expectation', { expectId: 'ui-message', evidenceId: after.evidenceId, path: '$' })
    await call('assert_expectation', { expectId: 'ui-table', evidenceId: after.evidenceId, path: '$' })
    await call('assert_expectation', { expectId: 'db-status', evidenceId: row.evidenceId, path: '$.rows[0].status' })
    await call('assert_expectation', { expectId: 'db-qty', evidenceId: row.evidenceId, path: '$.rows[0].qty' })
  },
  async 'E2E-02'(call) {
    await submitOrder(call, { symbol: 'VC', side: 'Bán', qty: '100', price: '90000' })
    await call('browser_wait_for', { text: 'Lỗi:' })
    const after = await call('browser_snapshot')
    const count = await call('db_query', { sql: "SELECT COUNT(*) AS n FROM orders WHERE symbol = 'VC'" })
    await call('assert_expectation', { expectId: 'ui-error', evidenceId: after.evidenceId, path: '$' })
    await call('assert_expectation', { expectId: 'db-none', evidenceId: count.evidenceId, path: '$.rows[0].n' })
  },
}

describe.skipIf(skip)('browser e2e capabilities (scripted agent)', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await setupHarness({ port: PORT, config: 'aitest.e2e.yml', scripts })
  }, 60_000)

  afterAll(() => harness?.dispose())

  it('drives the web UI through Playwright MCP and cross-checks the DB', async () => {
    const report = await harness.kernel.ctx.runner.run({ plan: join(root, 'examples/plans/order-ui.plan.yaml'), agent: 'scripted' })
    expect(Object.fromEntries(report.cases.map((c) => [c.id, [c.verdict, c.reasons]]))).toEqual({
      'E2E-01': ['pass', []],
      'E2E-02': ['pass', []],
    })
    // Teardown đóng trình duyệt sau mỗi case.
    const teardown = report.cases.flatMap((c) => c.actions.filter((a) => a.phase === 'teardown').map((a) => a.name))
    expect(teardown).toEqual(['browser_close', 'browser_close'])
  }, 180_000)
})
