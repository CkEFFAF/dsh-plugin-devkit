/**
 * Fiber lifecycle states, mirrored from `vendor/cordis/src/fiber.ts`.
 *
 * ## Why these values are hardcoded
 *
 * Cordis declares `export const enum FiberState` (fiber.ts:147). A `const enum`
 * is erased during compilation — there is no runtime object to import — so
 * `import { FiberState } from 'cordis'` yields `undefined` and every fiber would
 * silently render as "Unknown". The values must therefore be mirrored as
 * literals.
 *
 * ## Why that is safe
 *
 * `tests/fiber-state.test.mjs` parses the real cordis source and asserts this
 * mirror still matches, so a cordis upgrade that reorders or inserts a member
 * fails the test suite instead of silently mislabeling states.
 *
 * If cordis ever exports a runtime enum, delete this mirror and import it.
 *
 * ## Relationship to `dsh-debugger`'s copy
 *
 * The debugger ships its own mirror so it stays a self-contained plugin with no
 * dependency on a test package. Duplication of six frozen numbers is the cheaper
 * cost than either a runtime cross-dependency or a build step. The two are kept
 * honest by `tests/mirror-agreement.test.mjs`, which fails if they diverge.
 */

/** Numeric state values, matching cordis member order exactly. */
export const FiberState = Object.freeze({
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
})

/** Human-readable label per state. */
export const FIBER_STATE_NAMES = Object.freeze({
  [FiberState.PENDING]: 'PENDING',
  [FiberState.LOADING]: 'LOADING',
  [FiberState.ACTIVE]: 'ACTIVE',
  [FiberState.FAILED]: 'FAILED',
  [FiberState.DISPOSED]: 'DISPOSED',
  [FiberState.UNLOADING]: 'UNLOADING',
})

/**
 * Name a fiber state.
 *
 * Unknown values render as `UNKNOWN(n)` rather than throwing, so a cordis that
 * adds a state degrades visibly instead of taking a report down.
 *
 * @param {unknown} state
 * @returns {string}
 */
export function fiberStateName(state) {
  return FIBER_STATE_NAMES[state] ?? `UNKNOWN(${String(state)})`
}

/** Whether a state is settled and healthy enough to serve. */
export function isActive(state) {
  return state === FiberState.ACTIVE
}

/** Whether a state will never become active without intervention. */
export function isTerminal(state) {
  return state === FiberState.FAILED || state === FiberState.DISPOSED
}

/** Whether a state is still moving and may resolve on its own. */
export function isTransient(state) {
  return state === FiberState.PENDING || state === FiberState.LOADING || state === FiberState.UNLOADING
}
