// mini-cordis B5：子上下文与作用域（scope）。
// 参照物：deepseek-harness-master/packages/core/scope/src/index.ts（createScope/
// bindScopeParent/scopeChainOf）与 store.ts（ScopedLayers 的分层 merge + effect 归属）。
//
// 核心认知（本章最重要的修正，见 dsh-B5.md 第 1 节）：
//   - 服务表整树共享、同名冲突抛错（B2 语义）——作用域的"隔离"不在服务表里
//   - dsh 的 per-agent 隔离分两层：cordis 的 isolate realm 管"服务行多实例"
//     （mini 不实现，只讲原理）；工具/注册表这类领域结构走 scope-key 分层
//     （本章实现的 ScopeLayers）——global 层铺底，scope 链从远到近覆盖，
//     **nearest scope wins**，"子遮蔽父"发生在分层注册表，不在服务表
//
// scope 的本体只有一个：一个匿名 fiber（dsh 的 `function scope(): void {}`）
// + 一个打上 scope 标签的子上下文。经 scope.ctx 做的一切注册（effect/事件/
// 分层注册表条目）自动归属该 fiber，dispose 一次回滚。

import type { Context } from './context.js'

/** 作用域的身份：opaque、按引用比较（Symbol 就够了）。 */
export type ScopeKey = object

/** 每个 scope key 的父 scope（注册视图沿它向下继承，事件收容沿它向上扩展）。 */
const scopeParents = new WeakMap<ScopeKey, ScopeKey>()

/** ctx → scope 标签。createScope 时打在 scope 的 ctx 上，沿 parent 链继承。 */
const scopeTags = new WeakMap<Context, ScopeKey>()

/**
 * 绑定 key 的父 scope（一次性；rebind 机制见 dsh 的 ScopeParentBinding，mini 裁剪）。
 * 环检测：每个消费者都要沿链走到根，闭环会让它们全部死循环。
 */
export function bindScopeParent(key: ScopeKey, parent: ScopeKey): void {
  if (scopeParents.has(key)) {
    throw new Error('[mini-cordis] scope key is already bound to a parent')
  }
  for (let cursor: ScopeKey | undefined = parent; cursor !== undefined; cursor = scopeParents.get(cursor)) {
    if (cursor === key) throw new Error('[mini-cordis] scope parent link would form a cycle')
  }
  scopeParents.set(key, parent)
}

/** 从 key 到根的链：nearest-first（[key, parent, grandparent, …]）。 */
export function scopeChainOf(key: ScopeKey | undefined): ScopeKey[] {
  const chain: ScopeKey[] = []
  for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) chain.push(cursor)
  return chain
}

/**
 * 读一个 ctx 归属的 scope 标签：沿 Context.parent 链向上找——scope 内挂的
 * 子插件（其 ctx 是 scope.ctx 的 child）自动继承标签，注册跟随 scope 层。
 * 这对应 dsh 里 `fiber.ctx.extend({ [kScope]: key })` 的属性继承行为。
 */
export function scopeOf(ctx: Context): ScopeKey | undefined {
  let current: Context | undefined = ctx
  while (current) {
    const tag = scopeTags.get(current)
    if (tag !== undefined) return tag
    current = current.parent
  }
  return undefined
}

/** scope 的壳：ctx 做注册入口，dispose 收口（透传 fiber 的幂等结算）。 */
export interface Scope {
  ctx: Context
  key: ScopeKey
  dispose(): Promise<void>
}

/** 匿名空插件：scope fiber 的骨架（dsh 的 `function scope(): void {}` 同款）。 */
function scopeFiber(): void {}

/**
 * 在 parent 下铸造一个作用域 = 匿名 fiber + 打标签的子上下文。
 * scope.ctx 能看到父链全部服务（服务查找沿 bag.parent 穿透），经它做的
 * 注册（ctx.effect / ctx.on / ScopeLayers.register）都归属 scope fiber，
 * dispose() 一次性回滚且幂等。key 必传：它是分层的身份，省不掉
 * （roadmap 的单参签名在这里与 dsh 分道，差异记入 dsh-B5.md）。
 */
export function createScope(parent: Context, key: ScopeKey, options?: { parent?: ScopeKey }): Scope {
  if (options?.parent !== undefined) bindScopeParent(key, options.parent)
  const fiber = parent.plugin(scopeFiber)
  const ctx = fiber.ctx
  scopeTags.set(ctx, key)
  return { ctx, key, dispose: () => fiber.dispose() }
}

/**
 * 分层注册表：一套 global 条目 + 每个 scope key 一层。
 *   写：register(ctx, …) 按 scopeOf(ctx) 落层；同层同名冲突抛错，
 *       不同层同名不冲突（这正是"同名不同实现"的位置）；undo 与空层回收
 *       挂 ctx.effect——条目生命周期自动跟随 scope fiber。
 *   读：resolve(scope) = global 铺底 + 沿 scope 链从最远祖先到本 scope 依次
 *       覆盖（nearest wins）；root 视图（scope=undefined）只有 global。
 */
export class ScopeLayers<V> {
  private readonly scoped = new Map<ScopeKey, Map<string, V>>()

  constructor(private readonly global = new Map<string, V>()) {}

  /** scope 层内的同名注册直接冲突（跨层同名是遮蔽，不是冲突）。 */
  register(ctx: Context, name: string, value: V): void {
    const scope = scopeOf(ctx)
    let target = scope === undefined ? this.global : this.scoped.get(scope)
    let created = false
    if (scope !== undefined && target === undefined) {
      target = new Map()
      this.scoped.set(scope, target)
      created = true
    }
    const layer = target!
    if (layer.has(name)) {
      const where = scope === undefined ? 'globally' : 'in this scope'
      throw new Error(`[mini-cordis] registry entry "${name}" has been registered ${where} already`)
    }
    layer.set(name, value)
    if (ctx.fiber !== undefined) {
      ctx.effect(() => () => {
        layer.delete(name)
        // 空层回收：undo 逆序清空后，scope 的层不留空壳
        if (scope !== undefined && layer.size === 0) this.scoped.delete(scope)
      }, `scope-registry.register("${name}")`)
    } else if (scope !== undefined) {
      // 有 scope 标签却没有 fiber 可挂（手工 new Context(scope.ctx) 这类）：
      // 条目将无法随 dispose 回滚，fail-loud 拒绝而非静默泄漏
      layer.delete(name)
      throw new Error('[mini-cordis] scope-layer registration requires a fiber（请经 scope.ctx 或其插件内 ctx 注册）')
    }
    // global 层 + 无 fiber（root）：条目随注册表生存——真 cordis 里 global
    // 挂在永不卸载的 root fiber 上，生存语义一致
  }

  /** 解析视图：global 铺底，key 链从最远祖先到本 scope 依次覆盖（nearest wins）。 */
  resolve(scope: ScopeKey | undefined): Map<string, V> {
    const merged = new Map(this.global)
    for (const key of scopeChainOf(scope).reverse()) {
      const layer = this.scoped.get(key)
      if (layer !== undefined) for (const [name, value] of layer) merged.set(name, value)
    }
    return merged
  }

  /** 便捷读取：解析后取单个条目。 */
  get(scope: ScopeKey | undefined, name: string): V | undefined {
    return this.resolve(scope).get(name)
  }
}
