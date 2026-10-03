// mini-cordis B2：插件与 Fiber。
// 参照物：deepseek-harness-master/vendor/cordis/src/fiber.ts（状态机段：FiberState、
// 构造时的 parent.extend）与 registry.ts（插件三形态归一化）。
//
// Fiber = 一个插件实例的运行时。状态机：
//   pending  —— 已挂载，但 inject 声明的依赖尚未齐备，apply 未执行
//   loading  —— 依赖齐备，apply 执行中（mini 版 apply 只支持同步；真 cordis 支持异步）
//   active   —— apply 正常返回，插件生效
//   disposed —— apply 抛错或（B3 起）被显式卸载
//
// 关键语义（与真 cordis 对齐）：
//   - 每个 fiber 拥有自己的 child Context（作用域/生命周期的边界），但服务表
//     整棵树共享——上下文树是"生命周期树"，不是"服务表树"（B1 的遮蔽语义
//     在 B2 被修正，见 dsh-B2.md 第 1 节）
//   - apply 只执行一次；依赖晚到时由 registry 的 provide 通知唤醒 refresh

import type { Context } from './context.js'

/** 对象形态插件：name/inject/apply 三件套（todo 插件就是这个形状）。 */
export interface PluginObject {
  name?: string
  /** 依赖的服务名列表；全部可解析后才执行 apply，否则扣在 pending。 */
  inject?: string[]
  apply(ctx: Context, config: unknown): void
}

export type Plugin =
  | PluginObject
  | ((ctx: Context, config: unknown) => void)
  | (new (ctx: Context, config: unknown) => void)

export type FiberState = 'pending' | 'loading' | 'active' | 'disposed'

export class Fiber {
  readonly name: string
  readonly inject: readonly string[]
  readonly ctx: Context
  state: FiberState = 'pending'

  constructor(
    private readonly parentCtx: Context,
    ctx: Context,
    private readonly pluginDef: PluginObject,
    private readonly config: unknown,
  ) {
    this.ctx = ctx
    // 匿名箭头函数的 .name 是 ''（不是 undefined），用 || 而非 ??
    this.name = pluginDef.name || '<anonymous>'
    this.inject = pluginDef.inject ?? []
  }

  /**
   * 依赖齐备则执行 apply（恰好一次）。幂等：非 pending 状态直接返回。
   * 依赖未齐 → 静默留在 pending（registry 的 provide 通知会再次调它）。
   * apply 抛错 → 状态置 disposed 并上抛（fail-loud）。
   */
  refresh(): void {
    if (this.state !== 'pending') return
    for (const name of this.inject) {
      if (!this.parentCtx.has(name)) return
    }
    this.state = 'loading'
    try {
      this.pluginDef.apply(this.ctx, this.config)
      this.state = 'active'
    } catch (error) {
      this.state = 'disposed'
      throw error
    }
  }
}
