import type { ComponentType } from 'react'
import type { ActionCallData, ToolView } from './types.ts'

/**
 * Slot của giao diện, theo mẫu của dsh: plugin phía client đăng ký thành phần vào slot,
 * khung giao diện chỉ đọc slot và không biết từng thành phần cụ thể.
 */
export interface ToolViewProps {
  call: ActionCallData
  view: ToolView
}

export interface PanelProps {
  chatId: string
}

export interface PanelEntry {
  id: string
  title: string
  order: number
  component: ComponentType<PanelProps>
}

export interface PageProps {
  /** Phần sau tên trang trong đường dẫn, ví dụ mã cuộc chat. */
  param?: string
  navigate(path: string): void
}

export interface PageEntry {
  id: string
  title: string
  order: number
  component: ComponentType<PageProps>
  /** Nội dung riêng của trang trong cột trái, ví dụ danh sách cuộc chat. */
  sidebar?: ComponentType<PageProps>
  /** Trang con: không hiện trên thanh điều hướng; khi mở, mục `parent` được đánh dấu đang chọn. */
  parent?: string
}

class Registry<K, V> {
  private readonly map = new Map<K, V>()
  register(key: K, value: V) {
    this.map.set(key, value)
    return () => { this.map.delete(key) }
  }
  get(key: K) {
    return this.map.get(key)
  }
  values() {
    return [...this.map.values()]
  }
}

export const slots = {
  /** Thẻ hiển thị một lời gọi tool, chọn theo `view.kind`. Kind không đăng ký dùng thẻ mặc định. */
  toolView: new Registry<string, ComponentType<ToolViewProps>>(),
  /** Bảng bên phải của cuộc chat, ví dụ bản nháp plan. */
  panel: new Registry<string, PanelEntry>(),
  /** Trang cấp cao nhất, hiện trên thanh điều hướng: soạn plan, plugin, tool. */
  page: new Registry<string, PageEntry>(),
}

/** Một plugin phía client: hàm nhận `slots` và đăng ký thành phần. */
export type ClientPlugin = (s: typeof slots) => void
