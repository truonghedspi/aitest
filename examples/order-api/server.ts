/**
 * Ứng dụng mẫu để demo: API và giao diện web đặt lệnh chứng khoán, lưu vào SQLite.
 *
 * - Lệnh kèm `callback_url` được "khớp" bất đồng bộ sau `EXEC_DELAY_MS`:
 *   status chuyển sang FILLED, rồi API gọi POST tới callback_url. Dùng cho test integration.
 * - `GET /` là giao diện web đặt lệnh. Dùng cho test E2E qua trình duyệt.
 *
 * Ứng dụng có hai lỗi cố ý:
 * - không kiểm tra lô chẵn 100 cổ phiếu (TC-03 trong `examples/plans/order.plan.yaml` phát hiện);
 * - tính phí bằng số thực rồi `toFixed(2)`, nên làm tròn sai ở giá trị biên như 1,545
 *   (FEE-02 trong `examples/plans/order-fee.plan.yaml` phát hiện).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.ORDER_API_PORT ?? 4100)
const execDelay = Number(process.env.EXEC_DELAY_MS ?? 1500)
const db = new DatabaseSync(process.env.ORDER_DB ?? join(dir, 'orders.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    qty INTEGER NOT NULL,
    price INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    cancelled_at TEXT,
    filled_qty INTEGER NOT NULL DEFAULT 0,
    filled_at TEXT,
    callback_url TEXT
  )
`)
// Nâng cấp file DB tạo bởi phiên bản cũ của ứng dụng mẫu.
for (const column of ['filled_qty INTEGER NOT NULL DEFAULT 0', 'filled_at TEXT', 'callback_url TEXT']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${column}`) } catch {}
}

type Order = { id: number; status: string; qty: number; callback_url: string | null }

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { return undefined }
}

/**
 * Phí giao dịch theo đặc tả: 0,15% × qty × price, đơn vị nghìn đồng, làm tròn nửa lên tới 2 chữ số thập phân.
 * LỖI CỐ Ý: dùng số thực và `toFixed(2)`, nên 1,545 thành 1,54 thay vì 1,55.
 */
const feeOf = (qty: number, price: number) => Number((qty * price / 1000 * 0.0015).toFixed(2))

const withFee = (row: unknown) => {
  const order = row as (Order & { price: number }) | undefined
  return order && { ...order, fee: feeOf(order.qty, order.price) }
}

const findOrder = (id: number) => withFee(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)) as Order | undefined

/** Mô phỏng sàn khớp lệnh: sau một khoảng trễ, khớp toàn bộ rồi gọi callback. */
function scheduleExecution(id: number) {
  setTimeout(async () => {
    const order = findOrder(id)
    if (!order || order.status !== 'NEW') return
    db.prepare("UPDATE orders SET status = 'FILLED', filled_qty = qty, filled_at = datetime('now') WHERE id = ?").run(id)
    const filled = findOrder(id)!
    try {
      await fetch(order.callback_url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-event-type': 'order.filled' },
        body: JSON.stringify({ event: 'order.filled', orderId: id, status: 'FILLED', filledQty: (filled as any).filled_qty }),
      })
    } catch (error) {
      console.error(`callback failed for order ${id}:`, (error as Error).message)
    }
  }, execDelay)
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const parts = url.pathname.split('/').filter(Boolean)

  if (req.method === 'GET' && url.pathname === '/') {
    return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
  }

  if (req.method === 'GET' && url.pathname === '/orders') {
    return send(res, 200, db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 50').all().map(withFee))
  }

  if (req.method === 'POST' && url.pathname === '/orders') {
    const body = await readBody(req)
    if (!body) return send(res, 400, { error: 'invalid JSON' })
    const { symbol, side, qty, price, callback_url } = body
    if (typeof symbol !== 'string' || !/^[A-Z]{3}$/.test(symbol)) return send(res, 400, { error: 'symbol must be 3 uppercase letters' })
    if (side !== 'BUY' && side !== 'SELL') return send(res, 400, { error: 'side must be BUY or SELL' })
    if (!Number.isInteger(qty) || qty <= 0) return send(res, 400, { error: 'qty must be a positive integer' })
    // LỖI CỐ Ý: thiếu kiểm tra lô chẵn `qty % 100 === 0`.
    if (!Number.isInteger(price) || price <= 0) return send(res, 400, { error: 'price must be a positive integer' })
    if (callback_url !== undefined && !/^https?:\/\//.test(callback_url)) return send(res, 400, { error: 'callback_url must be http(s)' })
    const info = db.prepare('INSERT INTO orders (symbol, side, qty, price, status, callback_url) VALUES (?, ?, ?, ?, ?, ?)')
      .run(symbol, side, qty, price, 'NEW', callback_url ?? null)
    const id = Number(info.lastInsertRowid)
    if (callback_url) scheduleExecution(id)
    return send(res, 201, findOrder(id))
  }

  if (parts[0] === 'orders' && parts[1]) {
    const id = Number(parts[1])
    const order = findOrder(id)
    if (!order) return send(res, 404, { error: 'order not found' })
    if (req.method === 'GET' && parts.length === 2) return send(res, 200, order)
    if (req.method === 'POST' && parts[2] === 'cancel') {
      if (order.status !== 'NEW') return send(res, 409, { error: `cannot cancel order in status ${order.status}` })
      db.prepare("UPDATE orders SET status = 'CANCELLED', cancelled_at = datetime('now') WHERE id = ?").run(id)
      return send(res, 200, findOrder(id))
    }
  }

  send(res, 404, { error: 'not found' })
}).listen(port, '127.0.0.1', () => {
  console.log(`order-api listening on http://127.0.0.1:${port}`)
})

const PAGE = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Đặt lệnh</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
  form { display: grid; grid-template-columns: 8rem 1fr; gap: .5rem 1rem; align-items: center; }
  table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
  th, td { border-bottom: 1px solid #ddd; padding: .4rem; text-align: left; }
  #message { margin-top: 1rem; min-height: 1.5rem; }
  .error { color: #b00020; } .ok { color: #0a7a2f; }
</style>
</head>
<body>
<h1>Đặt lệnh</h1>
<form id="order-form">
  <label for="symbol">Mã chứng khoán</label>
  <input id="symbol" name="symbol" required maxlength="3">
  <label for="side">Chiều</label>
  <select id="side" name="side"><option value="BUY">Mua</option><option value="SELL">Bán</option></select>
  <label for="qty">Khối lượng</label>
  <input id="qty" name="qty" type="number" required>
  <label for="price">Giá</label>
  <input id="price" name="price" type="number" required>
  <span></span><button type="submit">Đặt lệnh</button>
</form>
<div id="message" role="status"></div>
<h2>Lệnh gần đây</h2>
<table>
  <thead><tr><th>Số hiệu</th><th>Mã</th><th>Chiều</th><th>Khối lượng</th><th>Giá</th><th>Trạng thái</th></tr></thead>
  <tbody id="orders"></tbody>
</table>
<script>
  const message = document.getElementById('message')
  async function refresh() {
    const orders = await (await fetch('/orders')).json()
    document.getElementById('orders').innerHTML = orders.map(o =>
      '<tr><td>' + o.id + '</td><td>' + o.symbol + '</td><td>' + o.side + '</td><td>' + o.qty +
      '</td><td>' + o.price + '</td><td>' + o.status + '</td></tr>').join('')
  }
  document.getElementById('order-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = new FormData(event.target)
    const body = { symbol: form.get('symbol'), side: form.get('side'), qty: Number(form.get('qty')), price: Number(form.get('price')) }
    const res = await fetch('/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json()
    message.className = res.ok ? 'ok' : 'error'
    message.textContent = res.ok ? 'Đã đặt lệnh số ' + data.id : 'Lỗi: ' + data.error
    await refresh()
  })
  refresh()
</script>
</body>
</html>`
