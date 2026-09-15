/**
 * JSON report tests.
 *
 * 设计文档 §3 makes the JSON report a CI seam: **stable fields, not formatting**.
 * These tests pin the field names and the honesty properties — in particular that
 * a run which dropped records cannot read as a clean pass.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from 'dsh-debugger'
import {
  REPORT_VERSION,
  buildReport,
  renderReportJson,
  renderReportSummary,
  runCases,
} from '../src/report.mjs'
import { createFakeContext, createFakeCommands, fakeFiber, FiberState } from '../src/fake-host.mjs'

/**
 * Mount the debugger and return the service.
 *
 * @param {{capacity?: number}} [options]
 */
function mount(options = {}) {
  const ctx = createFakeContext({ services: { commands: createFakeCommands() } })
  return apply(ctx, options)
}

// ------------------------------------------------------------ buildReport --

test('a report with no failures is ok', () => {
  const report = buildReport({
    cases: [
      { name: 'a', ok: true, message: 'fine' },
      { name: 'b', ok: true, message: 'fine' },
    ],
  })
  assert.equal(report.ok, true)
  assert.equal(report.summary.total, 2)
  assert.equal(report.summary.passed, 2)
  assert.equal(report.summary.failed, 0)
})

test('one failure makes the whole report not ok', () => {
  const report = buildReport({
    cases: [
      { name: 'a', ok: true, message: 'fine' },
      { name: 'b', ok: false, message: 'broken' },
    ],
  })
  assert.equal(report.ok, false)
  assert.equal(report.summary.failed, 1)
})

test('the report carries a schema version', () => {
  const report = buildReport({ cases: [] })
  assert.equal(report.version, REPORT_VERSION)
  assert.equal(typeof report.version, 'number')
})

test('the report has stable top-level fields', () => {
  const report = buildReport({ suite: 'my-suite', cases: [] })
  assert.deepEqual(
    Object.keys(report).sort(),
    ['cases', 'counters', 'ok', 'suite', 'summary', 'version'],
  )
  assert.equal(report.suite, 'my-suite')
})

test('a case detail is only present when supplied', () => {
  const report = buildReport({
    cases: [
      { name: 'with', ok: false, message: 'x', detail: { why: 1 } },
      { name: 'without', ok: true, message: 'y' },
    ],
  })
  assert.equal(typeof report.cases[0].detail, 'string')
  assert.equal('detail' in report.cases[1], false)
})

// ------------------------------------------------------- evidence honesty --

test('a clean run reports no overflow', () => {
  const api = mount()
  api.mark('x')
  const report = buildReport({ cases: [], debugger: api })
  assert.equal(report.summary.overflowed, false)
  assert.equal(report.summary.recordsDropped, 0)
})

test('an overflowed buffer is surfaced in the report, not hidden', () => {
  const api = mount({ capacity: 2 })
  for (let i = 0; i < 10; i += 1) api.mark(`m${i}`)

  const report = buildReport({ cases: [{ name: 'a', ok: true, message: 'fine' }], debugger: api })

  // The run "passed", but its view of the timeline was partial. A report that
  // hid that would let a dropped-evidence run read as clean.
  assert.equal(report.ok, true)
  assert.equal(report.summary.overflowed, true)
  assert.equal(report.summary.recordsDropped, 8)
  assert.equal(report.summary.recordsRetained, 2)
})

test('the summary line mentions dropped records', () => {
  const api = mount({ capacity: 2 })
  for (let i = 0; i < 5; i += 1) api.mark(`m${i}`)
  const report = buildReport({ cases: [{ name: 'a', ok: true, message: '' }], debugger: api })
  assert.match(renderReportSummary(report), /3 records dropped/)
})

test('counters are zero when no debugger is supplied', () => {
  const report = buildReport({ cases: [] })
  assert.deepEqual(report.counters, { size: 0, capacity: 0, dropped: 0, seq: 0 })
})

test('a throwing debugger does not break report generation', () => {
  const hostile = {
    stats() {
      throw new Error('stats exploded')
    },
  }
  const report = buildReport({ cases: [{ name: 'a', ok: true, message: '' }], debugger: hostile })
  assert.equal(report.counters.dropped, 0)
  assert.equal(report.ok, true)
})

test('a debugger exposing only recorder.stats() still reports counters', () => {
  const report = buildReport({
    cases: [],
    debugger: { recorder: { stats: () => ({ size: 3, capacity: 10, dropped: 1, seq: 4 }) } },
  })
  assert.equal(report.counters.size, 3)
  assert.equal(report.counters.dropped, 1)
})

// ------------------------------------------------------------------ render --

test('the report renders as parseable JSON', () => {
  const report = buildReport({
    cases: [{ name: 'a', ok: false, message: 'boom', detail: { n: 1 } }],
  })
  const parsed = JSON.parse(renderReportJson(report))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.cases[0].name, 'a')
})

test('the summary line reads as a verdict', () => {
  const ok = buildReport({ cases: [{ name: 'a', ok: true, message: '' }] })
  assert.match(renderReportSummary(ok), /^PASS: 1\/1/)

  const bad = buildReport({ cases: [{ name: 'a', ok: false, message: '' }] })
  assert.match(renderReportSummary(bad), /^FAIL: 0\/1/)
})

test('the summary line counts failures', () => {
  const report = buildReport({
    cases: [
      { name: 'a', ok: false, message: '' },
      { name: 'b', ok: false, message: '' },
      { name: 'c', ok: true, message: '' },
    ],
  })
  assert.match(renderReportSummary(report), /1\/3 checks passed, 2 failed/)
})

// ---------------------------------------------------------------- runCases --

test('runCases accepts assertion results', async () => {
  const report = await runCases([
    { name: 'passing', run: () => ({ ok: true, message: 'fine' }) },
    { name: 'failing', run: () => ({ ok: false, message: 'nope' }) },
  ])
  assert.equal(report.summary.total, 2)
  assert.equal(report.summary.failed, 1)
})

test('runCases accepts booleans', async () => {
  const report = await runCases([
    { name: 'yes', run: () => true },
    { name: 'no', run: () => false },
  ])
  assert.equal(report.summary.passed, 1)
  assert.equal(report.cases[1].ok, false)
})

// Regression guard. `run` used to pass ONLY on a literal `true`, so the ordinary
// JS style — return nothing, throw on failure — was recorded as failed with the
// message "expected true, got undefined", which describes the return value
// rather than the problem. Found by writing a real plugin against the CLI.
test('a case that returns nothing has passed', async () => {
  const report = await runCases([
    { name: 'void success', run: () => {} },
    { name: 'void success, async', run: async () => {} },
  ])
  assert.equal(report.summary.passed, 2, 'returning nothing must mean success')
  assert.equal(report.ok, true)
})

test('the throw-on-failure style works end to end', async () => {
  // The idiomatic shape: succeed silently, throw with a useful message.
  const report = await runCases([
    { name: 'good', run: () => { if (1 !== 1) throw new Error('never') } },
    { name: 'bad', run: () => { if (1 === 1) throw new Error('the real problem') } },
  ])
  assert.equal(report.summary.passed, 1)
  assert.equal(report.summary.failed, 1)
  // The message must describe the PROBLEM, not the return value.
  assert.match(report.cases[1].message, /the real problem/)
})

test('a non-boolean return explains what was returned', async () => {
  const report = await runCases([
    { name: 'returns a number', run: () => 7 },
    { name: 'returns a string', run: () => 'nope' },
    { name: 'returns an object without ok', run: () => ({ message: 'forgot ok' }) },
  ])
  assert.equal(report.summary.failed, 3)
  assert.match(report.cases[0].message, /got 7/)
  assert.match(report.cases[1].message, /"nope"/)
  assert.match(report.cases[2].message, /without an 'ok' field/)
})

test('runCases awaits async cases', async () => {
  const report = await runCases([
    { name: 'async', run: async () => ({ ok: true, message: 'eventually' }) },
  ])
  assert.equal(report.ok, true)
})

test('a throwing case fails without aborting the run', async () => {
  const report = await runCases([
    { name: 'throws', run: () => { throw new Error('kaboom') } },
    { name: 'still runs', run: () => true },
  ])
  // One broken assertion must not hide the rest of the picture.
  assert.equal(report.summary.total, 2)
  assert.equal(report.summary.failed, 1)
  assert.match(report.cases[0].message, /kaboom/)
  assert.equal(report.cases[1].ok, true)
})

test('runCases threads the debugger into counters', async () => {
  const api = mount({ capacity: 1 })
  for (let i = 0; i < 4; i += 1) api.mark(`m${i}`)
  const report = await runCases([{ name: 'a', run: () => true }], { debugger: api })
  assert.equal(report.summary.recordsDropped, 3)
})

test('a full report survives JSON round-tripping', async () => {
  const api = mount({ capacity: 2 })
  for (let i = 0; i < 5; i += 1) api.mark(`m${i}`)
  const report = await runCases([
    { name: 'ok', run: () => ({ ok: true, message: 'fine' }) },
    { name: 'bad', run: () => ({ ok: false, message: 'broken', detail: { waitingFor: ['tools'] } }) },
  ], { debugger: api })

  const parsed = JSON.parse(renderReportJson(report))
  assert.equal(parsed.summary.total, 2)
  assert.equal(parsed.summary.recordsDropped, 3)
  assert.equal(parsed.ok, false)
})

test('an un-serializable detail does not break the report', async () => {
  const cyclic = { name: 'c' }
  cyclic.self = cyclic
  const report = await runCases([
    { name: 'cyclic', run: () => ({ ok: false, message: 'x', detail: cyclic }) },
  ])
  // The report must still render; the detail degrades rather than throwing.
  assert.equal(JSON.parse(renderReportJson(report)).cases[0].name, 'cyclic')
})
