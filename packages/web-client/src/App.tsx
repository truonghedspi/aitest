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
        <div className="brand">aitest <span className={`online ${online ? 'on' : ''}`} title={online ? 'Đã kết nối' : 'Mất kết nối'} /></div>
        <nav className="pages">
          {pages.filter((p) => !p.parent).map((p) => (
            <button key={p.id} className={p.id === (page.parent ?? page.id) ? 'active' : ''} onClick={() => navigate(p.id)}>{p.title}</button>
          ))}
        </nav>
        {Sidebar && <Sidebar param={route.param} navigate={navigate} />}
      </aside>
      <Page param={route.param} navigate={navigate} />
    </div>
  )
}

function parseRoute() {
  const [page, ...rest] = location.hash.replace(/^#\/?/, '').split('/')
  return { page: page || 'chat', param: rest.join('/') || undefined }
}
