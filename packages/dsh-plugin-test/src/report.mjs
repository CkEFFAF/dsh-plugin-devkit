/**
 * JSON report generation for host contract tests.
 *
 * 功能文档 §6.3 asks for "pass / fail / overflow counts" in a machine-readable
 * report, and 设计文档 §3 lists the JSON report as a seam: **stable fields, not
 * formatting**. So nothing here decides wording for humans — it emits a fixed
 * shape that CI can branch on.
 *
 * The report is built from assertion results plus the recorder's own counters,
 * which means an overflow in the debugger shows up in the same report as the
 * test outcome. A run that silently dropped evidence must not read as a clean
 * pass, so `overflowed` is a top-level field rather than a footnote.
 */

import { safeJson } from './json.mjs'

/** Report schema version. Bump only on a breaking field change. */
export const REPORT_VERSION = 1

/**
 * @typedef {{
 *   name: string,
 *   ok: boolean,
 *   message: string,
 *   detail?: unknown,
 * }} CaseResult
 */

/**
 * Build a report from named assertion results.
 *
 * @param {{
 *   suite?: string,
 *   cases: Array<CaseResult>,
 *   debugger?: object|null,
 *   now?: () => Date,
 * }} options
 * @returns {object}
 */
export function buildReport(options) {
  const cases = (options.cases ?? []).map((entry) => ({
    name: entry.name,
    ok: entry.ok === true,
    message: entry.message ?? '',
    // `detail` is present only when there is something to say, so the shape
    // stays stable without padding every row with null.
    ...(entry.detail === undefined ? {} : { detail: safeJson(entry.detail) }),
  }))

  const passed = cases.filter((entry) => entry.ok).length
  const failed = cases.length - passed

  const counters = readCounters(options.debugger)

  return {
    version: REPORT_VERSION,
    suite: options.suite ?? 'dsh-plugin-test',
    ok: failed === 0,
    summary: {
      total: cases.length,
      passed,
      failed,
      // Honest evidence accounting: if the buffer dropped records, the report
      // itself says the run's view was partial.
      overflowed: counters.dropped > 0,
      recordsDropped: counters.dropped,
      recordsRetained: counters.size,
    },
    counters,
    cases,
  }
}

/**
 * Read the recorder counters defensively.
 *
 * A report must be buildable even when the plugin under test failed to mount, so
 * a missing or throwing `stats()` degrades to zeros rather than taking the report
 * down with it.
 *
 * @param {object|null|undefined} debuggerService
 * @returns {{size: number, capacity: number, dropped: number, seq: number}}
 */
function readCounters(debuggerService) {
  const empty = { size: 0, capacity: 0, dropped: 0, seq: 0 }
  if (!debuggerService) return empty
  try {
    const stats = typeof debuggerService.stats === 'function'
      ? debuggerService.stats()
      : debuggerService.recorder?.stats?.()
    if (!stats || typeof stats !== 'object') return empty
    return {
      size: num(stats.size),
      capacity: num(stats.capacity),
      dropped: num(stats.dropped ?? stats.evicted),
      seq: num(stats.seq),
    }
  } catch {
    return empty
  }
}

/**
 * Coerce to a finite number.
 *
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Render a report as JSON text.
 *
 * @param {object} report
 * @param {{pretty?: boolean}} [options]
 * @returns {string}
 */
export function renderReportJson(report, options = {}) {
  return JSON.stringify(report, null, options.pretty === false ? 0 : 2)
}

/**
 * Render a one-line human summary for a terminal.
 *
 * Deliberately terse: the JSON is the contract, this is a convenience.
 *
 * @param {object} report
 * @returns {string}
 */
export function renderReportSummary(report) {
  const { total, passed, failed, recordsDropped } = report.summary
  const verdict = report.ok ? 'PASS' : 'FAIL'
  let line = `${verdict}: ${passed}/${total} checks passed`
  if (failed > 0) line += `, ${failed} failed`
  if (recordsDropped > 0) line += `, ${recordsDropped} records dropped (buffer overflowed)`
  return line
}

/**
 * Run named cases and produce a report.
 *
 * ## The `run` return contract
 *
 * A case passes when it:
 *
 * - returns nothing (`undefined`) — the ordinary JS style of throwing on failure;
 * - returns `true`;
 * - returns an assertion result `{ ok, message }` from the helpers in
 *   `assertions.mjs`.
 *
 * Anything else is a failure, and a throw is caught and reported with its own
 * message so one broken case does not hide the rest.
 *
 * Returning `undefined` meaning *success* is deliberate. It is what
 * `if (bad) throw new Error(...)` naturally produces, and treating it as failure
 * made the most idiomatic way to write a case report the misleading
 * `expected true, got undefined` — describing the return value rather than the
 * problem. The rule now matches the assertion helpers, which return a result
 * object rather than throwing.
 *
 * @param {Array<{name: string, run: () => unknown}>} cases
 * @param {{suite?: string, debugger?: object|null}} [options]
 * @returns {Promise<object>}
 */
export async function runCases(cases, options = {}) {
  const results = []
  for (const entry of cases) {
    try {
      const value = await entry.run()
      if (value && typeof value === 'object' && 'ok' in value) {
        results.push({ name: entry.name, ok: value.ok === true, message: value.message ?? '', detail: value.detail })
      } else if (value === undefined) {
        // Void means "nothing went wrong". See the contract note above.
        results.push({ name: entry.name, ok: true, message: 'ok' })
      } else {
        results.push({
          name: entry.name,
          ok: value === true,
          message: value === true
            ? 'ok'
            : `expected true, an assertion result, or no return value; got ${describe(value)}`,
        })
      }
    } catch (error) {
      results.push({
        name: entry.name,
        ok: false,
        message: `threw: ${error?.message ?? String(error)}`,
      })
    }
  }
  return buildReport({ suite: options.suite, cases: results, debugger: options.debugger })
}

/**
 * Describe a returned value for a failure message.
 *
 * Distinguishes the cases an author actually confuses: a forgotten `return`
 * versus a `false` from a real check.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'function') return 'a function'
  if (Array.isArray(value)) return `an array (length ${value.length})`
  if (typeof value === 'object') return `an object without an 'ok' field: ${Object.keys(value).join(', ') || '(empty)'}`
  return String(value)
}
