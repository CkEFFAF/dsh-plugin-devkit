/**
 * The two `FiberState` mirrors must not diverge.
 *
 * `dsh-debugger` ships its own copy so the plugin stays self-contained (no
 * dependency on a test package), and `dsh-plugin-test` ships one because it owns
 * the guarded mirror. Six frozen numbers are cheaper duplicated than either a
 * runtime cross-dependency or a build step — but only if something fails when
 * they disagree.
 *
 * This is that something. Each mirror is independently checked against the real
 * cordis source by its own `fiber-state.test.mjs`; this test closes the triangle
 * so an edit to one copy cannot silently leave the other wrong.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as pluginTest from '../src/fiber-state.mjs'
import * as debugger_ from 'dsh-debugger/fiber-state'

test('both FiberState mirrors agree exactly', () => {
  assert.deepEqual(
    { ...pluginTest.FiberState },
    { ...debugger_.FiberState },
    'the dsh-plugin-test and dsh-debugger mirrors have diverged',
  )
})

test('both mirrors agree on member order', () => {
  // Order is part of the contract: the numeric values are positional.
  assert.deepEqual(
    Object.keys(pluginTest.FiberState),
    Object.keys(debugger_.FiberState),
  )
})

test('both mirrors agree on every derived label', () => {
  for (const value of Object.values(pluginTest.FiberState)) {
    assert.equal(
      pluginTest.fiberStateName(value),
      debugger_.fiberStateName(value),
      `state ${value} is labelled differently by the two packages`,
    )
  }
})

test('both mirrors agree on the classification predicates', () => {
  for (const value of Object.values(pluginTest.FiberState)) {
    assert.equal(pluginTest.isActive(value), debugger_.isActive(value), `isActive(${value})`)
    assert.equal(pluginTest.isTerminal(value), debugger_.isTerminal(value), `isTerminal(${value})`)
    assert.equal(pluginTest.isTransient(value), debugger_.isTransient(value), `isTransient(${value})`)
  }
})
