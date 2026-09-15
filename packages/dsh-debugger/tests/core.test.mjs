/**
 * Core layer tests: ring buffer, sanitization, and crash-resistant normalization.
 *
 * Covers acceptance A5 (redaction before storage, including verbose JSON) and
 * A6 (overflow is counted and visible), plus design constraints 3, 4, and 5.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RingBuffer, normalizeCapacity } from '../src/ring-buffer.mjs'
import { createRecorder, CATEGORIES } from '../src/recorder.mjs'
import {
  sanitize,
  redactString,
  isSecretKey,
  describeThrown,
  REDACTED,
  MAX_STRING,
} from '../src/sanitize.mjs'

// ---------------------------------------------------------------- ring buffer --

test('ring buffer retains up to capacity in insertion order', () => {
  const buffer = new RingBuffer(3)
  buffer.push('a')
  buffer.push('b')
  buffer.push('c')
  assert.deepEqual(buffer.toArray(), ['a', 'b', 'c'])
  assert.equal(buffer.size, 3)
  assert.equal(buffer.evicted, 0)
})

test('ring buffer evicts the oldest and counts the eviction', () => {
  const buffer = new RingBuffer(3)
  for (const item of ['a', 'b', 'c', 'd']) buffer.push(item)
  assert.deepEqual(buffer.toArray(), ['b', 'c', 'd'])
  assert.equal(buffer.evicted, 1)
  assert.equal(buffer.overflowed, true)
})

test('ring buffer overflow count keeps rising past the first eviction', () => {
  const buffer = new RingBuffer(2)
  for (let i = 0; i < 10; i += 1) buffer.push(i)
  assert.deepEqual(buffer.toArray(), [8, 9])
  assert.equal(buffer.evicted, 8)
})

test('ring buffer wraps correctly across many cycles', () => {
  const buffer = new RingBuffer(4)
  for (let i = 0; i < 100; i += 1) buffer.push(i)
  assert.deepEqual(buffer.toArray(), [96, 97, 98, 99])
  assert.equal(buffer.evicted, 96)
})

test('ring buffer clear keeps the lifetime eviction count', () => {
  const buffer = new RingBuffer(2)
  buffer.push(1)
  buffer.push(2)
  buffer.push(3)
  buffer.clear()
  assert.deepEqual(buffer.toArray(), [])
  assert.equal(buffer.size, 0)
  // "Clear the buffer, keep counts" — the overflow must remain visible.
  assert.equal(buffer.evicted, 1)
})

test('ring buffer resize preserves newest items when shrinking', () => {
  const buffer = new RingBuffer(5)
  for (let i = 1; i <= 5; i += 1) buffer.push(i)
  buffer.resize(2)
  assert.equal(buffer.capacity, 2)
  assert.deepEqual(buffer.toArray(), [4, 5])
  // Shrinking genuinely lost rows, so the loss is counted.
  assert.equal(buffer.evicted, 3)
})

test('ring buffer resize preserves everything when growing', () => {
  const buffer = new RingBuffer(2)
  buffer.push(1)
  buffer.push(2)
  buffer.resize(5)
  assert.deepEqual(buffer.toArray(), [1, 2])
  assert.equal(buffer.evicted, 0)
})

test('ring buffer toArray returns a copy, not internal state', () => {
  const buffer = new RingBuffer(2)
  buffer.push('a')
  const snapshot = buffer.toArray()
  snapshot.push('tampered')
  assert.deepEqual(buffer.toArray(), ['a'])
})

test('capacity normalisation rejects junk without throwing', () => {
  assert.equal(normalizeCapacity(10), 10)
  assert.equal(normalizeCapacity('25'), 25)
  assert.equal(normalizeCapacity(0), 1000)
  assert.equal(normalizeCapacity(-5), 1000)
  assert.equal(normalizeCapacity(Number.NaN), 1000)
  assert.equal(normalizeCapacity(undefined), 1000)
  assert.equal(normalizeCapacity('abc'), 1000)
  assert.equal(normalizeCapacity(10.7), 10)
})

// ------------------------------------------------------------------ sanitize --

test('secret keys are detected case- and separator-insensitively', () => {
  for (const key of ['apiKey', 'api_key', 'API-KEY', 'token', 'Authorization', 'DB_PASSWORD', 'secret', 'x-credential']) {
    assert.equal(isSecretKey(key), true, `${key} should be secret`)
  }
  for (const key of ['name', 'count', 'userId', 'path']) {
    assert.equal(isSecretKey(key), false, `${key} should not be secret`)
  }
})

test('secret-keyed object values are replaced wholesale', () => {
  const out = sanitize({ apiKey: 'sk-live-abcdef123456', user: 'ada' })
  assert.equal(out.apiKey, REDACTED)
  assert.equal(out.user, 'ada')
})

test('nested secret keys are redacted at any depth', () => {
  const out = sanitize({ outer: { inner: { password: 'hunter2', keep: 1 } } })
  assert.equal(out.outer.inner.password, REDACTED)
  assert.equal(out.outer.inner.keep, 1)
})

test('inline secret shapes inside free text are redacted', () => {
  assert.doesNotMatch(redactString('using sk-live-abc123def456 now'), /sk-live/)
  assert.doesNotMatch(redactString('Authorization: Bearer eyJhbGciOi.abc.def'), /eyJhbGciOi/)
  assert.doesNotMatch(redactString('call with token=supersecretvalue'), /supersecretvalue/)
  assert.doesNotMatch(redactString('key api_key=abcdef123456'), /abcdef123456/)
})

test('redaction preserves the surrounding text and key prefix', () => {
  const out = redactString('request failed: token=abc123xyz done')
  assert.match(out, /^request failed: token=/)
  assert.match(out, /done$/)
  assert.doesNotMatch(out, /abc123xyz/)
})

test('redaction is stable across repeated calls (no lastIndex bug)', () => {
  const input = 'sk-firstvalue111 and sk-secondvalue222'
  const once = redactString(input)
  const twice = redactString(once)
  assert.equal(once, twice)
  assert.doesNotMatch(once, /sk-/)
})

test('sanitize survives circular references', () => {
  const value = { name: 'a' }
  value.self = value
  const out = sanitize(value)
  assert.equal(out.name, 'a')
  assert.equal(out.self, '[circular]')
})

test('sanitize survives a throwing getter and names it', () => {
  const value = {
    ok: 1,
    get boom() {
      throw new Error('getter exploded')
    },
  }
  const out = sanitize(value)
  assert.equal(out.ok, 1)
  assert.match(out.boom, /getter threw/)
  assert.match(out.boom, /getter exploded/)
})

test('sanitize survives a Proxy that rejects enumeration', () => {
  const hostile = new Proxy({}, {
    ownKeys() {
      throw new Error('no keys for you')
    },
  })
  const out = sanitize(hostile)
  assert.equal(out, '[uninspectable]')
})

test('sanitize truncates very long strings with a visible marker', () => {
  const out = sanitize('x'.repeat(MAX_STRING + 500))
  assert.ok(out.length < MAX_STRING + 100)
  assert.match(out, /truncated 500 chars/)
})

test('sanitize handles primitives and exotic values without throwing', () => {
  assert.equal(sanitize(null), null)
  assert.equal(sanitize(true), true)
  assert.equal(sanitize(42), 42)
  assert.equal(sanitize(BigInt(7)), '7n')
  assert.equal(sanitize(undefined), undefined)
  assert.match(sanitize(() => {}), /\[function/)
  assert.match(sanitize(Symbol('s')), /Symbol/)
  assert.equal(sanitize(Number.POSITIVE_INFINITY), 'Infinity')
})

test('sanitize bounds depth rather than recursing forever', () => {
  let deep = { value: 'bottom' }
  for (let i = 0; i < 20; i += 1) deep = { nested: deep }
  const out = sanitize(deep)
  assert.equal(JSON.stringify(out).includes('[depth limit]'), true)
})

test('sanitize normalises Errors and redacts their message', () => {
  const out = sanitize(new Error('failed with sk-live-abcdef12345'))
  assert.equal(out.name, 'Error')
  assert.doesNotMatch(out.message, /sk-live/)
})

test('sanitize handles Maps, Sets, Dates, and RegExps', () => {
  assert.deepEqual(sanitize(new Map([['a', 1]])), { a: 1 })
  assert.deepEqual(sanitize(new Set([1, 2])), [1, 2])
  assert.equal(typeof sanitize(new Date(0)), 'string')
  assert.equal(sanitize(/ab+c/g), '/ab+c/g')
})

test('sanitize redacts a secret inside a Map key', () => {
  const out = sanitize(new Map([['apiKey', 'sk-live-aaaaaaaa']]))
  assert.equal(out.apiKey, REDACTED)
})

test('describeThrown handles non-Error throws', () => {
  assert.equal(describeThrown(new TypeError('bad')), 'TypeError: bad')
  assert.equal(describeThrown('plain string'), 'plain string')
  assert.match(describeThrown({ weird: true }), /object/)
})

test('describeThrown redacts secrets in thrown messages', () => {
  assert.doesNotMatch(describeThrown(new Error('bad token=abcdef123456')), /abcdef123456/)
})

// ------------------------------------------------------------------ recorder --

test('recorder assigns monotonically increasing sequence numbers', () => {
  const recorder = createRecorder({ capacity: 10 })
  recorder.push('mark', 'one')
  recorder.push('mark', 'two')
  const rows = recorder.query()
  assert.deepEqual(rows.map((r) => r.seq), [1, 2])
})

test('recorder sanitizes before storing (constraint 3)', () => {
  const recorder = createRecorder()
  recorder.push('log', 'auth', { data: { apiKey: 'sk-live-abcdef123456' } })
  const [row] = recorder.query()
  assert.equal(row.data.apiKey, REDACTED)
  // The raw value must not survive anywhere in the serialized record.
  assert.doesNotMatch(JSON.stringify(row), /sk-live-abcdef123456/)
})

test('recorder redacts secrets in the record name', () => {
  const recorder = createRecorder()
  recorder.push('mark', 'using sk-live-abcdef123456')
  const [row] = recorder.query()
  assert.doesNotMatch(row.name, /sk-live/)
})

test('recorder normalizes a thrown Error into name and message', () => {
  const recorder = createRecorder()
  recorder.push('error', 'boom', { error: new Error('it broke') })
  const [row] = recorder.query()
  assert.equal(row.error.name, 'Error')
  assert.equal(row.error.message, 'it broke')
})

test('recorder accepts a non-Error thrown value', () => {
  const recorder = createRecorder()
  recorder.push('error', 'boom', { error: 'just a string' })
  const [row] = recorder.query()
  assert.equal(row.error, 'just a string')
})

test('recorder rejects an unknown category by degrading to mark', () => {
  const recorder = createRecorder()
  recorder.push('nonsense', 'x')
  assert.equal(recorder.query()[0].category, 'mark')
})

test('every documented category is accepted', () => {
  const recorder = createRecorder()
  for (const category of CATEGORIES) recorder.push(category, `n-${category}`)
  assert.deepEqual(
    recorder.query().map((r) => r.category),
    CATEGORIES,
  )
})

test('layout is not a category (preview stays a separate package)', () => {
  assert.equal(CATEGORIES.includes('layout'), false)
  assert.equal(CATEGORIES.length, 8)
})

test('recorder filters by category, name, and source', () => {
  const recorder = createRecorder()
  recorder.push('tool', 'read', { source: 'fs' })
  recorder.push('command', 'read', { source: 'cli' })
  recorder.push('log', 'noise', { source: 'fs' })

  assert.equal(recorder.query({ category: 'tool' }).length, 1)
  assert.equal(recorder.query({ name: 'read' }).length, 2)
  assert.equal(recorder.query({ source: 'fs' }).length, 2)
  assert.equal(recorder.query({ category: 'tool', name: 'read' }).length, 1)
})

test('recorder filters errorsOnly', () => {
  const recorder = createRecorder()
  recorder.push('tool', 'ok')
  recorder.push('tool', 'bad', { error: new Error('nope') })
  const rows = recorder.query({ errorsOnly: true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'bad')
})

test('recorder limit keeps the newest records', () => {
  const recorder = createRecorder()
  for (let i = 1; i <= 10; i += 1) recorder.push('mark', `m${i}`)
  const rows = recorder.query({ limit: 3 })
  assert.deepEqual(rows.map((r) => r.name), ['m8', 'm9', 'm10'])
})

test('recorder filters by since (exclusive)', () => {
  const recorder = createRecorder()
  for (let i = 1; i <= 5; i += 1) recorder.push('mark', `m${i}`)
  assert.deepEqual(recorder.query({ since: 3 }).map((r) => r.seq), [4, 5])
})

test('recorder trace returns one correlation chain in seq order', () => {
  const recorder = createRecorder()
  recorder.push('tool', 'pre', { correlation: 'call-1' })
  recorder.push('tool', 'other', { correlation: 'call-2' })
  recorder.push('tool', 'exec', { correlation: 'call-1' })
  recorder.push('tool', 'result', { correlation: 'call-1' })
  const chain = recorder.trace('call-1')
  assert.deepEqual(chain.map((r) => r.name), ['pre', 'exec', 'result'])
  assert.deepEqual(chain.map((r) => r.seq), [1, 3, 4])
})

test('recorder trace of an unknown id is empty, not an error', () => {
  const recorder = createRecorder()
  assert.deepEqual(recorder.trace('nope'), [])
})

test('recorder stats report size, capacity, and dropped count', () => {
  const recorder = createRecorder({ capacity: 2 })
  for (let i = 0; i < 5; i += 1) recorder.push('mark', `m${i}`)
  const stats = recorder.stats()
  assert.equal(stats.capacity, 2)
  assert.equal(stats.size, 2)
  assert.equal(stats.dropped, 3)
  assert.equal(stats.seq, 5)
})

test('recorder stats report per-category counts and timings', () => {
  const recorder = createRecorder()
  recorder.push('tool', 'a', { durationMs: 10 })
  recorder.push('tool', 'b', { durationMs: 30 })
  recorder.push('mark', 'c')
  const stats = recorder.stats()
  assert.equal(stats.counts.tool, 2)
  assert.equal(stats.counts.mark, 1)
  assert.equal(stats.timings.tool.count, 2)
  assert.equal(stats.timings.tool.totalMs, 40)
  assert.equal(stats.timings.tool.avgMs, 20)
  assert.equal(stats.timings.tool.maxMs, 30)
})

test('recorder stats rank the most-used tools', () => {
  const recorder = createRecorder()
  recorder.push('tool', 'read')
  recorder.push('tool', 'read')
  recorder.push('tool', 'write')
  const stats = recorder.stats()
  assert.equal(stats.topTools[0].name, 'read')
  assert.equal(stats.topTools[0].count, 2)
})

test('recorder setCapacity shrinks and reports the loss', () => {
  const recorder = createRecorder({ capacity: 10 })
  for (let i = 0; i < 10; i += 1) recorder.push('mark', `m${i}`)
  recorder.setCapacity(3)
  assert.equal(recorder.capacity, 3)
  assert.equal(recorder.size, 3)
  assert.equal(recorder.stats().dropped, 7)
})

test('recorder clear empties records but keeps counters', () => {
  const recorder = createRecorder({ capacity: 2 })
  for (let i = 0; i < 4; i += 1) recorder.push('mark', `m${i}`)
  recorder.clear()
  assert.equal(recorder.query().length, 0)
  assert.equal(recorder.stats().dropped, 2)
})

test('recorder buffers early errors until drained', () => {
  const recorder = createRecorder()
  recorder.noteEarlyError(new Error('startup failed'))
  assert.deepEqual(recorder.takeEarlyErrors(), ['Error: startup failed'])
  // Drained: a second call must not replay the same error.
  assert.deepEqual(recorder.takeEarlyErrors(), [])
})

test('recorder early error buffer is bounded', () => {
  const recorder = createRecorder()
  for (let i = 0; i < 100; i += 1) recorder.noteEarlyError(new Error(`e${i}`))
  const errors = recorder.takeEarlyErrors()
  assert.equal(errors.length, 50)
  assert.match(errors[errors.length - 1], /e99/)
})
