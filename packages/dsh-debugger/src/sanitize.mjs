/**
 * Sanitization and crash-resistant value normalization.
 *
 * Two design constraints live here:
 *
 * 3. **Sanitize before writing.** Redaction happens before `recorder.push`, not
 *    at render time. Otherwise the secret is already in the in-memory snapshot,
 *    the `/debug --json` output, and any future dump.
 * 5. **Crash resistance.** The observed values are live objects: cycles, throwing
 *    getters, proxies, and enormous strings are normal. Every one of them must
 *    produce a stable placeholder instead of an exception, because a sanitizer
 *    that throws takes the probe (and possibly the tool) down with it.
 */

/** Replacement text for a redacted value. */
export const REDACTED = '[redacted]'

/**
 * Key names whose values are always replaced.
 *
 * Matched case-insensitively against the whole key, and also as a substring so
 * `x-api-key` and `dbPassword` are caught rather than slipping through a strict
 * equality check.
 */
export const SECRET_KEY_PATTERNS = [
  'apikey',
  'api_key',
  'token',
  'authorization',
  'password',
  'passwd',
  'secret',
  'credential',
  'cookie',
]

/**
 * Inline value shapes replaced wherever they appear in a string.
 *
 * These catch secrets pasted into free text (a log line, a URL, an error
 * message) where no key name is available to inspect.
 */
export const SECRET_VALUE_PATTERNS = [
  // sk-… style provider keys
  /\bsk-[A-Za-z0-9_-]{4,}/g,
  // Bearer <token>
  /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi,
  // key=value pairs inside a larger string
  /\b(api[_-]?key|token|password|secret|authorization)\s*[=:]\s*[^\s,;&"']+/gi,
  // JWTs (three base64url segments)
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
]

/** Maximum characters kept from any single string before truncation. */
export const MAX_STRING = 4096

/** Maximum entries visited per object/array while normalizing. */
export const MAX_ENTRIES = 200

/** Maximum depth walked while normalizing. */
export const MAX_DEPTH = 6

/**
 * Test whether a key name looks like it holds a secret.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  const k = String(key).toLowerCase().replace(/[-\s.]/g, '_')
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p))
}

/**
 * Redact secret-shaped substrings inside a string.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactString(text) {
  let out = text
  for (const pattern of SECRET_VALUE_PATTERNS) {
    // Each pattern is global; reset lastIndex so repeated calls stay correct.
    pattern.lastIndex = 0
    out = out.replace(pattern, (match) => {
      // Preserve the `key=` / `Bearer ` prefix so the record stays readable
      // while the value behind it disappears.
      const sep = /^([A-Za-z_-]+\s*[=:]|Bearer\s)/i.exec(match)
      return sep ? `${sep[0]}${REDACTED}` : REDACTED
    })
  }
  return out
}

/**
 * Produce a safe, JSON-serializable copy of a live value.
 *
 * Never throws. Cycles, throwing getters, symbols, functions, proxies, and
 * oversized structures all resolve to a stable representation.
 *
 * @param {unknown} value
 * @param {{depth?: number, seen?: WeakSet<object>, key?: string}} [options]
 * @returns {unknown}
 */
export function sanitize(value, options = {}) {
  const depth = options.depth ?? 0
  const seen = options.seen ?? new WeakSet()

  let keyIsSecret = false
  try {
    keyIsSecret = options.key !== undefined && isSecretKey(options.key)
  } catch {
    keyIsSecret = false
  }

  if (typeof value === 'string') {
    if (keyIsSecret) return REDACTED
    const redacted = redactString(value)
    return redacted.length > MAX_STRING
      ? `${redacted.slice(0, MAX_STRING)}…[truncated ${redacted.length - MAX_STRING} chars]`
      : redacted
  }

  if (value === null) return null

  const type = typeof value
  if (type === 'number') return Number.isFinite(value) ? value : String(value)
  if (type === 'boolean') return value
  if (type === 'undefined') return undefined
  if (type === 'bigint') return `${value}n`
  if (type === 'symbol') return safeToString(value)
  if (type === 'function') return `[function ${safeName(value)}]`

  // Only objects remain. Anything secret-keyed short-circuits, which is what
  // keeps a nested credential object from being walked at all.
  if (keyIsSecret) return REDACTED

  if (depth >= MAX_DEPTH) return '[depth limit]'

  try {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
  } catch {
    // A proxy may reject WeakSet operations; treat it as opaque.
    return '[uninspectable]'
  }

  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[invalid date]' : value.toISOString()
    if (value instanceof RegExp) return String(value)
    if (value instanceof Error) return sanitizeError(value, { depth, seen })

    if (Array.isArray(value)) {
      const out = []
      const limit = Math.min(value.length, MAX_ENTRIES)
      for (let i = 0; i < limit; i += 1) {
        out.push(sanitize(readIndex(value, i), { depth: depth + 1, seen }))
      }
      if (value.length > limit) out.push(`…[${value.length - limit} more]`)
      return out
    }

    if (value instanceof Map) {
      const out = {}
      let n = 0
      for (const [k, v] of value) {
        if (n >= MAX_ENTRIES) break
        out[safeToString(k)] = sanitize(v, { depth: depth + 1, seen, key: safeToString(k) })
        n += 1
      }
      return out
    }

    if (value instanceof Set) {
      const out = []
      let n = 0
      for (const v of value) {
        if (n >= MAX_ENTRIES) break
        out.push(sanitize(v, { depth: depth + 1, seen }))
        n += 1
      }
      return out
    }

    // Plain object (or a class instance read structurally). Own enumerable
    // string keys only: reading them individually is what lets a single
    // throwing getter degrade to a placeholder instead of failing the record.
    const out = {}
    let keys
    try {
      keys = Object.keys(value)
    } catch {
      return '[uninspectable]'
    }
    const limit = Math.min(keys.length, MAX_ENTRIES)
    for (let i = 0; i < limit; i += 1) {
      const k = keys[i]
      let v
      try {
        v = value[k]
      } catch (error) {
        out[k] = `[getter threw: ${describeThrown(error)}]`
        continue
      }
      out[k] = sanitize(v, { depth: depth + 1, seen, key: k })
    }
    if (keys.length > limit) out['…'] = `[${keys.length - limit} more keys]`
    return out
  } catch (error) {
    // Last-resort net: the constraint is "never throw", not "never lose data".
    return `[unsanitizable: ${describeThrown(error)}]`
  }
}

/**
 * Read one array index without letting a hostile proxy throw.
 *
 * @param {unknown[]} array
 * @param {number} index
 * @returns {unknown}
 */
function readIndex(array, index) {
  try {
    return array[index]
  } catch (error) {
    return `[getter threw: ${describeThrown(error)}]`
  }
}

/**
 * Normalize an Error into `{name, message, stack?}` with its text redacted.
 *
 * @param {Error} error
 * @param {{depth: number, seen: WeakSet<object>}} ctx
 * @returns {{name: string, message: string, stack?: string}}
 */
export function sanitizeError(error, ctx = { depth: 0, seen: new WeakSet() }) {
  const out = {
    name: safeString(() => error.name, 'Error'),
    message: safeString(() => error.message, ''),
  }
  out.message = redactString(out.message)
  // Stack frames run through redaction too: a token can appear in a URL or a
  // source line quoted by the message.
  const stack = safeString(() => error.stack, '')
  if (stack) out.stack = redactString(truncate(stack, MAX_STRING))
  return out
}

/**
 * Describe any thrown value as a short readable string.
 *
 * Errors are the common case, but JS permits throwing anything at all.
 *
 * @param {unknown} thrown
 * @returns {string}
 */
export function describeThrown(thrown) {
  try {
    if (thrown instanceof Error) return redactString(`${thrown.name}: ${thrown.message}`)
    if (typeof thrown === 'string') return redactString(thrown)
    return redactString(safeToString(thrown))
  } catch {
    return '[unprintable]'
  }
}

/**
 * Run a function, returning its `fallback` when it throws or returns empty.
 *
 * @param {() => string} fn
 * @param {string} fallback
 * @returns {string}
 */
function safeString(fn, fallback) {
  try {
    const value = fn()
    return typeof value === 'string' ? value : fallback
  } catch {
    return fallback
  }
}

/**
 * `String(value)` that cannot throw (a hostile `toString`/`Symbol.toPrimitive`).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function safeToString(value) {
  try {
    const s = String(value)
    return redactString(truncate(s, 256))
  } catch {
    return '[unprintable]'
  }
}

/**
 * Read a function or object name defensively.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function safeName(value) {
  try {
    const name = value?.name
    return typeof name === 'string' && name ? name : 'anonymous'
  } catch {
    return 'anonymous'
  }
}

/**
 * Truncate a string to `max` characters with a visible marker.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  if (typeof text !== 'string') return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}
