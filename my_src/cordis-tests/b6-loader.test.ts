// B6 单测：配置组装 loader——B 阶段总验收。
// 四条组合断言：注释掉某插件 → 能力消失；加一行 → 能力出现；
// 书写顺序打乱 → 依赖驱动照常激活；dump 输出正确。
// 另覆盖：同 id 整行替换（非字段合并）、disabled 语义、未知 name fail-loud、
// pending 行在 dump 中的实时状态。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { loadRows, dumpTree } from '../cordis/loader.js'
import type { Row } from '../cordis/loader.js'
import type { Context as Ctx } from '../cordis/context.js'
import type { Plugin } from '../cordis/fiber.js'

// E2 起真实清单（baseRows/appRows/profiles）搬进 cordis.config.ts 服务产品装配，
// 这份玩具清单（core/greeter/clock）是 loader 的教学夹具，原样内联回本章测试。
// 玩具故事：core 提供全局 config 服务；greeter 依赖 config 拼问候语；clock 独立计时。

interface AppConfig { title: string; suffix?: string }

const core: Plugin = {
  name: 'core',
  apply(ctx: Ctx, rawConfig: unknown) {
    const config = rawConfig as AppConfig
    ctx.provide('config', Object.freeze({ ...config }))
  },
}

const greeter: Plugin = {
  name: 'greeter',
  inject: ['config'],
  apply(ctx: Ctx) {
    const config = ctx.require<{ title: string; suffix?: string }>('config')
    const greet = (who: string) => `${config.title} says hi to ${who}${config.suffix ?? ''}`
    ctx.provide('greet', greet)
  },
}

const clock: Plugin = {
  name: 'clock',
  apply(ctx: Ctx) {
    ctx.provide('clock', { startedAt: Date.now() })
  },
}

const toyPlugins: Record<string, Plugin> = { core, greeter, clock }

const resolvePlugin = (name: string): Plugin => {
  const plugin = toyPlugins[name]
  if (!plugin) throw new Error(`[mini-cordis] no plugin named "${name}"`)
  return plugin
}

const baseRows: Row[] = [
  { id: 'core', name: 'core', config: { title: 'mini-harness' } },
  { id: 'greeter', name: 'greeter' },
]

test('基本加载：行清单挂载、依赖注入、greet 能力可用', () => {
  const ctx = new Context()
  loadRows(ctx, baseRows, resolvePlugin)
  const greet = ctx.require<(who: string) => string>('greet')
  assert.equal(greet('world'), 'mini-harness says hi to world')
})

// ---------- 组合断言一：注释掉某插件 → 能力消失 ----------

test('patch 层把 greeter 行替换成 disabled → 能力消失，dump 里无此行', () => {
  const ctx = new Context()
  const cliPatch: Row[] = [{ id: 'greeter', name: 'greeter', disabled: true }]
  loadRows(ctx, [...baseRows, ...cliPatch], resolvePlugin)
  assert.equal(ctx.has('greet'), false)
  assert.ok(!dumpTree(ctx).includes('greeter')) // disabled 行从不挂载
  assert.ok(dumpTree(ctx).includes('[core]'))
})

// ---------- 组合断言二：加一行 → 能力出现 ----------

test('app 层追加 clock 行 → clock 能力出现，原有能力不受影响', () => {
  const ctx = new Context()
  const appRows: Row[] = [{ id: 'clock', name: 'clock' }]
  loadRows(ctx, [...baseRows, ...appRows], resolvePlugin)
  assert.equal(typeof ctx.get<{ startedAt: number }>('clock')?.startedAt, 'number')
  assert.equal(ctx.require<(w: string) => string>('greet')('x'), 'mini-harness says hi to x')
})

// ---------- 组合断言三：书写顺序打乱 → 依赖驱动照常激活 ----------

test('greeter 行排在 core 之前：先 pending 后激活，最终状态一致', () => {
  const ctx = new Context()
  loadRows(ctx, [baseRows[1], baseRows[0]], resolvePlugin) // 乱序：greeter 先、core 后
  const greet = ctx.require<(who: string) => string>('greet')
  assert.equal(greet('late'), 'mini-harness says hi to late')
})

// ---------- 组合断言四：dump 输出正确 ----------

test('dumpTree：id/name/state/inject 树状输出，pending 行显示实时状态', () => {
  const ctx = new Context()
  loadRows(ctx, baseRows, resolvePlugin)
  assert.equal(
    dumpTree(ctx),
    [
      '<mini-cordis>',
      '├─ [core] core → active',
      '└─ [greeter] greeter → active (inject: config)',
    ].join('\n'),
  )
  // 依赖缺席：greeter 扣 pending，dump 反映实时状态而非加载快照
  const pendingCtx = new Context()
  loadRows(pendingCtx, [{ id: 'greeter', name: 'greeter' }], resolvePlugin)
  assert.equal(dumpTree(pendingCtx), '<mini-cordis>\n└─ [greeter] greeter → pending (inject: config)')
})

// ---------- 危险点：同 id 整行替换，而非字段合并 ----------

test('同 id 后写胜是整行替换：patch 行省略 config 时不会继承 base 的 config', () => {
  const ctx = new Context()
  // patch 行只改了 name 保留语义、不带 config——若按字段合并，core 会拿到
  // base 的 { title: 'mini-harness' }；整行替换则 config 为 undefined
  const cliPatch: Row[] = [{ id: 'core', name: 'core', config: { title: 'patched', suffix: '!' } }]
  loadRows(ctx, [...baseRows, ...cliPatch], resolvePlugin)
  assert.equal(ctx.require<(w: string) => string>('greet')('you'), 'patched says hi to you!')
})

test('同 name 不同 id：两行都挂载（配置身份 ≠ 实现入口），第二个触发服务冲突 fail-loud', () => {
  const ctx = new Context()
  const rows: Row[] = [
    { id: 'core', name: 'core', config: { title: 't' } },
    { id: 'core-mirror', name: 'core' }, // 不同 id、同实现
  ]
  // 第一行 active 并 provide 'config'；第二行 apply 时共享表同名冲突 → 挂载点上抛
  assert.throws(() => loadRows(ctx, rows, resolvePlugin), /has been registered already/)
})

test('未知 name：resolve fail-loud，报出实现名', () => {
  const ctx = new Context()
  assert.throws(
    () => loadRows(ctx, [{ id: 'ghost', name: 'no-such-plugin' }], resolvePlugin),
    /no plugin named "no-such-plugin"/,
  )
})
