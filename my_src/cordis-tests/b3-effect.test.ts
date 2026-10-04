// B3 单测：effect 模型——注册即可撤销。
// 覆盖：立即执行 + 逆序清理、async disposer 等待、dispose 幂等、
// 单个抛错不阻断、父子级联卸载（含 pending 子）、apply 抛错回滚、
// provide 自动收集、setInterval 清理、effect 归属校验。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ---------- effect 基本语义 ----------

test('effect：注册动作立即执行，disposer 逆序执行', async () => {
  const ctx = new Context()
  const order: string[] = []
  const fiber = ctx.plugin({
    name: 'stacked',
    apply(c) {
      c.effect(() => { order.push('setup:a'); return () => { order.push('teardown:a') } }, 'a')
      c.effect(() => { order.push('setup:b'); return () => { order.push('teardown:b') } }, 'b')
    },
  })
  assert.deepEqual(order, ['setup:a', 'setup:b']) // 立即执行，不等 dispose
  await fiber.dispose()
  assert.deepEqual(order, ['setup:a', 'setup:b', 'teardown:b', 'teardown:a']) // 后注册先拆
})

test('async disposer：dispose 的结算等待异步清理完成', async () => {
  const ctx = new Context()
  let done = false
  const fiber = ctx.plugin({
    name: 'slow',
    apply: c => c.effect(() => async () => { await delay(20); done = true }),
  })
  await fiber.dispose()
  assert.equal(done, true) // 若未 await 就判完成，这里会是 false
})

test('dispose 幂等：并发双调与二次调用只清理一次', async () => {
  const ctx = new Context()
  let count = 0
  const fiber = ctx.plugin({ name: 'once', apply: c => c.effect(() => () => { count++ }) })
  const p1 = fiber.dispose()
  const p2 = fiber.dispose() // 清理进行中重复调用
  await p1
  await p2
  await fiber.dispose() // 结算后再调
  assert.equal(count, 1)
})

test('单个 disposer 抛错只记日志，不阻断其他清理，dispose 正常结算', async () => {
  const ctx = new Context()
  const ran: string[] = []
  const fiber = ctx.plugin({
    name: 'messy',
    apply: c => {
      c.effect(() => () => { throw new Error('sync boom') }, 'sync-boom')
      c.effect(() => () => Promise.reject(new Error('async boom')), 'async-boom')
      c.effect(() => () => { ran.push('good') }, 'good')
    },
  })
  await fiber.dispose() // 不应 reject
  assert.deepEqual(ran, ['good'])
})

// ---------- 级联卸载 ----------

test('级联卸载：父 dispose → 子/孙 disposed，effect 与 provide 全部撤销', async () => {
  const ctx = new Context()
  const order: string[] = []
  const parent = ctx.plugin({
    name: 'parent',
    apply(inner) {
      inner.effect(() => () => { order.push('parent-effect') }, 'parent-e')
      inner.plugin({
        name: 'child',
        apply(mid) {
          mid.provide('child-svc', 1)
          mid.effect(() => () => { order.push('child-effect') }, 'child-e')
          mid.plugin({
            name: 'grandchild',
            apply: leaf => leaf.effect(() => () => { order.push('grand-effect') }),
          })
        },
      })
    },
  })
  assert.equal(ctx.has('child-svc'), true) // 共享表：插件 provide 全树可见
  await parent.dispose()
  assert.equal(parent.state, 'disposed')
  assert.deepEqual(order, ['grand-effect', 'child-effect', 'parent-effect']) // 逆序：孙先于子先于父
  assert.equal(ctx.has('child-svc'), false)
})

test('pending 中的子 fiber 被级联卸载：随后 provide 不复活它', async () => {
  const ctx = new Context()
  let applied = 0
  const parent = ctx.plugin({
    name: 'parent',
    apply: inner => void inner.plugin({ inject: ['nope'], apply: () => { applied++ } }),
  })
  await parent.dispose()
  ctx.provide('nope', 1) // 若已出队/已 disposed，这次 provide 不会唤醒它
  assert.equal(applied, 0)
})

// ---------- apply 抛错回滚 ----------

test('apply 中途抛错：已注册的 effect 与 provide 被回滚，错误照常上抛', () => {
  const ctx = new Context()
  let cleaned = false
  assert.throws(
    () => ctx.plugin({
      name: 'halffail',
      apply(c) {
        c.provide('temp', 1)
        c.effect(() => () => { cleaned = true })
        throw new Error('midway')
      },
    }),
    /plugin <halffail> apply failed: midway/,
  )
  assert.equal(cleaned, true) // 同步 disposer 在错误上抛前已执行
  assert.equal(ctx.has('temp'), false)
})

// ---------- provide 自动收集 ----------

test('provide 自动收集：插件内 provide 随卸载消失，root 手动 provide 不受影响', async () => {
  const ctx = new Context()
  ctx.provide('manual', 1) // B1 语义：root 上手动管理
  const fiber = ctx.plugin({ name: 'p', apply: c => c.provide('auto', 2) })
  assert.equal(ctx.get('auto'), 2)
  await fiber.dispose()
  assert.equal(ctx.has('auto'), false)
  assert.equal(ctx.has('manual'), true)
})

// ---------- 定时器清理 ----------

test('setInterval 随 dispose 停止（注册即可撤销的实效场景）', async () => {
  const ctx = new Context()
  let ticks = 0
  const fiber = ctx.plugin({
    name: 'ticker',
    apply: c => c.effect(() => {
      const timer = setInterval(() => { ticks++ }, 5)
      return () => clearInterval(timer)
    }),
  })
  await delay(30)
  const before = ticks
  assert.ok(before > 0, 'dispose 前计时器应在跑')
  await fiber.dispose()
  await delay(30)
  assert.equal(ticks, before, 'dispose 后不应再走针')
})

// ---------- 归属校验（fail-loud） ----------

test('effect 归属：root context 与已 disposed 的 fiber 都拒绝注册', async () => {
  const ctx = new Context()
  assert.throws(() => ctx.effect(() => () => {}), /requires a plugin fiber/)
  const fiber = ctx.plugin({ name: 'd', apply: () => {} })
  await fiber.dispose()
  assert.throws(() => fiber.ctx.effect(() => () => {}), /disposed fiber/)
})
