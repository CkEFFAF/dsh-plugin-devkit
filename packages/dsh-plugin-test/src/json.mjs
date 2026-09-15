/**
 * JSON helpers shared by the assertion and report layers.
 *
 * A test helper must never take a process down because the value under test is
 * un-serializable — a report about a broken plugin is exactly when the data is
 * most likely to be hostile. Every helper here returns a value instead of
 * throwing, and the `FAILED` marker keeps an un-serializable field visible rather
 * than silently emitting `null`, which would read as "there was no data".
 */

/** Marker used in place of a value that could not be serialized. */
export const UNSERIALIZABLE = '[unserializable]'

/**
 * `JSON.stringify` that never throws.
 *
 * @param {unknown} value
 * @param {string|number} [space]
 * @returns {string|null} null when the value cannot be serialized
 */
export function safeJson(value, space) {
  try {
    const text = JSON.stringify(value, space)
    // `undefined` and functions stringify to undefined rather than throwing.
    return text === undefined ? null : text
  } catch {
    return null
  }
}

/**
 * Deep-copy a value through JSON, or return the marker when that is impossible.
 *
 * Used on assertion details so a report can never carry live runtime objects —
 * 设计文档 requires that services and contexts are not serialized whole.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function toPlainJson(value) {
  const text = safeJson(value)
  if (text === null) return UNSERIALIZABLE
  try {
    return JSON.parse(text)
  } catch {
    return UNSERIALIZABLE
  }
}
