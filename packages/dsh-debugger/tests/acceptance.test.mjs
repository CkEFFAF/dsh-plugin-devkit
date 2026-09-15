/**
 * Acceptance coverage audit.
 *
 * The functional document's §8 acceptance table (A1–A10) is the contract. This
 * test makes the coverage *executable* rather than a claim in a progress file:
 * each acceptance row is either demonstrated here or explicitly recorded as
 * not-yet-demonstrable, with the reason.
 *
 * A row marked pending fails loudly if it is silently dropped later, so the
 * gap list cannot rot into a false "all green" impression.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { apply } from '../index.mjs'
import { createRecorder } from '../src/recorder.mjs'
import { installProbes } from '../src/probes.mjs'
import { createInspector } from '../src/inspector.mjs'
import { runCommand } from '../src/command.mjs'
import { createFakeContext, createFakeCommands, fakeFiber, FiberState } from './fake-context.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Acceptance rows and where each is demonstrated.
 *
 * `status` values:
 * - `covered`  — asserted by a test that can be run on demand.
 * - `pending`  — a genuine gap with the concrete reason it is open.
 *
 * A1 is `covered` because a *reproducible* check exists:
 * `packages/dsh-debug-boot/tests/real-boot.mjs` boots a real isolated DSH and
 * asserts the pass condition (6/6, stable across repeated runs). It is not part
 * of `node --test` — it spawns a real server — but anyone can re-run it, which
 * is the property that makes "covered" meaningful.
 */
export const ACCEPTANCE = {
  A1: {
    status: 'covered',
    where: 'a real isolated boot mounts the kernel and serves the web app',
    check: 'node packages/dsh-debug-boot/tests/real-boot.mjs',
    evidence:
      'the kernel logs "[dsh-debugger] probes active", GET / returns 401 without a token, '
      + 'the token exchange yields the web app, and the daily 3080 instance stays up',
  },
  A2: { status: 'covered', where: 'loaded without tools, debugger stays usable' },
  A3: { status: 'covered', where: 'waterfall probes forward next() unchanged' },
  A4: { status: 'covered', where: 'a throwing probe does not fail the observed call' },
  A5: { status: 'covered', where: 'secrets are redacted before storage, including verbose JSON' },
  A6: { status: 'covered', where: 'overflow is counted and surfaced in stats/health' },
  A7: { status: 'covered', where: 'PENDING names the awaited service; degraded enumeration is reported' },
  A8: { status: 'covered', where: 'unload restores console, commands.execute, and the logger' },
  A9: { status: 'covered', where: 'a second plugin marks and correlates on the same timeline' },
  A10: { status: 'covered', where: 'the fake host constructs PENDING and the diagnosis text is asserted' },
}

test('A1 names a check that can actually be re-run', () => {
  // The row must point at an executable command, not just describe an event.
  // An earlier revision asserted a string written into this same object — green
  // whether or not any boot ever happened.
  assert.equal(ACCEPTANCE.A1.status, 'covered')
  assert.match(ACCEPTANCE.A1.check, /real-boot\.mjs/)
  assert.match(ACCEPTANCE.A1.evidence, /probes active/)

  // The named script must exist, or `covered` is a claim about nothing.
  const script = join(here, '..', '..', 'dsh-debug-boot', 'tests', 'real-boot.mjs')
  assert.ok(existsSync(script), `A1's check is missing: ${script}`)
})

test('A2 the debugger loads and works without a tools service', () => {
  const ctx = createFakeContext({ services: { commands: createFakeCommands() } })
  const api = apply(ctx)

  // No `tools` service exists, yet every part of the surface still works. If
  // `tools` were declared in `inject`, this mount would be stuck in PENDING —
  // exactly the failure the debugger exists to diagnose.
  assert.equal(ctx.get('tools'), undefined)
  assert.equal(typeof api.mark, 'function')
  assert.equal(typeof api.snapshot, 'function')
  assert.equal(api.mark('still-alive').category, 'mark')
  assert.equal(api.query({ category: 'mark' }).length, 1)

  const debuggerApi = { recorder: api.recorder, inspector: api, config: api.config, probes: { installed: {} } }
  assert.match(runCommand('health', debuggerApi).output, /probes: active/)
})

test('A3 a waterfall probe does not change next()\'s return value', () => {
  const ctx = createFakeContext()
  const recorder = createRecorder()
  const probes = installProbes({
    ctx,
    recorder,
    config: { probes: true, captureConsole: false, captureProcessErrors: false },
  })

  // Identity, not deep equality: a clone would break reference-comparing callers.
  const decision = { behavior: 'deny', reason: 'policy' }
  assert.equal(ctx.waterfall('tools/pre-execute', { name: 'bash', callId: 'a3' }, decision), decision)

  const executionResult = { content: 'body' }
  assert.equal(ctx.waterfall('tools/execute', { name: 'read', callId: 'a3' }, executionResult), executionResult)
  probes.dispose()
})

test('A4 a probe failure does not fail the tool call', () => {
  const ctx = createFakeContext()
  const recorder = {
    push() {
      throw new Error('recorder down')
    },
    query: () => [],
    trace: () => [],
    stats: () => ({}),
    clear() {},
    setCapacity: () => 1,
    noteEarlyError() {},
    takeEarlyErrors: () => [],
  }
  installProbes({ ctx, recorder, config: { probes: true, captureConsole: false, captureProcessErrors: false } })

  const decision = { behavior: 'allow' }
  let returned
  assert.doesNotThrow(() => {
    returned = ctx.waterfall('tools/pre-execute', { name: 'bash', callId: 'a4' }, decision)
  })
  assert.equal(returned, decision)
})

test('A5 secrets are redacted before storage and in verbose JSON', () => {
  const ctx = createFakeContext({ services: { commands: createFakeCommands() } })
  const api = apply(ctx)

  api.mark('auth', { apiKey: 'sk-live-abcdef123456', user: 'ada' })

  // The buffer itself must not hold the secret.
  assert.doesNotMatch(JSON.stringify(api.query()), /sk-live-abcdef123456/)

  // Nor may any rendered form.
  const debuggerApi = { recorder: api.recorder, inspector: api, config: api.config, probes: { installed: {} } }
  assert.doesNotMatch(runCommand('events -v', debuggerApi).output, /sk-live-abcdef123456/)
  assert.doesNotMatch(runCommand('events -v --json', debuggerApi).output, /sk-live-abcdef123456/)
})

test('A6 overflow is counted and visible in stats and health', () => {
  const ctx = createFakeContext({ services: { commands: createFakeCommands() } })
  const api = apply(ctx, { capacity: 3 })
  for (let i = 0; i < 10; i += 1) api.mark(`m${i}`)

  const stats = api.stats()
  assert.equal(stats.size, 3)
  assert.equal(stats.dropped, 7)

  const debuggerApi = { recorder: api.recorder, inspector: api, config: api.config, probes: { installed: {} } }
  assert.match(runCommand('stats', debuggerApi).output, /dropped:\s+7/)
  assert.match(runCommand('health', debuggerApi).output, /7 dropped/)
})

test('A7 /debug plugins names the service a PENDING fiber waits for', () => {
  const ctx = createFakeContext({
    services: { commands: createFakeCommands() },
    plugins: [
      { name: 'stuck-plugin', fibers: [fakeFiber({ state: FiberState.PENDING, uid: 4, inject: { tools: true } })] },
    ],
  })
  const api = apply(ctx)
  const debuggerApi = { recorder: api.recorder, inspector: api, config: api.config, probes: { installed: {} } }

  const output = runCommand('plugins', debuggerApi).output
  assert.match(output, /stuck-plugin/)
  assert.match(output, /pending \(waiting for tools\)/)
})

test('A7 degradation: a broken loader does not fail /debug plugins', () => {
  const ctx = createFakeContext({ services: { commands: createFakeCommands() }, failEntries: true })
  const api = apply(ctx)
  const debuggerApi = { recorder: api.recorder, inspector: api, config: api.config, probes: { installed: {} } }

  const result = runCommand('plugins', debuggerApi)
  assert.equal(result.ok, true)
  assert.match(result.output, /enumerating plugins failed/)
})

test('A8 unload restores console, commands.execute, and the logger', () => {
  const commands = createFakeCommands()
  const ctx = createFakeContext({ services: { commands } })

  const originalConsoleLog = console.log
  const originalExecute = commands.execute
  const originalLoggerError = ctx.logger.error
  const consoleMarker = () => {}
  console.log = consoleMarker

  try {
    apply(ctx)
    assert.notEqual(console.log, consoleMarker, 'console wrapped')
    assert.notEqual(commands.execute, originalExecute, 'execute wrapped')
    assert.notEqual(ctx.logger.error, originalLoggerError, 'logger wrapped')

    ctx.disposeAll()

    assert.equal(console.log, consoleMarker, 'console restored')
    assert.equal(commands.execute, originalExecute, 'execute restored')
    assert.equal(ctx.logger.error, originalLoggerError, 'logger restored')
  } finally {
    console.log = originalConsoleLog
  }
})

test('A9 a second plugin can inject debugger and mark the timeline', () => {
  const ctx = createFakeContext({ services: { commands: createFakeCommands() } })
  const api = apply(ctx)

  // What a consumer plugin does after `inject: ['commands', 'debugger']`.
  api.mark('consumer/loaded', { version: '2.0.0' })
  api.record('tool', 'read', { correlation: 'call-42' })
  api.record('tool', 'read-done', { correlation: 'call-42' })

  assert.equal(api.query({ category: 'mark' })[0].name, 'consumer/loaded')
  assert.deepEqual(api.trace('call-42').map((r) => r.name), ['read', 'read-done'])
})

test('A10 the fake host constructs PENDING and the diagnosis text is asserted', () => {
  // The constructible-failure seam: this is what a real host cannot do on demand.
  const ctx = createFakeContext({
    plugins: [
      { name: 'pending-plugin', fibers: [fakeFiber({ state: FiberState.PENDING, uid: 1, inject: { tools: true } })] },
      { name: 'failed-plugin', fibers: [fakeFiber({ state: FiberState.FAILED, uid: 2 })] },
      { name: 'active-plugin', fibers: [fakeFiber({ state: FiberState.ACTIVE, uid: 3 })] },
    ],
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  const byName = Object.fromEntries(inspector.diagnose().findings.map((f) => [f.name, f]))

  assert.equal(byName['pending-plugin'].reason, 'pending (waiting for tools)')
  assert.match(byName['failed-plugin'].reason, /failed/)
  assert.equal(byName['active-plugin'], undefined, 'a healthy plugin produces no finding')
})

test('every acceptance row is accounted for', () => {
  const rows = Object.keys(ACCEPTANCE)
  assert.equal(rows.length, 10, 'the §8 table has ten rows')
  for (const row of rows) {
    assert.ok(['covered', 'pending'].includes(ACCEPTANCE[row].status), `${row} needs a status`)
  }

  const byStatus = (status) => rows.filter((r) => ACCEPTANCE[r].status === status)
  // All ten are covered. A1 qualifies because `real-boot.mjs` makes the claim
  // re-runnable, not because a one-off run was described in prose.
  assert.equal(byStatus('covered').length, 10, 'every acceptance row has a runnable check')
  assert.deepEqual(byStatus('pending'), [])
})
