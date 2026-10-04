// C3 单测：会话事件日志。
// 覆盖：derive 纯函数（重放一致 + 返回拷贝）、derive 只取最新 system、
// 回放 round-trip、注记事件不进请求、连续 user 合并双侧语义、
// usage 四计数挂 assistant 事件、Agent 集成（日志投影 ≡ 线上工作集）。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { SessionLog, type SessionEvent } from '../services/session-log.js'
import { Agent } from '../agent.js'

function makeLog(): SessionLog {
  return new SessionLog(new Context(), 'session-log')
}

test('derive 纯函数：重放两次结果一致，改写返回值不污染日志', () => {
  const log = makeLog()
  log.append({ type: 'system/message', content: JSON.stringify([{ type: 'text', text: 'sys' }]) })
  log.append({ type: 'user/message', content: 'hi' })
  log.append({ type: 'assistant/message', content: [{ type: 'text', text: 'hello' }] })
  const a = log.derive()
  const b = log.derive()
  assert.deepEqual(a, b)
  ;(a.messages[0].content as string) = 'MUTATED'
  ;(a.system as unknown[]).push({ type: 'text', text: 'INJECTED' })
  assert.equal((log.derive().messages[0].content as string), 'hi')
  assert.equal(log.derive().system.length, 1)
})

test('derive 只取最新一条 system（动态段会变，旧的不进请求）', () => {
  const log = makeLog()
  log.append({ type: 'system/message', content: JSON.stringify([{ type: 'text', text: 'old' }]) })
  log.append({ type: 'user/message', content: 'hi' })
  log.append({ type: 'system/message', content: JSON.stringify([{ type: 'text', text: 'new' }]) })
  const { system } = log.derive()
  assert.equal(system.length, 1)
  assert.equal(system[0].text, 'new')
})

test('注记事件（tool/turn/meta）不进请求投影', () => {
  const plain = makeLog()
  const noisy = makeLog()
  const core: SessionEvent[] = [
    { type: 'system/message', content: JSON.stringify([{ type: 'text', text: 'sys' }]) },
    { type: 'user/message', content: 'run it' },
    { type: 'assistant/message', content: [{ type: 'tool_use', id: 't1', name: 'run_shell', input: { command: 'echo' } } as any] },
    { type: 'user/message', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' } as any] },
  ]
  for (const evt of core) {
    plain.append(evt)
    noisy.append(evt)
  }
  // 注记穿插其中
  noisy.append({ type: 'tool/call', id: 't1', name: 'run_shell', input: { command: 'echo' } })
  noisy.append({ type: 'tool/result', callId: 't1', content: 'ok' })
  noisy.append({ type: 'turn/start' })
  noisy.append({ type: 'turn/end', reason: 'end-turn' })
  noisy.append({ type: 'meta/note', key: 'mode', value: 'plan' })
  assert.deepEqual(noisy.derive(), plain.derive())
})

test('连续 user 合并：字符串拼接（\\n\\n）；批次数组追加 text 块', () => {
  const log = makeLog()
  log.append({ type: 'user/message', content: 'first' })
  log.append({ type: 'user/message', content: 'second' })
  assert.deepEqual(log.derive().messages, [{ role: 'user', content: 'first\n\nsecond' }])

  const log2 = makeLog()
  const batch = [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' } as any]
  log2.append({ type: 'user/message', content: batch })
  log2.append({ type: 'user/message', content: 'followup' })
  const msgs = log2.derive().messages
  assert.equal(msgs.length, 1)
  assert.deepEqual(msgs[0].content, [
    { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
    { type: 'text', text: 'followup' },
  ])
})

test('usage 四计数挂在 assistant 事件上', () => {
  const log = makeLog()
  log.append({
    type: 'assistant/message',
    content: [{ type: 'text', text: 'done' }],
    usage: { input: 100, output: 20, cacheRead: 300, cacheCreation: 40 },
  })
  const evt = log.events.find(e => e.type === 'assistant/message') as Extract<SessionEvent, { type: 'assistant/message' }>
  assert.deepEqual(evt.usage, { input: 100, output: 20, cacheRead: 300, cacheCreation: 40 })
})

test('load 回放 round-trip：消息数组 → 事件流 → derive 还原（含字符串与块两种 content）', () => {
  const log = makeLog()
  const messages = [
    { role: 'user', content: 'plain text' },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }, { type: 'tool_use', id: 't9', name: 'read_file', input: { file_path: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: 'file body' }] },
  ] as any[]
  log.load(messages as any)
  const derived = log.derive().messages
  assert.equal(JSON.stringify(derived), JSON.stringify(messages))
})

// ---------- Agent 集成：日志投影 ≡ 线上工作集 ----------

test('Agent：loadHistory 后日志投影与工作集逐字节一致；clearHistory 双侧清空', () => {
  const agent = new Agent({ customSystemPrompt: 'test-only' })
  const messages = [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
  ] as any[]
  agent.loadHistory(messages as any)
  const derived = agent.deriveSession()
  assert.equal(JSON.stringify(derived.messages), JSON.stringify(agent.history()))

  agent.clearHistory()
  assert.equal(agent.history().length, 0)
  assert.equal(agent.deriveSession().messages.length, 0)
})

test('Agent：append 后 meta/note（mode 变更）不进请求投影', () => {
  const agent = new Agent({ customSystemPrompt: 'test-only' })
  agent.setMode('plan')
  const notes = agent.deriveSession().messages.length
  assert.equal(notes, 0) // meta 事件不产生消息
  const log = (agent as any).sessionLog as SessionLog
  assert.ok(log.events.some(e => e.type === 'meta/note' && (e as any).value === 'plan'))
})
