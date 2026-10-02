import { useEffect, useState } from 'react'
import { connection } from './connection.ts'
import { slots } from './slots.ts'

/**
 * Khung giao diện: thanh điều hướng từ slot `page`, nội dung của trang đang chọn.
 * Đường dẫn dạng `#/<trang>/<tham số>`, ví dụ `#/chat/<mã cuộc chat>`, `#/plugins`.
 */
export function App() {
  const [route, setRoute] = useState(parseRoute)
  useEffect(() => {
    const onHash = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const [outdated, setOutdated] = useState(connection.missingMethod)
  useEffect(() => connection.onOutdated(setOutdated), [])
  const staleUi = useStaleUi()
  const [online, setOnline] = useState(connection.connected)
  useEffect(() => {
    setOnline(connection.connected)
    return connection.onStatus(setOnline)
  }, [])

  const pages = slots.page.values().sort((a, b) => a.order - b.order)
  const page = pages.find((p) => p.id === route.page) ?? pages[0]
  const navigate = (path: string) => { location.hash = `/${path}` }
  const Page = page.component
  const Sidebar = page.sidebar

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          aitest <span className={`online ${online ? 'on' : ''}`} title={online ? 'Đã kết nối' : 'Mất kết nối'} />
          <HostVersion />
        </div>
        <nav className="pages">
          {pages.filter((p) => !p.parent).map((p) => (
            <button key={p.id} className={p.id === (page.parent ?? page.id) ? 'active' : ''} onClick={() => navigate(p.id)}>{p.title}</button>
          ))}
        </nav>
        {Sidebar && <Sidebar param={route.param} navigate={navigate} />}
      </aside>
      {staleUi && (
        <div className="host-outdated" role="alert">
          <b>Đã có bản giao diện mới.</b> Tải lại trang để dùng các tính năng mới.{' '}
          <button className="primary" onClick={() => location.reload()}>Tải lại</button>
        </div>
      )}
      {outdated && !staleUi && (
        <div className="host-outdated" role="alert">
          <b>Host đang chạy phiên bản cũ hơn giao diện</b> (thiếu <code>{outdated}</code>), nên một số tính năng chưa dùng được.
          {' '}Khởi động lại Host: dừng <code>aitest … serve</code> bằng Ctrl+C, chạy lại, rồi tải lại trang (Cmd+Shift+R).
        </div>
      )}
      <Page param={route.param} navigate={navigate} />
    </div>
  )
}

/**
 * Giao diện đang chạy cũ hơn bản Host phục vụ: so đường dẫn script (có mã băm của bản build)
 * khi kết nối và mỗi phút một lần.
 */
function useStaleUi() {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    const own = document.querySelector<HTMLScriptElement>('script[type=module][src]')?.getAttribute('src')
    if (!own) return
    const check = () => {
      connection.call<{ script?: string }>('web.build').then((b) => setStale(!!b.script && b.script !== own), () => {})
    }
    check()
    const stop = connection.onOpen(check)
    const timer = setInterval(check, 60_000)
    return () => { stop(); clearInterval(timer) }
  }, [])
  return stale
}

declare const __UI_VERSION__: string

/**
 * Phiên bản đang chạy: commit của Host (lúc khởi động) và của giao diện (lúc build).
 * Hai bản khác nhau nghĩa là một bên chưa được cập nhật: giao diện chưa build lại, hoặc Host chưa khởi động lại.
 */
function HostVersion() {
  const [info, setInfo] = useState<{ version?: string; startedAt?: string; error?: string }>()
  useEffect(() => {
    const load = () => {
      connection.call<{ version?: string; startedAt?: string }>('web.build').then(setInfo, (e) => setInfo({ error: (e as Error).message }))
    }
    load()
    return connection.onOpen(load)
  }, [])
  if (!info) return null
  const ui = __UI_VERSION__ || undefined
  const host = info.error ? 'cũ' : info.version
  const started = info.startedAt ? new Date(info.startedAt).toLocaleString('vi-VN') : ''
  const mismatch = !!ui && !!host && ui !== host
  const title = [
    `Host: ${info.error ? 'phiên bản cũ, chưa báo được phiên bản' : host ?? 'không rõ (không đọc được git)'}${started ? `, khởi động ${started}` : ''}`,
    `Giao diện: ${ui ?? 'không rõ'}`,
    mismatch ? 'Hai bản khác nhau: chạy `pnpm serve` (build giao diện rồi chạy Host), sau đó tải lại trang.' : '',
  ].filter(Boolean).join('\n')
  return (
    <span className={`host-version ${mismatch ? 'mismatch' : ''}`} title={title}>
      {mismatch ? `⚠ host ${host} · ui ${ui}` : host ?? ui ?? '?'}
    </span>
  )
}

function parseRoute() {
  const [page, ...rest] = location.hash.replace(/^#\/?/, '').split('/')
  return { page: page || 'chat', param: rest.join('/') || undefined }
}
