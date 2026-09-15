/**
 * Command layer tests: parsing, dispatch, rendering, and configuration.
 *
 * These run without any host because parsing and rendering are pure functions
 * over the debugger API.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseArgs, runCommand, SUBCOMMANDS } from '../src/command.mjs'
import { createRecorder } from '../src/recorder.mjs'
import { createInspector } from '../src/inspector.mjs'
import { createFakeContext, fakeFiber, FiberState } from './fake-context.mjs'

/**
 * Build a debugger API over a fake context.
 *
 * @param {{plugins?: object[], services?: object}} [options]
 */
function makeApi(options = {}) {
  const ctx = createFakeContext(options)
  const recorder = createRecorder({ capacity: options.capacity ?? 1000 })
  const inspector = createInspector({ ctx, recorder })
  const config = { capacity: 1000, probes: true, captureConsole: true, captureProcessErrors: true, enabled: true }
  return {
    recorder,
    inspector,
    config,
    probes: { installed: { tools: true, commands: true, console: true, process: true }, failures: {} },
  }
}

// ------------------------------------------------------------------- parsing --

test('an empty invocation defaults to health', () => {
  assert.equal(parseArgs('').subcommand, 'health')
})

test('a bare subcommand parses', () => {
  const parsed = parseArgs('plugins')
  assert.equal(parsed.subcommand, 'plugins')
  assert.deepEqual(parsed.positional, [])
})

test('equals-form options parse', () => {
  const parsed = parseArgs('events --category=tool --limit=5')
  assert.equal(parsed.options.category, 'tool')
  assert.equal(parsed.options.limit, 5)
})

test('space-form options after the subcommand parse as positionals', () => {
  // `/debug events --name read` -> --name takes the next token.
  const parsed = parseArgs('events --name=read')
  assert.equal(parsed.options.name, 'read')
})

test('-v is accepted as verbose', () => {
  assert.equal(parseArgs('events -v').options.verbose, true)
  assert.equal(parseArgs('events --verbose').options.verbose, true)
})

test('--errors is a boolean flag', () => {
  assert.equal(parseArgs('events --errors').options.errorsOnly, true)
})

test('--json is a boolean flag', () => {
  assert.equal(parseArgs('health --json').options.json, true)
})

test('trace takes a positional correlation id', () => {
  const parsed = parseArgs('trace call-123')
  assert.equal(parsed.subcommand, 'trace')
  assert.deepEqual(parsed.positional, ['call-123'])
})

test('quoted values are preserved', () => {
  const parsed = parseArgs('events --name="two words"')
  assert.equal(parsed.options.name, 'two words')
})

test('an unknown category is rejected at parse time', () => {
  const parsed = parseArgs('events --category=nonsense')
  assert.equal(parsed.errors.length, 1)
  assert.match(parsed.errors[0], /unknown category/)
})

test('every documented category is accepted', () => {
  for (const category of ['plugin', 'event', 'tool', 'command', 'service', 'log', 'error', 'mark']) {
    assert.deepEqual(parseArgs(`events --category=${category}`).errors, [], `${category} should parse`)
  }
})

test('a non-numeric limit is rejected', () => {
  const parsed = parseArgs('events --limit=abc')
  assert.match(parsed.errors[0], /--limit needs a non-negative number/)
})

test('a negative limit is rejected', () => {
  assert.match(parseArgs('events --limit=-3').errors[0], /--limit/)
})

test('an unknown option is rejected, not silently ignored', () => {
  assert.match(parseArgs('events --bogus').errors[0], /unknown option '--bogus'/)
})

test('--category without a value is rejected', () => {
  assert.match(parseArgs('events --category').errors[0], /--category needs a value/)
})

// ------------------------------------------------------------------ dispatch --

test('an unknown subcommand produces usage instead of throwing', () => {
  const result = runCommand('nonsense', makeApi())
  assert.equal(result.ok, false)
  assert.match(result.output, /unknown subcommand/)
})

test('every declared subcommand is dispatchable', () => {
  const api = makeApi()
  for (const subcommand of SUBCOMMANDS) {
    const input = subcommand === 'trace' ? 'trace x' : subcommand
    const result = runCommand(input, api)
    assert.equal(result.ok, true, `${subcommand} should succeed`)
    assert.ok(result.output.length > 0, `${subcommand} should render something`)
  }
})

test('health gives a one-line verdict plus the timeline state', () => {
  const api = makeApi({
    plugins: [{
      name: 'ok',
      fibers: [fakeFiber({ state: FiberState.ACTIVE, uid: 1 })],
    }],
  })
  const result = runCommand('health', api)
  assert.equal(result.ok, true)
  assert.match(result.output, /^OK: plugins 1\/1 active/)
  assert.match(result.output, /timeline: 0\/1000 records/)
  assert.match(result.output, /probes: active/)
})

test('health reports DEGRADED when a plugin is pending', () => {
  const api = makeApi({
    plugins: [{
      name: 'stuck',
      fibers: [fakeFiber({ state: FiberState.PENDING, uid: 1, inject: { tools: true } })],
    }],
  })
  const result = runCommand('health', api)
  assert.match(result.output, /^DEGRADED/)
  assert.match(result.output, /stuck: pending \(waiting for tools\)/)
})

test('health reports UNHEALTHY when a plugin failed', () => {
  const api = makeApi({
    plugins: [{ name: 'boom', fibers: [fakeFiber({ state: FiberState.FAILED, uid: 1 })] }],
  })
  assert.match(runCommand('health', api).output, /^UNHEALTHY/)
})

test('health surfaces buffer overflow rather than hiding it (A6)', () => {
  const api = makeApi({ plugins: [], capacity: 2 })
  for (let i = 0; i < 5; i += 1) api.recorder.push('mark', `m${i}`)

  const result = runCommand('health', api)
  assert.match(result.output, /2\/2 records, 3 dropped/)
  assert.match(result.output, /overflowed/)
})

test('health names the source-debugging boundary (功能文档 §6.5)', () => {
  // §6.5 requires this text in `/debug health`, because the debugger answers "is
  // the composition wired" and the next question is "why did my line not run" —
  // a different tool. It was missing until this test was written.
  const output = runCommand('health', makeApi()).output
  assert.match(output, /--inspect=9229/)
  assert.match(output, /chrome:\/\/inspect/)
  assert.match(output, /not this one/)
})

test('health -v omits the source-debugging note', () => {
  // Once it has been read, repeating it on every call is noise.
  const output = runCommand('health -v', makeApi()).output
  assert.doesNotMatch(output, /--inspect=9229/)
})

test('health --json omits the note entirely', () => {
  // The JSON form is a machine contract; a prose hint does not belong in it.
  const output = runCommand('health --json', makeApi()).output
  assert.doesNotMatch(output, /--inspect/)
  assert.doesNotThrow(() => JSON.parse(output))
})

test('the verdict stays on the first line despite the note', () => {
  const output = runCommand('health', makeApi()).output
  assert.match(output.split('\n')[0], /^OK: plugins/)
})

test('health is never OK while a plugin is still loading (false-green guard)', () => {
  // Found by driving /debug against a real cordis host: three fibers mid-load
  // reported "OK: plugins 0/3 active, 0 pending, 0 failed", because the verdict
  // only looked at failed and pending. A composition with nothing active must
  // never read as healthy — that is the worst output this tool can produce.
  const api = makeApi({
    plugins: [
      { name: 'loading-a', fibers: [fakeFiber({ state: FiberState.LOADING, uid: 1 })] },
      { name: 'loading-b', fibers: [fakeFiber({ state: FiberState.LOADING, uid: 2 })] },
    ],
  })
  const output = runCommand('health', api).output
  assert.doesNotMatch(output.split('\n')[0], /^OK/)
  assert.match(output.split('\n')[0], /^DEGRADED/)
  assert.match(output.split('\n')[0], /0\/2 active/)
  assert.match(output.split('\n')[0], /2 in transition/)
})

test('health is not OK while a plugin is unloading or disposed', () => {
  for (const state of [FiberState.UNLOADING, FiberState.DISPOSED]) {
    const api = makeApi({
      plugins: [{ name: 'p', fibers: [fakeFiber({ state, uid: 1 })] }],
    })
    assert.doesNotMatch(runCommand('health', api).output.split('\n')[0], /^OK/, `state ${state}`)
  }
})

test('health stays OK when every fiber is active', () => {
  const api = makeApi({
    plugins: [
      { name: 'a', fibers: [fakeFiber({ state: FiberState.ACTIVE, uid: 1 })] },
      { name: 'b', fibers: [fakeFiber({ state: FiberState.ACTIVE, uid: 2 })] },
    ],
  })
  assert.match(runCommand('health', api).output.split('\n')[0], /^OK: plugins 2\/2 active/)
})

test('a non-OK verdict with no findings explains itself', () => {
  // Otherwise the reader is told something is wrong and given nothing to act on.
  const api = makeApi({
    plugins: [{ name: 'p', fibers: [fakeFiber({ state: FiberState.LOADING, uid: 1 })] }],
  })
  const output = runCommand('health', api).output
  assert.match(output, /still settling|in transition/)
})

test('health lists inactive probes', () => {
  const api = makeApi()
  api.probes = { installed: { tools: false, console: true }, failures: { tools: 'no event bus' } }
  assert.match(runCommand('health', api).output, /probes: inactive \[tools\]/)
})

test('health does not report an absent optional service as a broken probe', () => {
  // `toolsService` records reachability, not probe health. Reporting it as an
  // inactive probe would blame the debugger for a composition that simply has
  // no tools service.
  const api = makeApi()
  api.probes = {
    installed: { tools: true, commands: true, console: true, process: true, toolsService: false, commandsService: true },
    failures: {},
  }
  const output = runCommand('health', api).output
  assert.match(output, /probes: active/)
  assert.doesNotMatch(output, /inactive/)
  assert.match(output, /optional services absent: \[tools\]/)
})

test('plugins lists each fiber with its state', () => {
  const api = makeApi({
    plugins: [{ name: 'alpha', fibers: [fakeFiber({ state: FiberState.ACTIVE, uid: 3 })] }],
  })
  const result = runCommand('plugins', api)
  assert.match(result.output, /ACTIVE\s+alpha \(fiber 3\)/)
})

test('plugins shows a root-cause section for unhealthy plugins (A7)', () => {
  const api = makeApi({
    plugins: [{
      name: 'stuck',
      fibers: [fakeFiber({ state: FiberState.PENDING, uid: 1, inject: { tools: true } })],
    }],
  })
  const result = runCommand('plugins', api)
  assert.match(result.output, /root causes:/)
  assert.match(result.output, /stuck: pending \(waiting for tools\)/)
})

test('plugins reports an empty composition honestly', () => {
  assert.match(runCommand('plugins', makeApi()).output, /no plugins registered/)
})

test('plugins reports a degraded inspector instead of failing', () => {
  const api = makeApi()
  api.inspector = createInspector({
    ctx: createFakeContext({ failEntries: true }),
    recorder: api.recorder,
  })
  const result = runCommand('plugins', api)
  assert.equal(result.ok, true)
  assert.match(result.output, /enumerating plugins failed/)
})

test('services lists registered services', () => {
  const api = makeApi({ services: { tools: {}, commands: {} } })
  const result = runCommand('services', api)
  assert.match(result.output, /tools/)
  assert.match(result.output, /commands/)
})

test('events renders records and honours --limit', () => {
  const api = makeApi()
  for (let i = 1; i <= 10; i += 1) api.recorder.push('mark', `m${i}`)

  const result = runCommand('events --limit=2', api)
  assert.match(result.output, /m9/)
  assert.match(result.output, /m10/)
  assert.doesNotMatch(result.output, /m8/)
})

test('events filters by category', () => {
  const api = makeApi()
  api.recorder.push('tool', 'read')
  api.recorder.push('log', 'noise')

  const result = runCommand('events --category=tool', api)
  assert.match(result.output, /read/)
  assert.doesNotMatch(result.output, /noise/)
})

test('events --errors shows only failures', () => {
  const api = makeApi()
  api.recorder.push('tool', 'fine')
  api.recorder.push('tool', 'broken', { error: new Error('kaput') })

  const result = runCommand('events --errors', api)
  assert.match(result.output, /broken/)
  assert.doesNotMatch(result.output, /fine/)
})

test('events -v prints sanitized payloads', () => {
  const api = makeApi()
  api.recorder.push('log', 'auth', { data: { apiKey: 'sk-live-abcdef123456', user: 'ada' } })

  const result = runCommand('events -v', api)
  assert.match(result.output, /\[redacted\]/)
  assert.match(result.output, /ada/)
  // The secret must not appear even in verbose output (A5).
  assert.doesNotMatch(result.output, /sk-live-abcdef123456/)
})

test('events on an empty timeline says so', () => {
  assert.match(runCommand('events', makeApi()).output, /no records/)
})

test('trace lists one correlation chain in seq order', () => {
  const api = makeApi()
  api.recorder.push('tool', 'pre', { correlation: 'c1' })
  api.recorder.push('tool', 'unrelated', { correlation: 'c2' })
  api.recorder.push('tool', 'result', { correlation: 'c1' })

  const result = runCommand('trace c1', api)
  assert.match(result.output, /trace c1 \(2 records\)/)
  assert.ok(result.output.indexOf('pre') < result.output.indexOf('result'))
  assert.doesNotMatch(result.output, /unrelated/)
})

test('trace without an id prints usage', () => {
  const result = runCommand('trace', makeApi())
  assert.equal(result.ok, false)
  assert.match(result.output, /usage: \/debug trace <id>/)
})

test('trace of an unknown id is empty, not an error', () => {
  const result = runCommand('trace nope', makeApi())
  assert.equal(result.ok, true)
  assert.match(result.output, /no records/)
})

test('stats reports the overflow count as a warning (A6)', () => {
  const api = makeApi({ capacity: 2 })
  for (let i = 0; i < 4; i += 1) api.recorder.push('mark', `m${i}`)

  const result = runCommand('stats', api)
  assert.match(result.output, /dropped:\s+2/)
  assert.match(result.output, /timeline is incomplete/)
})

test('stats reports per-category timings and tool ranking', () => {
  const api = makeApi()
  api.recorder.push('tool', 'read', { durationMs: 20 })
  api.recorder.push('tool', 'read', { durationMs: 40 })

  const result = runCommand('stats', api)
  assert.match(result.output, /tool\s+n=2 avg=30ms max=40ms/)
  assert.match(result.output, /read/)
})

test('stats without overflow shows no warning', () => {
  const api = makeApi()
  api.recorder.push('mark', 'x')
  const result = runCommand('stats', api)
  assert.doesNotMatch(result.output, /incomplete/)
})

test('config with no arguments reads current settings', () => {
  const result = runCommand('config', makeApi())
  assert.match(result.output, /capacity = 1000/)
  assert.match(result.output, /probes = true/)
})

test('config capacity=<n> resizes the buffer at runtime', () => {
  const api = makeApi()
  const result = runCommand('config capacity=50', api)
  assert.equal(result.ok, true)
  assert.equal(api.recorder.capacity, 50)
  assert.match(result.output, /capacity=50/)
})

test('config on=false toggles capture', () => {
  const api = makeApi()
  runCommand('config on=false', api)
  assert.equal(api.config.enabled, false)
})

test('config rejects an invalid capacity without changing it', () => {
  const api = makeApi()
  const result = runCommand('config capacity=abc', api)
  assert.equal(result.ok, false)
  assert.equal(api.recorder.capacity, 1000)
})

test('config rejects an unknown key', () => {
  const result = runCommand('config nonsense=1', makeApi())
  assert.equal(result.ok, false)
  assert.match(result.output, /unknown config key/)
})

test('config rejects a non key=value token', () => {
  assert.match(runCommand('config justaword', makeApi()).output, /expected key=value/)
})

test('clear empties the timeline but keeps counters', () => {
  const api = makeApi({ capacity: 2 })
  for (let i = 0; i < 4; i += 1) api.recorder.push('mark', `m${i}`)

  const result = runCommand('clear', api)
  assert.equal(result.ok, true)
  assert.equal(api.recorder.query().length, 0)
  // The overflow is a lifetime counter and must survive a clear.
  assert.equal(api.recorder.stats().dropped, 2)
  assert.match(result.output, /counters kept/)
})

// ---------------------------------------------------------------------- JSON --

test('--json emits parseable JSON with stable fields', () => {
  const api = makeApi({
    plugins: [{ name: 'ok', fibers: [fakeFiber({ state: FiberState.ACTIVE, uid: 1 })] }],
  })
  const result = runCommand('health --json', api)
  const parsed = JSON.parse(result.output)
  assert.equal(parsed.subcommand, 'health')
  assert.equal(parsed.counts.active, 1)
  assert.equal(typeof parsed.stats.capacity, 'number')
})

test('--json on events returns the records array', () => {
  const api = makeApi()
  api.recorder.push('tool', 'read', { correlation: 'c1' })

  const parsed = JSON.parse(runCommand('events --json', api).output)
  assert.equal(parsed.count, 1)
  assert.equal(parsed.records[0].name, 'read')
  assert.equal(parsed.records[0].correlation, 'c1')
})

test('--json never leaks an unredacted secret (A5)', () => {
  const api = makeApi()
  api.recorder.push('log', 'auth', { data: { token: 'sk-live-abcdef123456' } })

  const output = runCommand('events -v --json', api).output
  assert.doesNotMatch(output, /sk-live-abcdef123456/)
  assert.match(output, /\[redacted\]/)
})

test('--json reports an error object on failure', () => {
  const parsed = JSON.parse(runCommand('nonsense --json', makeApi()).output)
  assert.equal(parsed.subcommand, 'error')
  assert.match(parsed.error, /unknown subcommand/)
})

test('--json on trace returns the correlation chain', () => {
  const api = makeApi()
  api.recorder.push('tool', 'pre', { correlation: 'c1' })
  const parsed = JSON.parse(runCommand('trace c1 --json', api).output)
  assert.equal(parsed.correlation, 'c1')
  assert.equal(parsed.records.length, 1)
})

test('--json on stats includes the overflow count', () => {
  const api = makeApi({ capacity: 1 })
  api.recorder.push('mark', 'a')
  api.recorder.push('mark', 'b')
  const parsed = JSON.parse(runCommand('stats --json', api).output)
  assert.equal(parsed.dropped, 1)
})
