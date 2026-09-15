/**
 * Fixed-capacity ring buffer with an honest overflow count.
 *
 * Design constraint 4 ("bounded and honest"): capacity is fixed, and every
 * eviction increments a counter that `stats`/`health` must be able to read.
 * Silently dropping data turns "the timeline looks complete" into a wrong
 * conclusion, so overflow is a first-class, reported number.
 *
 * This layer knows nothing about records' meaning; it only stores and counts.
 */

/** A ring buffer holding at most `capacity` items, newest last. */
export class RingBuffer {
  #items
  #capacity
  #next = 0
  #size = 0
  #evicted = 0

  /**
   * @param {number} capacity maximum retained items (must be a positive integer)
   */
  constructor(capacity = 1000) {
    this.#capacity = normalizeCapacity(capacity)
    this.#items = new Array(this.#capacity)
  }

  /** Maximum number of retained items. */
  get capacity() {
    return this.#capacity
  }

  /** Number of items currently retained. */
  get size() {
    return this.#size
  }

  /** Number of items dropped because the buffer was full. */
  get evicted() {
    return this.#evicted
  }

  /** True once at least one item has been dropped. */
  get overflowed() {
    return this.#evicted > 0
  }

  /**
   * Append one item, evicting the oldest when full.
   *
   * @param {unknown} item
   * @returns {boolean} true when an eviction happened
   */
  push(item) {
    let evicted = false
    if (this.#size === this.#capacity) {
      // The slot we are about to overwrite holds the oldest item.
      evicted = true
      this.#evicted += 1
    } else {
      this.#size += 1
    }
    this.#items[this.#next] = item
    this.#next = (this.#next + 1) % this.#capacity
    return evicted
  }

  /**
   * Snapshot every retained item in insertion order (oldest first).
   *
   * Returns a fresh array, so callers cannot mutate internal state.
   *
   * @returns {unknown[]}
   */
  toArray() {
    if (this.#size < this.#capacity) {
      return this.#items.slice(0, this.#size)
    }
    const start = this.#next % this.#capacity
    return [...this.#items.slice(start), ...this.#items.slice(0, start)]
  }

  /** Iterate retained items oldest-first. */
  *[Symbol.iterator]() {
    yield* this.toArray()
  }

  /**
   * Drop all items but keep the lifetime eviction count.
   *
   * `/debug clear` is documented as "clear the buffer (keep counts)", and the
   * counters are what make an overflow visible after a clear.
   */
  clear() {
    this.#items = new Array(this.#capacity)
    this.#next = 0
    this.#size = 0
  }

  /**
   * Change capacity, preserving the most recent items.
   *
   * Backs `/debug config capacity=<n>`. Shrinking evicts and counts the loss,
   * so a user who shrinks the buffer still sees the dropped rows.
   *
   * @param {number} capacity
   */
  resize(capacity) {
    const target = normalizeCapacity(capacity)
    if (target === this.#capacity) return
    const kept = this.toArray()
    // Shrinking genuinely loses rows; growing never does.
    const dropped = Math.max(0, kept.length - target)
    this.#capacity = target
    this.#items = new Array(target)
    this.#next = 0
    this.#size = 0
    this.#evicted += dropped
    for (const item of kept.slice(dropped)) this.push(item)
  }

  /** Counters for `stats` / `health`. */
  stats() {
    return {
      capacity: this.#capacity,
      size: this.#size,
      // `evicted` is the internal name; `dropped` is the field the recorder and
      // command layers report. They are the same number by construction.
      evicted: this.#evicted,
      dropped: this.#evicted,
    }
  }
}

/**
 * Coerce a capacity to a positive integer.
 *
 * Falls back to the default rather than throwing: a bad capacity from a config
 * file or a `/debug config` typo must not take down the command entry that
 * exists to explain such problems.
 *
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function normalizeCapacity(value, fallback = 1000) {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < 1) return fallback
  return i
}
