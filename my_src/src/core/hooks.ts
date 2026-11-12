// mini-cordis B2：框架内部通知钩子。
// provide() 落表后要唤醒"依赖等待中"的 fiber——但 context.ts 不能反向 import
// fiber/registry（会成环），所以把通知点抽成这个零依赖小模块：
//   context.ts --(notifyProvided)--> hooks.ts <--(onProvide)-- registry.ts
// 真 cordis 用 internal/update waterfall + fiber epoch 做精确失效；
// mini 版用"全量重查 pending 集"，语义超集、代价是每次 provide 扫一遍等待队列。
// B4 落地事件系统后，这个模块仍是框架内部机制，不暴露给插件。

const provideHooks = new Set<(name: string) => void>()

/** 订阅 provide 通知，返回取消订阅的 disposer。registry 在模块加载时订阅一次。 */
export function onProvide(fn: (name: string) => void): () => void {
  provideHooks.add(fn)
  return () => provideHooks.delete(fn)
}

/** provide 落表后调用；迭代快照，允许钩子在遍历中再触发 provide（递归深度=激活链长）。 */
export function notifyProvided(name: string): void {
  for (const fn of [...provideHooks]) fn(name)
}
