/**
 * Real-process verification for the `dsh-plugin-test` assertion helpers.
 *
 * ## Why this exists
 *
 * `packages/dsh-plugin-test/tests/*.test.mjs` exercises the helpers against the
 * fake host. That proves their logic but not that they work against the *real*
 * debugger running on a real Cordis `Context` — a fake only ever agrees with the
 * assumptions it was written from.
 *
 * This script mounts the real `dsh-debugger` on a real `Context`, drives it
 * through the real surface, and runs every assertion helper against the result.
 * It is the assertion-helper counterpart to the debugger's own
 * `tests/real-cordis.mjs`.
 *
 * It does **not** start a full DSH session: that needs a model and would spend
 * real quota. What it proves is that the helpers read a genuine debugger
 * correctly; what it does not prove is noted in the report.
 *
 * ## Running
 *
 * ```sh
 * cd D:/DSH/deepseek-harness
 * node --import tsx/esm \
 *   D:/DSH_workspace/dsh-plugin-devkit-pack/packages/dsh-plugin-test/tests/real-process.mjs
 * ```
 *
 * `file:///` URLs are mandatory for the absolute imports below: Node's ESM loader
 * rejects a bare `D:` drive path.
 */

import assert from 'node:assert/strict'

const CORDIS = 'file:///D:/DSH/deepseek-harness/vendor/cordis/src/index.ts'
const DEBUGGER = 'file:///D:/DSH_workspace/dsh-plugin-devkit-pack/packages/dsh-debugger/index.mjs'
const ASSERTIONS = 'file:///D:/DSH_workspace/dsh-plugin-devkit-pack/packages/dsh-plugin-test/src/assertions.mjs'
const REPORT = 'file:///D:/DSH_workspace/dsh-plugin-devkit-pack/packages/dsh-plugin-test/src/report.mjs'
const FAKE = 'file:///D:/DSH_workspace/dsh-plugin-devkit-pack/packages/dsh-plugin-test/src/fake-host.mjs'

const { Context, Service } = await import(CORDIS)
const Debugger = await import(DEBUGGER)
const { noPending, serviceActive, traceHas, noSecrets } = await import(ASSERTIONS)
const { runCases, buildReport, renderReportJson } = await import(REPORT)
const { fakeFiber, FiberState } = await import(FAKE)

const results = []
async function check(label, fn) {
  try {
    await fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error.message })
  }
}

// ---------------------------------------------------------------------------
// Mount the real debugger on a real Context.
// ---------------------------------------------------------------------------
const root = new Context()
const registered = new Map()
root.provide('commands', {
  register(definition) {
    // Mirror the real normalizeDefinition (interaction/commands/src/index.ts:189).
    // A host that accepts `execute` in place of `handler` hides the defect the
    // debugger actually shipped.
    if (typeof definition.handler !== 'function') {
      throw new TypeError(`command "${definition.name}" handler must be a function`)
    }
    registered.set(definition.name, definition)
    return () => registered.delete(definition.name)
  },
  // The real signature: (agent, line, attachments, signal).
  async execute(agent, line) {
    const parsed = /^\s*\/?([\w:-]+)/.exec(String(line ?? ''))
    const definition = parsed && registered.get(parsed[1])
    if (!definition) return undefined
    const result = await definition.handler({
      commandId: 'cmd-real-1',
      agent,
      rawInput: String(line ?? '').slice((parsed?.[0] ?? '').length),
      attachments: [],
      signal: new AbortController().signal,
    })
    return { commandId: 'cmd-real-1', result }
  },
})

let api
await check('the debugger mounts on a real Context', () => {
  api = Debugger.apply(root, { capacity: 100 })
  assert.equal(typeof api.mark, 'function')
})

// A real service provider, to give serviceActive something genuine to find.
class RealService extends Service {
  static provide = 'demoService'
}
await root.plugin(RealService, {})

// ---------------------------------------------------------------------------
// Drive the real surface, then assert on it with the helpers.
// ---------------------------------------------------------------------------
await check('noPending passes on a real composition', () => {
  const result = noPending(api)
  assert.equal(result.ok, true, result.message)
})

await check('serviceActive finds the debugger itself on a real Context', () => {
  const result = serviceActive(api, 'debugger')
  assert.equal(result.ok, true, result.message)
})

await check('serviceActive finds a real third-party service by its owning fiber', () => {
  // The declared name (`demoService`) is NOT readable on a real Context — the
  // proxy masks it. Only the owning fiber's name (`RealService`) survives, so
  // that is what a caller must match on. Asserting the declared name would be
  // asserting something the runtime cannot deliver.
  const result = serviceActive(api, 'RealService')
  assert.equal(result.ok, true, result.message)
  assert.match(result.message, /identified via/, 'an inferred identity must be labelled')
})

await check('the declared service name is genuinely unreadable, and says so', () => {
  const snapshot = api.snapshot()
  const entry = snapshot.services.find((candidate) => candidate.provider?.name === 'RealService')
  assert.ok(entry, 'the service should be listed')
  assert.equal(entry.nameReliable, false)
  assert.match(entry.name, /not readable/)

  // And looking it up by the declared name must fail rather than silently match
  // the wrong service.
  assert.equal(serviceActive(api, 'demoService').ok, false)
})

await check('serviceActive fails clearly for an absent service', () => {
  const result = serviceActive(api, 'definitelyNotAService')
  assert.equal(result.ok, false)
  assert.match(result.message, /not registered/)
})

await check('traceHas follows a real correlation chain', () => {
  api.record('tool', 'pre-execute', { correlation: 'real-call-1' })
  api.record('tool', 'execute', { correlation: 'real-call-1', durationMs: 3 })
  api.record('tool', 'result', { correlation: 'real-call-1' })
  const result = traceHas(api, 'real-call-1', ['pre-execute', 'execute', 'result'])
  assert.equal(result.ok, true, result.message)
})

await check('traceHas reports a missing kind', () => {
  const result = traceHas(api, 'real-call-1', ['never-happened'])
  assert.equal(result.ok, false)
  assert.match(result.message, /never-happened/)
})

await check('noSecrets passes after real redaction', () => {
  api.mark('auth', { apiKey: 'sk-live-SHOULD-NOT-SURVIVE' })
  const result = noSecrets(api)
  assert.equal(result.ok, true, JSON.stringify(result.detail))
})

await check('a real secret never reaches the buffer', () => {
  const serialized = JSON.stringify(api.query())
  assert.doesNotMatch(serialized, /SHOULD-NOT-SURVIVE/)
})

// ---------------------------------------------------------------------------
// The CLI's case-runner path, against a real debugger.
// ---------------------------------------------------------------------------
await check('runCases produces a report from real assertions', async () => {
  const report = await runCases([
    { name: 'noPending', run: () => noPending(api) },
    { name: 'serviceActive', run: () => serviceActive(api, 'debugger') },
    { name: 'traceHas', run: () => traceHas(api, 'real-call-1', ['execute']) },
    { name: 'noSecrets', run: () => noSecrets(api) },
  ], { suite: 'real-process', debugger: api })

  assert.equal(report.ok, true, JSON.stringify(report.cases.filter((c) => !c.ok)))
  assert.equal(report.summary.total, 4)
  assert.equal(report.summary.failed, 0)
  // And it must serialize, since the CLI prints exactly this.
  assert.doesNotThrow(() => JSON.parse(renderReportJson(report)))
})

await check('a failing case is reported, not thrown', async () => {
  const report = await runCases([
    { name: 'deliberate', run: () => serviceActive(api, 'nope') },
    { name: 'still runs', run: () => true },
  ], { debugger: api })
  assert.equal(report.ok, false)
  assert.equal(report.summary.failed, 1)
  assert.equal(report.cases[1].ok, true)
})

await check('overflow reaches the report from a real recorder', () => {
  const small = Debugger.apply(root, { capacity: 2 })
  for (let i = 0; i < 6; i += 1) small.mark(`m${i}`)
  const report = buildReport({ cases: [], debugger: small })
  assert.equal(report.summary.overflowed, true)
  assert.equal(report.summary.recordsDropped, 4)
})

// ---------------------------------------------------------------------------
// Real /debug command, driven the way a session would.
//
// Note the argument contract, established by calling the real definition: a
// command's invocation carries the **argument string only** ("health --json"),
// in `rawInput`, not the full "/debug health --json" line. Passing the line
// makes the parser read "/debug" as the subcommand and return an error.
// ---------------------------------------------------------------------------
async function runDebug(rawInput) {
  const execution = await root.get('commands').execute(
    root, `/debug ${rawInput}`.trim(),
  )
  return String(execution?.result?.text)
}

await check('the /debug command answers on a real host', async () => {
  const output = await runDebug('health')
  assert.match(output, /plugins/)
})

await check('the /debug command output is JSON-parseable', async () => {
  const parsed = JSON.parse(await runDebug('health --json'))
  assert.equal(typeof parsed.counts.total, 'number')
})

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
let failed = 0
for (const result of results) {
  if (result.ok) console.log(`ok    ${result.label}`)
  else {
    failed += 1
    console.log(`FAIL  ${result.label}\n        ${result.error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
console.log('note: no full DSH session was started (that needs a model and spends quota)')
process.exit(failed === 0 ? 0 : 1)
