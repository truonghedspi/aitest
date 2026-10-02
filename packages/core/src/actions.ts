import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import type { ActionCall, ActionDefinition, ActionOutcome, ActionScope, CallIntent, CaseScope, ScopeKind } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    actions: ActionRegistry
    evidence: import('./types.ts').EvidenceReader
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
  private readonly owners = new Map<string, Fiber>()
  private readonly restricted = new Map<string, number>()
  private seq = 0

  constructor(ctx: Context) {
    super(ctx, 'actions')
  }

  register(def: ActionDefinition) {
    if (!NAME_PATTERN.test(def.name)) throw new Error(`invalid action name: ${def.name}`)
    // `this.ctx` là context của plugin gọi `register`, nên fiber của nó là chủ sở hữu action.
    const owner = this.ctx.fiber
    return this.ctx.effect(() => {
      if (this.defs.has(def.name)) throw new Error(`duplicate action: ${def.name}`)
      this.defs.set(def.name, def)
      this.owners.set(def.name, owner)
      return () => {
        this.defs.delete(def.name)
        this.owners.delete(def.name)
      }
    }, `actions.register(${def.name})`)
  }

  /** Fiber của plugin đã đăng ký action. */
  ownerOf(name: string) {
    return this.owners.get(name)
  }

  /**
   * Ẩn một action khỏi mọi scope, theo mẫu `ctx.tools.restrict()` của dsh: chỉ bớt đi, không thêm được.
   * Action bị ẩn không xuất hiện trong danh sách và không gọi được. Nhiều plugin có thể cùng ẩn một action.
   */
  restrict(name: string) {
    return this.ctx.effect(() => {
      this.restricted.set(name, (this.restricted.get(name) ?? 0) + 1)
      return () => {
        const count = (this.restricted.get(name) ?? 1) - 1
        if (count > 0) this.restricted.set(name, count)
        else this.restricted.delete(name)
      }
    }, `actions.restrict(${name})`)
  }

  isRestricted(name: string) {
    return this.restricted.has(name)
  }

  get(name: string) {
    return this.defs.get(name)
  }

  /** Mọi action đã đăng ký, kể cả action đang bị ẩn; dùng cho trang quản lý. */
  all() {
    return [...this.defs.values()]
  }

  /**
   * Danh sách action. Khi có `scope`, chỉ trả về action khai báo hỗ trợ loại scope đó.
   * Ở pha `agent`, danh sách còn bị giới hạn theo namespace; pha khác do người soạn plan
   * hoặc người dùng kiểm soát nên được dùng mọi action cùng loại scope.
   */
  list(scope?: Pick<ActionScope, 'namespaces'> & { kind?: ScopeKind; phase?: ActionScope['phase'] }) {
    const all = [...this.defs.values()].filter((def) => !this.restricted.has(def.name))
    if (!scope) return all
    const kind = scope.kind ?? 'case'
    const ofKind = all.filter((def) => (def.scopes ?? DEFAULT_SCOPES).includes(kind))
    if (scope.phase && scope.phase !== 'agent') return ofKind
    return ofKind.filter((def) => def.always || scope.namespaces.has(def.namespace))
  }

  /**
   * Thực thi action qua pipeline `action/before` → `execute` → `action/after` → `action/result`.
   * Hàm này không ném lỗi; mọi lỗi được chuẩn hoá thành `ActionOutcome`.
   */
  /**
   * `intent` là lý do agent khai báo (gateway tách từ tham số `reason`, `step`); được ghi vào log cùng lời gọi
   * để người dùng biết agent lấy dữ liệu gì và vì sao.
   */
  async invoke(scope: ActionScope, name: string, args: Record<string, unknown>, intent: CallIntent = {}): Promise<ActionOutcome> {
    const started = performance.now()
    const definition = this.list(scope).find((def) => def.name === name)
    const elapsed = () => Math.round(performance.now() - started)
    if (!definition) {
      return { status: 'error', error: `action not available in this case: ${name}`, durationMs: 0, annotations: {} }
    }

    const call: ActionCall = {
      id: `c${++this.seq}`, name, namespace: definition.namespace, args: args ?? {}, scope, definition, intent,
    }
    scope.log('action/start', { callId: call.id, scope: scope.kind, phase: scope.phase, name, args: call.args, ...intent })
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
      callId: call.id, scope: scope.kind, phase: scope.phase, ...intent, name, args: call.args, status: outcome.status, value: outcome.value,
      error: outcome.error, durationMs: outcome.durationMs, annotations: outcome.annotations,
      view: presentSafely(definition, call.args, outcome),
    })
    this.ctx.emit('action/result', call, outcome)
    return outcome
  }
}

/** Lỗi trong hàm hiển thị không được làm hỏng lời gọi action; thẻ mặc định được dùng thay thế. */
function presentSafely(definition: ActionDefinition, args: Record<string, unknown>, outcome: ActionOutcome) {
  try {
    return definition.present?.(args, outcome)
  } catch {
    return undefined
  }
}

const DEFAULT_SCOPES: ScopeKind[] = ['case', 'explore']

export function isCaseScope(scope: ActionScope): scope is CaseScope {
  return scope.kind === 'case'
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
