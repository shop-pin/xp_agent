// B2 单测：插件三形态、Fiber 状态机、依赖等待时序。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { Service } from '../cordis/service.js'
import type { Fiber } from '../cordis/fiber.js'

// ---------- 玩具插件 ----------

// 类形态：构造器即入口，借 Service 基类注册服务
class PingService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ping')
  }
  pong(): string {
    return 'pong'
  }
}

// 消费者插件：依赖 ping，把它转成自己的 greeting 服务（验证插件 provide 对兄弟可见）
const consumerPlugin = {
  name: 'consumer',
  inject: ['ping'],
  apply(ctx: Context) {
    ctx.provide('greeting', `hello from ${ctx.require<PingService>('ping').pong()}`)
  },
}
declare module '../cordis/context.js' {
  interface Context {
    ping?: PingService
    greeting?: string
  }
}

// ---------- 三形态 ----------

test('对象形态：apply 执行、config 传参可达', () => {
  const ctx = new Context()
  let seen: unknown
  const fiber = ctx.plugin({ name: 'obj', apply: (_ctx: Context, config: unknown) => { seen = config } }, { n: 42 })
  assert.equal(fiber.state, 'active')
  assert.deepEqual(seen, { n: 42 })
})

test('箭头函数形态：函数体即 apply', () => {
  const ctx = new Context()
  let ran = false
  const fiber = ctx.plugin(() => { ran = true })
  assert.equal(ran, true)
  assert.equal(fiber.name, '<anonymous>') // 箭头函数无名字
})

test('类形态：构造器执行，Service 子类的服务立即可用', () => {
  const ctx = new Context()
  const fiber = ctx.plugin(PingService)
  assert.equal(fiber.state, 'active')
  assert.equal(fiber.name, 'PingService')
  assert.equal(ctx.ping?.pong(), 'pong')
})

// ---------- 依赖等待时序三连 ----------

test('依赖先到：挂载即 active，apply 恰好执行一次', () => {
  const ctx = new Context()
  new PingService(ctx)
  let count = 0
  const fiber = ctx.plugin({ inject: ['ping'], apply: () => { count++ } })
  assert.equal(fiber.state, 'active')
  assert.equal(count, 1)
})

test('依赖后到：先挂载扣在 pending，provide 后自动激活（apply 只跑一次）', () => {
  const ctx = new Context()
  let count = 0
  const fiber = ctx.plugin({ inject: ['ping'], apply: () => { count++ } })
  assert.equal(fiber.state, 'pending')
  assert.equal(count, 0)
  new PingService(ctx) // 落表触发通知
  assert.equal(fiber.state, 'active')
  assert.equal(count, 1)
})

test('依赖永远不到：保持 pending，不执行 apply', () => {
  const ctx = new Context()
  let ran = false
  const fiber = ctx.plugin({ inject: ['nope'], apply: () => { ran = true } })
  assert.equal(fiber.state, 'pending')
  assert.equal(ran, false)
})

// ---------- 级联与共享 ----------

test('插件的 provide 对兄弟插件可见（共享服务表）', () => {
  const ctx = new Context()
  ctx.plugin(PingService)
  const fiber = ctx.plugin(consumerPlugin) // 依赖 ping，激活后 provide greeting
  assert.equal(fiber.state, 'active')
  assert.equal(ctx.greeting, 'hello from pong')
})

test('嵌套挂载：apply 里 ctx.plugin(子插件)，子依赖父链上的服务', () => {
  const ctx = new Context()
  ctx.plugin(PingService)
  let childFiber: Fiber | undefined
  ctx.plugin({
    name: 'parent',
    apply(innerCtx) {
      childFiber = innerCtx.plugin({ inject: ['ping'], apply: () => {} })
    },
  })
  assert.equal(childFiber?.state, 'active')
})

test('多个 pending 一次 provide 全部解扣（激活链递归）', () => {
  const ctx = new Context()
  const states: string[] = []
  const f1 = ctx.plugin({ inject: ['ping'], apply: () => { states.push('f1') } })
  const f2 = ctx.plugin({ inject: ['ping'], apply: () => { states.push('f2') } })
  assert.deepEqual(states, [])
  new PingService(ctx)
  assert.equal(f1.state, 'active')
  assert.equal(f2.state, 'active')
  assert.deepEqual(states.sort(), ['f1', 'f2'])
})

test('apply 抛错：挂载点上抛（带插件名），失败不阻塞后续挂载', () => {
  const ctx = new Context()
  new PingService(ctx)
  // fail-loud：错误直接从 ctx.plugin 抛出（refreshPendingFibers 包装插件名）
  assert.throws(
    () => ctx.plugin({
      name: 'boom',
      inject: ['ping'],
      apply: () => { throw new Error('kaboom') },
    }),
    /plugin <boom> apply failed: kaboom/,
  )
  const fine = ctx.plugin({ inject: ['ping'], apply: () => {} })
  assert.equal(fine.state, 'active')
})

test('provide 冲突抛错会让挂载失败并带上插件名', () => {
  const ctx = new Context()
  ctx.provide('taken', 1)
  assert.throws(
    () => ctx.plugin({ name: 'clash', apply: c => c.provide('taken', 2) }),
    /plugin <clash> apply failed.*has been registered/,
  )
})
