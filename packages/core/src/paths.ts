import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * `file` có nằm trong thư mục `root` hay không, đúng trên mọi hệ điều hành.
 *
 * Chỉ kiểm tra `relative(root, file).startsWith('..')` là chưa đủ trên Windows: hai ổ đĩa khác nhau
 * (`C:\` và `D:\`) cho kết quả là đường dẫn tuyệt đối, không bắt đầu bằng `..`.
 */
export function isInside(root: string, file: string): boolean {
  const rel = relative(resolve(root), resolve(file))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Đổi đường dẫn sang dấu `/`, để hiển thị và ghi cấu hình giống nhau trên mọi hệ điều hành. */
export function toPosix(path: string): string {
  return sep === '\\' ? path.replace(/\\/g, '/') : path
}
