// E2 单测：bundle/profile 分层装配——纯函数层（buildRows/mergeRows/formatRows）。
// 挂载级的双 profile 行为差异（有无 auto-approval、分类器直落人工）由
// run-mock 的 E2 场景断言；这里钉装配语义本身。
// 运行：npm run cordis
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    baseRows, buildRows, mergeRows, formatRows,
    type AppHost,
} from '../cordis.config.js'
import type { Row } from '../cordis/loader.js'

const noopHost = (): AppHost => ({
    parentMode: () => 'default',
    isSubAgent: false,
    commands: {} as AppHost['commands'],
    inject: () => {},
    wake: () => undefined,
    getBudget: () => ({ exceeded: false, reason: '' }),
    getMaxTurns: () => null,
    addTokens: () => {},
})

const rowOf = (rows: Row[], id: string): Row => {
    const row = rows.find((r) => r.id === id)
    assert.ok(row, `row "${id}" should exist`)
    return row
}

// ---------- base 层：全能力清单的三组生命线顺序 ----------

test('baseRows：服务行在前，core-* 工具广告序与 approval 瀑布序不被分层打乱', () => {
    const ids = baseRows.map((r) => r.id)
    const idx = (id: string) => {
        const i = ids.indexOf(id)
        assert.ok(i >= 0, `row "${id}" should exist in baseRows`)
        return i
    }
    // 服务行先于各自的消费者（依赖就绪序 = 行序；svc-system-prompt 的消费者
    // 是 prompt-sections，排在适配器之后是原构造函数的本来顺序）
    assert.ok(idx('svc-llm') < idx('llm-anthropic'))
    assert.ok(idx('svc-system-prompt') < idx('prompt-sections'))
    assert.ok(idx('svc-agents') < idx('subagent'))
    assert.ok(idx('svc-tools') < idx('mcp'))
    assert.ok(idx('svc-session-log') < idx('compaction'))
    // 工具广告序 = 请求体 tools 数组顺序的生命线（C1 立的规矩）
    assert.ok(idx('core-fs') < idx('core-exec') && idx('core-exec') < idx('core-meta'))
    // 审批瀑布从外到内：deny 硬底线在外，auto veto 链在内（C2 立的规矩）
    assert.ok(idx('approval') < idx('auto-approval'))
})

// ---------- buildRows：app 层接线 ----------

test('buildRows 带 host：app 层把桥/选项接到同 id 行上（整行替换）', () => {
    const host = noopHost()
    const rows = buildRows({ host })
    const sections = rowOf(rows, 'prompt-sections')
    assert.equal(sections.name, 'prompt-sections')
    const config = sections.config as { staticPrompt: string; dynamicEnabled: boolean }
    assert.ok(config.staticPrompt.length > 0)
    assert.equal(config.dynamicEnabled, true)
    // 桥接现取：commands 行拿到的就是 host 递进来的那个对象（同一引用）
    assert.equal(rowOf(rows, 'commands').config, host.commands)
    const autonomy = rowOf(rows, 'autonomy').config as Record<string, unknown>
    assert.equal(typeof autonomy.getBudget, 'function')
    assert.equal(typeof autonomy.wake, 'function')
    assert.equal(typeof autonomy.getMaxTurns, 'function')
})

test('buildRows isSubAgent：四个能力行的行为开关全关（子 agent 装配）', () => {
    const rows = buildRows({ host: { ...noopHost(), isSubAgent: true } })
    // skills 的开关是 catalogInjection（目录注入），其余三个是 enabled
    assert.equal((rowOf(rows, 'skills').config as { catalogInjection?: boolean }).catalogInjection, false)
    for (const id of ['mcp', 'subagent', 'memory']) {
        assert.equal((rowOf(rows, id).config as { enabled?: boolean }).enabled, false, `${id} should be disabled for sub-agent`)
    }
})

// ---------- profile 层：同一份代码组装出两个 agent ----------

test("profile 'full' ≙ base 原样；'no-auto' 只把 auto-approval 行换成 disabled", () => {
    const host = noopHost() // 共用同一 host：桥闭包同引用，逐行 deepEqual 才有意义
    const full = buildRows({ host })
    const noAuto = buildRows({ host, profile: 'no-auto' })
    // 行数与行序完全一致：no-auto 是"注释掉"一行，不是删掉
    assert.deepEqual(noAuto.map((r) => r.id), full.map((r) => r.id))
    assert.equal(rowOf(full, 'auto-approval').disabled, undefined)
    assert.equal(rowOf(noAuto, 'auto-approval').disabled, true)
    // 其余行逐字段全等（id/name/config/disabled）
    for (const row of full) {
        if (row.id === 'auto-approval') continue
        assert.deepEqual(rowOf(noAuto, row.id), row, `row "${row.id}" should be untouched by no-auto`)
    }
})

test('未知 profile fail-loud，报出可选名单', () => {
    assert.throws(() => buildRows({ profile: 'turbo' }), /unknown profile "turbo".*full, no-auto/)
})

// ---------- 层间优先级与整行替换危险点 ----------

test('extraRows 赢过 profile：用非 disabled 行恢复 auto-approval（patch 能翻案）', () => {
    const rows = buildRows({
        host: noopHost(),
        profile: 'no-auto',
        extraRows: [{ id: 'auto-approval', name: 'auto-approval' }],
    })
    assert.equal(rowOf(rows, 'auto-approval').disabled, undefined)
})

test('整行替换不做字段合并：patch 行漏写 config 就没有 config（不继承 app 层）', () => {
    const rows = mergeRows([
        buildRows({ host: noopHost() }),
        [{ id: 'prompt-sections', name: 'prompt-sections' }],
    ])
    const sections = rowOf(rows, 'prompt-sections')
    assert.equal(sections.config, undefined)
    assert.equal(sections.name, 'prompt-sections')
})

test('整行替换连 name 一起换：漏写 name 的 patch 行会在 resolve 时炸出来', () => {
    const rows = mergeRows([baseRows, [{ id: 'compaction', name: 'compaction', config: { tick: 1 } }]])
    assert.deepEqual(rowOf(rows, 'compaction').config, { tick: 1 })
    // 若 patch 只写 id 不写 name，name 就是 undefined——loadRows 的 resolve 会
    // 以 `no plugin named "undefined"` fail-loud（挂在调用方，而非静默丢行）
    const broken = mergeRows([baseRows, [{ id: 'compaction', name: undefined as unknown as string }]])
    assert.equal(rowOf(broken, 'compaction').name, undefined)
})

// ---------- formatRows：--dump-config 的输出形状 ----------

test('formatRows：disabled 标记 + 函数折叠 <fn> + 树状枝', () => {
    const rows = buildRows({
        host: noopHost(),
        profile: 'no-auto',
    })
    const text = formatRows(rows)
    assert.ok(text.startsWith('<mini-cordis.config>'))
    assert.ok(text.includes('[auto-approval] auto-approval (disabled)'))
    assert.ok(text.includes('getBudget: <fn>'))
    assert.ok(!text.includes('()=>')) // 函数体从不出现
    assert.ok(text.includes('└─ [')) // 末行用收尾枝
})
