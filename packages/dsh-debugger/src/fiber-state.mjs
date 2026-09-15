/**
 * Fiber lifecycle states, mirrored from `vendor/cordis/src/fiber.ts`.
 *
 * ## Why these values are hardcoded
 *
 * Cordis declares `export const enum FiberState` (fiber.ts:147). A `const enum`
 * is erased during compilation — there is no runtime object to import — so
 * `import { FiberState } from 'cordis'` yields `undefined` and every fiber would
 * silently render as "Unknown". The values must therefore be mirrored here as
 * literals.
 *
 * ## Why that is safe
 *
 * Design document 4.5 requires that enum drift be a build failure rather than a
 * cosmetic "Unknown". `tests/fiber-state.test.mjs` parses the real cordis source
 * and asserts this mirror still matches, so a cordis upgrade that reorders or
 * inserts a member fails the test suite instead of silently mislabeling states.
 *
 * If cordis ever exports a runtime enum, delete this mirror and import it.
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
 * @param {unknown} state
 * @returns {string}
 */
export function fiberStateName(state) {
  return FIBER_STATE_NAMES[state] ?? `UNKNOWN(${String(state)})`
}

/** States that are settled and healthy enough to serve requests. */
export function isActive(state) {
  return state === FiberState.ACTIVE
}

/** States that will never become active without intervention. */
export function isTerminal(state) {
  return state === FiberState.FAILED || state === FiberState.DISPOSED
}

/** States that are still moving and may resolve on their own. */
export function isTransient(state) {
  return state === FiberState.PENDING || state === FiberState.LOADING || state === FiberState.UNLOADING
}
