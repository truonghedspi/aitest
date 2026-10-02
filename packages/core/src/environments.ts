import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import z from '@deepseek-ai/schemastery'
import { interpolate } from './kernel.ts'
import { toPosix } from './paths.ts'

/**
 * Môi trường chạy test (`envs/<tên>.yml`): mọi thứ khác nhau giữa dev, staging, UAT…
 * - `systems`: địa chỉ service và tên topic, exchange theo môi trường (dùng với catalog hệ thống);
 * - `brokers`: broker logic của catalog → namespace tool kết nối tới broker đó;
 * - `tools`: ghi đè cấu hình row trong `aitest.yml` theo mã row; giữ nguyên `${env.TÊN}` để kernel thay khi nạp;
 * - `vars`: biến dùng chung cho mọi plan ở môi trường này;
 * - `policy.readOnly`: chặn mọi lời gọi có thể ghi dữ liệu.
 * File không chứa bí mật nên commit được.
 */
export interface EnvironmentSpec {
  name: string
  label?: string
  description?: string
  systems: Record<string, { url?: string; events?: Record<string, { topic?: string; exchange?: string }> }>
  brokers: Record<string, { namespace: string; description?: string }>
  tools: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>
  vars: Record<string, unknown>
  policy: { readOnly: boolean }
  /** File khai báo, tương đối với thư mục làm việc; không có khi môi trường không có file. */
  file?: string
}

export interface EnvironmentIssue {
  file: string
  error: string
}

const EnvironmentSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  systems: z.dict(z.object({
    url: z.string(),
    events: z.dict(z.object({ topic: z.string(), exchange: z.string() })),
  })).default({}),
  brokers: z.dict(z.object({ namespace: z.string().required(), description: z.string() })).default({}),
  tools: z.dict(z.object({ enabled: z.boolean(), config: z.dict(z.any()) })).default({}),
  vars: z.dict(z.any()).default({}),
  policy: z.object({ readOnly: z.boolean().default(false) }),
})

export const ENV_NAME = /^[a-z][a-z0-9-]*$/

/** Tên các môi trường có file trong thư mục, theo thứ tự chữ cái. */
export async function listEnvironments(dir: string): Promise<string[]> {
  const files = await readdir(resolve(dir)).catch(() => [] as string[])
  return files.filter((f) => /\.ya?ml$/.test(f)).map((f) => f.replace(/\.ya?ml$/, '')).filter((n) => ENV_NAME.test(n)).sort()
}

/** Đọc một môi trường. Thiếu file thì trả môi trường rỗng kèm issue. */
export async function loadEnvironment(dir: string, name: string): Promise<{ env: EnvironmentSpec; issues: EnvironmentIssue[] }> {
  const empty: EnvironmentSpec = { name, systems: {}, brokers: {}, tools: {}, vars: {}, policy: { readOnly: false } }
  if (!ENV_NAME.test(name)) return { env: empty, issues: [{ file: name, error: `invalid environment name ${name}` }] }
  const file = resolve(dir, `${name}.yml`)
  const shown = toPosix(relative(process.cwd(), file))
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return { env: empty, issues: [{ file: shown, error: missing ? `environment ${name} not found` : (error as Error).message }] }
  }
  try {
    const data = EnvironmentSchema(parseYaml(raw) ?? {})
    // `tools` giữ nguyên tham chiếu `${env.TÊN}`; các phần khác được thay ngay.
    return {
      env: {
        name,
        label: data.label,
        description: data.description,
        systems: interpolate(data.systems),
        brokers: interpolate(data.brokers),
        tools: data.tools,
        vars: interpolate(data.vars),
        policy: { readOnly: data.policy?.readOnly ?? false },
        file: shown,
      },
      issues: data.name && data.name !== name ? [{ file: shown, error: `name ${data.name} does not match file name ${name}` }] : [],
    }
  } catch (error) {
    return { env: { ...empty, file: shown }, issues: [{ file: shown, error: (error as Error).message.split('\n')[0] }] }
  }
}
