import { variablesOf } from './calc.ts'
import { parseJson } from './json.ts'
import type { ExpectationCheck, TestCase, TestPlan } from './types.ts'

/**
 * Nguồn của biến trong công thức `check.expr`:
 * - `vars`: biến tĩnh của plan; `input`: đầu vào của lượt chạy; `fixture`: giá trị `save` của bước chuẩn bị.
 *   Ba nguồn này nền tảng tự gắn lúc assert, agent chạy test không truyền `inputs`.
 * - Biến còn lại phải được agent chạy test chỉ ra bằng `inputs` (evidence và path chứa giá trị thật).
 */
export type RunVariableSource = 'vars' | 'input' | 'fixture'

export interface FormulaVariables {
  fromRun: Array<{ name: string; source: RunVariableSource }>
  fromEvidence: string[]
}

export function formulaVariables(plan: TestPlan, testCase: TestCase, check: ExpectationCheck): FormulaVariables {
  if (!check.expr) return { fromRun: [], fromEvidence: [] }
  const sources = new Map<string, RunVariableSource>()
  for (const name of Object.keys(plan.vars)) sources.set(name, 'vars')
  for (const input of plan.inputs ?? []) sources.set(input.name, 'input')
  for (const step of [...plan.setup, ...testCase.setup]) for (const name of Object.keys(step.save ?? {})) sources.set(name, 'fixture')
  const fromRun: FormulaVariables['fromRun'] = []
  const fromEvidence: string[] = []
  for (const name of variablesOf(check.expr, { let: check.let })) {
    const source = sources.get(name)
    if (source) fromRun.push({ name, source })
    else fromEvidence.push(name)
  }
  return { fromRun, fromEvidence }
}

/**
 * Giá trị biến dạng chuỗi JSON (đầu vào do người chạy điền, giá trị đọc từ cột văn bản) được đọc thành object hoặc
 * danh sách, để công thức truy cập được trường (`account_data.balance`); số giữ nguyên chữ số. Chuỗi khác giữ nguyên.
 */
export function coerceJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!(text.startsWith('{') && text.endsWith('}')) && !(text.startsWith('[') && text.endsWith(']'))) return value
  try {
    // Số lớn và số thập phân giữ nguyên chữ số, như kết quả action.
    return parseJson(text)
  } catch {
    return value
  }
}
