/**
 * Kết nối WebSocket tới web host: gọi method (`call`) và nhận message đẩy chủ động (`listen`).
 * Mất kết nối thì tự kết nối lại; listener `onOpen` dùng để đăng ký lại các luồng follow.
 */
type Push = { type: string; [key: string]: any }

export class Connection {
  private socket?: WebSocket
  private seq = 0
  private readonly waiting = new Map<number, { resolve(v: any): void; reject(e: Error): void }>()
  private readonly listeners = new Set<(message: Push) => void>()
  private readonly openListeners = new Set<() => void>()
  private readonly statusListeners = new Set<(connected: boolean) => void>()
  private queue: string[] = []
  private readonly outdatedListeners = new Set<(method: string) => void>()
  connected = false
  /**
   * Method mà Host không có: giao diện mới hơn Host (Host chưa khởi động lại sau khi cập nhật mã).
   * Giao diện hiện cảnh báo thay vì để từng trang báo lỗi khó hiểu.
   */
  missingMethod?: string

  constructor(private readonly url: string) {
    this.open()
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq
    const payload = JSON.stringify({ id, method, params })
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, {
        resolve,
        reject: (error) => {
          if (/^unknown method/.test(error.message) && !this.missingMethod) {
            this.missingMethod = method
            for (const l of this.outdatedListeners) l(method)
          }
          reject(error)
        },
      })
      if (this.connected) this.socket!.send(payload)
      else this.queue.push(payload)
    })
  }

  listen(listener: (message: Push) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Theo dõi trạng thái kết nối; gọi ngay mỗi khi kết nối mở hoặc đóng. */
  onStatus(listener: (connected: boolean) => void) {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  /** Theo dõi khi phát hiện Host thiếu method mà giao diện cần. */
  onOutdated(listener: (method: string) => void) {
    this.outdatedListeners.add(listener)
    return () => { this.outdatedListeners.delete(listener) }
  }

  onOpen(listener: () => void) {
    this.openListeners.add(listener)
    return () => { this.openListeners.delete(listener) }
  }

  private open() {
    const socket = new WebSocket(this.url)
    this.socket = socket
    socket.onopen = () => {
      this.connected = true
      for (const listener of this.statusListeners) listener(true)
      for (const payload of this.queue.splice(0)) socket.send(payload)
      for (const listener of this.openListeners) listener()
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== undefined) {
        const waiter = this.waiting.get(message.id)
        this.waiting.delete(message.id)
        if (message.error) waiter?.reject(new Error(message.error))
        else waiter?.resolve(message.result)
        return
      }
      for (const listener of this.listeners) listener(message)
    }
    socket.onclose = () => {
      this.connected = false
      for (const listener of this.statusListeners) listener(false)
      for (const waiter of this.waiting.values()) waiter.reject(new Error('connection lost'))
      this.waiting.clear()
      setTimeout(() => this.open(), 1000)
    }
  }
}

export const connection = new Connection(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
