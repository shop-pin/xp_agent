// B1 单测：服务容器 Context 与 Service 基类。
// 运行：npm run cordis（tsc && node --test dist/cordis-tests/）
// 这些"玩具插件"同时是类型断言：declaration merging 失效时 tsc 直接编不过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { Service } from '../cordis/service.js'

// ---------- 玩具插件（B2 之前，插件就是普通函数/类） ----------

export class GreeterService extends Service {
  constructor(ctx: Context, private greeting: string = 'hello') {
    super(ctx, 'greeter')
  }
  greet(name: string): string {
    return `${this.greeting}, ${name}`
  }
}
declare module '../cordis/context.js' {
  interface Context {
    greeter: GreeterService
  }
}

export class CounterService extends Service {
  private n = 0
  constructor(ctx: Context) {
    super(ctx, 'counter')
  }
  next(): number {
    return ++this.n
  }
}
declare module '../cordis/context.js' {
  interface Context {
    counter: CounterService
  }
}

// ---------- 测试 ----------

test('ctx.<name> 读取已提供服务，方法 this 正常', () => {
  const ctx = new Context()
  const greeter = new GreeterService(ctx)
  assert.equal(ctx.greeter, greeter)
  assert.equal(ctx.greeter.greet('world'), 'hello, world')
})

test('声明合并生效：ctx.greeter 有完整类型（编译期断言）', () => {
  const ctx = new Context()
  new GreeterService(ctx)
  const s: string = ctx.greeter.greet('merge')
  assert.equal(s, 'hello, merge')
})

test('读取未提供服务 → 抛错，错误信息含服务名', () => {
  const ctx = new Context()
  assert.throws(
    () => (ctx as unknown as Record<string, unknown>).missing,
    /service "missing" is not provided/,
  )
})

test('ctx.get 可空读取；ctx.require 严格读取', () => {
  const ctx = new Context()
  const greeter = new GreeterService(ctx)
  assert.equal(ctx.get('greeter'), greeter)
  assert.equal(ctx.get('nope'), undefined)
  assert.equal(ctx.require('greeter'), greeter)
  assert.throws(() => ctx.require('nope'), /"nope" is not provided/)
})

test('ctx.has 报告可解析性（含父链）', () => {
  const parent = new Context()
  new GreeterService(parent)
  const child = new Context(parent)
  assert.equal(parent.has('greeter'), true)
  assert.equal(child.has('greeter'), true)
  assert.equal(child.has('counter'), false)
})

test('子上下文继承父服务（同一实例）', () => {
  const parent = new Context()
  const counter = new CounterService(parent)
  const child = new Context(parent)
  assert.equal(child.counter, counter)
  assert.equal(child.counter.next(), 1)
  assert.equal(parent.counter.next(), 2) // 状态共享：就是同一个实例
})

test('子上下文遮蔽：同名 provide 覆盖本层，父层不受影响', () => {
  const parent = new Context()
  const parentCounter = new CounterService(parent)
  const child = new Context(parent)
  const childCounter = new CounterService(child)
  assert.equal(child.counter, childCounter)
  assert.equal(parent.counter, parentCounter)
  assert.notEqual(child.counter, parentCounter)
})

test('provide 返回的 disposer：卸载即删除、幂等、不误删后来的提供者', () => {
  const ctx = new Context()
  const disposeTemp = ctx.provide('temp', { v: 1 })
  assert.equal(ctx.get<{ v: number }>('temp')?.v, 1)
  disposeTemp()
  assert.equal(ctx.get('temp'), undefined)
  disposeTemp() // 二次调用安全

  const disposeFirst = ctx.provide('x', 'first')
  const disposeSecond = ctx.provide('x', 'second')
  disposeFirst() // 旧 disposer 不该动新提供者
  assert.equal(ctx.get('x'), 'second')
  disposeSecond()
  assert.equal(ctx.get('x'), undefined)
})

test('Context 自有方法优先于服务查找（同名服务换名，已知限制）', () => {
  const ctx = new Context()
  ctx.provide('get', '被方法遮蔽的值')
  assert.equal(typeof ctx.get, 'function')
})

test('thenable 安全：ctx.then 为 undefined，await ctx 不抛错', async () => {
  const ctx = new Context()
  assert.equal((ctx as unknown as Record<string, unknown>).then, undefined)
  assert.equal(await ctx, ctx)
})
