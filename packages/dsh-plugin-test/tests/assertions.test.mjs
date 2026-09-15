/**
 * Assertion helper tests.
 *
 * These helpers are what a plugin author actually calls, so the tests cover both
 * directions: a passing composition must pass, and a genuinely broken one must
 * fail *with a message that names the cause*. An assertion that merely returns
 * false without saying why is not worth shipping.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from 'dsh-debugger'
import { noPending, serviceActive, traceHas, noSecrets, assertOk, ASSERTIONS } from '../src/assertions.mjs'
import { createFakeContext, createFakeCommands, fakeFiber, FiberState } from '../src/fake-host.mjs'

/**
 * Mount the debugger on a fake host and return the service.
 *
 * @param {{plugins?: object[], services?: object, serviceProviders?: object, config?: object}} [options]
 */
function mount(options = {}) {
  const services = { commands: createFakeCommands(), ...(options.services ?? {}) }
  const ctx = createFakeContext({
    services,
    serviceProviders: options.serviceProviders,
    plugins: options.plugins ?? [],
  })
  const api = apply(ctx, options.config)
  return { ctx, api }
}

// --------------------------------------------------------------- noPending --

test('noPending passes when every plugin is active', () => {
  const { api } = mount({
    plugins: [{ name: 'healthy', fibers: [fakeFiber({ state: FiberState.ACTIVE, uid: 1 })] }],
  })
  const result = noPending(api)
  assert.equal(result.ok, true)
})

test('noPending fails and names the awaited service', () => {
  const { api } = mount({
    plugins: [
      { name: 'stuck', fibers: [fakeFiber({ state: FiberState.PENDING, uid: 1, inject: { tools: true } })] },
    ],
  })
  const result = noPending(api)
  assert.equal(result.ok, false)
  // The useful information is *which service*, not merely that it is pending.
  assert.match(result.message, /stuck/)
  assert.match(result.message, /tools/)
  assert.deepEqual(result.detail[0].waitingFor, ['tools'])
})

test('noPending filters by plugin name', () => {
  const { api } = mount({
    plugins: [
      { name: 'stuck-a', fibers: [fakeFiber({ state: FiberState.PENDING, uid: 1, inject: { tools: true } })] },
      { name: 'stuck-b', fibers: [fakeFiber({ state: FiberState.PENDING, uid: 2, inject: { db: true } })] },
    ],
  })
  // Asking about a different plugin must not fail on an unrelated one.
  assert.equal(noPending(api, 'stuck-b').ok, false)
  assert.equal(noPending(api, 'nonexistent').ok, true)
  assert.match(noPending(api, 'stuck-b').message, /db/)
})

test('noPending accepts a context instead of the service', () => {
  const { ctx } = mount({
    plugins: [{ name: 'ok', fibers: [fakeFiber({ state: FiberState.ACTIVE, uid: 1 })] }],
  })
  assert.equal(noPending(ctx).ok, true)
})

test('noPending reports a missing debugger rather than throwing', () => {
  const result = noPending({})
  assert.equal(result.ok, false)
  assert.match(result.message, /no debugger service/)
})

// ----------------------------------------------------------- serviceActive --

test('serviceActive passes for a registered, active service', () => {
  const { api } = mount({ services: { tools: {} } })
  const result = serviceActive(api, 'tools')
  assert.equal(result.ok, true)
})

test('serviceActive finds a service by its owning fiber name', () => {
  // On a real Context the declared name is masked, so matching on the provider
  // fiber is the only route that works there. It must work here too.
  const { api } = mount({
    services: { masked: {} },
    serviceProviders: { masked: { name: 'RealService', state: FiberState.ACTIVE } },
  })
  const result = serviceActive(api, 'RealService')
  assert.equal(result.ok, true, result.message)
  assert.match(result.message, /identified via/, 'an inferred identity must be labelled')
})

test('serviceActive reports what is registered with providers when it fails', () => {
  const { api } = mount({
    services: { tools: {} },
    serviceProviders: { tools: { name: 'ToolHost', state: FiberState.ACTIVE } },
  })
  const result = serviceActive(api, 'nope')
  assert.equal(result.ok, false)
  // Naming both the entry and its provider is what makes the failure actionable.
  assert.ok(result.detail.registered.some((entry) => entry.provider === 'ToolHost'
    || entry.name === 'tools' || entry.name === 'ToolHost'))
})

test('serviceActive fails and lists what is registered', () => {
  const { api } = mount({ services: { tools: {} } })
  const result = serviceActive(api, 'nope')
  assert.equal(result.ok, false)
  assert.match(result.message, /not registered/)
  // The list of what *does* exist is what makes this actionable. Entries carry
  // both the reported name and the owning fiber, since either may be the
  // readable one depending on the host.
  assert.ok(result.detail.registered.some((entry) => entry.name === 'tools' || entry.provider === 'tools'))
})

test('serviceActive fails when the provider is not ACTIVE', () => {
  const { api } = mount({
    services: { slow: {} },
    serviceProviders: { slow: { name: 'slow-host', state: FiberState.LOADING } },
  })
  const result = serviceActive(api, 'slow')
  assert.equal(result.ok, false)
  assert.match(result.message, /LOADING/)
})

test('serviceActive finds the debugger itself', () => {
  const { api } = mount()
  assert.equal(serviceActive(api, 'debugger').ok, true)
})

// ---------------------------------------------------------------- traceHas --

test('traceHas passes when every expected kind is present in order', () => {
  const { api } = mount()
  api.record('tool', 'pre-execute', { correlation: 'call-1' })
  api.record('tool', 'execute', { correlation: 'call-1' })
  api.record('tool', 'result', { correlation: 'call-1' })

  assert.equal(traceHas(api, 'call-1', ['pre-execute', 'execute', 'result']).ok, true)
})

test('traceHas fails and names the missing kinds', () => {
  const { api } = mount()
  api.record('tool', 'pre-execute', { correlation: 'call-1' })

  const result = traceHas(api, 'call-1', ['pre-execute', 'result'])
  assert.equal(result.ok, false)
  assert.match(result.message, /result/)
  assert.deepEqual(result.detail.found, ['pre-execute'])
})

test('traceHas fails on an unknown correlation id', () => {
  const { api } = mount()
  const result = traceHas(api, 'never-happened', ['anything'])
  assert.equal(result.ok, false)
  assert.match(result.message, /no records/)
})

test('traceHas accepts an empty expectation for an existing trace', () => {
  const { api } = mount()
  api.record('mark', 'x', { correlation: 'c' })
  assert.equal(traceHas(api, 'c', []).ok, true)
})

// --------------------------------------------------------------- noSecrets --

test('noSecrets passes on a clean timeline', () => {
  const { api } = mount()
  api.mark('boot', { user: 'ada', count: 3 })
  const result = noSecrets(api)
  assert.equal(result.ok, true)
})

test('noSecrets passes when the debugger redacted on the way in', () => {
  const { api } = mount()
  api.mark('auth', { apiKey: 'sk-live-abcdef123456' })
  // The record is already sanitized, so the check must pass — the redaction
  // happened before storage, which is the whole point of constraint 3.
  assert.equal(noSecrets(api).ok, true)
})

test('noSecrets detects a record that bypassed sanitization', () => {
  const { api } = mount()
  // Simulate a value that reached the buffer without redaction by pushing a
  // record whose serialized form still matches a secret pattern.
  const forged = { seq: 99, name: 'leak', data: { note: 'token=abcdef123456' } }
  const result = noSecrets(api, forged)
  assert.equal(result.ok, false)
  assert.match(result.message, /leak secrets/)
})

test('noSecrets detects a secret-keyed field that survived', () => {
  const { api } = mount()
  const forged = { seq: 1, name: 'leak', data: { credentials: { password: 'hunter2' } } }
  const result = noSecrets(api, forged)
  assert.equal(result.ok, false)
})

test('noSecrets can target records by name', () => {
  const { api } = mount()
  api.mark('quiet', { n: 1 })
  assert.equal(noSecrets(api, 'quiet').ok, true)
})

// ------------------------------------------------------------------ assertOk --

test('assertOk throws with the message on failure', () => {
  const { api } = mount({
    plugins: [{ name: 'stuck', fibers: [fakeFiber({ state: FiberState.PENDING, uid: 1, inject: { tools: true } })] }],
  })
  assert.throws(() => assertOk(noPending(api)), /pending/)
})

test('assertOk returns the result on success', () => {
  const { api } = mount()
  const result = assertOk(noPending(api))
  assert.equal(result.ok, true)
})

test('assertOk includes the detail in the thrown message', () => {
  const { api } = mount({
    plugins: [{ name: 'stuck', fibers: [fakeFiber({ state: FiberState.PENDING, uid: 1, inject: { tools: true } })] }],
  })
  assert.throws(() => assertOk(noPending(api)), /tools/)
})

// -------------------------------------------------------------------- misc --

test('every documented helper is exported from ASSERTIONS', () => {
  assert.deepEqual(Object.keys(ASSERTIONS).sort(), ['noPending', 'noSecrets', 'serviceActive', 'traceHas'])
})

test('helpers never throw on a hostile target', () => {
  const hostile = {
    snapshot() {
      throw new Error('exploded')
    },
    query() {
      throw new Error('exploded')
    },
    trace() {
      throw new Error('exploded')
    },
  }
  for (const helper of [noPending, serviceActive, traceHas, noSecrets]) {
    const result = helper(hostile)
    assert.equal(result.ok, false, `${helper.name} should fail, not throw`)
    assert.match(result.message, /threw/)
  }
})
