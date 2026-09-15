/**
 * Inspector (diagnostic layer) tests.
 *
 * Covers acceptance A7 (a PENDING plugin names the service it waits for),
 * A2 (a composition without tools still reports honestly), and the degradation
 * rule: `/debug plugins` must never itself fail because the loader is broken.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createInspector } from '../src/inspector.mjs'
import { createRecorder } from '../src/recorder.mjs'
import { createFakeContext, fakeFiber, FiberState } from './fake-context.mjs'

/**
 * Build a runtime descriptor for the fake registry.
 *
 * @param {string} name
 * @param {object[]} fibers
 */
function runtime(name, fibers) {
  return { name, fibers }
}

test('an ACTIVE plugin produces no findings', () => {
  const ctx = createFakeContext({
    plugins: [runtime('healthy', [fakeFiber({ state: FiberState.ACTIVE, uid: 1 })])],
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })

  const { findings, total } = inspector.diagnose()
  assert.equal(total, 1)
  assert.deepEqual(findings, [])
})

test('a PENDING plugin names the service it is waiting for (A7)', () => {
  const ctx = createFakeContext({
    plugins: [
      runtime('tool-dependent', [
        fakeFiber({ state: FiberState.PENDING, uid: 7, inject: { tools: true } }),
      ]),
    ],
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })

  const { findings } = inspector.diagnose()
  assert.equal(findings.length, 1)
  assert.equal(findings[0].name, 'tool-dependent')
  // Wording aligned with DSH's own boot message (app-boot/index.ts:743).
  assert.equal(findings[0].reason, 'pending (waiting for tools)')
  assert.equal(findings[0].stateName, 'PENDING')
})

test('a PENDING plugin waiting on several services lists all of them', () => {
  const ctx = createFakeContext({
    plugins: [
      runtime('needy', [fakeFiber({ state: FiberState.PENDING, uid: 3, inject: { tools: true, commands: true } })]),
    ],
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  const [finding] = inspector.diagnose().findings
  assert.equal(finding.reason, 'pending (waiting for tools, commands)')
})

test('a PENDING plugin with no declared inject still explains itself', () => {
  const ctx = createFakeContext({
    plugins: [runtime('mystery', [fakeFiber({ state: FiberState.PENDING, uid: 4 })])],
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  assert.equal(inspector.diagnose().findings[0].reason, 'pending (waiting for services)')
})

test('a FAILED plugin reports the captured apply error', () => {
  const ctx = createFakeContext({
    plugins: [runtime('exploding', [fakeFiber({ state: FiberState.FAILED, uid: 9 })])],
  })
  const recorder = createRecorder()
  const errorLog = { top: (name) => (name === 'exploding' ? 'Error: apply blew up' : undefined) }

  const inspector = createInspector({ ctx, recorder, errorLog })
  const [finding] = inspector.diagnose().findings
  assert.equal(finding.stateName, 'FAILED')
  assert.equal(finding.reason, 'failed: Error: apply blew up')
})

test('a FAILED plugin falls back to the early-error buffer', () => {
  const ctx = createFakeContext({
    plugins: [runtime('exploding', [fakeFiber({ state: FiberState.FAILED, uid: 9 })])],
  })
  const recorder = createRecorder()
  recorder.noteEarlyError(new Error('recorded at startup'))

  const inspector = createInspector({ ctx, recorder })
  assert.match(inspector.diagnose().findings[0].reason, /recorded at startup/)
})

test('a FAILED plugin with no message is honest about the gap', () => {
  const ctx = createFakeContext({
    plugins: [runtime('silent', [fakeFiber({ state: FiberState.FAILED, uid: 2 })])],
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  assert.match(inspector.diagnose().findings[0].reason, /no message captured/)
})

test('DISPOSED and LOADING states are explained distinctly', () => {
  const ctx = createFakeContext({
    plugins: [
      runtime('gone', [fakeFiber({ state: FiberState.DISPOSED, uid: 1 })]),
      runtime('starting', [fakeFiber({ state: FiberState.LOADING, uid: 2 })]),
      runtime('stopping', [fakeFiber({ state: FiberState.UNLOADING, uid: 3 })]),
    ],
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  const reasons = Object.fromEntries(inspector.diagnose().findings.map((f) => [f.name, f.reason]))
  assert.match(reasons.gone, /disposed/)
  assert.match(reasons.starting, /loading/)
  assert.match(reasons.stopping, /unloading/)
})

test('a broken registry degrades instead of failing (A7 degradation)', () => {
  const ctx = createFakeContext({ failEntries: true })
  const inspector = createInspector({ ctx, recorder: createRecorder() })

  let result
  assert.doesNotThrow(() => {
    result = inspector.diagnose()
  })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].id, 'inspector:degraded')
  assert.match(result.findings[0].reason, /enumerating plugins failed/)
})

test('a missing registry and loader degrades with a clear reason', () => {
  const ctx = { reflect: { props: {} } }
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  const { findings } = inspector.diagnose()
  assert.equal(findings.length, 1)
  assert.match(findings[0].reason, /no loader or registry/)
})

test('a loader-style source is accepted as well as the registry', () => {
  const ctx = {
    loader: {
      entries: () => [runtime('from-loader', [fakeFiber({ state: FiberState.ACTIVE, uid: 1 })])],
    },
    reflect: { props: {} },
  }
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  assert.equal(inspector.diagnose().total, 1)
  assert.deepEqual(inspector.diagnose().findings, [])
})

test('findings are sorted by name for stable output', () => {
  const ctx = createFakeContext({
    plugins: [
      runtime('zebra', [fakeFiber({ state: FiberState.PENDING, uid: 1 })]),
      runtime('alpha', [fakeFiber({ state: FiberState.PENDING, uid: 2 })]),
    ],
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  assert.deepEqual(inspector.diagnose().findings.map((f) => f.name), ['alpha', 'zebra'])
})

test('snapshot counts plugins by state', () => {
  const ctx = createFakeContext({
    plugins: [
      runtime('a', [fakeFiber({ state: FiberState.ACTIVE, uid: 1 })]),
      runtime('b', [fakeFiber({ state: FiberState.ACTIVE, uid: 2 })]),
      runtime('c', [fakeFiber({ state: FiberState.PENDING, uid: 3 })]),
      runtime('d', [fakeFiber({ state: FiberState.FAILED, uid: 4 })]),
    ],
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  const snapshot = inspector.snapshot()
  assert.equal(snapshot.counts.total, 4)
  assert.equal(snapshot.counts.active, 2)
  assert.equal(snapshot.counts.pending, 1)
  assert.equal(snapshot.counts.failed, 1)
})

test('one plugin may own several fibers, each reported separately', () => {
  const ctx = createFakeContext({
    plugins: [
      runtime('multi', [
        fakeFiber({ state: FiberState.ACTIVE, uid: 1 }),
        fakeFiber({ state: FiberState.PENDING, uid: 2, inject: { tools: true } }),
      ]),
    ],
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  const { total, findings } = inspector.diagnose()
  assert.equal(total, 2)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].name, 'multi')
})

test('services are listed from the live store with provider state', () => {
  const ctx = createFakeContext({
    services: { tools: {}, commands: {} },
    serviceProviders: { tools: { name: 'tool-host', state: FiberState.ACTIVE } },
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })

  const { services } = inspector.listServices()
  const byName = Object.fromEntries(services.map((s) => [s.name, s]))
  assert.equal(byName.tools.available, true)
  assert.equal(byName.commands.available, true)
  // Ownership comes from the registration record, not from the service object.
  assert.equal(byName.tools.provider.name, 'tool-host')
  assert.equal(byName.tools.provider.stateName, 'ACTIVE')
})

test('a readable service name is marked reliable', () => {
  const ctx = createFakeContext({ services: { tools: {} } })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  const [service] = inspector.listServices().services
  assert.equal(service.name, 'tools')
  assert.equal(service.nameReliable, true)
})

test('reflection accessors are never reported as services', () => {
  // Regression guard: `ctx.reflect.props` mixes services with the proxy
  // accessors (`get`, `on`, `waterfall`, ...). Reading that table instead of
  // `reflect.store` reports Cordis's own plumbing as the composition's services.
  const ctx = createFakeContext({ services: { tools: {} } })
  const inspector = createInspector({ ctx, recorder: createRecorder() })

  const names = inspector.listServices().services.map((s) => s.name)
  for (const accessor of ['get', 'set', 'provide', 'accessor', 'on', 'waterfall']) {
    assert.equal(names.includes(accessor), false, `'${accessor}' is an accessor, not a service`)
  }
  assert.deepEqual(names, ['tools'])
})

test('a service whose provider fiber is not active is still reported', () => {
  const ctx = createFakeContext({
    services: { loading: {} },
    serviceProviders: { loading: { name: 'slow-host', state: FiberState.LOADING } },
  })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  const [service] = inspector.listServices().services
  assert.equal(service.provider.stateName, 'LOADING')
})

test('services are listed alphabetically', () => {
  const ctx = createFakeContext({ services: { zeta: {}, alpha: {}, mid: {} } })
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  assert.deepEqual(inspector.listServices().services.map((s) => s.name), ['alpha', 'mid', 'zeta'])
})

test('a proxied store whose impl.name is opaque still yields a usable identity', () => {
  // Measured against a real cordis context: the store read through the context
  // proxy hands back wrapped values, so `impl.name` arrives as an opaque object
  // (String() -> "[object Object]", empty own keys) while `impl.fiber.name`
  // survives as a string. Reading `impl.name` naively reports every service as
  // "[object Object]".
  const opaque = Object.create(null)
  const store = {
    [Symbol('svc')]: {
      name: opaque,
      value: {},
      fiber: { name: 'demo-provider', state: FiberState.ACTIVE },
    },
  }
  const ctx = { registry: { entries: () => [][Symbol.iterator]() }, reflect: { store } }
  const inspector = createInspector({ ctx, recorder: createRecorder() })

  const [service] = inspector.listServices().services
  assert.match(service.name, /demo-provider/)
  assert.doesNotMatch(service.name, /object Object/)
  // The identity was inferred, and the record says so rather than implying the
  // name was read.
  assert.equal(service.nameReliable, false)
  assert.match(service.name, /not readable/)
})

test('a string impl.name is preferred when readable', () => {
  const store = {
    [Symbol('svc')]: {
      name: 'tools',
      value: {},
      fiber: { name: 'tool-host', state: FiberState.ACTIVE },
    },
  }
  const ctx = { registry: { entries: () => [][Symbol.iterator]() }, reflect: { store } }
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  assert.equal(inspector.listServices().services[0].name, 'tools')
})

test('the symbol description is used before admitting a name is unknown', () => {
  // Cordis creates the store key as `Symbol(name)` (reflect.ts:286), so an
  // unwrapped store carries the name in the key's description.
  const store = {
    [Symbol('filesystem')]: {
      name: Object.create(null),
      value: {},
      fiber: { name: 'anonymous', state: FiberState.ACTIVE },
    },
  }
  const ctx = { registry: { entries: () => [][Symbol.iterator]() }, reflect: { store } }
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  assert.equal(inspector.listServices().services[0].name, 'filesystem')
})

test('a service with no recoverable name admits it rather than guessing', () => {
  // A key with no description and an opaque name: nothing trustworthy remains,
  // so the report says so instead of inventing an identifier.
  const store = {
    [Symbol()]: {
      name: Object.create(null),
      value: {},
      fiber: { name: 'anonymous', state: FiberState.ACTIVE },
    },
  }
  const ctx = { registry: { entries: () => [][Symbol.iterator]() }, reflect: { store } }
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  assert.equal(inspector.listServices().services[0].name, '(unnamed service)')
})

test('a missing reflect store degrades instead of failing', () => {
  const ctx = { registry: { entries: () => [][Symbol.iterator]() } }
  const inspector = createInspector({ ctx, recorder: createRecorder() })
  const { services, degraded } = inspector.listServices()
  assert.deepEqual(services, [])
  assert.match(degraded, /no reflect store/)
})

test('snapshot samples live state on every call (no caching)', () => {
  const fibers = [fakeFiber({ state: FiberState.PENDING, uid: 1, inject: { tools: true } })]
  const ctx = createFakeContext({ plugins: [runtime('late', fibers)] })
  const inspector = createInspector({ ctx, recorder: createRecorder() })

  assert.equal(inspector.snapshot().counts.pending, 1)

  // The service appears: a cached snapshot would still report PENDING.
  fibers[0].state = FiberState.ACTIVE
  assert.equal(inspector.snapshot().counts.pending, 0)
  assert.equal(inspector.snapshot().counts.active, 1)
})

test('snapshot output is sanitized', () => {
  const ctx = createFakeContext({
    plugins: [runtime('leaky', [fakeFiber({ state: FiberState.FAILED, uid: 1 })])],
  })
  const recorder = createRecorder()
  const errorLog = { top: () => 'Error: failed with token=abcdef123456' }
  const inspector = createInspector({ ctx, recorder, errorLog })

  const snapshot = inspector.snapshot()
  assert.doesNotMatch(JSON.stringify(snapshot), /abcdef123456/)
})

test('a fiber with a throwing state getter does not break enumeration', () => {
  const hostile = {
    uid: 5,
    inject: {},
    get state() {
      throw new Error('state unavailable')
    },
  }
  const ctx = createFakeContext({ plugins: [runtime('hostile', [hostile])] })
  const inspector = createInspector({ ctx, recorder: createRecorder() })

  let result
  assert.doesNotThrow(() => {
    result = inspector.diagnose()
  })
  // An unreadable state degrades to PENDING (the cautious default: "not
  // confirmed active" must never be reported as healthy). What matters is that
  // enumeration survives and still surfaces a finding.
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].name, 'hostile')
  assert.equal(result.findings[0].stateName, 'PENDING')
})

test('a fiber with a throwing uid getter still enumerates', () => {
  const hostile = {
    state: FiberState.ACTIVE,
    get uid() {
      throw new Error('uid unavailable')
    },
  }
  const ctx = createFakeContext({ plugins: [runtime('hostile', [hostile])] })
  const inspector = createInspector({ ctx, recorder: createRecorder() })

  let snapshot
  assert.doesNotThrow(() => {
    snapshot = inspector.snapshot()
  })
  assert.equal(snapshot.plugins[0].uid, null)
  assert.equal(snapshot.counts.active, 1)
})

test('an unnamed plugin gets a stable placeholder name', () => {
  const rt = { fibers: [fakeFiber({ state: FiberState.PENDING, uid: 1 })], callback: function named() {} }
  rt.callback = function () {}
  const ctx = createFakeContext({ plugins: [] })
  ctx.registry.entries = () => [[rt.callback, rt]][Symbol.iterator]()

  const inspector = createInspector({ ctx, recorder: createRecorder() })
  const [finding] = inspector.diagnose().findings
  assert.equal(finding.name, '(anonymous plugin)')
})
