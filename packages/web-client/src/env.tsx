import { useEffect, useSyncExternalStore } from 'react'
import { connection } from './connection.ts'

/**
 * Môi trường trên giao diện: danh sách lấy từ Host (`envs.list`), môi trường đang chọn lưu ở trình duyệt.
 * Trang Plan, hộp thoại chạy và cuộc chat mới dùng môi trường đang chọn.
 */
export interface EnvInfo {
  name: string
  label?: string
  description?: string
  default: boolean
  readOnly: boolean
  file?: string
  tools: Array<{ row: string; enabled: boolean }>
  active: boolean
  issues: Array<{ file: string; error: string }>
}

const KEY = 'aitest.env'
let envs: EnvInfo[] | undefined
let selected: string | undefined = readStored()
const listeners = new Set<() => void>()
let loading: Promise<void> | undefined

function readStored() {
  try {
    return localStorage.getItem(KEY) ?? undefined
  } catch {
    return undefined
  }
}

function emit() {
  for (const l of listeners) l()
}

function load() {
  loading ??= connection.call<EnvInfo[]>('envs.list').then(
    (list) => { envs = list; emit() },
    () => { envs = []; emit() },
  ).finally(() => { loading = undefined })
  return loading
}

/** Danh sách môi trường; rỗng khi Host không bật plugin môi trường. */
export function useEnvs() {
  useEffect(() => { if (!envs) void load() }, [])
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => envs)
}

/** Môi trường mặc định của Host. */
export function defaultEnv(list = envs) {
  return list?.find((e) => e.default)?.name
}

/** Môi trường đang chọn trên giao diện; chưa chọn hoặc không còn tồn tại thì là môi trường mặc định. */
export function useSelectedEnv(): [string | undefined, (env: string) => void] {
  const list = useEnvs()
  const value = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l) } }, () => selected)
  const current = value && list?.some((e) => e.name === value) ? value : defaultEnv(list)
  return [current, setSelectedEnv]
}

export function setSelectedEnv(env: string) {
  selected = env
  try {
    localStorage.setItem(KEY, env)
  } catch { /* trình duyệt chặn lưu: chỉ nhớ trong phiên */ }
  emit()
}

/** Tên hiển thị: nhãn kèm tên. */
export function envLabel(env?: EnvInfo) {
  if (!env) return ''
  return env.label && env.label !== env.name ? `${env.label} (${env.name})` : env.name
}

/** Ô chọn môi trường. `allowed` giới hạn môi trường theo `envs` của plan. */
export function EnvSelect({ value, onChange, allowed, compact }: {
  value?: string; onChange(env: string): void; allowed?: string[]; compact?: boolean
}) {
  const list = useEnvs()
  if (!list?.length) return null
  const current = list.find((e) => e.name === value)
  return (
    <label className={`env-select ${current?.readOnly ? 'readonly' : ''}`} title={current?.description ?? 'Môi trường chạy test'}>
      {!compact && <span className="muted small">Môi trường</span>}
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {list.map((e) => (
          <option key={e.name} value={e.name} disabled={!!allowed?.length && !allowed.includes(e.name)}>
            {envLabel(e)}{e.readOnly ? ' · chỉ đọc' : ''}{e.issues.length ? ' · lỗi cấu hình' : ''}
          </option>
        ))}
      </select>
      {current?.readOnly && <span className="badge readonly" title="Mọi lời gọi có thể ghi dữ liệu bị chặn">chỉ đọc</span>}
      {!!current?.issues.length && <span className="bad small" title={current.issues.map((i) => i.error).join('\n')}>⚠ lỗi cấu hình</span>}
    </label>
  )
}

/** Nhãn môi trường gọn cho bảng và tiêu đề. */
export function EnvTag({ env }: { env?: string }) {
  const list = useEnvs()
  if (!env) return null
  const info = list?.find((e) => e.name === env)
  return <span className={`tag env ${info?.readOnly ? 'readonly' : ''}`} title={info?.label}>{env}</span>
}
