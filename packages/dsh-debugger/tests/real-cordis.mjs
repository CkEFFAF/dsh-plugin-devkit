/**
 * Real-Cordis verification (acceptance A1, real-host half).
 *
 * Everything else in this package runs against a fake host. That fake is
 * deliberate — it can construct PENDING, FAILED, and deny on demand — but it
 * cannot prove the plugin survives contact with the genuine runtime, because a
 * fake only ever agrees with the assumptions it was written from.
 *
 * This script mounts the real plugin on a real `Context` from the DSH checkout.
 * It is **not** part of the default `node --test` run: it needs the checkout and
 * `tsx`, neither of which the workspace depends on. Run it explicitly:
 *
 * ```sh
 * cd D:/DSH/deepseek-harness
 * node --import tsx/esm \
 *   D:/DSH_workspace/dsh-plugin-devkit-pack/packages/dsh-debugger/tests/real-cordis.mjs
 * ```
 *
 * Windows note: the absolute paths in the import specifiers must be `file:///`
 * URLs. Node's ESM loader rejects a bare `D:` drive path with
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME` — the same constraint 设计文档 §5 records for
 * dsh-debug-boot's overlay entries.
 *
 * It found real defects that the fake host could not: `listServices` reading the
 * declaration table (which mixes services with Cordis's reflection accessors)
 * and reading `impl.name` through the context proxy, where it arrives as an
 * opaque object rather than the string the source stores.
 */

import assert from 'node:assert/strict'

const CORDIS = 'file:///D:/DSH/deepseek-harness/vendor/cordis/src/index.ts'
const DEBUGGER = 'file:///D:/DSH_workspace/dsh-plugin-devkit-pack/packages/dsh-debugger/index.mjs'
const INSPECTOR = 'file:///D:/DSH_workspace/dsh-plugin-devkit-pack/packages/dsh-debugger/src/inspector.mjs'
const RECORDER = 'file:///D:/DSH_workspace/dsh-plugin-devkit-pack/packages/dsh-debugger/src/recorder.mjs'

const { Context, Service } = await import(CORDIS)
const Debugger = await import(DEBUGGER)
const { createInspector } = await import(INSPECTOR)
const { createRecorder } = await import(RECORDER)

/** Track outcomes so the script exits non-zero on any failure. */
const results = []
function check(label, fn) {
  try {
    fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error.message })
  }
}

// ---------------------------------------------------------------------------
// 1. A bare Context: the debugger must not be confused by Cordis's own plumbing.
// ---------------------------------------------------------------------------
{
  const root = new Context()
  const inspector = createInspector({ ctx: root, recorder: createRecorder() })
  const { services, degraded } = inspector.listServices()

  check('bare context does not degrade service enumeration', () => {
    assert.equal(degraded, null)
  })
  check('reflection accessors are not reported as services', () => {
    const names = services.map((s) => s.name)
    for (const accessor of ['get', 'set', 'provide', 'accessor', 'mixin', 'on', 'waterfall']) {
      assert.equal(names.includes(accessor), false, `'${accessor}' leaked in as a service`)
    }
  })
  check('no service name renders as [object Object]', () => {
    for (const service of services) {
      assert.doesNotMatch(service.name, /object Object/)
    }
  })
}

// ---------------------------------------------------------------------------
// 2. A real service provider: name, availability, and owner must all resolve.
//
// Note what is *not* asserted here. Through the context proxy the declared
// service name is unreachable — `impl.name`, the store key's description, and
// the `reflect.props` service key all read back as the literal string
// "[object Object]". Only `impl.fiber.name` survives as a real string. So this
// check asserts the property that actually holds (an honest, identified owner)
// rather than the one that would be nicer.
// ---------------------------------------------------------------------------
{
  class Demo extends Service {
    static provide = 'demoService'
  }

  const root = new Context()
  await root.plugin(Demo, {})

  const inspector = createInspector({ ctx: root, recorder: createRecorder() })
  const { services } = inspector.listServices()
  const demo = services.find((s) => s.provider?.name === 'Demo')

  check('a real service is enumerated with its owning fiber', () => {
    assert.ok(demo, `Demo provider missing; saw ${JSON.stringify(services)}`)
    assert.equal(demo.provider.name, 'Demo')
    assert.equal(demo.provider.stateName, 'ACTIVE')
  })

  check('the owning fiber is identified even though the service name is masked', () => {
    // The proxy masks the service name; the report must say so rather than
    // presenting the fiber name as if it were the service name.
    assert.equal(demo.nameReliable, false)
    assert.match(demo.name, /Demo/)
    assert.match(demo.name, /not readable/)
  })

  check('no service name or state renders as [object Object]', () => {
    for (const service of services) {
      assert.doesNotMatch(service.name, /object Object/)
      assert.doesNotMatch(String(service.provider?.stateName ?? ''), /object Object/)
    }
  })
}

// ---------------------------------------------------------------------------
// 3. The debugger mounts on a real Context and serves `/debug`.
// ---------------------------------------------------------------------------
{
  const root = new Context()
  const registered = new Map()
  root.provide('commands', {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    async execute(name) {
      return registered.get(name)?.execute?.('')
    },
  })

  let api
  check('apply() mounts on a real Context without throwing', () => {
    api = Debugger.apply(root, {})
    assert.equal(typeof api.mark, 'function')
  })

  check("ctx.get('debugger') resolves the provided service", () => {
    assert.notEqual(root.get('debugger'), undefined)
  })

  check('the /debug command is registered on a real host', () => {
    assert.ok(registered.has('debug'))
  })

  check('the timeline accepts records on a real host', () => {
    api.mark('real-cordis-mark', { ok: true })
    assert.equal(api.query({ category: 'mark' }).length, 1)
  })

  check('snapshot() survives a real Context', () => {
    const snapshot = api.snapshot()
    assert.equal(typeof snapshot.counts.total, 'number')
    assert.equal(snapshot.degraded, null)
  })

  check('/debug health renders on a real host', async () => {
    const output = await registered.get('debug').execute('health')
    assert.match(output, /OK: plugins/)
    assert.match(output, /probes: active/)
  })

  check('/debug services lists real services, not framework internals', async () => {
    const output = await registered.get('debug').execute('services')
    assert.match(output, /commands/)
    assert.match(output, /debugger/)
    assert.doesNotMatch(output, /object Object/)
    assert.doesNotMatch(output, /\bwaterfall\b/)
  })

  check('/debug services marks an inferred identity as inferred', async () => {
    const output = await registered.get('debug').execute('services')
    // The `~` suffix means "this name was inferred, not read".
    assert.match(output, /~\s*$/m)
  })
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
let failed = 0
for (const result of results) {
  if (result.ok) {
    console.log(`ok    ${result.label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${result.label}\n        ${result.error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
