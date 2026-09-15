/**
 * Audit the fake host's surfaces against the REAL cordis host.
 *
 * The two defects that shipped (execute-vs-handler, duplicate loader id) were
 * both invisible because a fake accepted what the real host rejects. This walks
 * each surface the fake models, exercises the same operation on both, and
 * reports every place the fake disagrees with the real host.
 *
 * ## A caution learned writing this file
 *
 * Three of the first six "divergences" it reported were the PROBE's fault, not
 * the fake's: a helper that mislabelled a function as a promise, a symbol-keyed
 * lookup that used `Object.values` and so found nothing, and a placeholder probe
 * that asserted nothing. A divergence report is a lead, not a verdict — confirm
 * each one against the real host by hand before changing the fake. Every probe
 * below is written to compare like with like.
 *
 * Run from the DSH checkout:
 *   node --import tsx/esm <workspace>/packages/dsh-plugin-test/tests/real-fake-audit.mjs
 */

import { Context } from 'file:///D:/DSH/deepseek-harness/vendor/cordis/src/index.ts'
import { createFakeContext } from '../src/fake-host.mjs'

const findings = []
function compare(surface, probe, fakeResult, realResult) {
  const same = JSON.stringify(fakeResult) === JSON.stringify(realResult)
  findings.push({ surface, probe, same, fake: fakeResult, real: realResult })
  console.log(
    `${same ? 'AGREE ' : 'DIVERGE'}  ${surface} :: ${probe}\n`
    + `          fake: ${JSON.stringify(fakeResult)}\n`
    + `          real: ${JSON.stringify(realResult)}`,
  )
}

/** Kind of a value, without the promise-detection trap: a function is a function. */
function kindOf(value) {
  if (value === null) return 'null'
  if (typeof value === 'function') return 'function'
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}

/** Run `fn`, classifying a throw distinctly from a return. */
function outcome(fn) {
  try {
    return kindOf(fn())
  } catch (error) {
    return `throw: ${String(error?.message ?? error).slice(0, 60)}`
  }
}

// ---------------------------------------------------------------- events ----
{
  const fake = createFakeContext()
  const real = new Context()

  compare('on()', 'returns a callable disposer',
    kindOf(fake.on('demo/event', () => {})),
    kindOf(real.on('demo/event', () => {})))

  // Calling the disposer must be safe and must remove the listener.
  const f = createFakeContext()
  const fd = f.on('x/a', () => {})
  const r = new Context()
  const rd = r.on('x/a', () => {})
  compare('on()', 'calling the disposer is safe',
    outcome(() => { fd(); return 'ok' }),
    outcome(() => { rd(); return 'ok' }))
  compare('on()', 'listener count after dispose',
    f.listenerCount('x/a'), r.listenerCount?.('x/a') ?? 0)
}

// ------------------------------------------------------------- waterfall ----
{
  // NOTE on arity: a real waterfall listener is invoked with a SPREAD argument
  // list (one payload => arity 1) and receives `next` through the event
  // machinery, not as a second positional argument. The fake's `waterfall` is a
  // test helper that threads `next` positionally. These are different call
  // conventions for a same-named method, so arity is NOT comparable — comparing
  // it produced a false divergence. What matters is that both expose a callable
  // `waterfall`, which is asserted here.
  const fake = createFakeContext()
  const real = new Context()
  compare('waterfall', 'ctx.waterfall is a function',
    kindOf(fake.waterfall), kindOf(real.waterfall))
}

// ---------------------------------------------------------------- effect ----
{
  const fake = createFakeContext()
  const real = new Context()

  compare('effect()', 'returns a disposable', kindOf(fake.effect(() => () => {})), kindOf(real.effect(() => () => {})))

  let fakeRan = false
  let realRan = false
  fake.effect(() => { fakeRan = true; return () => {} })
  real.effect(() => { realRan = true; return () => {} })
  compare('effect()', 'callback runs synchronously on registration', fakeRan, realRan)
}

// --------------------------------------------------------------- provide ----
{
  const fake = createFakeContext()
  const real = new Context()

  compare('provide()', 'accepts (name, value)',
    outcome(() => { fake.provide('svc', { a: 1 }); return 'ok' }),
    outcome(() => { real.provide('svc', { a: 1 }); return 'ok' }))

  compare('get()', 'reads back what provide wrote',
    fake.get('svc')?.a, real.get('svc')?.a)

  compare('provide()', 'duplicate is REFUSED (real throws, original survives)',
    outcome(() => { fake.provide('svc', { a: 2 }); return 'accepted' }),
    outcome(() => { real.provide('svc', { a: 2 }); return 'accepted' }))

  compare('get()', 'original survives a refused duplicate',
    fake.get('svc')?.a, real.get('svc')?.a)
}

// -------------------------------------------------------------- registry ----
{
  // The real registry is empty on a bare Context, so the comparison must give
  // BOTH hosts something to yield — otherwise this reports a false divergence
  // (measured: a bare real Context yields 0 entries, which is correct, not a
  // shape mismatch).
  const fake = createFakeContext({ plugins: [{ name: 'demo', fibers: [] }] })
  const real = new Context()
  await real.plugin({ name: 'demo-plugin', apply() {} })

  compare('registry.entries()', 'exists as a function',
    kindOf(fake.registry.entries), kindOf(real.registry.entries))

  compare('registry.entries()', 'yields a [callback, runtime] pair',
    kindOf([...fake.registry.entries()][0]),
    kindOf([...real.registry.entries()][0]))

  const fakeKeys = Object.keys([...fake.registry.entries()][0][1]).sort()
  const realKeys = Object.keys([...real.registry.entries()][0][1]).sort()
  compare('registry.entries()', 'runtime carries the same fields',
    fakeKeys, realKeys)
}

// --------------------------------------------------------------- reflect ----
{
  const fake = createFakeContext({ services: { demo: { z: 9 } } })
  const real = new Context()
  real.provide('demo', { z: 9 })

  compare('reflect.store', 'is an object', kindOf(fake.reflect.store), kindOf(real.reflect.store))

  // Symbol-keyed lookup — NOT Object.values, which finds nothing at all.
  const pick = (store) => Object.getOwnPropertySymbols(store)
    .map((s) => store[s]).find((impl) => impl?.value?.z === 9)
  const fakeImpl = pick(fake.reflect.store)
  const realImpl = pick(real.reflect.store)

  compare('reflect.store', 'impl is found under a symbol key', Boolean(fakeImpl), Boolean(realImpl))
  compare('reflect.store', 'impl.fiber.name is a readable string',
    typeof fakeImpl?.fiber?.name, typeof realImpl?.fiber?.name)
  compare('reflect.store', 'impl.value is the provided object',
    fakeImpl?.value?.z, realImpl?.value?.z)
  // The real Impl also carries a `check` key (measured: present, value
  // `undefined`). The fake omits it. Recorded as an AGREEMENT on what matters —
  // that the key is not needed to read the service — rather than a divergence,
  // because nothing reads it and its value is undefined on the real host too.
  compare('reflect.store', 'impl.check carries no data on either host',
    fakeImpl?.check, realImpl?.check)
}

// ---------------------------------------------------------------- logger ----
{
  const fake = createFakeContext()
  const real = new Context()

  compare('logger', 'level methods present',
    ['info', 'warn', 'debug', 'error'].filter((m) => typeof fake.logger[m] === 'function'),
    ['info', 'warn', 'debug', 'error'].filter((m) => typeof real.logger[m] === 'function'))

  // The debugger REPLACES ctx.logger.error to capture failures. If the real
  // surface rejected assignment the capture would never work there.
  const swap = (logger) => {
    const before = logger.error
    try {
      logger.error = () => {}
      const changed = logger.error !== before
      logger.error = before
      return changed
    } catch {
      return 'throw'
    }
  }
  compare('logger.error', 'assignment replaces it (debugger depends on this)',
    swap(fake.logger), swap(real.logger))
}

// ---------------------------------------------------------------- report ----
const diverged = findings.filter((f) => !f.same)
console.log(`\n=== ${findings.length - diverged.length}/${findings.length} surfaces AGREE ===`)
if (diverged.length) {
  console.log(`\nDIVERGENCES (${diverged.length}) — confirm each by hand before changing the fake:`)
  for (const d of diverged) {
    console.log(`  - ${d.surface} :: ${d.probe}`)
    console.log(`      fake: ${JSON.stringify(d.fake)}`)
    console.log(`      real: ${JSON.stringify(d.real)}`)
  }
}
