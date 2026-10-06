// C2 单测：执行管线 + 权限瀑布。
// 覆盖：九段流水线对拍（管线结果 vs 旧 checkPermission 逐案等价）、guard 单调
// （deny 后内层无法翻案、内层可加严）、ask 审批（缓存语义 mode 区分、fail-closed）、
// auto 模式（fast-path 不问分类器、裁决映射、headless）、post-execute 改写。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Context } from '../cordis/context.js'
import { ToolsService, type ToolExec, type ExecOutcome } from '../services/tools.js'
import { checkPermission } from '../permissions.js'
import { approvalPlugin } from '../plugins/approval.js'
import { autoApprovalPlugin } from '../plugins/auto-approval.js'
import type { ApprovalService } from '../services/approval.js'
import { coreFsTools } from '../plugins/core-fs-tools.js'
import { coreExecTools } from '../plugins/core-exec-tools.js'
import { coreMetaTools } from '../plugins/core-meta-tools.js'
import { LlmRuntime, type LlmAdapter } from '../services/llm.js'
import { SessionLog } from '../services/session-log.js'
import { UiService } from '../services/ui-service.js'

const EXECUTED = 'EXECUTED'
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }

/** 分类器桩（D6 起缝在 ctx.llm）：script 每次旁调返回一行 `<block>` 裁决文本，
 *  计数器锚"分类器被惊动几次"。 */
function fakeClassifierLlm(ctx: Context, script: () => string): { calls: () => number } {
  let n = 0
  const llm = new LlmRuntime(ctx, 'llm')
  const adapter: LlmAdapter = {
    async *stream() {},
    async sideCall() {
      n++
      return { text: script(), usage: ZERO_USAGE }
    },
  }
  llm.registerAdapter('anthropic', adapter)
  return { calls: () => n }
}

interface Harness {
  ctx: Context
  tools: ToolsService
  approval: ApprovalService
  providerCalls: string[]
}

function buildTree(autoYes: boolean): Harness {
  const ctx = new Context()
  const tools = new ToolsService(ctx, 'tools')
  new UiService(ctx, 'ui') // approval/auto 插件 apply 时 require（E1：树的保底公民）
  // 工具插件必须先注册：permissionHint 元数据在 def 上，九段流水线要读它
  //（dispatch 桩接管执行，工具的 execute 不会真跑）
  ctx.plugin(coreFsTools)
  ctx.plugin(coreExecTools)
  ctx.plugin(coreMetaTools)
  ctx.plugin(approvalPlugin)
  ctx.plugin(autoApprovalPlugin)
  const approval = ctx.require<ApprovalService>('approval')
  const providerCalls: string[] = []
  approval.setInteractiveProvider(async (_call, message) => {
    providerCalls.push(message)
    return autoYes ? 'allow-once' : 'deny'
  })
  return { ctx, tools, approval, providerCalls }
}

function exec(h: Harness, opts?: Partial<ToolExec>): (name: string, input: Record<string, any>, mode?: any, planPath?: string) => Promise<ExecOutcome> {
  return (name, input, mode = 'default', planPath?: string) =>
    h.tools.executeCall(
      { name, input, mode, planFilePath: planPath },
      { dispatch: async () => EXECUTED, ...opts },
    )
}

// ---------- 九段流水线对拍（可达段；规则表为空的测试环境 → ①④天然跳过） ----------

test('对拍：六种模式 × 代表性工具，管线结果与旧 checkPermission 逐案等价', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-approval-'))
  try {
    const existing = join(dir, 'exists.txt')
    writeFileSync(existing, 'x')
    const fresh = join(dir, 'fresh.txt')
    const cases: Array<{ name: string; input: Record<string, any> }> = [
      { name: 'read_file', input: { file_path: existing } },
      { name: 'web_fetch', input: { url: 'https://x' } },
      { name: 'write_file', input: { file_path: fresh, content: 'x' } },       // 新文件 → confirm 候选
      { name: 'write_file', input: { file_path: existing, content: 'x' } },    // 已存在 → 兜底 allow
      { name: 'edit_file', input: { file_path: fresh, old_string: 'a', new_string: 'b' } },
      { name: 'run_shell', input: { command: 'echo hi' } },
      { name: 'run_shell', input: { command: 'rm -rf x' } },                   // 危险 → confirm 候选
      { name: 'enter_plan_mode', input: {} },
      { name: 'skill', input: { skill_name: 's' } },
      { name: 'agent', input: { description: 'd', prompt: 'p' } },
      { name: 'tool_search', input: { query: 'q' } },
      { name: 'mcp__remote/tool', input: {} },                                 // 未注册 → 段⑨ allow
    ]
    const modes = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'] as const
    for (const mode of modes) {
      for (const c of cases) {
        const h = buildTree(false)
        const run = exec(h)
        const outcome = await run(c.name, c.input, mode)
        const expected = checkPermission(c.name, c.input, mode)
        if (expected.action === 'allow') {
          assert.equal(outcome.kind, 'result', `${mode}/${c.name}: 旧=allow 管线却拒绝`)
        } else {
          assert.equal(outcome.kind, 'denied', `${mode}/${c.name}: 旧=${expected.action} 管线却放行`)
          if (expected.action === 'confirm') {
            assert.ok(h.providerCalls.length > 0, `${mode}/${c.name}: 旧=confirm 但没人被问`)
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('拒绝话术逐字节保留（deny 规则/plan/dontAsk 三条）', async () => {
  const h = buildTree(false)
  const run = exec(h)
  const planDeny = await run('write_file', { file_path: 'x.txt', content: 'x' }, 'plan')
  assert.equal(planDeny.kind === 'denied' && planDeny.content, 'Denied: Blocked in plan mode: write_file')
  const planShell = await run('run_shell', { command: 'echo' }, 'plan')
  assert.equal(planShell.kind === 'denied' && planShell.content, 'Denied: Shell commands blocked in plan mode')
  const dontAsk = await run('run_shell', { command: 'rm -rf x' }, 'dontAsk')
  assert.equal(dontAsk.kind === 'denied' && dontAsk.content, 'Denied: Auto-denied (dontAsk mode): rm -rf x')
})

test('plan 模式豁免：写 plan 文件本身全等路径放行', async () => {
  const h = buildTree(false)
  const run = exec(h)
  const planFile = join(tmpdir(), 'c2-plan-file.md')
  const outcome = await run('write_file', { file_path: planFile, content: 'plan' }, 'plan', planFile)
  assert.equal(outcome.kind, 'result')
})

// ---------- guard 单调 ----------

test('guard 单调：deny 之后内层监听器返回 allow 也无法翻案', async () => {
  const h = buildTree(false)
  // 最后注册 = 最内层：试图放行一切
  h.ctx.on('tools/pre-execute', () => ({ type: 'allow' as const }))
  const run = exec(h)
  const outcome = await run('write_file', { file_path: 'x.txt', content: 'x' }, 'plan')
  assert.equal(outcome.kind, 'denied') // 外层 deny 是终局
})

test('guard 单调：内层监听器可以加严（allow → deny 可，反向不可）', async () => {
  const h = buildTree(true)
  h.ctx.on('tools/pre-execute', (call, next) => {
    if (call.name === 'read_file') return { type: 'deny' as const, reason: 'tightened by inner listener' }
    return next()
  })
  const run = exec(h)
  const tightened = await run('read_file', { file_path: 'any' }, 'default')
  assert.equal(tightened.kind === 'denied' && tightened.content, 'Denied: tightened by inner listener')
  const others = await run('run_shell', { command: 'echo' }, 'default')
  assert.equal(others.kind, 'result') // 透传不受影响
})

// ---------- ask / 审批缓存 ----------

test('ask 缓存：default 模式同 message 确认一次后免问；auto 模式每次都问', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-cache-'))
  try {
    const fresh = join(dir, 'fresh.txt')
    const h = buildTree(true)
    const run = exec(h)
    await run('write_file', { file_path: fresh, content: 'x' }, 'default')
    assert.equal(h.providerCalls.length, 1)
    await run('write_file', { file_path: fresh, content: 'y' }, 'default')
    assert.equal(h.providerCalls.length, 1) // 缓存命中，不再问

    const ha = buildTree(true)
    // auto 下 run_shell 不是 fast-path：树里没有 llm 服务 → 分类器不可用 →
    // 有人（interactive provider 在）转人工 confirm，ask 才会浮出
    const runA = exec(ha)
    await runA('run_shell', { command: 'rm -rf a' }, 'auto')
    await runA('run_shell', { command: 'rm -rf a' }, 'auto')
    assert.equal(ha.providerCalls.length, 2) // auto 的 confirm 不缓存——每次都问
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fail-closed：ask 时没有审批服务的树直接拒', async () => {
  const ctx = new Context()
  const tools = new ToolsService(ctx, 'tools')
  ctx.on('tools/pre-execute', () => ({ type: 'ask' as const, message: 'wanna?' }))
  const outcome = await tools.executeCall(
    { name: 'read_file', input: { file_path: 'x' }, mode: 'default' },
    { dispatch: async () => EXECUTED },
  )
  assert.equal(outcome.kind, 'denied')
})

// ---------- auto 模式 ----------

test('auto fast-path：只读工具放行且不惊动分类器；web_fetch 刻意不走 fast-path', async () => {
  const ctx = new Context()
  const tools = new ToolsService(ctx, 'tools')
  new UiService(ctx, 'ui')
  new SessionLog(ctx, 'session-log')
  ctx.plugin(approvalPlugin)
  ctx.plugin(autoApprovalPlugin)
  const fake = fakeClassifierLlm(ctx, () => '<block>no</block>')
  const outcome1 = await tools.executeCall(
    { name: 'read_file', input: { file_path: 'x' }, mode: 'auto' },
    { dispatch: async () => EXECUTED },
  )
  assert.equal(outcome1.kind, 'result')
  assert.equal(fake.calls(), 0)
  const outcome2 = await tools.executeCall(
    { name: 'web_fetch', input: { url: 'https://x' }, mode: 'auto' },
    { dispatch: async () => EXECUTED },
  )
  assert.equal(outcome2.kind, 'result')
  assert.equal(fake.calls(), 1) // web_fetch 必须过分类器（stage1 放行即完成，一次调用）
})

test('auto 裁决映射：分类器 block/deny 落 deny；分类器不可用 + 有人 → confirm 落 ask', async () => {
  const ctx = new Context()
  const tools = new ToolsService(ctx, 'tools')
  new UiService(ctx, 'ui')
  new SessionLog(ctx, 'session-log')
  ctx.plugin(approvalPlugin)
  ctx.plugin(autoApprovalPlugin)
  // 两段都裁 block → deny 话术逐字节同旧（[Auto Mode] + reason）
  fakeClassifierLlm(ctx, () => '<block>yes</block><reason>outbound</reason>')
  const denied = await tools.executeCall(
    { name: 'run_shell', input: { command: 'curl x' }, mode: 'auto' },
    { dispatch: async () => EXECUTED },
  )
  assert.equal(denied.kind === 'denied' && denied.content, 'Denied: [Auto Mode] outbound')

  // 没有分类器的树 + interactive provider 在 → autoFallback 转人工（旧 confirm 路径）
  const ctx2 = new Context()
  const tools2 = new ToolsService(ctx2, 'tools')
  new UiService(ctx2, 'ui')
  ctx2.plugin(approvalPlugin)
  ctx2.plugin(autoApprovalPlugin)
  const approval = ctx2.require<ApprovalService>('approval')
  const asked: string[] = []
  approval.setInteractiveProvider(async (_c, m) => { asked.push(m); return 'deny' })
  const confirmPath = await tools2.executeCall(
    { name: 'run_shell', input: { command: 'curl x' }, mode: 'auto' },
    { dispatch: async () => EXECUTED },
  )
  assert.equal(confirmPath.kind === 'denied' && confirmPath.content, 'User denied this action.')
  assert.deepEqual(asked, ['run_shell (auto-mode classifier unavailable)'])
})

// ---------- post-execute ----------

test('post-execute：监听器可改写输出（block 带反馈），无监听器原样', async () => {
  const h = buildTree(false)
  h.ctx.on('tools/post-execute', (result) => `[blocked] ${result.output}`)
  const run = exec(h)
  const outcome = await run('run_shell', { command: 'echo hi' }, 'default')
  assert.equal(outcome.kind === 'result' && outcome.output, '[blocked] EXECUTED')
})
