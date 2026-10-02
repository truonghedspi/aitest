import {
  compare, errorMessage, fillTemplate, z,
  type ActionScope, type Context, type PlanInput, type PrepareScope, type ResolvedInput, type RunContext,
} from '@aitest/core'

/**
 * Đầu vào của lượt chạy (`inputs` của plan), phân giải một lần trước mọi case.
 *
 * Nguồn giá trị theo thứ tự ưu tiên:
 * 1. người chạy điền (CLI `--input`, form trên giao diện);
 * 2. `fill`: bước xác định do người dùng định nghĩa (gọi API, INSERT, truy vấn dữ liệu có sẵn), runner chạy;
 * 3. `prepare`: mô tả bằng lời; agent thực hiện bằng tool trong scope `prepare` và trả giá trị qua `provide_input`.
 *    Giá trị luôn đọc từ evidence, agent không tự viết giá trị. Dữ liệu agent tạo ra được dọn qua `register_cleanup`;
 * 4. `default`.
 * Giá trị không thoả `require`, hoặc input bắt buộc không có giá trị, làm lượt chạy bị chặn (`blocked`):
 * case không chạy, báo cáo ghi lý do. Verdict của case không phụ thuộc agent chuẩn bị.
 */
export interface Config {
  prepareTimeout: number
}

export const name = 'inputs'
export const inject = ['actions', 'evidence']

export const Config = z.object({
  prepareTimeout: z.natural().default(300).description('Thời gian tối đa của phiên agent chuẩn bị dữ liệu, đơn vị giây.'),
})

interface PrepareState {
  run: RunContext
  pending: Map<string, PlanInput>
  provided: Map<string, ResolvedInput>
}

export function apply(ctx: Context, config: Config) {
  const states = new WeakMap<ActionScope, PrepareState>()
  const stateOf = (scope: ActionScope) => {
    const state = states.get(scope)
    if (!state) throw new Error('this tool is only available while preparing data for a run')
    return state
  }

  ctx.on('run/prepare', async (run) => {
    const inputs = run.plan.inputs ?? []
    if (!inputs.length) return
    const results: ResolvedInput[] = []
    const accept = (input: PlanInput, result: ResolvedInput) => {
      const checked = check(input, result)
      results.push(checked)
      if (checked.value !== undefined) run.vars[input.name] = checked.value
    }

    let batch: PlanInput[] = []
    const flush = async () => {
      if (!batch.length) return
      const prepared = await prepareWithAgent(run, batch)
      for (const input of batch) accept(input, prepared.get(input.name) ?? fallback(input, 'agent did not provide a value'))
      batch = []
    }

    for (const input of inputs) {
      if (input.name in run.given && run.given[input.name] !== '' && run.given[input.name] !== undefined) {
        await flush()
        accept(input, { name: input.name, source: 'user', value: run.given[input.name] })
        continue
      }
      if (input.fill.length) {
        await flush()
        const scope = run.createScope([])
        try {
          await run.runFixtures(scope, input.fill)
          const value = scope.vars[input.name]
          if (value === undefined) throw new Error(`fill steps did not save ${input.name}`)
          accept(input, { name: input.name, source: 'fill', value })
          for (const step of input.cleanup) run.cleanup.push({ scope, step })
          continue
        } catch (error) {
          // `fill` lỗi mà có `prepare` thì để agent thử; nếu không thì dùng giá trị mặc định.
          run.log('inputs/fill-failed', { name: input.name, error: errorMessage(error) })
          if (!input.prepare) {
            accept(input, fallback(input, `fill failed: ${errorMessage(error)}`))
            continue
          }
        }
      }
      if (input.prepare) {
        batch.push(input)
        continue
      }
      await flush()
      accept(input, fallback(input))
    }
    await flush()

    run.log('inputs/resolved', { inputs: results })
    for (const r of results) {
      if (r.source === 'missing' || r.error) run.blocked.push(`input ${r.name}: ${r.error ?? 'no value'}`)
    }
  })

  /** Một phiên agent chuẩn bị các input liên tiếp có `prepare`. */
  async function prepareWithAgent(run: RunContext, batch: PlanInput[]) {
    const namespaces = new Set(batch.flatMap((i) => i.uses ?? run.plan.requires))
    const scope = run.createScope(namespaces)
    const state: PrepareState = { run, pending: new Map(batch.map((i) => [i.name, i])), provided: new Map() }
    states.set(scope, state)
    try {
      const prompt = buildPrompt(run, scope, batch, ctx.actions.list(scope).map((a) => `- \`${a.name}\`: ${a.description.split('\n')[0]}`))
      await run.promptAgent(scope, prompt, config.prepareTimeout * 1000)
    } catch (error) {
      run.log('inputs/prepare-failed', { inputs: batch.map((i) => i.name), error: errorMessage(error) })
    } finally {
      states.delete(scope)
    }
    return state.provided
  }

  ctx.actions.register({
    name: 'provide_input',
    namespace: 'inputs',
    scopes: ['prepare'],
    always: true,
    readOnly: true,
    evidence: false,
    description: [
      'Cung cấp giá trị cho một đầu vào của lượt chạy. Giá trị được đọc từ kết quả của một tool đã gọi:',
      'truyền `evidenceId` của kết quả đó và `path` trỏ tới giá trị, ví dụ `$.rows[0].account_id` hoặc `$.body.id`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tên đầu vào.' },
        evidenceId: { type: 'string', description: 'Mã evidence (evN) chứa giá trị.' },
        path: { type: 'string', description: 'JSONPath tới giá trị trong evidence.' },
      },
      required: ['name', 'evidenceId', 'path'],
      additionalProperties: false,
    },
    async execute(args: { name: string; evidenceId: string; path: string }, { scope }) {
      const state = stateOf(scope)
      const input = state.pending.get(args.name)
      if (!input) throw new Error(`unknown input ${args.name}; inputs to prepare: ${[...state.pending.keys()].join(', ')}`)
      const value = ctx.evidence.read(scope, { evidenceId: args.evidenceId, path: args.path })
      if (value === undefined) throw new Error(`path ${args.path} has no value in ${args.evidenceId}`)
      if (input.require) {
        const result = compare(input.require.op, value, input.require.value)
        if (!result.passed) throw new Error(`value ${JSON.stringify(value)} does not satisfy the requirement: ${result.message}`)
      }
      state.provided.set(input.name, { name: input.name, source: 'agent', value, evidence: { evidenceId: args.evidenceId, path: args.path } })
      ;(scope as PrepareScope).vars[input.name] = value
      const remaining = [...state.pending.keys()].filter((n) => !state.provided.has(n))
      return { name: input.name, value, remaining }
    },
  })

  ctx.actions.register({
    name: 'register_cleanup',
    namespace: 'inputs',
    scopes: ['prepare'],
    always: true,
    evidence: false,
    description: [
      'Đăng ký một bước dọn dữ liệu vừa tạo, chạy sau khi mọi case kết thúc (theo thứ tự ngược).',
      'Gọi ngay sau mỗi lần tạo dữ liệu mới. Không đăng ký dọn dữ liệu có sẵn.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Tên tool dùng để dọn, ví dụ `http_request`, `dbadmin_query`.' },
        args: { type: 'object', description: 'Tham số đầy đủ của tool, đã điền giá trị thật.' },
        desc: { type: 'string', description: 'Mô tả ngắn, ví dụ "Huỷ lệnh 123 tạo để chuẩn bị dữ liệu".' },
      },
      required: ['action', 'args', 'desc'],
      additionalProperties: false,
    },
    async execute(args: { action: string; args: Record<string, unknown>; desc: string }, { scope }) {
      const state = stateOf(scope)
      if (!ctx.actions.get(args.action)) throw new Error(`unknown action ${args.action}`)
      state.run.cleanup.push({ scope: scope as PrepareScope, step: { action: args.action, args: args.args, desc: args.desc } })
      return { registered: true, cleanupSteps: state.run.cleanup.length }
    },
  })
}

/** Giá trị mặc định khi các nguồn khác không có; không có mặc định thì thiếu. */
function fallback(input: PlanInput, error?: string): ResolvedInput {
  if (input.default !== undefined) return { name: input.name, source: 'default', value: input.default }
  if (!input.required) return { name: input.name, source: 'missing' }
  return { name: input.name, source: 'missing', error: error ?? 'no value: provide it when running, or define fill/prepare/default' }
}

/** Kiểm tra `require`; không thoả thì ghi lỗi để lượt chạy bị chặn. */
function check(input: PlanInput, result: ResolvedInput): ResolvedInput {
  if (result.value === undefined || !input.require) return result
  const outcome = compare(input.require.op, result.value, input.require.value)
  return outcome.passed ? result : { ...result, error: `does not satisfy requirement: ${outcome.message}` }
}

function buildPrompt(run: RunContext, scope: PrepareScope, batch: PlanInput[], tools: string[]) {
  const vars = scope.vars
  const lines = [
    'Bạn là agent chuẩn bị dữ liệu cho một lượt chạy kiểm thử tự động trên môi trường tích hợp dùng chung. Không có người dùng tương tác; không hỏi lại.',
    '',
    '## Ràng buộc',
    '- Chỉ dùng tool của MCP server được cấp. Không đọc, ghi file; không chạy shell.',
    '- Làm đúng cách chuẩn bị được mô tả. Ưu tiên dữ liệu có sẵn thoả điều kiện; chỉ tạo mới khi mô tả cho phép.',
    `- Dữ liệu tạo mới gắn mã lượt chạy \`${vars['$run.short']}\` vào trường cho phép (mã tham chiếu, ghi chú), để không lẫn với dữ liệu của người khác.`,
    '- Mỗi lần tạo dữ liệu mới, gọi ngay `register_cleanup` với tool và tham số để xoá hoặc huỷ đúng dữ liệu đó. Không dọn dữ liệu có sẵn.',
    '- Với mỗi đầu vào, gọi `provide_input` kèm `evidenceId` và `path` trỏ tới giá trị trong kết quả tool. Không tự viết giá trị.',
    '- Không tìm được, không tạo được dữ liệu thoả điều kiện thì dừng và giải thích ngắn; không cung cấp giá trị sai điều kiện.',
    '- Mỗi lần gọi tool, điền `reason`: lấy hoặc tạo dữ liệu gì, để làm gì.',
    '',
    `## Plan: ${run.plan.name} (${run.plan.id})`,
  ]
  if (run.plan.context) lines.push(fillTemplate(run.plan.context, vars).trim())
  lines.push('', '### Biến đã có', '```json', JSON.stringify(vars, null, 2), '```', '', '## Đầu vào cần chuẩn bị')
  for (const input of batch) {
    lines.push('', `### ${input.name}`)
    if (input.desc) lines.push(`Mô tả: ${fillTemplate(input.desc, vars)}`)
    if (input.require) lines.push(`Điều kiện: ${input.require.op}${input.require.value !== undefined ? ` ${JSON.stringify(input.require.value)}` : ''}`)
    lines.push('Cách chuẩn bị:', fillTemplate(input.prepare ?? '', vars).trim())
  }
  lines.push('', '## Tool khả dụng', ...tools, '', 'Khi đã cung cấp đủ đầu vào, tóm tắt ngắn (tối đa 5 dòng) rồi kết thúc lượt.')
  return lines.join('\n')
}
