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
//   3. `provide` 返回 disposer——B3 的 effect 模型会接管这些 disposer，
//      实现"插件卸载 = 注册全部回滚"。
//
// 与真 cordis 的已知差异（B2/B3 起逐步补齐或明确放弃）：
//   - get 陷阱不做 inject 声明校验（真版：'cannot get property without inject'），
//     B2 引入 Fiber 后补上
//   - 无 effect/事件系统（B3/B4）
//   - 同名服务覆盖时直接替换并返回恢复型 disposer（真版走 reflect.provide 的 check 流程）

type ServiceBag = {
  services: Map<string, unknown>
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
  constructor(parent?: Context) {
    const bag: ServiceBag = { services: new Map(), parent }
    bags.set(this, bag)
    const proxy = new Proxy(this, contextProxyHandler)
    bags.set(proxy, bag)
    return proxy
  }

  /**
   * 注册服务到本层（同名覆盖旧值，父层不受影响）。
   * 返回 disposer：只删除"仍然是自己的"注册，幂等，不误删后来的提供者，
   * 也不恢复旧值（恢复会让已卸载的提供者复活；子层卸载后自然回落到父层同名服务，
   * 因为查找是沿父链走的，不需要 restore）。
   * B3 起 disposer 由 effect 统一收集，插件卸载时自动调用。
   */
  provide(name: string, service: unknown): () => void {
    const bag = bags.get(this)
    if (!bag) throw new Error('[mini-cordis] provide() 必须通过 ctx 实例调用（不要解构方法）')
    bag.services.set(name, service)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (bag.services.get(name) === service) bag.services.delete(name)
    }
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
}
