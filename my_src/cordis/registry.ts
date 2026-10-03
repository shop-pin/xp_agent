// mini-cordis B2：插件注册表——三形态归一化 + pending 依赖等待队列。
// 参照物：deepseek-harness-master/vendor/cordis/src/registry.ts（插件归一化段）。
//
// 依赖等待的机制：
//   - fiber 挂载时若 inject 未齐 → 进 pendingFibers 集合挂起
//   - 任何 provide() 落表 → hooks.onProvide（本模块加载时订阅）→ 全量重查 pending 集
//   - refresh() 幂等，重复调用无害；激活/死亡即出队
//
// 已知简化（真 cordis 用 epoch 精确失效，且按 fiber 归树）：mini 版假设单树运行，
// 所有 pending fiber 共享一个全局集合。

import { onProvide } from './hooks.js'
import type { Context } from './context.js'
import type { Fiber, Plugin, PluginObject } from './fiber.js'

/**
 * 插件三形态归一化为 PluginObject：
 *   - 对象形态：原样返回（name/inject/apply）
 *   - 箭头函数形态：函数体即 apply（箭头函数没有 prototype）
 *   - 类形态：构造函数即入口，包一层 new（Service 子类插件靠构造器注册服务）
 *
 * 已知限制：带 prototype 的普通 function 会被当类处理（new 调用）——
 * 函数形态请一律用箭头函数，与 cordis 教程的约定一致。
 */
export function resolvePlugin(plugin: Plugin): PluginObject {
  if (typeof plugin === 'function') {
    if (plugin.prototype !== undefined) {
      const Cls = plugin as new (ctx: Context, config: unknown) => void
      return { name: plugin.name, apply: (ctx, config) => void new Cls(ctx, config) }
    }
    return { name: plugin.name, apply: plugin as (ctx: Context, config: unknown) => void }
  }
  return plugin
}

const pendingFibers = new Set<Fiber>()

export function trackPending(fiber: Fiber): void {
  pendingFibers.add(fiber)
}

/** 重查等待队列：依赖已齐的 fiber 逐个 refresh，状态离开 pending 即出队。 */
export function refreshPendingFibers(): void {
  for (const fiber of [...pendingFibers]) {
    if (fiber.state !== 'pending') {
      pendingFibers.delete(fiber)
      continue
    }
    try {
      fiber.refresh()
    } catch (error) {
      pendingFibers.delete(fiber)
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[mini-cordis] plugin <${fiber.name}> apply failed: ${message}`)
    }
    if (fiber.state !== 'pending') pendingFibers.delete(fiber)
  }
}

// 模块加载时订阅一次：任何 provide 落表都会唤醒等待队列。
onProvide(refreshPendingFibers)
