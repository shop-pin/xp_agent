// mini-cordis B1：Service 基类。
// 参照物：deepseek-harness-master/vendor/cordis/src/service.ts（constructor 内
// `self.ctx.reflect.provide(name, self, ...)`）。
//
// 用法：子类构造时 `super(ctx, '服务名')`，实例即在 ctx 上可读：
//   class Greeter extends Service { constructor(ctx: Context) { super(ctx, 'greeter') } }
//   ctx.greeter  // → Greeter 实例（service 即服务值）
//
// 类型面：`ctx.greeter` 能有 Greeter 类型靠 declaration merging，由插件方自己声明：
//   declare module '../cordis/context.js' { interface Context { greeter: Greeter } }
// 详见 dsh-B1.md 的 declaration merging 一节。

import type { Context } from './context.js'

export class Service {
  /** 挂回注册时的 ctx，子类由此访问其他服务（this.ctx.tools 之类）。 */
  protected ctx: Context

  constructor(ctx: Context, name: string) {
    this.ctx = ctx
    ctx.provide(name, this)
  }
}
