// cordis.config.ts——第一版插件清单（B6 玩具 harness 的"用户侧"产物）。
// 框架（cordis/）不认识任何具体插件：清单声明"装什么、什么配置"，
// 插件表提供"名字 → 实现"的解析。换 provider 即换产品从这里开始。
//
// 玩具故事：core 提供全局 config 服务；greeter 依赖 config，用它的 title
// 拼问候语；clock 独立计时。三件套足够演示分层、禁用、乱序依赖激活。

import type { Context } from './cordis/context.js'
import type { Plugin } from './cordis/fiber.js'
import type { Row } from './cordis/loader.js'

export interface AppConfig {
  title: string
  suffix?: string
}

/** core：无依赖，提供 config 服务（只读视图，防插件改配置）。 */
const core: Plugin = {
  name: 'core',
  apply(ctx: Context, rawConfig: unknown) {
    const config = rawConfig as AppConfig
    ctx.provide('config', Object.freeze({ ...config }))
  },
}

/** greeter：inject config——配置行没带 core 行时扣 pending，乱序激活的演示主角。 */
const greeter: Plugin = {
  name: 'greeter',
  inject: ['config'],
  apply(ctx: Context) {
    const config = ctx.require<{ title: string; suffix?: string }>('config')
    const greet = (who: string) => `${config.title} says hi to ${who}${config.suffix ?? ''}`
    ctx.provide('greet', greet)
  },
}

/** clock：独立能力，"加一行 → 能力出现"的演示主角。 */
const clock: Plugin = {
  name: 'clock',
  apply(ctx: Context) {
    ctx.provide('clock', { startedAt: Date.now() })
  },
}

/** 插件表：resolve(name) 的静态映射（真框架是动态 import + 包清单校验，标注"略"）。 */
export const plugins: Record<string, Plugin> = { core, greeter, clock }

export function resolvePlugin(name: string): Plugin {
  const plugin = plugins[name]
  if (!plugin) throw new Error(`[mini-cordis] no plugin named "${name}"`)
  return plugin
}

/** base 层：随产品发布的默认清单。 */
export const baseRows: Row[] = [
  { id: 'core', name: 'core', config: { title: 'mini-harness' } },
  { id: 'greeter', name: 'greeter' },
]
