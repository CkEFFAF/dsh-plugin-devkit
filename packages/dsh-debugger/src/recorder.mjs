/**
 * Timeline storage: monotonic sequence numbers, categories, and per-category timing.
 *
 * This is the layer `ctx.debugger` exposes as `recorder`. It owns the ring
 * buffer and is the single place where records are created, which is what makes
 * constraint 3 enforceable: `sanitize` runs *here*, immediately before the push,
 * so no path into the buffer can bypass redaction.
 */

import { RingBuffer, normalizeCapacity } from './ring-buffer.mjs'
import { sanitize, describeThrown, sanitizeError } from './sanitize.mjs'

/**
 * The closed set of record categories.
 *
 * Design document 6.2 fixes this list. Layout/preview concerns are deliberately
 * absent — preview is a separate package, and letting layout enter this enum is
 * the shallow-interface failure the design doc forbids.
 */
export const CATEGORIES = ['plugin', 'event', 'tool', 'command', 'service', 'log', 'error', 'mark']

/** Fast membership test for category filters. */
const CATEGORY_SET = new Set(CATEGORIES)

/**
 * Owns the timeline: append, filter, correlate, and time.
 *
 * @param {{capacity?: number}} [options]
 */
export function createRecorder(options = {}) {
  const buffer = new RingBuffer(options.capacity ?? 1000)
  /** @type {Map<string, number>} category -> count */
  const counts = new Map()
  /** @type {Map<string, {count: number, totalMs: number, maxMs: number}>} */
  const timings = new Map()
  /** @type {Map<string, number>} correlation id -> record count */
  const correlations = new Map()
  /** @type {Map<string, number>} tool name -> call count (stats ranking) */
  const toolUsage = new Map()

  let seq = 0
  /** Names captured before `loader` existed, replayed by the inspector. */
  const pendingErrors = []

  /**
   * Append one record.
   *
   * Every field is sanitized here, before storage. `error` is normalized through
   * `sanitizeError` so a thrown non-Error still yields `{name, message}`.
   *
   * @param {string} category one of {@link CATEGORIES}
   * @param {string} name short name
   * @param {object} [payload]
   * @returns {object} the stored record
   */
  function push(category, name, payload = {}) {
    const cat = CATEGORY_SET.has(category) ? category : 'mark'
    seq += 1

    const record = {
      seq,
      ts: Date.now(),
      category: cat,
      name: sanitize(String(name ?? '')),
    }

    if (payload.source !== undefined) record.source = sanitize(String(payload.source))
    if (payload.correlation !== undefined) record.correlation = sanitize(String(payload.correlation))
    if (payload.durationMs !== undefined && Number.isFinite(payload.durationMs)) {
      record.durationMs = payload.durationMs
    }
    if (payload.error !== undefined) {
      record.error = payload.error instanceof Error
        ? sanitizeError(payload.error)
        : sanitize(payload.error)
    }
    if (payload.data !== undefined) record.data = sanitize(payload.data)

    // `buffer.push` returns whether an eviction happened; the buffer owns that
    // count, so nothing is tracked in parallel here.
    buffer.push(record)

    counts.set(cat, (counts.get(cat) ?? 0) + 1)

    if (Number.isFinite(record.durationMs)) {
      const t = timings.get(cat) ?? { count: 0, totalMs: 0, maxMs: 0 }
      t.count += 1
      t.totalMs += record.durationMs
      t.maxMs = Math.max(t.maxMs, record.durationMs)
      timings.set(cat, t)
    }

    if (record.correlation !== undefined) {
      correlations.set(record.correlation, (correlations.get(record.correlation) ?? 0) + 1)
    }
    if (cat === 'tool' && payload.usage !== false) {
      toolUsage.set(record.name, (toolUsage.get(record.name) ?? 0) + 1)
    }

    return record
  }

  /**
   * Query records, oldest first.
   *
   * @param {{
   *   category?: string, name?: string, source?: string, correlation?: string,
   *   since?: number, errorsOnly?: boolean, limit?: number
   * }} [filter]
   * @returns {object[]}
   */
  function query(filter = {}) {
    let rows = buffer.toArray()
    if (filter.category !== undefined) rows = rows.filter((r) => r.category === filter.category)
    if (filter.correlation !== undefined) rows = rows.filter((r) => r.correlation === filter.correlation)
    if (filter.errorsOnly) rows = rows.filter((r) => r.error !== undefined)
    if (filter.since !== undefined) rows = rows.filter((r) => r.seq > filter.since)
    if (filter.name !== undefined) {
      const needle = String(filter.name).toLowerCase()
      rows = rows.filter((r) => r.name.toLowerCase().includes(needle))
    }
    if (filter.source !== undefined) {
      const needle = String(filter.source).toLowerCase()
      rows = rows.filter((r) => (r.source ?? '').toLowerCase().includes(needle))
    }
    // `limit` keeps the newest rows, matching "show me the last N".
    if (filter.limit !== undefined && filter.limit >= 0 && rows.length > filter.limit) {
      rows = rows.slice(rows.length - filter.limit)
    }
    return rows
  }

  /**
   * Every record sharing one correlation id, in ascending `seq` order.
   *
   * Sorted explicitly rather than relying on insertion order so the contract
   * ("stable, seq ascending") holds even if records are ever pushed out of order.
   *
   * @param {string} id
   * @returns {object[]}
   */
  function trace(id) {
    return query({ correlation: String(id) }).sort((a, b) => a.seq - b.seq)
  }

  /**
   * Remember an error seen before the inspector could be built.
   *
   * `commands` is the only declared injection, and the logger is consulted by
   * the inspector; anything observed earlier is buffered here so early failures
   * are not lost. Bounded, because this is still unbounded input.
   *
   * @param {unknown} error
   */
  function noteEarlyError(error) {
    pendingErrors.push(describeThrown(error))
    if (pendingErrors.length > 50) pendingErrors.shift()
  }

  /** Drain buffered early errors (called once, by the inspector's first sample). */
  function takeEarlyErrors() {
    return pendingErrors.splice(0, pendingErrors.length)
  }

  /** Counters for `stats` / `health`. */
  function stats() {
    const categoryTimings = {}
    for (const [cat, t] of timings) {
      categoryTimings[cat] = {
        count: t.count,
        totalMs: round(t.totalMs),
        avgMs: round(t.totalMs / t.count),
        maxMs: round(t.maxMs),
      }
    }
    const topTools = [...toolUsage.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }))

    return {
      ...buffer.stats(),
      seq,
      counts: Object.fromEntries(counts),
      timings: categoryTimings,
      topTools,
      correlations: correlations.size,
    }
  }

  /** Reset the timeline, keeping lifetime counters. */
  function clear() {
    buffer.clear()
    counts.clear()
    timings.clear()
    correlations.clear()
    toolUsage.clear()
  }

  /**
   * Change capacity at runtime (`/debug config capacity=`).
   *
   * @param {number} capacity
   */
  function setCapacity(capacity) {
    const next = normalizeCapacity(capacity, buffer.capacity)
    // The buffer owns the eviction count; it also counts rows lost to a shrink,
    // so `stats().dropped` stays honest after a resize instead of silently
    // under-reporting (the recorder keeps no parallel counter).
    buffer.resize(next)
    return buffer.capacity
  }

  return {
    push,
    query,
    trace,
    stats,
    clear,
    setCapacity,
    noteEarlyError,
    takeEarlyErrors,
    get capacity() {
      return buffer.capacity
    },
    get size() {
      return buffer.size
    },
    get evicted() {
      return buffer.evicted
    },
    get seq() {
      return seq
    },
  }
}

/**
 * Round to 3 decimals so reports stay stable and diffable.
 *
 * @param {number} n
 * @returns {number}
 */
function round(n) {
  return Math.round(n * 1000) / 1000
}
