/**
 * The fake Cordis host now lives in `dsh-plugin-test`.
 *
 * This file was the original home of the fake host; it moved when feat-004
 * promoted the test infrastructure into its own package. Rather than leave two
 * copies to drift apart, this is a re-export of the canonical implementation.
 *
 * 功能文档 §6.3 and `harness/progress.md` both said feat-004 should *promote* the
 * existing host rather than write a second one. This is that promotion: the
 * debugger's tests keep working unchanged, and there is exactly one fake host.
 *
 * Do not add behaviour here. Extend `packages/dsh-plugin-test/src/fake-host.mjs`.
 */

export {
  FiberState,
  fakeFiber,
  fakeRuntime,
  createFakeContext,
  createFakeCommands,
  createFakeTools,
} from 'dsh-plugin-test/fake-host'
