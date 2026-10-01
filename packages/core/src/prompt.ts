import { Context, Service } from '@deepseek-ai/cordis'
import type { ActionDefinition, CaseScope } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    prompt: PromptService
  }
}

export interface PromptSection {
  id: string
  /** Thứ tự tăng dần; section có `order` nhỏ đứng trước. */
  order: number
  render(scope: CaseScope, actions: ActionDefinition[]): string | undefined
}

/**
 * Dựng prompt gửi cho agent từ các section do plugin đóng góp.
 *
 * ACP không có system prompt riêng, nên toàn bộ chỉ dẫn nằm trong lượt prompt đầu tiên.
 */
export class PromptService extends Service {
  private readonly sections = new Map<string, PromptSection>()

  constructor(ctx: Context) {
    super(ctx, 'prompt')
  }

  section(section: PromptSection) {
    return this.ctx.effect(() => {
      this.sections.set(section.id, section)
      return () => { this.sections.delete(section.id) }
    }, `prompt.section(${section.id})`)
  }

  build(scope: CaseScope, actions: ActionDefinition[]) {
    return [...this.sections.values()]
      .sort((a, b) => a.order - b.order)
      .map((s) => s.render(scope, actions)?.trim())
      .filter(Boolean)
      .join('\n\n')
  }
}
