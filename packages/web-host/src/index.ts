import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { isInside, Service, errorMessage, z, type Context } from '@aitest/core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    web: WebHost
  }
}

/**
 * Kết nối WebSocket của một trình duyệt.
 * Method handler dùng `push` để đẩy dữ liệu chủ động và `onClose` để dọn đăng ký theo kết nối.
 */
export interface WebConnection {
  id: number
  push(message: unknown): void
  onClose(callback: () => void): void
}

export type MethodHandler = (params: any, connection: WebConnection) => unknown

export interface Config {
  host: string
  port: number
  staticDir: string
}

/**
 * Web host: phục vụ giao diện tĩnh và một kênh WebSocket duy nhất tại `/ws`.
 *
 * Giao thức trên WebSocket (JSON):
 * - client gửi `{ id, method, params }`, host trả `{ id, result }` hoặc `{ id, error }`;
 * - host đẩy chủ động các message có trường `type` qua `WebConnection.push`.
 * Method đăng ký qua `method(name, handler)`, theo mẫu Remote method của dsh: plugin nghiệp vụ
 * tự khai báo method của mình, web host không biết nghiệp vụ.
 */
export class WebHost extends Service {
  static Config = z.object({
    host: z.string().default('127.0.0.1'),
    port: z.natural().default(4300),
    staticDir: z.string().default('packages/web-client/dist').description('Thư mục giao diện đã build.'),
  })

  private readonly methods = new Map<string, MethodHandler>()
  private http?: Server
  private seq = 0
  private listening?: Promise<string>
  url?: string

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'web')
    ctx.effect(() => {
      this.start()
      return () => this.stop()
    }, 'web.http')
    // Bản giao diện Host đang phục vụ (đường dẫn script trong `index.html`, có mã băm của bản build).
    // Giao diện so với bản của chính nó để nhắc người dùng tải lại trang sau khi build mới.
    this.method('web.build', async () => {
      const html = await readFile(join(resolve(this.config.staticDir), 'index.html'), 'utf8').catch(() => '')
      return { script: /<script[^>]+src="([^"]+)"/.exec(html)?.[1] }
    })
  }

  method(name: string, handler: MethodHandler) {
    return this.ctx.effect(() => {
      if (this.methods.has(name)) throw new Error(`duplicate web method: ${name}`)
      this.methods.set(name, handler)
      return () => { this.methods.delete(name) }
    }, `web.method(${name})`)
  }

  /** Chờ server lắng nghe xong; trả về URL gốc. Ném lỗi khi không mở được cổng (ví dụ cổng đã bị chiếm). */
  ready(): Promise<string> {
    return this.listening ?? Promise.reject(new Error('web host is not started'))
  }

  private start() {
    const root = resolve(this.config.staticDir)
    const http = createServer(async (req, res) => {
      let pathname: string
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      } catch {
        return void res.writeHead(400).end()
      }
      let file = join(root, normalize(pathname))
      // Chặn đường dẫn thoát khỏi thư mục giao diện, kể cả dạng `..\` và đổi ổ đĩa trên Windows.
      if (!isInside(root, file)) return void res.writeHead(403).end()
      const info = await stat(file).catch(() => undefined)
      if (!info || info.isDirectory()) file = join(root, 'index.html')
      const exists = await stat(file).catch(() => undefined)
      if (!exists) return void res.writeHead(404).end('web client is not built; run `pnpm web:build`')
      // `index.html` luôn được kiểm tra lại để trình duyệt nhận bản build mới; file trong `assets/` có mã băm nên cache lâu dài.
      const hashed = /[\\/]assets[\\/]/.test(file.slice(root.length))
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
      createReadStream(file).pipe(res)
    })
    const wss = new WebSocketServer({ server: http, path: '/ws' })
    wss.on('connection', (socket) => this.accept(socket))
    // Lỗi mở cổng (EADDRINUSE...) được ghi log và trả qua `ready()`, không làm sập process.
    wss.on('error', () => {})
    this.listening = new Promise<string>((resolve, reject) => {
      http.once('error', (error) => {
        this.ctx.logger('web').error('cannot listen on %s:%s: %s', this.config.host, this.config.port, error.message)
        reject(error)
      })
      http.listen(this.config.port, this.config.host, () => {
        const { port } = http.address() as AddressInfo
        this.url = `http://${this.config.host}:${port}`
        this.ctx.logger('web').info('listening on %s', this.url)
        resolve(this.url)
      })
    })
    this.listening.catch(() => {})
    this.http = http
  }

  private stop() {
    this.http?.closeAllConnections()
    this.http?.close()
    this.http = undefined
    this.url = undefined
  }

  private accept(socket: WebSocket) {
    const closers: Array<() => void> = []
    const connection: WebConnection = {
      id: ++this.seq,
      push: (message) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)) },
      onClose: (callback) => { closers.push(callback) },
    }
    socket.on('close', () => { for (const close of closers.splice(0)) close() })
    socket.on('message', async (data) => {
      let request: { id?: number; method?: string; params?: unknown }
      try {
        request = JSON.parse(String(data))
      } catch {
        return
      }
      const handler = request.method ? this.methods.get(request.method) : undefined
      if (!handler) return connection.push({ id: request.id, error: `unknown method: ${request.method}` })
      try {
        connection.push({ id: request.id, result: (await handler(request.params ?? {}, connection)) ?? null })
      } catch (error) {
        connection.push({ id: request.id, error: errorMessage(error) })
      }
    })
  }
}

export default WebHost

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
}
