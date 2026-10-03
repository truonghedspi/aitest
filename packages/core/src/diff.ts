/**
 * Khác biệt theo dòng giữa hai văn bản, dạng `+`/`-`/` ` kèm vài dòng ngữ cảnh quanh chỗ đổi.
 * Dùng cho bản xem trước khi agent đề xuất sửa file (catalog hệ thống, tài liệu ngữ cảnh). LCS đơn giản, đủ cho file vài nghìn dòng.
 */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  const n = a.length
  const m = b.length
  // Bảng độ dài dãy con chung dài nhất tính từ cuối.
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const ops: Array<{ op: ' ' | '+' | '-'; line: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: ' ', line: a[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ op: '-', line: a[i++] })
    else ops.push({ op: '+', line: b[j++] })
  }
  while (i < n) ops.push({ op: '-', line: a[i++] })
  while (j < m) ops.push({ op: '+', line: b[j++] })
  // Chỉ giữ dòng đổi và `context` dòng quanh đó; đoạn bỏ qua ghi `…`.
  const keep = ops.map(() => false)
  ops.forEach((o, k) => {
    if (o.op === ' ') return
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true
  })
  const out: string[] = []
  let skipped = false
  ops.forEach((o, k) => {
    if (!keep[k]) { if (!skipped && out.length) out.push('…'); skipped = true; return }
    skipped = false
    out.push(`${o.op} ${o.line}`)
  })
  return out.join('\n')
}
