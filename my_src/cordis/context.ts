// mini-cordis B1：服务容器 Context。
// 参照物：deepseek-harness-master/vendor/cordis/src/context.ts（class Context）
// 与 reflect.ts（ReflectService.handler 的 get 陷阱）。
//
// 核心机制：
//   1. Context 实例被 Proxy 包裹，`ctx.<name>` 走 get 陷阱做服务查找——
//      命中返回服务实例，未命中沿父链查找，仍没有则抛错。
//   2. 内部状态存 WeakMap（key 同时挂 raw 实例与 proxy 两个身份），
//      而不是私有字段：Proxy 会改变 this 的身份，#private 品牌检查会在
//      proxy 身份上直接 TypeError（见 dsh-B1.md 的 this 绑定一节）。
//   3. `provide` 返回 disposer；B3 起，插件内发起的 provide 其 disposer
//      自动收集进当前 fiber（"注册即可撤销"），effect/级联卸载见 fiber.ts
//
// 与真 cordis 的已知差异（后续章补齐或明确放弃）：
//   - get 陷阱不做 inject 声明校验（真版：'cannot get property without inject'）——
//     需要按 ctx 层追踪提供者归属，mini 版明确放弃，依赖纪律靠 inject 声明 + 评审
//   - 无事件系统（B4）；effect/级联卸载已在 B3 落地（见 fiber.ts）
//   - 假设单树运行（全局 pending 队列），见 registry.ts

import type { EffectExecute, Plugin } from './fiber.js'
import { Fiber } from './fiber.js'
import { resolvePlugin, trackPending, refreshPendingFibers } from './registry.js'
import { notifyProvided } from './hooks.js'
import {
  getHooks, onEvent, emitEvent, parallelEvent, serialEvent, bailEvent, waterfallEvent,
} from './events.js'
import type { Events, Parameters, ReturnType, Hook, HookMap } from './events.js'

type ServiceBag = {
  services: Map<string, unknown>
  /** 事件域整树共享（B4）——与 services 同一传递方式：根部创建，子层拿引用。 */
  events: HookMap
  parent?: Context
}

const MISSING: unique symbol = Symbol('mini-cordis.missing')

// key 同时挂 raw 实例与 proxy：构造函数里 `this` 是 raw，而使用者手里的引用
// 是 proxy。同一份 bag 挂两个 key，查找/注册无论从哪个身份进来都能命中。
const bags = new WeakMap<Context, ServiceBag>()

function lookup(ctx: Context, name: string): unknown {
  let current: Context | undefined = ctx
  while (current) {
    const bag = bags.get(current)
    if (bag?.services.has(name)) return bag.services.get(name)
    current = bag?.parent
  }
  return MISSING
}

const contextProxyHandler: ProxyHandler<Context> = {
  get(target, prop) {
    // symbol 键（node:test、util.inspect 等内部机制会读）不做服务查找
    if (typeof prop !== 'string') return Reflect.get(target, prop, target)
    // thenable 安全：`await ctx` 时 JS 会读 `ctx.then`，若这里抛错会把
    // 普通使用变成莫名其妙 rejection；返回 undefined 即"不是 thenable"
    if (prop === 'then') return undefined
    // 自有属性与原型链方法（get/provide/require/has/constructor/toString...）
    // 优先于服务查找——因此服务不许与这些名字冲突（已知限制）。
    // receiver 传 target（raw 实例）：方法内的 `this` 必须是 WeakMap 挂过 key 的身份
    if (Reflect.has(target, prop)) return Reflect.get(target, prop, target)
    const found = lookup(target, prop)
    if (found === MISSING) {
      throw new Error(
        `[mini-cordis] service "${prop}" is not provided`
        + `（ctx.${prop} 是严格读取；可空读取请用 ctx.get("${prop}")）`,
      )
    }
    return found
  },
  has(target, prop) {
    if (Reflect.has(target, prop)) return true
    return typeof prop === 'string' && lookup(target, prop) !== MISSING
  },
}

export class Context {
  /**
   * 本上下文归属的 fiber（生命周期所有者）。root context 没有 fiber；
   * 插件的 child context 在 plugin() 里指认。effect 必须有 fiber 才有归属。
   * 与 get/provide 等自有成员一样，服务不许占用 "fiber" 这个名字（已知限制）。
   */
  fiber?: Fiber

  constructor(parent?: Context) {
    // B2 语义修正：整棵树共享一张服务表（真 cordis 的 store 按 isolate key 分槽，
    // 默认全树同名同槽；上下文树是"生命周期树"不是"服务表树"）。
    // parent 字段保留给查找兜底与 B5 的 isolate 讲解。
    const parentBag = parent ? bags.get(parent) : undefined
    const bag: ServiceBag = {
      services: parentBag?.services ?? new Map(),
      events: parentBag?.events ?? new Map(),
      parent,
    }
    bags.set(this, bag)
    const proxy = new Proxy(this, contextProxyHandler)
    bags.set(proxy, bag)
    return proxy
  }

  /**
   * 注册服务到本树（同名冲突直接抛错，与真 cordis 一致：
   * `service "x" has been registered at <fiber>`；要隔离实例请用 isolate，B5 讲原理）。
   * 返回 disposer：只删除"仍然是自己的"注册，幂等；B3 起由 effect 统一收集。
   * 落表后触发 notifyProvided 唤醒依赖等待中的 fiber。
   */
  provide(name: string, service: unknown): () => void {
    const bag = bags.get(this)
    if (!bag) throw new Error('[mini-cordis] provide() 必须通过 ctx 实例调用（不要解构方法）')
    if (bag.services.has(name)) {
      throw new Error(`[mini-cordis] service "${name}" has been registered already`)
    }
    bag.services.set(name, service)
    notifyProvided(name)
    let disposed = false
    const disposer = () => {
      if (disposed) return
      disposed = true
      if (bag.services.get(name) === service) bag.services.delete(name)
    }
    // B3：发生在插件 fiber 内的 provide，disposer 自动收集进该 fiber
    // （真 cordis 里 provide 本身就是一条 effect）。fiber 外的手动场景维持 B1 语义。
    const fiber = this.fiber
    if (fiber && (fiber.state === 'loading' || fiber.state === 'active')) {
      fiber.collect(disposer, `provide("${name}")`)
    }
    return disposer
  }

  /**
   * 注册一条随本 fiber 卸载自动执行的 effect（B3）：execute 立即执行，
   * 返回的 disposer 由 fiber 收集，dispose 时逆序执行。
   * 必须在插件 apply 内调用——root context 没有 fiber，注册无主，直接 fail-loud。
   */
  effect(execute: EffectExecute, label?: string): void {
    const fiber = this.fiber
    if (!fiber) {
      throw new Error('[mini-cordis] ctx.effect() requires a plugin fiber（请在插件 apply 内调用）')
    }
    fiber.effect(execute, label)
  }

  /**
   * 挂载插件（B2）。创建 fiber 专属的 child Context（生命周期边界），
   * 未就绪的依赖使 fiber 扣在 pending，由 provide 通知自动唤醒。
   * B3：子 fiber 的 dispose 注册为父 fiber 的一条 effect（级联卸载）——
   * 父卸载连带子卸载，孙随子，深度不限；root 上挂载的插件没有父 fiber，
   * 不参与级联（root 在 mini 版里不可卸载）。
   * 返回 Fiber 以便检查状态与显式 dispose。
   */
  plugin(pluginDef: Plugin, config?: unknown): Fiber {
    const child = new Context(this)
    const fiber = new Fiber(this, child, resolvePlugin(pluginDef), config)
    child.fiber = fiber
    const parentFiber = this.fiber
    if (parentFiber) {
      // disposer 本身可异步：父 fiber 卸载时会等待子 fiber 清理结算
      parentFiber.effect(() => () => fiber.dispose(), `child <${fiber.name}>`)
    }
    trackPending(fiber)
    refreshPendingFibers()
    return fiber
  }

  /** 可空读取：沿父链查找，找不到返回 undefined，不抛错。 */
  get<T = unknown>(name: string): T | undefined {
    const found = lookup(this, name)
    return found === MISSING ? undefined : (found as T)
  }

  /** 严格读取：找不到直接抛错（与 `ctx.<name>` 同一语义，但名字可以是运行时字符串）。 */
  require<T = unknown>(name: string): T {
    const found = lookup(this, name)
    if (found === MISSING) {
      throw new Error(`[mini-cordis] service "${name}" is not provided（require 严格读取）`)
    }
    return found as T
  }

  /** 是否可解析到该服务（含父链）。 */
  has(name: string): boolean {
    return lookup(this, name) !== MISSING
  }

  // ---------- 事件系统（B4）：五种派发 + on，语义照抄 vendor/cordis events.ts ----------

  /** 取（必要时建立）事件名对应的监听器列表；顺带做解构调用守卫。 */
  private eventHooks(name: string): Hook[] {
    const bag = bags.get(this)
    if (!bag) throw new Error('[mini-cordis] 事件方法必须通过 ctx 实例调用（不要解构方法）')
    return getHooks(bag.events, name)
  }

  /**
   * 注册监听器。插件内调用 → disposer 走 B3 effect（卸载自动摘除，
   * 级联卸载顺带清干净子树）；root 上调用 → 返回 disposer 手动管理。
   * 事件类型来自用户 declaration merging 的 Events 接口（同服务类型的手法）。
   */
  on<K extends keyof Events>(name: K, listener: Events[K]): () => boolean {
    return onEvent(this.eventHooks(name as string), this.fiber, name as string, listener as (...args: any[]) => any)
  }

  /** 同步广播：不等待、忽略返回值；listener 同步抛错照常上抛。 */
  emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void {
    emitEvent(this.eventHooks(name as string), args)
  }

  /** 全并发 await；任一 reject 时以 AggregateError 汇总上抛。 */
  parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void> {
    return parallelEvent(this.eventHooks(name as string), args)
  }

  /** 顺序 await；listener 返回非 null/false/undefined 即停（bail），返回该值。 */
  serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<Awaited<ReturnType<Events[K]> | undefined>> {
    return serialEvent(this.eventHooks(name as string), args) as Promise<Awaited<ReturnType<Events[K]> | undefined>>
  }

  /** serial 的同步版：不 await，遇 bail 值即停并返回它。 */
  bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]> {
    return bailEvent(this.eventHooks(name as string), args) as ReturnType<Events[K]>
  }

  /**
   * around 中间件链：listener 收 (...eventArgs, next)，调 next() 委托后继
   * （可改写返回值），不调 = 否决（后继与兜底都不执行）。
   * 调用方在最后一个参数位置传入兜底行为 inner——类型上恰好占据事件签名里
   * next 的位置。
   */
  waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]> {
    return waterfallEvent(this.eventHooks(name as string), args) as ReturnType<Events[K]>
  }
}
