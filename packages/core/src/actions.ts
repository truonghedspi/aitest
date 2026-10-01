import { Context, Service } from '@deepseek-ai/cordis'
import type { ActionCall, ActionDefinition, ActionOutcome, CaseScope } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    actions: ActionRegistry
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/**
 * Registry các action mà agent gọi được.
 *
 * Mỗi lần đăng ký là một effect gắn với plugin gọi `register`. Khi plugin đó
 * bị gỡ, action tự biến mất khỏi registry.
 */
export class ActionRegistry extends Service {
  private readonly defs = new Map<string, ActionDefinition>()
  private seq = 0

  constructor(ctx: Context) {
    super(ctx, 'actions')
  }

  register(def: ActionDefinition) {
    if (!NAME_PATTERN.test(def.name)) throw new Error(`invalid action name: ${def.name}`)
    return this.ctx.effect(() => {
      if (this.defs.has(def.name)) throw new Error(`duplicate action: ${def.name}`)
      this.defs.set(def.name, def)
      return () => { this.defs.delete(def.name) }
    }, `actions.register(${def.name})`)
  }

  get(name: string) {
    return this.defs.get(name)
  }

  /**
   * Danh sách action. Khi có `scope` ở pha `agent`, chỉ trả về action được phép trong case đó.
   * Pha `setup`/`teardown` do người soạn plan kiểm soát nên được dùng mọi action.
   */
  list(scope?: Pick<CaseScope, 'namespaces'> & { phase?: CaseScope['phase'] }) {
    const all = [...this.defs.values()]
    if (!scope || (scope.phase && scope.phase !== 'agent')) return all
    return all.filter((def) => def.always || scope.namespaces.has(def.namespace))
  }

  /**
   * Thực thi action qua pipeline `action/before` → `execute` → `action/after` → `action/result`.
   * Hàm này không ném lỗi; mọi lỗi được chuẩn hoá thành `ActionOutcome`.
   */
  async invoke(scope: CaseScope, name: string, args: Record<string, unknown>): Promise<ActionOutcome> {
    const started = performance.now()
    const definition = this.list(scope).find((def) => def.name === name)
    const elapsed = () => Math.round(performance.now() - started)
    if (!definition) {
      return { status: 'error', error: `action not available in this case: ${name}`, durationMs: 0, annotations: {} }
    }

    const call: ActionCall = {
      id: `c${++this.seq}`, name, namespace: definition.namespace, args: args ?? {}, scope, definition,
    }
    let outcome: ActionOutcome
    const decision = await this.ctx.waterfall('action/before', call, async () => ({ type: 'allow' as const }))
    if (decision.type === 'deny') {
      outcome = { status: 'denied', error: decision.reason, durationMs: elapsed(), annotations: {} }
    } else {
      try {
        const value = await definition.execute(call.args, { scope, callId: call.id, signal: scope.signal })
        outcome = { status: 'ok', value, durationMs: elapsed(), annotations: {} }
      } catch (error) {
        outcome = { status: 'error', error: errorMessage(error), durationMs: elapsed(), annotations: {} }
      }
    }

    const base = outcome
    outcome = await this.ctx.waterfall('action/after', call, base, async () => base)
    scope.log('action/call', {
      callId: call.id, phase: scope.phase, name, args: call.args, status: outcome.status, value: outcome.value,
      error: outcome.error, durationMs: outcome.durationMs, annotations: outcome.annotations,
    })
    this.ctx.emit('action/result', call, outcome)
    return outcome
  }
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
