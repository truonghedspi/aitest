import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentDriver } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry
  }
}

/** Registry các agent driver. Runner chọn driver theo tên trong cấu hình. */
export class AgentRegistry extends Service {
  private readonly drivers = new Map<string, AgentDriver>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  register(driver: AgentDriver) {
    return this.ctx.effect(() => {
      if (this.drivers.has(driver.name)) throw new Error(`duplicate agent driver: ${driver.name}`)
      this.drivers.set(driver.name, driver)
      return () => { this.drivers.delete(driver.name) }
    }, `agents.register(${driver.name})`)
  }

  get(name: string) {
    const driver = this.drivers.get(name)
    if (!driver) {
      throw new Error(`agent driver not found: ${name}; registered: ${[...this.drivers.keys()].join(', ') || '(none)'}`)
    }
    return driver
  }

  list() {
    return [...this.drivers.values()]
  }
}
