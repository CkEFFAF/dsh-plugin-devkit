/**
 * Assertion helpers over `ctx.debugger`.
 *
 * ## Design rule
 *
 * Every helper reads only the **public** debugger surface — `snapshot()`,
 * `query()`, `trace()`, `stats()` — and never reaches into probe internals or the
 * ring buffer. That is deliberate: swapping the buffer implementation must not
 * break a downstream plugin's tests, and 设计文档 §6 states the seam is
 * `ctx.debugger`, not the machinery behind it.
 *
 * ## Framework independence
 *
 * The helpers return a result object and never throw their own error type, so
 * they compose with `node:test`, vitest, or a hand-rolled runner. `assertOk`
 * bridges to `node:assert` for callers who want that.
 *
 * ## Reading the service
 *
 * A consumer plugin declares `inject: ['commands', 'debugger']` and then uses
 * `ctx.debugger`. These helpers take that service, or the context, and resolve
 * whichever was passed.
 */

/**
 * The redaction rules come from `dsh-debugger`, not a second copy.
 *
 * Constraint 3 ("sanitize before writing") is security-relevant, and an
 * assertion helper that checks secrets with a *different* pattern list than the
 * one that redacts them would pass while real secrets leak. One source of truth
 * is the only defensible arrangement.
 */
import { sanitize, redactString, isSecretKey, REDACTED } from '../../dsh-debugger/src/sanitize.mjs'
import { safeJson } from './json.mjs'

/**
 * Resolve a `debugger` service from a service or a context.
 *
 * @param {object} target a debugger service, or a ctx exposing one
 * @returns {object|null}
 */
function resolveDebugger(target) {
  if (!target) return null
  // A debugger service answers `snapshot`; a context exposes one via `get`.
  if (typeof target.snapshot === 'function' && typeof target.query === 'function') return target
  try {
    const service = target.get?.('debugger')
    if (service && typeof service.snapshot === 'function') return service
  } catch {
    // fall through
  }
  return null
}

/**
 * @typedef {{ok: boolean, message: string, detail?: unknown}} AssertionResult
 */

/**
 * @param {boolean} ok
 * @param {string} message
 * @param {unknown} [detail]
 * @returns {AssertionResult}
 */
function result(ok, message, detail) {
  return detail === undefined ? { ok, message } : { ok, message, detail }
}

/**
 * Assert that no plugin matching `id` is stuck in PENDING.
 *
 * PENDING is the most common "my plugin does nothing" failure, and the useful
 * information is *which service* it waits for — so the failure detail names it.
 *
 * @param {object} target debugger service or ctx
 * @param {string} [id] plugin/fiber name substring; all plugins when omitted
 * @returns {AssertionResult}
 */
export function noPending(target, id) {
  const debuggerService = resolveDebugger(target)
  if (!debuggerService) return result(false, 'no debugger service available to inspect')

  let snapshot
  try {
    snapshot = debuggerService.snapshot()
  } catch (error) {
    return result(false, `snapshot() threw: ${error?.message ?? error}`)
  }

  const pending = (snapshot.plugins ?? []).filter(
    (plugin) => plugin.stateName === 'PENDING' && matches(plugin.name, id),
  )

  if (pending.length === 0) {
    return result(true, id ? `no plugin matching '${id}' is pending` : 'no plugin is pending')
  }

  const detail = pending.map((plugin) => ({
    name: plugin.name,
    waitingFor: plugin.inject ?? [],
  }))
  const summary = detail
    .map((entry) => `${entry.name} (waiting for ${entry.waitingFor.join(', ') || 'services'})`)
    .join('; ')
  return result(false, `pending: ${summary}`, detail)
}

/**
 * Assert that a service is registered and its provider fiber is ACTIVE.
 *
 * ## Matching by name *or* provider fiber
 *
 * Measured against a real `Context`: the declared service name is **masked**
 * through the context proxy. `impl.name`, the store key's `Symbol.description`,
 * the `reflect.props` key, and even a raw `getOwnPropertyDescriptor(...).value`
 * all read back as the literal string `"[object Object]"`. Only the owning
 * fiber's name survives as a real string.
 *
 * A helper that matched on the declared name alone therefore reported every real
 * service as "not registered" — verified by calling it against a genuine
 * `Context`, which is the only way this was ever going to surface.
 *
 * So the match is: exact name, **or** provider fiber name, **or** a substring of
 * either. When the match came from the fiber rather than the name, the result
 * says so, because an inferred identity must not be presented as a read one.
 *
 * @param {object} target debugger service or ctx
 * @param {string} name service name, or the owning fiber's name
 * @returns {AssertionResult}
 */
export function serviceActive(target, name) {
  const debuggerService = resolveDebugger(target)
  if (!debuggerService) return result(false, 'no debugger service available to inspect')

  let snapshot
  try {
    snapshot = debuggerService.snapshot()
  } catch (error) {
    return result(false, `snapshot() threw: ${error?.message ?? error}`)
  }

  const services = snapshot.services ?? []
  const wanted = String(name)

  // Prefer a real name match; fall back to the owning fiber.
  let service = services.find((candidate) => candidate.name === wanted)
  let matchedBy = 'name'
  if (!service) {
    service = services.find((candidate) => candidate.provider?.name === wanted)
    matchedBy = 'provider fiber'
  }
  if (!service) {
    service = services.find((candidate) => String(candidate.name).includes(wanted)
      || String(candidate.provider?.name ?? '').includes(wanted))
    matchedBy = 'substring'
  }

  if (!service) {
    return result(false, `service '${name}' is not registered`, {
      registered: services.map((candidate) => ({
        name: candidate.name,
        provider: candidate.provider?.name ?? null,
      })),
    })
  }
  if (service.available === false) {
    return result(false, `service '${name}' is registered but has no value`)
  }
  const stateName = service.provider?.stateName
  if (stateName && stateName !== 'ACTIVE') {
    return result(false, `service '${name}' provider is ${stateName}, not ACTIVE`, service.provider)
  }

  const via = matchedBy === 'name'
    ? ''
    : ` (identified via ${matchedBy}: ${service.name})`
  return result(true, `service '${name}' is active${via}`)
}

/**
 * Assert that a correlation chain contains the expected record kinds.
 *
 * `kinds` are matched against record names (the `name` field) of the records
 * sharing one correlation id — a tool callId or a command id.
 *
 * @param {object} target debugger service or ctx
 * @param {string} callId correlation id
 * @param {string[]} kinds record names that must all be present
 * @returns {AssertionResult}
 */
export function traceHas(target, callId, kinds) {
  const debuggerService = resolveDebugger(target)
  if (!debuggerService) return result(false, 'no debugger service available to inspect')

  let records
  try {
    records = debuggerService.trace(callId)
  } catch (error) {
    return result(false, `trace() threw: ${error?.message ?? error}`)
  }

  if (!records || records.length === 0) {
    return result(false, `no records for correlation '${callId}'`)
  }

  const names = records.map((record) => record.name)
  const missing = (kinds ?? []).filter((kind) => !names.includes(kind))
  if (missing.length) {
    return result(false, `trace '${callId}' is missing: ${missing.join(', ')}`, { found: names })
  }

  // Ascending seq is the documented contract (设计文档 §4.4).
  const seqs = records.map((record) => record.seq)
  const sorted = [...seqs].sort((a, b) => a - b)
  if (seqs.join(',') !== sorted.join(',')) {
    return result(false, `trace '${callId}' is not in ascending seq order`, { seqs })
  }

  return result(true, `trace '${callId}' has ${kinds.length} expected kinds in order`)
}

/**
 * Assert that a record (or any record) carries no unredacted secret.
 *
 * Checks the sanitized form for secret-shaped strings *and* re-checks raw values
 * against the same patterns, so a value that slipped past sanitization is caught
 * here rather than by a human reading the JSON.
 *
 * @param {object} target debugger service or ctx
 * @param {object|string} [recordOrFilter] a record to inspect, or a filter/name
 * @returns {AssertionResult}
 */
export function noSecrets(target, recordOrFilter) {
  const debuggerService = resolveDebugger(target)
  if (!debuggerService) return result(false, 'no debugger service available to inspect')

  let records
  if (recordOrFilter && typeof recordOrFilter === 'object' && 'seq' in recordOrFilter) {
    records = [recordOrFilter]
  } else {
    try {
      const filter = typeof recordOrFilter === 'string' ? { name: recordOrFilter } : (recordOrFilter ?? {})
      records = debuggerService.query(filter)
    } catch (error) {
      return result(false, `query() threw: ${error?.message ?? error}`)
    }
  }

  if (!records.length) return result(true, 'no records to inspect')

  const leaks = []
  for (const record of records) {
    const text = safeJson(record)
    if (text === null) {
      leaks.push({ seq: record.seq, reason: 'record could not be serialized' })
      continue
    }
    // Re-run the redactor: if these patterns still match the *stored* form, the
    // value was never redacted on the way in (design constraint 3).
    if (redactString(text) !== text) {
      leaks.push({ seq: record.seq, name: record.name, reason: 'secret-shaped value survived sanitization' })
      continue
    }
    if (containsSecretKey(record.data)) {
      leaks.push({ seq: record.seq, name: record.name, reason: 'secret-keyed field survived sanitization' })
    }
  }

  if (leaks.length) {
    return result(false, `${leaks.length} record(s) leak secrets`, leaks)
  }
  return result(true, `${records.length} record(s) carry no secrets`)
}

/**
 * Whether any object in a value is keyed by a secret-looking name **and still
 * holds a value**.
 *
 * A correctly-sanitized record legitimately contains `apiKey: '[redacted]'`: the
 * key name survives redaction so the reader can see *that* a credential was
 * present. Flagging the key alone would report every properly redacted record as
 * a leak, which is worse than useless — it trains the reader to ignore the check.
 * The signal is a secret-keyed field whose value is anything other than the
 * placeholder.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {boolean}
 */
function containsSecretKey(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false
  try {
    if (seen.has(value)) return false
    seen.add(value)
  } catch {
    return false
  }

  for (const key of Object.keys(value)) {
    const entry = value[key]
    if (isSecretKey(key) && holdsRealValue(entry)) return true
    if (containsSecretKey(entry, seen)) return true
  }
  return false
}

/**
 * Whether a secret-keyed entry still carries something other than the redaction
 * placeholder.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function holdsRealValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') {
    // The placeholder means it was redacted; an empty string carries nothing.
    return value !== REDACTED && value.trim() !== ''
  }
  // An object or array is itself something to inspect, so recurse through it
  // rather than declaring the whole subtree a leak.
  return false
}

/**
 * Whether a name matches an optional filter.
 *
 * @param {string} name
 * @param {string|undefined} filter
 * @returns {boolean}
 */
function matches(name, filter) {
  if (filter === undefined) return true
  return String(name ?? '').includes(filter)
}

/** All helpers, for a runner that wants to enumerate them. */
export const ASSERTIONS = Object.freeze({ noPending, serviceActive, traceHas, noSecrets })

/**
 * Bridge an {@link AssertionResult} to a thrown error, for `node:assert` users.
 *
 * @param {AssertionResult} assertion
 * @returns {AssertionResult}
 * @throws {Error} when the assertion failed
 */
export function assertOk(assertion) {
  if (!assertion.ok) {
    const detail = assertion.detail === undefined ? '' : `\n${safeJson(assertion.detail)}`
    throw new Error(assertion.message + detail)
  }
  return assertion
}

export { sanitize }
