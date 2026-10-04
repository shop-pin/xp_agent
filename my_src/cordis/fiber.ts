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
//
// B3 增补（effect 模型：注册即可撤销）：
//   - ctx.effect(execute) 立即执行注册动作，把返回的 disposer 收进本 fiber
//   - fiber.dispose() 幂等（一次结算）：disposers 逆序启动、并发执行，
//     单个抛错只记日志不阻断其他清理
//   - 子 fiber 的 dispose 挂在父 fiber 的一条 effect 上（级联卸载，见 context.plugin）
//   - apply 中途抛错 → beginDispose 回滚已收集的 disposer（同步部分当场执行）
// 参照物：vendor/cordis/src/fiber.ts 的 Disposable/Effect 定义段与 _disposables。

import { untrackPending } from './registry.js'
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

/** 撤销函数：dispose 时执行，可异步。 */
export type Disposer = () => void | Promise<void>
/** effect 主体：执行注册动作，返回对应的撤销函数（同步返回）。 */
export type EffectExecute = () => Disposer | void

interface EffectRecord {
  run: Disposer
  label: string
}

export class Fiber {
  readonly name: string
  readonly inject: readonly string[]
  readonly ctx: Context
  state: FiberState = 'pending'

  /** 已收集、待 dispose 时逆序执行的撤销函数。 */
  private readonly _effects: EffectRecord[] = []
  /** 首次 dispose 的结算 promise：幂等闸，期间/之后的重复 dispose 共用它。 */
  private disposeTask: Promise<void> | undefined

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
   * 注册一条 effect：立即执行 execute，把返回的 disposer 收进本 fiber，
   * dispose 时逆序执行。已 disposed 的 fiber 上注册 → fail-loud 抛错
   * （真 cordis 的 INACTIVE_EFFECT 同款语义）。
   */
  effect(execute: EffectExecute, label = 'effect'): void {
    if (this.state === 'disposed') {
      throw new Error(`[mini-cordis] cannot create effect on disposed fiber <${this.name}>`)
    }
    const disposer = execute()
    if (typeof disposer === 'function') this._effects.push({ run: disposer, label })
  }

  /**
   * 收集一条既有 disposer（不执行任何动作）。provide 在插件内调用时
   * 由 context 自动把返回的 disposer 走这里——"注册即可撤销"对 provide 同样成立。
   */
  collect(disposer: Disposer, label = 'effect'): void {
    this._effects.push({ run: disposer, label })
  }

  /**
   * 卸载本 fiber。幂等：首次调用创建结算 promise，之后（含清理进行中）的
   * 调用返回同一个 promise。disposers 逆序启动、并发执行，单个抛错只记日志，
   * 不阻断、不影响其他清理；全部结算后 promise 才 resolve。
   */
  dispose(): Promise<void> {
    this.disposeTask ??= this.beginDispose()
    return this.disposeTask
  }

  /**
   * 状态闸 + 出队 + 逆序并发清理。dispose() 与 apply 失败回滚共用：
   * 先置 disposed（清理期间读状态者看到"已卸载"），再出队，再启动清理。
   * 同步 disposer 在本调用栈内当场执行——回滚顺序因此是确定的。
   */
  private beginDispose(): Promise<void> {
    this.state = 'disposed'
    untrackPending(this)
    const effects = this._effects.splice(0).reverse()
    const tasks = effects.map(({ run, label }) => {
      const onError = (error: unknown) => {
        console.error(`[mini-cordis] disposer failed during dispose of <${this.name}> (${label})`, error)
      }
      try {
        return Promise.resolve(run()).catch(onError)
      } catch (error) {
        onError(error)
        return Promise.resolve()
      }
    })
    return Promise.all(tasks).then(() => {})
  }

  /**
   * 依赖齐备则执行 apply（恰好一次）。幂等：非 pending 状态直接返回。
   * 依赖未齐 → 静默留在 pending（registry 的 provide 通知会再次调它）。
   * apply 抛错 → 回滚已收集的 effect 后状态置 disposed 并上抛（fail-loud）。
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
      // 回滚先于上抛：同步 disposer 在 beginDispose 里当场执行，
      // 异步部分进 disposeTask，挂载点的调用者拿到错误时清理已启动
      this.disposeTask = this.beginDispose()
      throw error
    }
  }
}
