// mini-cordis B4：事件系统——五种派发与 waterfall。
// 参照物：deepseek-harness-master/vendor/cordis/src/events.ts（EventsService 的
// dispatch/parallel/serial/bail/waterfall/register 段）。
//
// 五种派发（语义照抄真源码）：
//   emit      —— 同步广播，不等待、忽略返回值；listener 同步抛错照常上抛（fail-loud）
//   parallel  —— 全并发 await（allSettled），任一 reject 则 AggregateError 汇总上抛
//   serial    —— 顺序 await；listener 返回 bail 值即停并返回该值
//   bail      —— serial 的同步版
//   waterfall —— around 中间件：listener 收 (...eventArgs, next)，调 next() 委托
//                后继（可改写返回值），不调 = 否决（后继与 inner 都不执行）。
//                inner 是调用者传入的最后一个参数——类型上恰好占据事件签名里
//                next 的位置，"调用者提供兜底行为"由类型逼你写出来。
//
// bail 判定铁律（isBailed）：返回值 !== null && !== false && !== undefined 才算停。
// 写成 truthy 判定会把 0/''/NaN 误判为 bail（roadmap 预埋的危险点）。
//
// 监听器的生命周期归属与 provide 同款：插件内 on → disposer 走 B3 effect
// （卸载自动摘监听器，级联卸载顺带清干净子树）；root 上 on → 返回 disposer 手动管。
//
// 已知裁剪（真 cordis 有、mini 不做）：
//   - thisArg 首参探测与 Context.filter 过滤（B5 isolate 讲原理）
//   - prepend/global 选项、once、internal/* 框架事件

/** 取函数参数元组（cosmokit 同名工具的最小版）。 */
export type Parameters<F> = F extends (...args: infer P) => any ? P : never
/** 取函数返回类型。 */
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never

/**
 * 事件表：用户用 declaration merging 自己长出来（与 B1 的服务类型同一姿势）：
 *
 *   declare module '../cordis/events.js' {
 *     interface Events { 'demo/text'(s: string): void }
 *   }
 *
 * waterfall 类事件的最后一个参数是 next，由派发方在调用时以"兜底行为"填充。
 */
export interface Events {}

import type { Fiber } from './fiber.js'

/** bail 判定：非 null/false/undefined 的返回值都会让 serial/bail 停下来。 */
export function isBailed(value: unknown): boolean {
  return value !== null && value !== false && value !== undefined
}

/** 已注册的单条监听器记录。 */
export interface Hook {
  callback: (...args: any[]) => any
}

/** 一棵上下文树一个事件域：共享 Map（挂在 ServiceBag 上随树传递）。 */
export type HookMap = Map<string, Hook[]>

/** 取（必要时建立）某事件名的监听器列表。 */
export function getHooks(events: HookMap, name: string): Hook[] {
  const hooks = events.get(name) ?? []
  events.set(name, hooks)
  return hooks
}

/** 按 identity 摘除监听器；返回是否找到并删除（on 返回的 disposer 的返回值）。 */
function unregister(hooks: Hook[], hook: Hook): boolean {
  const index = hooks.indexOf(hook)
  if (index >= 0) {
    hooks.splice(index, 1)
    return true
  }
  return false
}

/**
 * 注册监听器。fiber 存在（插件内）→ 走 B3 effect，卸载自动摘除；
 * root（无 fiber）→ 直接登记，disposer 由调用者手动管理。
 * 返回 disposer：摘除该监听器，返回是否仍处于注册状态。
 */
export function onEvent(
  hooks: Hook[],
  fiber: Fiber | undefined,
  name: string,
  listener: (...args: any[]) => any,
): () => boolean {
  const hook: Hook = { callback: listener }
  const disposer = () => unregister(hooks, hook)
  if (fiber) {
    fiber.effect(() => {
      hooks.push(hook)
      // effect 通道只收 void 语义的 disposer（B3 纪律）；boolean 返回值
      // 是 on 公开 API 的语义，留给 on 的直接调用者
      return () => void disposer()
    }, `ctx.on(${JSON.stringify(name)})`)
  } else {
    hooks.push(hook)
  }
  return disposer
}

/** emit：同步广播；快照监听器列表，派发中增删同事件监听不影响本轮。 */
export function emitEvent(hooks: readonly Hook[], args: unknown[]): void {
  for (const { callback } of [...hooks]) callback(...args)
}

/** parallel：全并发 await；任一 reject 时汇总为 AggregateError 上抛（不吞错）。 */
export async function parallelEvent(hooks: readonly Hook[], args: unknown[]): Promise<void> {
  const results = await Promise.allSettled([...hooks].map(({ callback }) => callback(...args)))
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (errors.length) throw new AggregateError(errors.map(e => e.reason))
}

/** serial：顺序 await，遇 bail 值即停并返回它；全部走完返回 undefined。 */
export async function serialEvent(hooks: readonly Hook[], args: unknown[]): Promise<unknown> {
  for (const { callback } of [...hooks]) {
    const result = await callback(...args)
    if (isBailed(result)) return result
  }
}

/** bail：serial 的同步版（不 await，listener 返回 promise 视为非 bail 值）。 */
export function bailEvent(hooks: readonly Hook[], args: unknown[]): unknown {
  for (const { callback } of [...hooks]) {
    const result = callback(...args)
    if (isBailed(result)) return result
  }
}

/**
 * waterfall：around 中间件链。args 的最后一项是 inner（兜底行为）；
 * next 闭包链逐个 shift 监听器，耗尽后落到 inner。listener 不调 next = 否决：
 * 后继监听器与 inner 都不执行，链的返回值就是该 listener 自己的返回值。
 */
export function waterfallEvent(hooks: readonly Hook[], args: unknown[]): unknown {
  const cbs = [...hooks].map(hook => hook.callback)
  const inner = args.pop() as (...args: any[]) => any
  const next = () => {
    const cb = cbs.shift() ?? inner
    return cb(...args)
  }
  args.push(next)
  return next()
}
