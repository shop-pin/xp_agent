// C6 单测：聚合器（assembleStream）、路由表、sideCall 兜底聚合、llm/stream 瀑布。
// anthropic 适配器的全链路由 mock 场景背书（side call 线格式锚在 7/15/26）。
// 运行：npm run cordis（tsc && node --test "dist/cordis-tests/*.test.js"）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '../cordis/context.js'
import { LlmRuntime, assembleStream, type LlmAdapter, type StreamChunk } from '../services/llm.js'

async function* chunks(list: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const c of list) yield c
}

test('assembleStream：text/tool 聚合、usage/finish、空 json 视作 {}', async () => {
  const s = await assembleStream(chunks([
    { t: 'block-start', kind: 'text' },
    { t: 'text-delta', text: 'He' }, { t: 'text-delta', text: 'llo' },
    { t: 'block-end' },
    { t: 'block-start', kind: 'tool', id: 't1', name: 'read_file' },
    { t: 'tool-call-delta', partialJson: '{"file_pa' }, { t: 'tool-call-delta', partialJson: 'th":"x"}' },
    { t: 'block-end' },
    { t: 'block-start', kind: 'tool', id: 't2', name: 'list_files' },
    { t: 'block-end' },
    { t: 'usage', usage: { input: 10, output: 5, cacheRead: 100, cacheCreation: 0 } },
    { t: 'finish', reason: 'tool_use' },
  ]))
  const [text, t1, t2] = s.content as any[]
  assert.equal(text.text, 'Hello')
  assert.deepEqual(t1.input, { file_path: 'x' })
  assert.deepEqual(t2.input, {})
  assert.deepEqual(s.usage, { input: 10, output: 5, cacheRead: 100, cacheCreation: 0 })
  assert.equal(s.finishReason, 'tool_use')
})

test('assembleStream：onText 收到逐段 delta（流式打印口）', async () => {
  const seen: string[] = []
  await assembleStream(chunks([
    { t: 'block-start', kind: 'text' },
    { t: 'text-delta', text: 'a' }, { t: 'text-delta', text: 'b' },
    { t: 'block-end' },
  ]), (t) => seen.push(t))
  assert.deepEqual(seen, ['a', 'b'])
})

test('LlmRuntime：未知路由抛错；同名冲突抛错；disposer 摘除后回到未知', () => {
  const ctx = new Context()
  const rt = new LlmRuntime(ctx, 'llm')
  assert.throws(() => rt.stream({ model: 'm', maxTokens: 1, system: 's', messages: [] }))
  const adapter: LlmAdapter = {
    async *stream() { yield { t: 'finish', reason: 'x' } },
  }
  const dispose = rt.registerAdapter('echo', adapter)
  assert.equal(rt.hasRoute('echo'), true)
  assert.throws(() => rt.registerAdapter('echo', adapter))
  dispose()
  assert.equal(rt.hasRoute('echo'), false)
})

test('sideCall 兜底：无 sideCall 的适配器经流聚合出文本（接缝可推导）', async () => {
  const ctx = new Context()
  const rt = new LlmRuntime(ctx, 'llm')
  rt.registerAdapter('fake', {
    async *stream(req) {
      yield { t: 'block-start', kind: 'text' }
      yield { t: 'text-delta', text: 'answer: ' + String((req.messages[0] as any)?.content ?? '') }
      yield { t: 'block-end' }
      yield { t: 'usage', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }
      yield { t: 'finish', reason: 'end_turn' }
    },
  })
  const r = await rt.sideCall({
    route: 'fake', model: 'm', maxTokens: 8, system: 's',
    messages: [{ role: 'user', content: 'q' }],
  })
  assert.equal(r.text, 'answer: q')
  assert.deepEqual(r.usage, { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 })
})

test('llm/stream 瀑布：监听器不调 next = 换实现', async () => {
  const ctx = new Context()
  const rt = new LlmRuntime(ctx, 'llm')
  rt.registerAdapter('a', {
    async *stream() { yield { t: 'finish', reason: 'orig' } },
  })
  ctx.on('llm/stream', () => {
    // 否决原实现，返回自己的流（around 中间件：不调 next = inner 不执行）
    return (async function* (): AsyncIterable<StreamChunk> {
      yield { t: 'finish', reason: 'replaced' }
    })()
  })
  const s = await assembleStream(rt.stream({ route: 'a', model: 'm', maxTokens: 1, system: 's', messages: [] }))
  assert.equal(s.finishReason, 'replaced')
})
