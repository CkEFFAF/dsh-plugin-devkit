/**
 * dsh-plugin-test — host contract tests for DSH plugins.
 *
 * 功能文档 §6.3: assert Host behaviour without starting a browser. Four pieces:
 *
 * 1. A fake Cordis host that can construct PENDING, FAILED, and deny on demand.
 * 2. A `FiberState` mirror guarded against drift from the real cordis source.
 * 3. Assertion helpers over the public `ctx.debugger` surface.
 * 4. A JSON report with pass / fail / overflow counts.
 *
 * The point is not to test a plugin's business logic — authors write those tests.
 * DevKit tests the *diagnostic facility*, and gives authors a way to assert on
 * what it reports.
 */

export { FiberState, FIBER_STATE_NAMES, fiberStateName, isActive, isTerminal, isTransient } from './src/fiber-state.mjs'

export {
  createFakeContext,
  fakeFiber,
  fakeRuntime,
  createFakeCommands,
  createFakeTools,
} from './src/fake-host.mjs'

export {
  noPending,
  serviceActive,
  traceHas,
  noSecrets,
  assertOk,
  ASSERTIONS,
} from './src/assertions.mjs'

export {
  REPORT_VERSION,
  buildReport,
  renderReportJson,
  renderReportSummary,
  runCases,
} from './src/report.mjs'

export { safeJson, toPlainJson, UNSERIALIZABLE } from './src/json.mjs'
