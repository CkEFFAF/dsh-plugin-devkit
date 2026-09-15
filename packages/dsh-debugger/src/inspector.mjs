/**
 * Diagnostic layer: turn live loader/fiber state into actionable findings.
 *
 * ## Adapting to the real Cordis surface
 *
 * Design document 4.5 specifies the inspector's input as `loader.entries()`.
 * The shipped Cordis exposes the equivalent through `ctx.registry`, whose
 * `entries()` returns `[callback, Plugin.Runtime]` pairs where a runtime is
 * `{ name?, fibers: DisposableList<Fiber>, callback, Config? }`. This module
 * accepts that shape directly, and still tolerates a `ctx.loader`-style object
 * if a future host provides one, so the seam does not hard-code one spelling.
 *
 * ## Why the logger is read
 *
 * A `FAILED` fiber's root cause is an exception thrown by `apply`. Cordis routes
 * that to `context.logger.error(error)` (fiber.ts:126) rather than storing it on
 * the fiber, so the message has to be captured from the logger. That capture is
 * installed by `probes.mjs`; this module consumes it and falls back to the
 * recorder's early-error buffer when no capture is available.
 *
 * ## Degradation
 *
 * If the registry is unavailable or throws, findings degrade to a single
 * explanatory entry. `/debug plugins` must never itself fail — the command that
 * explains a broken composition cannot be the thing that breaks.
 */

import { FiberState, fiberStateName, isActive } from './fiber-state.mjs'
import { describeThrown, sanitize, safeName } from './sanitize.mjs'

/**
 * Build the inspector.
 *
 * @param {{
 *   ctx: object,
 *   recorder: ReturnType<import('./recorder.mjs').createRecorder>,
 *   errorLog?: {get: (key: string) => string[]|undefined, top: (key: string) => string|undefined},
 * }} deps
 */
export function createInspector(deps) {
  const { ctx, recorder } = deps
  const errorLog = deps.errorLog

  /**
   * Locate the entry-listing surface.
   *
   * Preference order: the registry (real cordis), then a loader if one exists.
   *
   * @returns {{entries: () => Iterable<any>, origin: string} | null}
   */
  function resolveSource() {
    try {
      const registry = ctx?.registry
      if (registry && typeof registry.entries === 'function') {
        return { entries: () => registry.entries(), origin: 'registry' }
      }
    } catch {
      // fall through to loader
    }
    try {
      const loader = ctx?.loader
      if (loader && typeof loader.entries === 'function') {
        return { entries: () => loader.entries(), origin: 'loader' }
      }
    } catch {
      // no source
    }
    return null
  }

  /**
   * Enumerate every fiber with its owning plugin name.
   *
   * Reads only leaf fields (`state`, `uid`, `inject`) from each fiber. The fiber
   * object itself is live internal data and is never stored or serialized.
   *
   * @returns {{entries: object[], degraded: string|null}}
   */
  function listFibers() {
    const source = resolveSource()
    if (!source) {
      return {
        entries: [],
        degraded: 'no loader or registry available: cannot enumerate plugins',
      }
    }

    const out = []
    try {
      for (const entry of source.entries()) {
        // `registry.entries()` yields [callback, runtime]; a loader-style
        // source may yield the runtime alone.
        const runtime = Array.isArray(entry) ? entry[1] : entry
        if (!runtime) continue

        const name = readName(runtime)
        const fibers = collectFibers(runtime)

        for (const fiber of fibers) {
          const state = readNumber(() => fiber?.state, FiberState.PENDING)
          out.push({
            name,
            state,
            stateName: fiberStateName(state),
            uid: readNumber(() => fiber?.uid, null),
            // Declared injections are what a PENDING fiber is waiting on.
            inject: readInject(fiber),
          })
        }
      }
    } catch (error) {
      return {
        entries: out,
        degraded: `enumerating plugins failed: ${describeThrown(error)}`,
      }
    }
    return { entries: out, degraded: null }
  }

  /**
   * Read a runtime's display name defensively.
   *
   * @param {object} runtime
   * @returns {string}
   */
  function readName(runtime) {
    try {
      if (typeof runtime.name === 'string' && runtime.name) return runtime.name
      const cb = runtime.callback
      if (typeof cb?.name === 'string' && cb.name) return cb.name
    } catch {
      // ignore
    }
    return '(anonymous plugin)'
  }

  /**
   * Extract the fiber list from a runtime's `fibers` collection.
   *
   * `DisposableList` is iterable; a plain array also works.
   *
   * @param {object} runtime
   * @returns {object[]}
   */
  function collectFibers(runtime) {
    const list = []
    try {
      const fibers = runtime.fibers
      if (!fibers) return list
      for (const fiber of fibers) list.push(fiber)
    } catch {
      // A partially disposed runtime simply contributes no fibers.
    }
    return list
  }

  /**
   * Read a fiber's resolved inject map into a plain name list.
   *
   * @param {object} fiber
   * @returns {string[]}
   */
  function readInject(fiber) {
    try {
      const inject = fiber?.inject
      if (!inject) return []
      if (Array.isArray(inject)) return inject.map(String)
      return Object.keys(inject)
    } catch {
      return []
    }
  }

  /**
   * Enumerate services currently registered, with provider fiber state.
   *
   * ## Why `reflect.store` and not `reflect.props`
   *
   * `ctx.reflect.props` is the *declaration* table and mixes two kinds of entry:
   * real services (`{type: 'service'}`) and the reflection-layer accessors
   * (`{type: 'accessor'}`) that put `get`, `on`, `waterfall`, `provide`, … on the
   * context proxy. Reading it without checking `type` reports Cordis's own
   * plumbing as if it were the composition's services — a wrong answer from a
   * tool whose whole job is telling the truth.
   *
   * `ctx.reflect.store` is the *live registration* table: symbol-keyed `Impl`
   * records of `{name, fiber, value?, check?}`, so it carries the provider fiber
   * and its state. This mirrors how DSH's own inspector reads it
   * (`packages/extensions/tool-cordis/src/inspect.ts`).
   *
   * @returns {{services: object[], degraded: string|null}}
   */
  function listServices() {
    const services = []
    let store
    try {
      store = ctx?.reflect?.store
    } catch {
      return { services, degraded: 'no reflect store: cannot enumerate services' }
    }
    if (!store) return { services, degraded: 'no reflect store: cannot enumerate services' }

    try {
      // Symbol keys: the store is isolation-scoped, so names are not own
      // string keys.
      const keys = Object.getOwnPropertySymbols(store)
      for (const key of keys) {
        let impl
        try {
          impl = store[key]
        } catch {
          continue
        }
        if (!impl) continue

        const provider = readFiberState(impl.fiber)
        services.push({
          name: readServiceName(impl, key),
          // True only when the store surfaced a real string name. Once the name
          // is derived from elsewhere, the identity is inferred, not read, and
          // the report says so instead of implying certainty it does not have.
          nameReliable: typeof safeRawName(impl) === 'string',
          available: impl.value !== undefined,
          // `impl.fiber` is the fiber that owns the service's lifetime, which is
          // the ownership the "who provides this" question is really asking.
          provider,
        })
      }
      services.sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
      return { services, degraded: `enumerating services failed: ${describeThrown(error)}` }
    }
    return { services, degraded: null }
  }

  /**
   * Read `impl.name` only when it is genuinely a usable string.
   *
   * @param {object} impl
   * @returns {string|null}
   */
  function safeRawName(impl) {
    try {
      const value = impl?.name
      return typeof value === 'string' && value ? value : null
    } catch {
      return null
    }
  }

  /**
   * Recover a service's name from the registration record.
   *
   * ## What is and is not recoverable (measured, not assumed)
   *
   * Cordis stores `Impl.name` as a plain string (reflect.ts:288), but reading the
   * store through the context proxy does not give that string back. Measured
   * against a real `Context`:
   *
   * - `impl.name` arrives as an opaque object (`String()` → `[object Object]`,
   *   empty own keys, no `[symbols.original]`, no `[symbols.shadow]`).
   * - The store key is `Symbol(name)`, but through the proxy its `description`
   *   *also* reads back as the literal string `[object Object]`.
   * - `reflect.props` own keys are readable strings for the reflection
   *   **accessors** (`get`, `on`, `waterfall`, …) but the service key is the
   *   literal string `[object Object]`.
   * - `impl.fiber.name` **does** survive as a real string.
   *
   * So the declared service name is not reachable through the proxy; only the
   * owning fiber's name is. Reporting the fiber name as though it were the
   * service name would be a silent lie, so callers are given `nameReliable` and
   * the renderer labels an inferred identity as inferred.
   *
   * The string branches are kept first because a host that hands back an
   * unwrapped store (or a future Cordis that stops masking) should get the exact
   * name rather than the inference.
   *
   * @param {object} impl
   * @param {symbol} key
   * @returns {string}
   */
  function readServiceName(impl, key) {
    const direct = safeRawName(impl)
    if (direct) return direct

    // The provider fiber's name is a real string even through the proxy.
    const fiberName = readFiberState(impl.fiber)?.name
    if (fiberName && fiberName !== 'anonymous') {
      return `${fiberName} (service name not readable)`
    }

    try {
      if (typeof key?.description === 'string' && key.description) return key.description
    } catch {
      // fall through
    }
    return '(unnamed service)'
  }

  /**
   * Read a fiber's name and state defensively.
   *
   * @param {unknown} fiber
   * @returns {{name: string, state: number, stateName: string}|null}
   */
  function readFiberState(fiber) {
    if (!fiber) return null
    try {
      const state = readNumber(() => fiber.state, FiberState.PENDING)
      return {
        name: safeName(fiber),
        state,
        stateName: fiberStateName(state),
      }
    } catch {
      return null
    }
  }

  /**
   * Produce findings for every plugin that is not healthy.
   *
   * Each finding carries `{id, name, state, stateName, reason}` so the command
   * layer can render a one-line root cause without re-deriving it.
   *
   * @returns {{findings: object[], degraded: string|null, total: number}}
   */
  function diagnose() {
    const { entries, degraded } = listFibers()

    const findings = []
    // Replay errors recorded before the capture existed, once.
    const early = recorder.takeEarlyErrors?.() ?? []

    for (const entry of entries) {
      if (isActive(entry.state)) continue

      const reason = explain(entry, early)
      findings.push({
        id: `fiber:${entry.uid ?? '?'}`,
        name: entry.name,
        state: entry.state,
        stateName: entry.stateName,
        reason,
      })
    }

    // Degraded enumeration is itself a finding, so `/debug health` reports it
    // instead of claiming a clean composition.
    if (degraded) {
      findings.push({
        id: 'inspector:degraded',
        name: 'inspector',
        state: null,
        stateName: 'UNKNOWN',
        reason: degraded,
      })
    }

    findings.sort((a, b) => (a.name.localeCompare(b.name) || a.id.localeCompare(b.id)))
    return { findings, degraded, total: entries.length }
  }

  /**
   * Explain one non-active fiber in the direction the plugin author needs.
   *
   * @param {object} entry
   * @param {string[]} early
   * @returns {string}
   */
  function explain(entry, early) {
    if (entry.state === FiberState.PENDING) {
      // Mirrors DSH's own boot wording so the two agree.
      const waiting = entry.inject.length ? entry.inject.join(', ') : 'services'
      return `pending (waiting for ${waiting})`
    }
    if (entry.state === FiberState.LOADING) return 'loading (apply() is still running)'
    if (entry.state === FiberState.UNLOADING) return 'unloading (disposers are still running)'
    if (entry.state === FiberState.DISPOSED) return 'disposed (removed; cannot restart)'

    if (entry.state === FiberState.FAILED) {
      const captured = errorLog?.top?.(entry.name)
      if (captured) return `failed: ${captured}`
      const fallback = early[0]
      if (fallback) return `failed: ${fallback}`
      return 'failed (apply() or config threw; no message captured)'
    }
    return `unexpected state ${entry.stateName}`
  }

  /**
   * Live composition snapshot.
   *
   * Deliberately samples on every call rather than caching (design document
   * 4.4): a cached snapshot would describe a composition that may already have
   * changed, which is exactly the false confidence this tool exists to remove.
   *
   * @returns {{findings: object[], services: object[], plugins: object[], counts: object}}
   */
  function snapshot() {
    const { findings, total, degraded } = diagnose()
    const { services } = listServices()

    const counts = { total, active: 0, pending: 0, failed: 0, other: 0 }
    const { entries } = listFibers()
    for (const entry of entries) {
      if (entry.state === FiberState.ACTIVE) counts.active += 1
      else if (entry.state === FiberState.PENDING) counts.pending += 1
      else if (entry.state === FiberState.FAILED) counts.failed += 1
      else counts.other += 1
    }

    return {
      findings: sanitize(findings),
      services: sanitize(services),
      plugins: sanitize(entries),
      counts,
      degraded: degraded ?? null,
    }
  }

  return { diagnose, snapshot, listFibers, listServices }
}

/**
 * Read a numeric field through a possibly-hostile getter.
 *
 * @param {() => unknown} read
 * @param {number|null} fallback
 * @returns {number|null}
 */
function readNumber(read, fallback) {
  try {
    const value = read()
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  } catch {
    return fallback
  }
}
