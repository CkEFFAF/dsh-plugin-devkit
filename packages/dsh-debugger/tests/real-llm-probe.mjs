/**
 * Real-host check: the LLM probe must PASS THE STREAM THROUGH UNTOUCHED.
 *
 * `llm/stream` is a waterfall whose return value IS the provider stream
 * (`packages/llm/llm/src/index.ts:1114`). A probe that returns a copy, a
 * wrapper, or `undefined` would break generation for every plugin in the
 * composition — the worst possible failure for an observer, and one that only
 * shows up when a real `LlmRuntime` dispatches.
 *
 * This drives the REAL runtime, with the debugger mounted, and asserts the
 * stream object that comes back is the identical reference the terminal
 * produced.
 *
 * Run from the DSH checkout:
 *   node --import tsx/esm <workspace>/packages/dsh-debugger/tests/real-llm-probe.mjs
 */

import assert from 'node:assert/strict'

import { Context } from 'file:///D:/DSH/deepseek-harness/vendor/cordis/src/index.ts'
import { LlmRuntime } from 'file:///D:/DSH/deepseek-harness/packages/llm/llm/src/index.ts'

import { apply } from '../index.mjs'

const results = []
async function check(label, fn) {
  try {
    await fn()
    results.push({ ok: true, label })
  } catch (error) {
    results.push({ ok: false, label, error })
  }
}

/** Mount the debugger over a real LlmRuntime. */
function mount() {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const api = apply(ctx, { capacity: 200 })
  return { ctx, llm, api }
}

await check('the debugger mounts beside a real LlmRuntime', () => {
  const { api } = mount()
  assert.equal(typeof api.mark, 'function')
})

await check('the probe records the request without consuming the stream', async () => {
  const { ctx, api } = mount()

  // Terminal listener installed AFTER the probe: it stands in for the adapter.
  const streamObject = (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
  ctx.on('llm/stream', () => streamObject)

  // Dispatch through the real waterfall, exactly as LlmRuntime does.
  const returned = ctx.waterfall(null, 'llm/stream', {
    provider: 'demo-provider',
    model: 'demo-model',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 'session-probe-1',
  }, () => streamObject)

  assert.equal(returned, streamObject, 'the probe must return next()\'s exact value')

  // Records land under `event` — the category 设计文档 §4.4 reserves for host
  // events. An invented category would be silently reclassified as `mark`.
  const rows = api.query({ category: 'event' }).filter((r) => r.name === 'llm/stream')
  assert.ok(rows.length > 0, 'the probe must record the request')
  const row = rows[0]
  assert.equal(row.data?.provider, 'demo-provider')
  assert.equal(row.data?.model, 'demo-model')
  assert.equal(row.data?.messages, 1)
  assert.equal(row.correlation, 'session-probe-1')
})

await check('hostile option FIELDS cannot break the stream (constraint 2)', () => {
  const { ctx } = mount()
  const streamObject = (async function* () {})()
  // Fields that throw on read, but a payload object cordis itself can still
  // process. This is the realistic hostile case: a plugin passes odd values.
  //
  // Note what is deliberately NOT tested: a Proxy that throws on EVERY read.
  // That breaks cordis's own dispatch before any probe runs —
  // `getTraceable` reads `value[symbols.tracker]` (vendor/cordis/src/utils.ts:122)
  // — so failing there would blame the probe for a host behaviour. Verified
  // separately: an event with NO probe behaves identically against such a Proxy.
  const hostile = {}
  for (const key of ['provider', 'model', 'messages', 'tools', 'sessionId']) {
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() { throw new Error(`hostile ${key}`) },
    })
  }

  let returned
  assert.doesNotThrow(() => {
    returned = ctx.waterfall(null, 'llm/stream', hostile, () => streamObject)
  })
  assert.equal(returned, streamObject, 'a probe error must not change the return value')
})

await check('a hostile payload is still passed through unchanged', () => {
  const { ctx, api } = mount()
  const streamObject = (async function* () {})()
  const hostile = {}
  Object.defineProperty(hostile, 'provider', {
    enumerable: true,
    get() { throw new Error('hostile provider') },
  })
  ctx.waterfall(null, 'llm/stream', hostile, () => streamObject)
  // The failure is recorded rather than thrown away, so the timeline explains
  // what happened instead of silently missing the call.
  const rows = api.query({ category: 'event' }).filter((r) => r.name === 'llm/stream')
  assert.ok(rows.length > 0, 'the attempted call must still appear on the timeline')
})

await check('llm/retry is recorded', () => {
  const { ctx, api } = mount()
  ctx.emit('llm/retry', {
    turn: 1, step: 1, retry: 1, provider: 'demo-provider',
    failure: { code: 'RATE_LIMITED', message: 'slow down' },
  })
  const rows = api.query({ category: 'event' }).filter((r) => r.name === 'llm/retry')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].data?.code, 'RATE_LIMITED')
})

await check('unload removes the LLM probe', async () => {
  // `disposeAll()` is a FAKE-only helper and does NOT exist on a real Context
  // (measured), so unlinking must go through a real fiber. Mounting the plugin
  // as a proper plugin and disposing that fiber is the real unload path.
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  void llm

  let api
  const plugin = {
    name: 'dsh-debugger-probe-test',
    apply(c, config) { api = apply(c, config) },
  }
  const fiber = await ctx.plugin(plugin, { capacity: 100 })

  ctx.emit('llm/retry', { turn: 1, step: 1, retry: 1 })
  const before = api.query({ category: 'event' }).length
  assert.ok(before > 0, 'the probe must record before unload')

  await fiber.dispose()

  // Emitting after dispose must not reach the recorder.
  assert.doesNotThrow(() => ctx.emit('llm/retry', { turn: 1, step: 1, retry: 1 }))
  assert.equal(
    api.query({ category: 'event' }).length,
    before,
    'the listener must be gone after the owning fiber is disposed',
  )
})

let failed = 0
for (const result of results) {
  if (result.ok) console.log(`ok    ${result.label}`)
  else {
    failed += 1
    console.log(`FAIL  ${result.label}`)
    console.log(`        ${result.error?.message ?? result.error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
