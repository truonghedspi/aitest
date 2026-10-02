import { isSafeNumber, parse as parseLossless } from 'lossless-json'

/**
 * Parse JSON mà không mất chữ số: số đổi sang `number` vẫn giữ nguyên giá trị thì trả về `number`;
 * số vượt độ chính xác của `number` (ví dụ `12345678901234567.89`) được giữ dạng chuỗi để so sánh bằng BigDecimal.
 */
export function parseJson(text: string): unknown {
  return parseLossless(text, null, (value: string) => (isSafeNumber(value) ? Number(value) : value))
}

/** Nội dung bản tin, body HTTP...: parse JSON nếu được, nếu không trả về chuỗi nguyên văn. */
export function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed || !'{["-0123456789tfn'.includes(trimmed[0])) return text
  try {
    return parseJson(trimmed)
  } catch {
    return text
  }
}
