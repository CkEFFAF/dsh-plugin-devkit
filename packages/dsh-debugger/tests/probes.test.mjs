/**
 * Probe layer tests.
 *
 * These are the most important tests in the package. They lock the guarantees
 * that separate a debugger from scattered console.log calls:
 *
 * - A3: a waterfall probe returns `next()`'s original value, unchanged.
 * - A4: a probe that throws does not fail the observed call.
 * - A8: unloading restores `console` and `commands.execute`.
 * - A2: the debugger loads and stays usable when `tools` is absent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installProbes, guard } from '../src/probes.mjs'
import { createRecorder, CATEGORIES } from '../src/recorder.mjs'
import { createFakeContext, createFakeCommands, createFakeTools } from './fake-context.mjs'

/** Default config mirroring index.mjs DEFAULTS. */
const config = { probes: true, captureConsole: true, captureProcessErrors: true }

test('waterfall probe forwards the identical decision object (A3)', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  const decision = { behavior: 'deny', reason: 'not allowed' }

  const probes = installProbes({ ctx, recorder, config })
  const returned = ctx.waterfall('tools/pre-execute', { name: 'bash', callId: 'c1' }, decision)

  // Identity, not deep equality: a proxy or clone would still break callers
  // that compare by reference.
  assert.equal(returned, decision)
  probes.dispose()
})

test('waterfall probe records the decision it observed', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  ctx.waterfall('tools/pre-execute', { name: 'bash', callId: 'c1' }, { behavior: 'deny' })
  const [row] = recorder.query({ category: 'tool' })
  assert.equal(row.name, 'bash')
  assert.equal(row.correlation, 'c1')
  assert.equal(row.data.decision, 'deny')
  assert.equal(row.data.phase, 'pre-execute')
})

test('allow decisions are reported as allow', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  ctx.waterfall('tools/pre-execute', { name: 'read', callId: 'c1' }, { behavior: 'allow' })
  assert.equal(recorder.query({ category: 'tool' })[0].data.decision, 'allow')
})

test('tools/execute probe forwards the original result (A3)', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  const result = { content: 'file body' }
  const returned = ctx.waterfall('tools/execute', { name: 'read', callId: 'c1' }, result)
  assert.equal(returned, result)
})

test('tools/execute probe records a duration', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  ctx.waterfall('tools/execute', { name: 'read', callId: 'c1' }, {})
  const [row] = recorder.query({ correlation: 'c1' })
  assert.equal(typeof row.durationMs, 'number')
  assert.ok(row.durationMs >= 0)
})

test('a downstream throw passes through the probe unchanged (A3)', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  // A probe must not swallow a genuine downstream failure: when `next()`
  // throws, the same error must reach the caller.
  const boom = new Error('downstream failed')
  const failing = () => {
    throw boom
  }
  ctx.on('tools/execute', failing)

  assert.throws(
    () => ctx.waterfall('tools/execute', { name: 'read', callId: 'c1' }, {}),
    (error) => error === boom,
  )
  // And the failure was still recorded.
  assert.ok(recorder.query({ correlation: 'c1' }).some((r) => r.error))
})

test('probe failure does not fail the observed call (A4)', () => {
  const ctx = createFakeContext()
  // A recorder whose push always throws: every probe body will fail.
  const recorder = {
    push() {
      throw new Error('recorder is broken')
    },
    query: () => [],
    trace: () => [],
    stats: () => ({}),
    clear() {},
    setCapacity: () => 1,
    noteEarlyError() {},
    takeEarlyErrors: () => [],
  }

  installProbes({ ctx, recorder, config })
  const decision = { behavior: 'allow' }
  let returned
  assert.doesNotThrow(() => {
    returned = ctx.waterfall('tools/pre-execute', { name: 'bash', callId: 'c1' }, decision)
  })
  // The decision still round-trips even though every record failed.
  assert.equal(returned, decision)
})

test('guard swallows a throwing body', () => {
  let reported = null
  const wrapped = guard(() => {
    throw new Error('boom')
  }, (error) => {
    reported = error.message
  })
  assert.doesNotThrow(wrapped)
  assert.equal(reported, 'boom')
})

test('guard swallows a throwing error reporter too', () => {
  const wrapped = guard(() => {
    throw new Error('boom')
  }, () => {
    throw new Error('reporter also broken')
  })
  assert.doesNotThrow(wrapped)
})

test('console wrapping preserves original behaviour and arguments', () => {
  const calls = []
  const original = console.log
  console.log = (...args) => calls.push(args)

  try {
    const recorder = createRecorder()
    const ctx = createFakeContext()
    const probes = installProbes({ ctx, recorder, config })

    console.log('hello', 42)
    assert.deepEqual(calls, [['hello', 42]], 'original console must still receive the call')
    const [row] = recorder.query({ category: 'log' })
    assert.equal(row.name, 'log')
    assert.deepEqual(row.data.args, ['hello', 42])

    probes.dispose()
  } finally {
    console.log = original
  }
})

test('console wrapping is restored on dispose (A8)', () => {
  const original = console.log
  const after = () => {}
  console.log = after

  try {
    const ctx = createFakeContext()
    const probes = installProbes({ ctx, recorder: createRecorder(), config })
    assert.notEqual(console.log, after, 'console.log should be wrapped while active')
    probes.dispose()
    assert.equal(console.log, after, 'dispose must restore the exact original reference')
  } finally {
    console.log = original
  }
})

test('console errors land on the timeline as log records', () => {
  const original = console.error
  console.error = () => {}

  try {
    const recorder = createRecorder()
    const probes = installProbes({ ctx: createFakeContext(), recorder, config })
    console.error('something bad', { apiKey: 'sk-live-abcdef123456' })

    const [row] = recorder.query({ category: 'log' })
    assert.equal(row.name, 'error')
    // Even console payloads are redacted before storage.
    assert.doesNotMatch(JSON.stringify(row), /sk-live-abcdef123456/)
    probes.dispose()
  } finally {
    console.error = original
  }
})

test('commands.execute wrapping is reversible (A8)', async () => {
  const commands = createFakeCommands()
  const original = commands.execute
  const ctx = createFakeContext({ services: { commands } })
  const recorder = createRecorder()

  const probes = installProbes({ ctx, recorder, config })
  assert.notEqual(commands.execute, original, 'execute should be wrapped')

  // The real signature: (agent, line, attachments, signal).
  await commands.execute({ session: { id: 's1' } }, '/hello')
  const [row] = recorder.query({ category: 'command' })
  assert.equal(row.name, 'hello')
  assert.equal(row.correlation, 'hello')

  probes.dispose()
  assert.equal(commands.execute, original, 'dispose must restore the exact original reference')
})

test('commands.execute wrapping preserves return values', async () => {
  const commands = createFakeCommands()
  const ctx = createFakeContext({ services: { commands } })
  const probes = installProbes({ ctx, recorder: createRecorder(), config })

  // An unresolved command name returns undefined on the real host
  // (commands/src/index.ts:368-370), and the wrapper must pass that through
  // unchanged rather than substituting a value of its own.
  const missing = await commands.execute({ session: { id: 's1' } }, '/greet')
  assert.equal(missing, undefined)
  probes.dispose()
})

test('the command wrapper passes a resolved result through unchanged', async () => {
  const commands = createFakeCommands()
  commands.register({
    name: 'greet',
    description: 'test command',
    handler: () => ({ kind: 'success', text: 'hello' }),
  })
  const ctx = createFakeContext({ services: { commands } })
  const probes = installProbes({ ctx, recorder: createRecorder(), config })

  const execution = await commands.execute({ session: { id: 's1' } }, '/greet')
  assert.equal(execution.result.text, 'hello')
  probes.dispose()
})

test('the command probe names a command from the real (agent, line) signature', async () => {
  // Regression guard. `CommandRuntime.execute(agent, line, attachments, signal)`
  // puts an Agent first, so reading `args[0]` named every command the generic
  // "command" and `/debug trace <id>` could never correlate one. The old fake
  // host took `(name, ...)`, which is exactly why every test passed regardless.
  const commands = createFakeCommands()
  const ctx = createFakeContext({ services: { commands } })
  const recorder = createRecorder()
  const probes = installProbes({ ctx, recorder, config })

  await commands.execute({ session: { id: 's1' } }, '/debug health')
  const [row] = recorder.query({ category: 'command' })
  assert.equal(row.name, 'debug', 'the leading /name token is the command')
  assert.notEqual(row.name, 'command', 'must not fall back to the generic name')
  assert.notEqual(row.correlation, '[object Object]')

  probes.dispose()
})

test('the command probe names a subcommand line without the leading slash', async () => {
  const commands = createFakeCommands()
  const ctx = createFakeContext({ services: { commands } })
  const recorder = createRecorder()
  const probes = installProbes({ ctx, recorder, config })

  await commands.execute({ session: { id: 's1' } }, 'compact')
  const [row] = recorder.query({ category: 'command' })
  assert.equal(row.name, 'compact')

  probes.dispose()
})

test('commands.execute wrapping propagates errors and still records them', async () => {
  const commands = createFakeCommands({ executeThrows: true })
  const ctx = createFakeContext({ services: { commands } })
  const recorder = createRecorder()
  const probes = installProbes({ ctx, recorder, config })

  await assert.rejects(() => commands.execute({ session: { id: 's1' } }, '/bad'))
  const [row] = recorder.query({ category: 'command' })
  assert.ok(row.error, 'a failed command must still produce a record')
  probes.dispose()
})

test('event probes install without a tools service, and absence is reported (A2)', () => {
  const ctx = createFakeContext() // no tools, no commands service
  const result = installProbes({ ctx, recorder: createRecorder(), config })

  // The event-based tool timeline must still work: those events fire from the
  // tool runtime and do not require the service object to be reachable.
  assert.equal(result.installed.tools, true)
  assert.equal(result.installed.commands, true)
  // But service availability is reported honestly and separately.
  assert.equal(result.installed.toolsService, false)
  assert.equal(result.installed.commandsService, false)
  assert.equal(Object.keys(result.failures).length, 0, 'absence is not a failure')
  assert.equal(result.installed.console, true)
  result.dispose()
})

test('a probe install failure degrades only that probe', () => {
  // `on` throws, so the event-bus probe setups fail...
  const ctx = createFakeContext()
  ctx.on = () => {
    throw new Error('event bus unavailable')
  }

  const result = installProbes({ ctx, recorder: createRecorder(), config })
  assert.equal(result.installed.tools, false)
  assert.match(result.failures.tools, /event bus unavailable/)
  assert.equal(result.installed.commands, false)
  // ...but process/console probes are independent and still active.
  assert.equal(result.installed.console, true)
  assert.equal(result.installed.process, true)
  result.dispose()
})

test('probes respect the captureConsole switch', () => {
  const ctx = createFakeContext()
  const result = installProbes({
    ctx,
    recorder: createRecorder(),
    config: { probes: true, captureConsole: false, captureProcessErrors: false },
  })
  assert.equal(result.installed.console, false)
  assert.equal(result.installed.process, false)
  result.dispose()
})

test('dispose is idempotent', () => {
  const commands = createFakeCommands()
  const original = commands.execute
  const ctx = createFakeContext({ services: { commands } })
  const probes = installProbes({ ctx, recorder: createRecorder(), config })

  probes.dispose()
  assert.doesNotThrow(() => probes.dispose())
  assert.equal(commands.execute, original)
})

test('a console payload object is recorded without running its toString', () => {
  const original = console.log
  console.log = () => {}

  try {
    const recorder = createRecorder()
    const probes = installProbes({ ctx: createFakeContext(), recorder, config })

    // `sanitize` runs inside the push. It reads own enumerable keys and never
    // stringifies a plain object, so user code (here, `toString`) must not run
    // during recording. This pins the property that made a re-entrancy guard
    // unnecessary; if sanitize ever gains a toString/toJSON call, this fails
    // and the guard must come back.
    let toStringCalls = 0
    const payload = {
      toString() {
        toStringCalls += 1
        return 'rendered'
      },
    }

    console.log('with payload', payload)

    assert.equal(toStringCalls, 0, 'recording must not invoke user toString')
    const [row] = recorder.query({ category: 'log' })
    assert.equal(row.name, 'log')
    assert.equal(row.data.args.length, 2)

    probes.dispose()
  } finally {
    console.log = original
  }
})

test('console probe records exactly one row per call', () => {
  const original = console.log
  console.log = () => {}

  try {
    const recorder = createRecorder()
    const probes = installProbes({ ctx: createFakeContext(), recorder, config })

    console.log('first')
    console.log('second')
    console.log('third')
    assert.equal(recorder.query({ category: 'log' }).length, 3)

    probes.dispose()
  } finally {
    console.log = original
  }
})

test('tool events without a call id still record', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  ctx.waterfall('tools/pre-execute', { name: 'bash' }, { behavior: 'allow' })
  const [row] = recorder.query({ category: 'tool' })
  assert.equal(row.correlation, undefined)
  assert.equal(row.name, 'bash')
})

test('malformed tool payloads degrade to a generic tool name', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  ctx.waterfall('tools/pre-execute', undefined, { behavior: 'allow' })
  const [row] = recorder.query({ category: 'tool' })
  assert.equal(row.name, 'tool')
})

test('installProbes reports installed and failed probes for health output', () => {
  const ctx = createFakeContext({ services: { commands: createFakeCommands(), tools: createFakeTools() } })
  const result = installProbes({ ctx, recorder: createRecorder(), config })

  assert.equal(result.installed.tools, true)
  assert.equal(result.installed.commands, true)
  assert.equal(result.installed.console, true)
  assert.equal(result.installed.process, true)
  assert.equal(result.installed.llm, true)
  result.dispose()
})

// ---------------------------------------------------------------------------
// LLM probes.
//
// Added after watching a real session: the kernel recorded NOTHING for a
// text-only model turn, because no LLM probe existed. `tools/*` only fires when
// a tool is called, so a chat-only turn left the timeline empty and `/debug`
// could not report how long a model call took or that it failed.
// ---------------------------------------------------------------------------

test('llm/stream forwards the identical stream object (A3)', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  const stream = (async function* () {})()
  installProbes({ ctx, recorder, config })

  const returned = ctx.waterfall('llm/stream', {
    provider: 'p', model: 'm', messages: [{ role: 'user' }],
  }, stream)

  // Identity, not deep equality. `llm/stream`'s return value IS the provider
  // stream (llm/src/index.ts:1114), so returning a copy or a wrapper would
  // break generation for every plugin in the composition.
  assert.equal(returned, stream)
})

test('llm/stream records the provider, model and request shape', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  ctx.waterfall('llm/stream', {
    provider: 'opencode-go-deepseek',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user' }, { role: 'assistant' }],
    tools: [{ name: 'glob' }],
    sessionId: 'session-1',
  }, (async function* () {})())

  const [row] = recorder.query({ category: 'event' })
  assert.equal(row.name, 'llm/stream')
  assert.equal(row.data.provider, 'opencode-go-deepseek')
  assert.equal(row.data.model, 'deepseek-v4.1-flash')
  assert.equal(row.data.messages, 2)
  assert.equal(row.data.tools, 1)
  assert.equal(row.correlation, 'session-1')
})

test('llm/stream falls back to a nested session id', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  ctx.waterfall('llm/stream', { session: { id: 'nested-9' } }, (async function* () {})())
  const [row] = recorder.query({ category: 'event' })
  assert.equal(row.correlation, 'nested-9')
})

test('a hostile field costs one value, not the whole llm/stream record', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  const options = { provider: 'p', model: 'm' }
  Object.defineProperty(options, 'messages', {
    enumerable: true,
    get() { throw new Error('hostile getter') },
  })

  // Must not throw into the observed call (A4)...
  assert.doesNotThrow(() => {
    ctx.waterfall('llm/stream', options, (async function* () {})())
  })
  // ...and the call must still be visible. Building every field in one
  // expression meant a single bad field discarded the record entirely, so the
  // model call vanished from the timeline instead of appearing with a gap.
  const rows = recorder.query({ category: 'event' }).filter((r) => r.name === 'llm/stream')
  assert.equal(rows.length, 1, 'the call must still be recorded')
  assert.equal(rows[0].data.provider, 'p')
  assert.equal(rows[0].data.messages, undefined, 'only the unreadable field is lost')
})

test('a hostile session getter does not escape the probe', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  const options = {}
  Object.defineProperty(options, 'session', {
    enumerable: true,
    get() { throw new Error('hostile session') },
  })

  assert.doesNotThrow(() => {
    ctx.waterfall('llm/stream', options, (async function* () {})())
  })
  assert.equal(recorder.query({ category: 'event' }).length, 1)
})

test('llm/retry is recorded with its failure code', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  ctx.emit('llm/retry', {
    turn: 1, step: 2, retry: 1, provider: 'p',
    failure: { code: 'RATE_LIMITED', message: 'slow down' },
  })

  const [row] = recorder.query({ category: 'event' })
  assert.equal(row.name, 'llm/retry')
  assert.equal(row.data.code, 'RATE_LIMITED')
  assert.equal(row.data.retry, 1)
})

test('record categories stay inside the frozen enum', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  installProbes({ ctx, recorder, config })

  ctx.waterfall('llm/stream', { provider: 'p', model: 'm' }, (async function* () {})())
  ctx.emit('llm/retry', { turn: 1, step: 1, retry: 1 })

  // 设计文档 §4.4 fixes the enum, and the recorder silently reclassifies an
  // unknown category as `mark` (recorder.mjs:57) — so an invented category
  // would produce plausible-looking but wrongly labelled records. This pins
  // that the LLM probes use a real category.
  for (const row of recorder.query()) {
    assert.ok(
      CATEGORIES.includes(row.category),
      `category ${row.category} is not in the frozen enum`,
    )
  }
  const names = recorder.query({ category: 'event' }).map((r) => r.name).sort()
  assert.deepEqual(names, ['llm/retry', 'llm/stream'])
})

test('the llm probe is removed on dispose (A8)', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  const probes = installProbes({ ctx, recorder, config })

  probes.dispose()
  assert.equal(ctx.listenerCount('llm/stream'), 0)
  assert.equal(ctx.listenerCount('llm/retry'), 0)
  ctx.emit('llm/retry', { turn: 1, step: 1, retry: 1 })
  assert.equal(recorder.query({ category: 'event' }).length, 0)
})

test('the llm probe is skipped when probes are disabled', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  const probes = installProbes({
    ctx, recorder, config: { ...config, probes: false },
  })
  assert.equal(probes.installed.llm, false)
  assert.equal(ctx.listenerCount('llm/stream'), 0)
  probes.dispose()
})
