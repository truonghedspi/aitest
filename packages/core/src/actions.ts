import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import type { ActionCall, ActionDefinition, ActionOutcome, ActionScope, CallIntent, CaseScope, ScopeKind } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    actions: ActionRegistry
    evidence: import('./types.ts').EvidenceReader
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/** Bộ lọc action theo scope; trả `false` để ẩn action khỏi scope đó. */
export type ActionFilter = (def: ActionDefinition, owner: Fiber, scope: Pick<ActionScope, 'namespaces'> & { kind?: ScopeKind; env?: string }) => boolean

/**
 * Registry các action mà agent gọi được.
 *
 * Mỗi lần đăng ký là một effect gắn với plugin gọi `register`. Khi plugin đó
 * bị gỡ, action tự biến mất khỏi registry.
 */
export class ActionRegistry extends Service {
  /** Mỗi tên có một bản mặc định và tối đa một bản cho mỗi môi trường. */
  private readonly entries = new Map<string, Array<{ def: ActionDefinition; owner: Fiber; env?: string }>>()
  private readonly restricted = new Map<string, number>()
  private readonly filters = new Set<ActionFilter>()
  private seq = 0
  /** Lời gọi đang chạy: dùng để người dùng dừng đúng một lời gọi (`cancel`). */
  private readonly inflight = new Map<string, { scope: ActionScope; name: string; controller: AbortController; started: number }>()

  constructor(ctx: Context) {
    super(ctx, 'actions')
  }

  register(def: ActionDefinition) {
    if (!NAME_PATTERN.test(def.name)) throw new Error(`invalid action name: ${def.name}`)
    // `this.ctx` là context của plugin gọi `register`, nên fiber của nó là chủ sở hữu action.
    const owner = this.ctx.fiber
    // Plugin nạp theo môi trường (row `<id>@<env>`) đăng ký bản riêng của môi trường đó.
    const env = (this.ctx.get('kernel') as { envOf?(fiber: Fiber): string | undefined } | undefined)?.envOf?.(owner)
    return this.ctx.effect(() => {
      const list = this.entries.get(def.name) ?? []
      if (list.some((e) => e.env === env)) throw new Error(`duplicate action: ${def.name}${env ? ` in environment ${env}` : ''}`)
      const entry = { def, owner, env }
      this.entries.set(def.name, [...list, entry])
      return () => {
        const rest = (this.entries.get(def.name) ?? []).filter((e) => e !== entry)
        if (rest.length) this.entries.set(def.name, rest)
        else this.entries.delete(def.name)
      }
    }, `actions.register(${def.name}${env ? `@${env}` : ''})`)
  }

  /** Bản của action cho môi trường: bản riêng nếu có, nếu không thì bản mặc định. */
  private pick(name: string, env?: string) {
    const list = this.entries.get(name)
    if (!list) return undefined
    return (env ? list.find((e) => e.env === env) : undefined) ?? list.find((e) => !e.env)
  }

  /** Fiber của plugin đã đăng ký action (theo môi trường khi có). */
  ownerOf(name: string, env?: string) {
    return this.pick(name, env)?.owner
  }

  /**
   * Thêm bộ lọc ẩn action theo scope, ví dụ môi trường tắt một tool. Chỉ bớt đi, không thêm được.
   * Bộ lọc nhận định nghĩa, fiber chủ sở hữu và scope; trả `false` để ẩn.
   */
  filter(fn: ActionFilter) {
    return this.ctx.effect(() => {
      this.filters.add(fn)
      return () => { this.filters.delete(fn) }
    }, 'actions.filter')
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

  get(name: string, env?: string) {
    return this.pick(name, env)?.def
  }

  /** Mọi action mặc định đã đăng ký, kể cả action đang bị ẩn; dùng cho trang quản lý. */
  all() {
    return [...this.entries.keys()].map((name) => this.pick(name)?.def).filter((d): d is ActionDefinition => !!d)
  }

  /** Môi trường có bản riêng của action. */
  envsOf(name: string) {
    return (this.entries.get(name) ?? []).map((e) => e.env).filter((e): e is string => !!e)
  }

  /**
   * Danh sách action. Khi có `scope`, chỉ trả về action khai báo hỗ trợ loại scope đó, theo môi trường của scope.
   * Ở pha `agent`, danh sách còn bị giới hạn theo namespace; pha khác do người soạn plan
   * hoặc người dùng kiểm soát nên được dùng mọi action cùng loại scope.
   */
  list(scope?: Pick<ActionScope, 'namespaces'> & { kind?: ScopeKind; phase?: ActionScope['phase']; env?: string }) {
    const picked = [...this.entries.keys()]
      .filter((name) => !this.restricted.has(name))
      .map((name) => this.pick(name, scope?.env))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .filter((e) => !scope || [...this.filters].every((fn) => fn(e.def, e.owner, scope)))
    const all = picked.map((e) => e.def)
    if (!scope) return all
    const kind = scope.kind ?? 'case'
    const ofKind = all.filter((def) => (def.scopes ?? DEFAULT_SCOPES).includes(kind))
    if (scope.phase && scope.phase !== 'agent') return ofKind
    return ofKind.filter((def) => def.always || scope.namespaces.has(def.namespace))
  }

  /**
   * Dừng một lời gọi đang chạy (người dùng bấm Dừng trên thẻ tool). Action nhận `signal` bị huỷ;
   * lời gọi trả về ngay `status: error` kèm `annotations.cancelled`. Trả `false` khi lời gọi đã xong.
   */
  cancel(callId: string, reason = 'cancelled by the user'): boolean {
    const entry = this.inflight.get(callId)
    if (!entry) return false
    entry.controller.abort(reason)
    return true
  }

  /** Lời gọi đang chạy, lọc theo mã scope (ví dụ mã cuộc chat). */
  running(scopeId?: string) {
    return [...this.inflight.entries()]
      .filter(([, e]) => !scopeId || e.scope.id === scopeId)
      .map(([callId, e]) => ({ callId, name: e.name, scopeId: e.scope.id, phase: e.scope.phase, startedAt: e.started }))
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
      // Signal riêng của lời gọi: huỷ khi scope bị huỷ hoặc khi người dùng dừng đúng lời gọi này.
      const controller = new AbortController()
      const signal = AbortSignal.any([scope.signal, controller.signal])
      this.inflight.set(call.id, { scope, name, controller, started: Date.now() })
      // Lời gọi bị dừng (người dùng dừng, case quá thời gian, lượt chạy bị dừng) trả kết quả ngay,
      // kể cả khi action không tự dừng theo signal.
      const cancelled = new Promise<never>((_, reject) => {
        const stop = () => reject(controller.signal.aborted ? new CancelledError(controller.signal.reason) : new Error(`aborted: ${errorMessage(signal.reason ?? 'scope ended')}`))
        if (signal.aborted) stop()
        else signal.addEventListener('abort', stop, { once: true })
      })
      try {
        const running = Promise.resolve().then(() => definition.execute(call.args, { scope, callId: call.id, signal }))
        // Action không dừng theo signal có thể lỗi sau khi lời gọi đã trả về: bỏ qua lỗi muộn đó.
        running.catch(() => {})
        const value = await Promise.race([running, cancelled])
        outcome = { status: 'ok', value, durationMs: elapsed(), annotations: {} }
      } catch (error) {
        const stopped = error instanceof CancelledError
        outcome = { status: 'error', error: errorMessage(error), durationMs: elapsed(), annotations: stopped ? { cancelled: true } : {} }
      } finally {
        this.inflight.delete(call.id)
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

/** Lời gọi bị người dùng dừng; thông báo dặn agent không tự gọi lại. */
class CancelledError extends Error {
  constructor(reason: unknown) {
    super(`${typeof reason === 'string' ? reason : 'cancelled by the user'}; do not retry unless the user asks`)
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

const DEFAULT_SCOPES: ScopeKind[] = ['case', 'explore', 'prepare']

export function isCaseScope(scope: ActionScope): scope is CaseScope {
  return scope.kind === 'case'
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
