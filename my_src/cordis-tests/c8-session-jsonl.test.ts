// C8 单测：SessionLog 订阅钩子（原始事件/合并前）、JSONL 往返（落盘→读回→
// 重放 derive 等价）、/clear 标记、崩溃修复（半行丢弃 + 未闭合 turn 补合成 end）。
// Agent 级 resume 的请求体续接由场景 32 背书。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Context } from '../cordis/context.js'
import { SessionLog } from '../services/session-log.js'
import { sessionJsonlPlugin, readSessionLines, repairUnclosedTurn, getLatestSessionId, type PersistLine } from '../plugins/session-jsonl.js'

function makeLog(): SessionLog {
  return new SessionLog(new Context(), 'session-log')
}

test('onAppend 拿到合并前的原始事件；disposer 摘除', () => {
  const log = makeLog()
  const seen: string[] = []
  const off = log.onAppend((e) => seen.push(e.type))
  log.append({ type: 'user/message', content: 'a' })
  log.append({ type: 'user/message', content: 'b' }) // 合并进上一条，但订阅方看到原始 b
  assert.deepEqual(seen, ['user/message', 'user/message'])
  off()
  log.append({ type: 'user/message', content: 'c' })
  assert.equal(seen.length, 2)
  // 日志侧合并照常：一条消息
  assert.equal(log.derive().messages.length, 1)
})

test('JSONL 往返：落盘 → 读回 → 重放 derive 与原日志逐字节一致（合并语义复现）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c8-jsonl-'))
  const ctx = new Context()
  const log = new SessionLog(ctx, 'session-log')
  ctx.plugin(sessionJsonlPlugin, { sessionId: 'roundtrip', dir })
  log.append({ type: 'system/message', content: JSON.stringify([{ type: 'text', text: 'sys' }]) })
  log.append({ type: 'user/message', content: 'hello' })
  log.append({ type: 'assistant/message', content: [{ type: 'text', text: 'hi' }], usage: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } })
  log.append({ type: 'user/message', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' } as any] })
  log.append({ type: 'user/message', content: 'followup' }) // 与上一条批次合并
  const original = JSON.stringify(log.derive())

  const lines = readSessionLines('roundtrip', dir)!
  const replayed = makeLog()
  for (const line of lines) replayed.append(line as any)
  assert.equal(JSON.stringify(replayed.derive()), original)
})

test('/clear 落一个标记行；重放时截断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c8-clear-'))
  const ctx = new Context()
  const log = new SessionLog(ctx, 'session-log')
  ctx.plugin(sessionJsonlPlugin, { sessionId: 'cleared', dir })
  log.append({ type: 'user/message', content: 'before' })
  log.clear()
  log.append({ type: 'user/message', content: 'after' })
  const lines = readSessionLines('cleared', dir)!
  assert.equal(lines.filter((l) => (l as { type: string }).type === 'log/clear').length, 1)
  const replayed = makeLog()
  for (const line of lines) {
    if ((line as { type: string }).type === 'log/clear') replayed.clear()
    else replayed.append(line as any)
  }
  assert.equal(replayed.derive().messages.length, 1)
  assert.equal((replayed.derive().messages[0].content as string), 'after')
})

test('崩溃修复：半行丢弃；未闭合 turn/start 补合成 end；配对完整则不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c8-crash-'))
  const file = join(dir, 'crash.jsonl')
  const good = [
    JSON.stringify({ type: 'turn/start' }) + '\n',
    JSON.stringify({ type: 'user/message', content: 'x' }) + '\n',
    JSON.stringify({ type: 'turn/end', reason: 'end-turn' }) + '\n',
    JSON.stringify({ type: 'turn/start' }) + '\n', // 未闭合
    '{"type":"user/mes', // 半行
  ].join('')
  writeFileSync(file, good)
  const lines = readSessionLines('crash', dir)!
  assert.equal(lines.length, 4) // 半行被丢
  const log = makeLog()
  for (const line of lines) log.append(line as any)
  const before = log.events.length
  repairUnclosedTurn(log)
  const last = log.events[log.events.length - 1] as { type: string; reason?: string }
  assert.equal(last.type, 'turn/end')
  assert.equal(last.reason, 'recovered')

  // 配对完整：repair 是 no-op
  const balanced = makeLog()
  balanced.append({ type: 'turn/start' })
  balanced.append({ type: 'turn/end', reason: 'end-turn' })
  const n = balanced.events.length
  repairUnclosedTurn(balanced)
  assert.equal(balanced.events.length, n)
})

test('getLatestSessionId 按 mtime 挑最新；空目录返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c8-latest-'))
  assert.equal(getLatestSessionId(dir), null)
  writeFileSync(join(dir, 'aaa.jsonl'), '{"type":"turn/start"}\n')
  writeFileSync(join(dir, 'zzz.jsonl'), '{"type":"turn/start"}\n')
  // Windows mtime 粒度：显式回拨 aaa 的时间戳
  const past = new Date(Date.now() - 60_000)
  utimesSync(join(dir, 'aaa.jsonl'), past, past)
  assert.equal(getLatestSessionId(dir), 'zzz')
  const lines: PersistLine[] | null = readSessionLines('zzz', dir)
  assert.equal(lines?.length, 1)
})
