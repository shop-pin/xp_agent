// mini-cordis B6：配置组装 loader——B 阶段收官。
// 参照物：deepseek-harness-master 的 cordis loader（行模型 + 分层 patch；
// 真框架的动态 import 与包清单校验，mini 标注"略"，见 dsh-B6.md）。
//
// 行模型：{ id, name, config?, disabled? }
//   id   —— 配置身份：分层叠加的去重键，同 id 后写胜（整行替换，不做字段合并）
//   name —— 实现入口：经 resolve 表找到 Plugin；同 name 多 id 合法
//   （两实例若都往共享服务表 provide 同名服务，B2 的冲突语义会 fail-loud——
//    配置身份与运行时身份的交界，见 dsh-B6.md）
//
// 激活仍走 B2 的老路：ctx.plugin() + inject 依赖等待——书写顺序无关，
// 依赖晚到由 provide 通知唤醒。loader 只负责"哪些行、什么配置、什么顺序表达"。

import type { Context } from './context.js'
import type { Fiber, Plugin } from './fiber.js'

/** 一行配置：分层叠加的最小单元。 */
export interface Row {
  /** 配置身份：patch 层用它整行替换 base 层的同 id 行。 */
  id: string
  /** 实现入口：resolve(name) 的键。 */
  name: string
  /** 透传给插件 apply 的 config（mini 不做 schema 校验，B2 已定）。 */
  config?: unknown
  /** 置 true 时该行不挂载（同 id 被后层替换成 disabled 行 = "注释掉"）。 */
  disabled?: boolean
}

interface RowRecord {
  id: string
  name: string
  /** 持 fiber 引用而非状态快照：dumpTree 永远读当前状态（pending 可转 active）。 */
  fiber: Fiber
}

// 行记录挂在树根上：loadRows 与 dumpTree 用树内任意 ctx 都能对上同一份清单
const loadedRows = new WeakMap<Context, RowRecord[]>()

function rootOf(ctx: Context): Context {
  let current: Context = ctx
  while (current.parent) current = current.parent
  return current
}

/**
 * 按行清单挂载插件。rows 由调用方分层铺平（[...base, ...app, ...cliPatch]）；
 * 本函数做：同 id 后写胜（整行替换）→ disabled 过滤 → resolve → ctx.plugin。
 * 插件 apply 抛错照常从挂载点 fail-loud（B2 语义）；依赖未齐的行扣 pending，
 * 后续行的 provide 会自动唤醒——书写顺序不影响最终激活。
 */
export function loadRows(ctx: Context, rows: Row[], resolve: (name: string) => Plugin): void {
  const byId = new Map<string, Row>()
  for (const row of rows) byId.set(row.id, row) // 后写覆盖 = 整行替换（危险点：不是字段合并）

  const root = rootOf(ctx)
  let records = loadedRows.get(root)
  if (!records) {
    records = []
    loadedRows.set(root, records)
  }
  for (const row of byId.values()) {
    if (row.disabled) continue
    const plugin = resolve(row.name)
    const fiber = ctx.plugin(plugin, row.config)
    records.push({ id: row.id, name: row.name, fiber })
  }
}

/** 输出已激活树：id / name / 当前状态 / inject 依赖。 */
export function dumpTree(ctx: Context): string {
  const records = loadedRows.get(rootOf(ctx)) ?? []
  const lines = ['<mini-cordis>']
  records.forEach((record, index) => {
    const branch = index === records.length - 1 ? '└─' : '├─'
    const inject = record.fiber.inject.length > 0
      ? ` (inject: ${record.fiber.inject.join(', ')})`
      : ''
    lines.push(`${branch} [${record.id}] ${record.name} → ${record.fiber.state}${inject}`)
  })
  return lines.join('\n')
}
