/**
 * Tests for the plugin-pending failure class.
 *
 * The real DSH message this parses (captured from a real boot):
 *
 * ```
 * Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
 * file:///D:/DSH_workspace/my-todo-plugin/index.mjs: pending (waiting for service: definitelyNotAService)
 * ```
 *
 * Without this, the author of that plugin gets a stack trace and no way to learn
 * which service is missing — and because the instance never starts, the
 * observation kernel cannot help either.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FAILURE,
  parseInactiveEntry,
  bootPendingFailure,
  bootFailure,
  renderFailure,
} from '../src/failures.mjs'

/** The real captured stderr, verbatim in shape. */
const REAL = `Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
file:///D:/DSH_workspace/my-todo-plugin/index.mjs: pending (waiting for service: definitelyNotAService)
    at boot (D:\\DSH\\deepseek-harness\\packages\\boot\\app-boot\\src\\index.ts:832:11)
`

test('the awaited service is extracted from a real DSH message', () => {
  const parsed = parseInactiveEntry(REAL)
  assert.notEqual(parsed, null)
  assert.equal(parsed.service, 'definitelyNotAService')
  assert.equal(parsed.state, 'pending')
  // The path is decoded back from the file:// URL, because that is what the
  // author typed and will open in an editor.
  assert.match(parsed.entry, /my-todo-plugin[\\/]index\.mjs$/)
})

test('a failure that is not an activation failure is not misread', () => {
  // Must not claim every boot failure is a pending plugin.
  assert.equal(parseInactiveEntry('Error: EADDRINUSE: address already in use'), null)
  assert.equal(parseInactiveEntry('some pending thing happened'), null)
  assert.equal(parseInactiveEntry(''), null)
  assert.equal(parseInactiveEntry(undefined), null)
})

test('a message without the parenthesised detail still parses', () => {
  const parsed = parseInactiveEntry('dsh: 1 entry did not activate\nfile:///a/b/index.mjs: pending')
  assert.notEqual(parsed, null)
  assert.equal(parsed.service, null)
  assert.equal(parsed.state, 'pending')
})

test('the failure names the service and explains the fix', () => {
  const parsed = parseInactiveEntry(REAL)
  const failure = bootPendingFailure(parsed, REAL).failure

  assert.equal(failure.code, 'plugin-pending')
  assert.equal(failure.exit, 7)
  assert.match(failure.message, /definitelyNotAService/)
  assert.ok(
    failure.hints.some((h) => h.includes('inject')),
    'a hint must point at inject, which is the thing to change',
  )
  assert.ok(
    failure.hints.some((h) => h.includes('/debug')),
    'a hint must say the kernel cannot help here, so the author stops looking for it',
  )
})

test('the exit code is distinct from every other class', () => {
  const codes = Object.values(FAILURE).map((f) => f.exit)
  assert.equal(new Set(codes).size, codes.length, 'exit codes must be unique')
  assert.equal(FAILURE.PLUGIN_PENDING.exit, 7)
})

test('the failure renders readably, with the raw output kept', () => {
  const parsed = parseInactiveEntry(REAL)
  const text = renderFailure(bootPendingFailure(parsed, REAL).failure)

  assert.match(text, /^debug-boot: plugin-pending:/m)
  assert.match(text, /definitelyNotAService/)
  // The original DSH text stays visible: the summary must not hide the evidence.
  assert.match(text, /did not activate/)
  assert.match(text, /^hint: /m)
})

test('a service naming a nested name is captured whole', () => {
  const parsed = parseInactiveEntry(
    'dsh: 1 entry did not activate\nfile:///x/index.mjs: pending (waiting for service: storage.backend)',
  )
  assert.equal(parsed.service, 'storage.backend')
})

test('an unparseable line degrades instead of throwing', () => {
  assert.doesNotThrow(() => parseInactiveEntry('dsh: 1 entry did not activate\n\x00\xff garbage'))
})

test('bootFailure still works for the pre-existing classes', () => {
  const failure = bootFailure(FAILURE.PORT_IN_USE, 'busy').failure
  assert.equal(failure.code, 'port-in-use')
  assert.equal(failure.exit, 3)
})
