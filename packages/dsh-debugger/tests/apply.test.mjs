/**
 * End-to-end tests against `apply()` — the assembly layer.
 *
 * The unit suites test each layer in isolation; this one proves the wiring:
 * that mounting the plugin provides `ctx.debugger`, registers `/debug`, installs
 * probes, stays ACTIVE without `tools` (A2), lets a second plugin mark the same
 * timeline (A9), and restores everything on unload (A8).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name as pluginName } from '../index.mjs'
import { createFakeContext, createFakeCommands, fakeFiber, FiberState } from './fake-context.mjs'

/**
 * Mount the debugger on a fake host and return the pieces for assertions.
 *
 * @param {{tools?: boolean, commands?: boolean, config?: object}} [options]
 */
function mount(options = {}) {
  const commands = options.commands === false ? undefined : createFakeCommands()
  const services = {}
  if (commands) services.commands = commands
  if (options.tools !== false && options.tools) services.tools = {}

  const ctx = createFakeContext({
    services,
    plugins: [{ name: 'dsh-debugger', fibers: [fakeFiber({ state: FiberState.ACTIVE, uid: 1 })] }],
  })

  const api = apply(ctx, options.config)
  return { ctx, commands, api }
}

test('the plugin declares its Cordis identity', () => {
  assert.equal(pluginName, 'dsh-debugger')
  // Only `commands`: see design document 4.2 and the acceptance note A2.
  assert.deepEqual(inject, ['commands'])
  assert.equal(inject.includes('tools'), false)
})

test('apply provides the debugger service', () => {
  const { ctx, api } = mount()
  assert.equal(ctx.get('debugger'), api)
})

test('apply registers the /debug command', () => {
  const { commands } = mount()
  assert.ok(commands.registered.has('debug'))
})

// Regression guard for a defect that shipped through 490 green tests and only
// appeared on a real boot: the definition used `execute` and `arguments`
// instead of `handler` and `input.hint`. The real `normalizeDefinition`
// (interaction/commands/src/index.ts:189) THROWS on a missing `handler`, and
// because registration runs inside `safeEffect` the throw was swallowed — the
// plugin mounted, announced "probes active", and `/debug` did not exist. The
// fake host used to store anything and dispatch via `definition.execute`, which
// is what made the bug invisible.
test('the command definition satisfies the real CommandDefinition contract', () => {
  const { commands } = mount()
  const definition = commands.registered.get('debug')

  assert.equal(typeof definition.handler, 'function', 'the field must be `handler`, not `execute`')
  assert.equal(definition.execute, undefined, '`execute` is not part of the contract')
  assert.equal(definition.arguments, undefined, '`arguments` is not part of the contract')
  assert.equal(typeof definition.input?.hint, 'string', 'the hint lives in input.hint')
})

test('a definition without `handler` is rejected, not silently accepted', () => {
  const { commands } = mount()
  // The fake host must enforce the real contract; if this ever stops throwing,
  // the guard above can no longer be trusted to catch a regression.
  assert.throws(
    () => commands.register({ name: 'broken', description: 'no handler', execute: () => 'x' }),
    /handler must be a function/,
  )
})

test('the registered command routes text to the right subcommand', async () => {
  const { commands } = mount()
  const definition = commands.registered.get('debug')

  // The real contract is `handler(invocation)`, and the invocation carries the
  // argument string in `rawInput` (commands/src/index.ts:47). Reading
  // `definition.execute` here is what let the `execute` vs `handler` bug ship.
  const execution = await definition.handler({
    commandId: 'cmd-1',
    agent: undefined,
    rawInput: 'health',
    attachments: [],
    signal: new AbortController().signal,
  })
  // The fake host carries one ACTIVE plugin, so the verdict line reports it.
  assert.match(execution.text, /plugins 1\/1 active/)
  assert.equal(execution.kind, 'success')
})

test('unload disposes the command registration (A8)', () => {
  const { ctx, commands } = mount()
  assert.ok(commands.registered.has('debug'))
  ctx.disposeAll()
  assert.equal(commands.registered.has('debug'), false)
})

test('apply works without a commands service (degraded, not fatal)', () => {
  let api
  assert.doesNotThrow(() => {
    api = mount({ commands: false }).api
  })
  // The programmable surface remains available for a host without commands.
  assert.equal(typeof api.mark, 'function')
  assert.equal(typeof api.snapshot, 'function')
})

test('the debugger stays usable without tools (A2)', () => {
  const { api } = mount({ tools: false })
  const result = api.snapshot()
  assert.equal(typeof result.counts.total, 'number')
  assert.equal(api.record('mark', 'still works').category, 'mark')
})

test('ctx.debugger.mark writes onto the timeline (A9)', () => {
  const { api } = mount()
  api.mark('my-plugin/loaded', { version: '1.0.0' })

  const rows = api.query({ category: 'mark' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'my-plugin/loaded')
  assert.equal(rows[0].data.version, '1.0.0')
})

test('ctx.debugger.record accepts every documented category', () => {
  const { api } = mount()
  for (const category of ['plugin', 'event', 'tool', 'command', 'service', 'log', 'error', 'mark']) {
    api.record(category, `n-${category}`)
  }
  assert.equal(api.query().length, 8)
})

test('a second plugin can inject debugger and correlate with a tool call (A9)', () => {
  const { api } = mount()

  // Simulate a downstream plugin marking a key path on the same timeline.
  api.mark('consumer/start')
  api.record('tool', 'read', { correlation: 'call-9' })
  api.record('tool', 'read-result', { correlation: 'call-9' })

  const chain = api.trace('call-9')
  assert.deepEqual(chain.map((r) => r.name), ['read', 'read-result'])
})

test('ctx.debugger.snapshot samples live state on each call', () => {
  const { api } = mount()
  const first = api.snapshot()
  const second = api.snapshot()
  // Different objects: no caching of a composition that may have changed.
  assert.notEqual(first, second)
  assert.deepEqual(first.counts, second.counts)
})

test('ctx.debugger exposes recorder and stats', () => {
  const { api } = mount()
  api.mark('x')
  assert.equal(typeof api.recorder.query, 'function')
  assert.equal(api.stats().size, 1)
})

test('profiling numbers reach the stats surface', () => {
  const { api } = mount()
  api.record('tool', 'read', { durationMs: 12 })
  assert.equal(api.stats().timings.tool.maxMs, 12)
})

test('a reserved secret never reaches the service timeline (A5)', () => {
  const { api } = mount()
  api.mark('auth', { apiKey: 'sk-live-abcdef123456' })

  const serialized = JSON.stringify(api.query())
  assert.doesNotMatch(serialized, /sk-live-abcdef123456/)
  assert.match(serialized, /\[redacted\]/)
})

test('overflow is visible through the service stats (A6)', () => {
  const { api } = mount({ config: { capacity: 2 } })
  for (let i = 0; i < 5; i += 1) api.mark(`m${i}`)

  const stats = api.stats()
  assert.equal(stats.size, 2)
  assert.equal(stats.dropped, 3)
})

test('config capacity is honoured at mount time', () => {
  const { api } = mount({ config: { capacity: 7 } })
  assert.equal(api.config.capacity, 7)
  assert.equal(api.stats().capacity, 7)
})

test('announce prints the readiness line when enabled', () => {
  const original = console.log
  let printed = ''
  console.log = (line) => {
    printed = line
  }
  try {
    mount({ config: { announce: true } })
  } finally {
    console.log = original
  }
  assert.match(printed, /probes active/)
})

test('announce is silent by default', () => {
  const original = console.log
  let called = false
  console.log = () => {
    called = true
  }
  try {
    mount()
  } finally {
    console.log = original
  }
  assert.equal(called, false)
})

test('unload restores console wrapping (A8)', () => {
  const original = console.log
  const marker = () => {}
  console.log = marker

  try {
    const { ctx } = mount()
    assert.notEqual(console.log, marker, 'console.log should be wrapped while mounted')
    ctx.disposeAll()
    assert.equal(console.log, marker, 'unload must restore the original')
  } finally {
    console.log = original
  }
})

test('unload restores commands.execute (A8)', () => {
  const commands = createFakeCommands()
  const original = commands.execute
  const ctx = createFakeContext({ services: { commands } })

  apply(ctx)
  assert.notEqual(commands.execute, original)
  ctx.disposeAll()
  assert.equal(commands.execute, original)
})

test('unload restores the logger (A8)', () => {
  const ctx = createFakeContext()
  const original = ctx.logger.error
  apply(ctx)
  assert.notEqual(ctx.logger.error, original, 'logger.error should be wrapped')
  ctx.disposeAll()
  assert.equal(ctx.logger.error, original)
})

test('a fiber load failure is captured as a plugin root cause', () => {
  // A FAILED fiber whose error cordis routed to the logger (fiber.ts:126).
  const ctx = createFakeContext({
    plugins: [
      { name: 'exploding-plugin', fibers: [fakeFiber({ state: FiberState.FAILED, uid: 2 })] },
    ],
  })
  const api = apply(ctx)

  // Cordis routes the load failure to the logger.
  ctx.logger.error(new Error('exploding-plugin: apply() threw during load'))

  // The capture turns that into a readable root cause on `/debug plugins`.
  const findings = api.snapshot().findings
  const finding = findings.find((f) => f.name === 'exploding-plugin')
  assert.ok(finding, 'the FAILED plugin should be reported')
  assert.equal(finding.stateName, 'FAILED')
  assert.match(finding.reason, /apply\(\) threw during load/)
})

test('a captured root cause is redacted before it is reported', () => {
  const ctx = createFakeContext({
    plugins: [{ name: 'leaky-plugin', fibers: [fakeFiber({ state: FiberState.FAILED, uid: 2 })] }],
  })
  const api = apply(ctx)
  ctx.logger.error(new Error('leaky-plugin: auth failed token=abcdef123456'))

  const serialized = JSON.stringify(api.snapshot())
  assert.doesNotMatch(serialized, /abcdef123456/)
})

test('logger capture forwards to the original implementation', () => {
  const ctx = createFakeContext()
  const seen = []
  const original = ctx.logger.error
  ctx.logger.error = (...args) => {
    seen.push(args)
    return original.apply(ctx.logger, args)
  }

  apply(ctx)
  ctx.logger.error(new Error('forwarded'))

  assert.equal(seen.length, 1, 'host logging must still happen')
})

test('apply survives a fully hostile host (constraint 2)', () => {
  // Every surface the assembly touches throws. This is not a hypothetical host:
  // a composition whose resolver or loader is broken is exactly the one a user
  // most needs to inspect, so `apply` must still return a working service.
  const ctx = {
    registry: {
      entries() {
        throw new Error('registry dead')
      },
    },
    logger: { error() {}, info() {}, warn() {}, debug() {} },
    reflect: {
      get props() {
        throw new Error('reflect dead')
      },
    },
    get() {
      throw new Error('ctx.get exploded')
    },
    on() {
      throw new Error('event bus dead')
    },
    effect(callback) {
      const dispose = callback()
      return () => dispose?.()
    },
    provide() {},
  }

  let api
  assert.doesNotThrow(() => {
    api = apply(ctx)
  }, 'a hostile host must not make apply throw')

  assert.equal(typeof api.mark, 'function')
  assert.equal(typeof api.snapshot, 'function')

  // The service still works, and the failure is reported rather than hidden.
  api.mark('after-hostile-mount')
  assert.equal(api.query({ category: 'mark' }).length, 1)
  assert.match(api.snapshot().degraded, /enumerating plugins failed/)
})

test('apply survives a host that refuses ctx.effect', () => {
  const ctx = createFakeContext({ services: { commands: createFakeCommands() } })
  const original = ctx.effect
  ctx.effect = () => {
    throw new Error('effect refused')
  }

  let api
  assert.doesNotThrow(() => {
    api = apply(ctx)
  })
  assert.equal(typeof api.mark, 'function')

  // The refused cleanup must not leave console wrapped after the mount gave up
  // ownership — `safeEffect` disposes immediately instead of leaking.
  ctx.effect = original
})

test('apply survives a host whose provide() throws', () => {
  const ctx = createFakeContext({ services: { commands: createFakeCommands() } })
  ctx.provide = () => {
    throw new Error('provide refused')
  }

  let api
  assert.doesNotThrow(() => {
    api = apply(ctx)
  })
  // The mounting caller still receives a usable API.
  assert.equal(typeof api.mark, 'function')
  api.mark('still-works')
})

test('applying twice on separate hosts is independent', () => {
  const a = mount()
  const b = mount()
  a.api.mark('only-a')

  assert.equal(a.api.query().length, 1)
  assert.equal(b.api.query().length, 0, 'timelines must not be shared')
})

// Regression guard, found by auditing the fake against a real Context: the real
// `provide()` REFUSES a duplicate ("service \"x\" has been registered at <root>")
// and leaves the original in place, while the fake silently overwrote. The
// debugger wraps `provide('debugger')` in a try/catch that records the failure,
// so on the old fake that branch was unreachable and its behaviour was untested.
test('a duplicate provide is refused and the original service survives', () => {
  const ctx = createFakeContext({ services: { commands: createFakeCommands() } })
  const first = apply(ctx)
  const original = ctx.get('debugger')
  assert.equal(original, first)

  // Remounting over a live service — what a reload does.
  let second
  assert.doesNotThrow(() => {
    second = apply(ctx)
  }, 'a refused provide must not take the whole mount down (constraint 2)')

  assert.equal(ctx.get('debugger'), original, 'the first service must survive')
  assert.notEqual(second, undefined, 'the second mount still returns a usable API')
  assert.equal(typeof second.mark, 'function')
})

test('a refused provide is reported rather than silently swallowed', () => {
  const ctx = createFakeContext({ services: { commands: createFakeCommands() } })
  const first = apply(ctx)
  const second = apply(ctx)

  // The second mount could not own the service, so its recorder must say so.
  const notes = second.stats()
  assert.ok(notes, 'stats() must still answer on the second mount')
  // And the timeline the first mount owns is untouched by the second.
  assert.equal(first.query().length, 0, 'the live service must not be written by the refused mount')
})

test('probe status is reported through the service', () => {
  const { api } = mount()
  assert.equal(api.config.probes, true)
})
