// B4 单测：事件系统——五种派发与 waterfall。
// 覆盖：emit 同步广播、parallel 并发/AggregateError、serial 顺序与 bail 判定
// （false/undefined 不停）、bail 同步版、waterfall 改写链与否决、
// 卸载/级联自动摘监听器（B3 红利）、root 手动 on、多树事件域隔离。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ---------- 事件表（declaration merging：类型由用户 merge 进框架） ----------

declare module '../cordis/events.js' {
  interface Events {
    'demo/text'(s: string): void
    'demo/maybe'(n: number): number | false | undefined
    'demo/flow'(input: string, next: () => string): string
    'demo/async'(n: number): Promise<number>
  }
}

// ---------- emit：同步广播 ----------

test('emit：同步广播，不等待、按注册顺序派发、忽略返回值', () => {
  const ctx = new Context()
  const seen: string[] = []
  ctx.on('demo/text', s => { seen.push(`a:${s}`); return 'ignored' })
  ctx.on('demo/text', s => { seen.push(`b:${s}`) })
  ctx.emit('demo/text', 'hi')
  assert.deepEqual(seen, ['a:hi', 'b:hi'])
})

// ---------- parallel：全并发 await ----------

test('parallel：等待全部 listener 结算（含异步）', async () => {
  const ctx = new Context()
  const done: number[] = []
  ctx.on('demo/async', async n => { await delay(15); done.push(n); return n })
  ctx.on('demo/async', async n => { await delay(5); done.push(n * 10); return n * 10 })
  await ctx.parallel('demo/async', 1)
  assert.deepEqual(done.sort((a, b) => a - b), [1, 10])
})

test('parallel：任一 reject 时以 AggregateError 汇总上抛，其余 listener 照常完成', async () => {
  const ctx = new Context()
  let good = false
  ctx.on('demo/async', async () => { await delay(5); good = true; return 0 })
  ctx.on('demo/async', async () => { throw new Error('boom') })
  await assert.rejects(
    () => ctx.parallel('demo/async', 1),
    (error: unknown) => error instanceof AggregateError,
  )
  assert.equal(good, true) // allSettled：不因一个失败中断其他
})

// ---------- serial：顺序 await + bail 判定 ----------

test('serial：顺序 await，bail 值即停并返回；null/false/undefined 不算 bail', async () => {
  const ctx = new Context()
  const calls: string[] = []
  ctx.on('demo/maybe', n => { calls.push('l1'); return false })   // 不停（危险点：非 truthy 判定）
  ctx.on('demo/maybe', n => { calls.push('l2'); return undefined }) // 不停
  ctx.on('demo/maybe', n => { calls.push('l3'); return n + 7 })   // 停，返回
  ctx.on('demo/maybe', n => { calls.push('l4'); return 999 })
  const result = await ctx.serial('demo/maybe', 1)
  assert.deepEqual(calls, ['l1', 'l2', 'l3'])
  assert.equal(result, 8)
})

// ---------- bail：同步版 ----------

test('bail：同步顺序派发，遇 bail 值即停并返回它', () => {
  const ctx = new Context()
  const calls: string[] = []
  ctx.on('demo/maybe', n => { calls.push('l1'); return undefined })
  ctx.on('demo/maybe', n => { calls.push('l2'); return n * 2 })
  ctx.on('demo/maybe', n => { calls.push('l3'); return -1 })
  const result = ctx.bail('demo/maybe', 21)
  assert.deepEqual(calls, ['l1', 'l2'])
  assert.equal(result, 42)
})

// ---------- waterfall：around 中间件 ----------

test('waterfall：外层先跑，next() 委托后继，返回值可逐层改写', () => {
  const ctx = new Context()
  ctx.on('demo/flow', (input, next) => next() + '>L1') // 先注册 = 最外层，最先被调
  ctx.on('demo/flow', (input, next) => next() + '>L2') // 后注册 = 内层
  const result = ctx.waterfall('demo/flow', 'x', () => 'core')
  assert.equal(result, 'core>L2>L1') // next 链：L1 → L2 → inner，返回值逐层包回去
})

test('waterfall：不调 next() 即否决——后继监听器与兜底 inner 都不执行', () => {
  const ctx = new Context()
  let reached = false
  ctx.on('demo/flow', (input, next) => 'veto')
  ctx.on('demo/flow', (input, next) => { reached = true; return next() })
  const result = ctx.waterfall('demo/flow', 'x', () => 'core')
  assert.equal(result, 'veto')
  assert.equal(reached, false)
  // inner 没执行：若执行了会返回 'core'
})

// ---------- 生命周期：监听器随 fiber 走（B3 红利） ----------

test('插件内 on：卸载自动摘监听器；级联卸载顺带清干净子树', async () => {
  const ctx = new Context()
  const seen: string[] = []
  const parent = ctx.plugin({
    name: 'bus-owner',
    apply(inner) {
      inner.on('demo/text', s => { seen.push(`child:${s}`) })
      inner.plugin({
        name: 'leaf',
        apply: leaf => leaf.on('demo/text', s => { seen.push(`grand:${s}`) }),
      })
    },
  })
  ctx.emit('demo/text', 'a')
  assert.deepEqual(seen, ['child:a', 'grand:a'])
  await parent.dispose()
  ctx.emit('demo/text', 'b')
  assert.deepEqual(seen, ['child:a', 'grand:a']) // 两条监听器都随树消失
})

test('root 上手动 on：disposer 摘除，返回是否仍处于注册状态（幂等）', () => {
  const ctx = new Context()
  const seen: string[] = []
  const off = ctx.on('demo/text', s => { seen.push(s) })
  ctx.emit('demo/text', 'a')
  assert.deepEqual(seen, ['a'])
  assert.equal(off(), true)  // 摘除成功
  assert.equal(off(), false) // 再摘：已不在册
  ctx.emit('demo/text', 'b')
  assert.deepEqual(seen, ['a'])
})

// ---------- 事件域归属：一棵树一个 bus ----------

test('两棵独立的 Context 树事件域互不干扰', () => {
  const a = new Context()
  const b = new Context()
  const seen: string[] = []
  a.on('demo/text', s => { seen.push(`a:${s}`) })
  b.emit('demo/text', 'x')
  a.emit('demo/text', 'y')
  assert.deepEqual(seen, ['a:y'])
})
