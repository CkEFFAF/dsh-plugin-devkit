/**
 * Guard test: the `FiberState` mirror must match real cordis source.
 *
 * Cordis declares `export const enum FiberState`, which is erased at runtime, so
 * the values cannot be imported and must be mirrored as literals. 设计文档 §4.5
 * requires that drift be a *build failure* rather than a cosmetic "Unknown", so
 * this test parses the real source file and compares member order and values.
 *
 * If this fails after a cordis upgrade, re-read the enum and update
 * `src/fiber-state.mjs`; do not relax the assertion.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { FiberState, FIBER_STATE_NAMES, fiberStateName } from '../src/fiber-state.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Candidate locations for the cordis checkout, in preference order. */
const CORDIS_CANDIDATES = [
  process.env.DSH_CORDIS_SOURCE,
  'D:/DSH/deepseek-harness/vendor/cordis/src/fiber.ts',
  join(here, '../../../vendor/cordis/src/fiber.ts'),
].filter(Boolean)

/**
 * Find the cordis fiber source, or null when no checkout is available.
 *
 * @returns {string|null}
 */
function findCordisSource() {
  for (const candidate of CORDIS_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Parse the `FiberState` enum body out of cordis source text.
 *
 * Handles both `const enum` and plain `enum`, honouring explicit initializers.
 *
 * @param {string} source
 * @returns {{name: string, value: number}[]}
 */
export function parseFiberStateEnum(source) {
  const match = /export\s+(?:const\s+)?enum\s+FiberState\s*\{([\s\S]*?)\n\}/.exec(source)
  assert.ok(match, 'FiberState enum not found in cordis source — was it renamed or moved?')

  // Strip comments before parsing members.
  const cleaned = match[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  const members = []
  let auto = 0
  for (const raw of cleaned.split(',')) {
    const text = raw.trim()
    if (!text) continue
    const [namePart, valuePart] = text.split('=').map((part) => part.trim())
    if (!/^[A-Za-z_$][\w$]*$/.test(namePart)) continue
    const value = valuePart === undefined || valuePart === '' ? auto : Number(valuePart)
    assert.ok(Number.isInteger(value), `FiberState.${namePart} has a non-numeric initializer: ${valuePart}`)
    members.push({ name: namePart, value })
    auto = value + 1
  }
  return members
}

test('the mirror matches cordis source order and values', (t) => {
  const source = findCordisSource()
  if (!source) {
    // Honest skip: without the checkout this guard proves nothing, and a silent
    // pass would be exactly the false confidence the guard exists to prevent.
    t.skip('cordis source not found; set DSH_CORDIS_SOURCE to enable this guard')
    return
  }

  const members = parseFiberStateEnum(readFileSync(source, 'utf8'))
  assert.ok(members.length > 0, 'parsed no FiberState members')

  const expected = {}
  for (const member of members) expected[member.name] = member.value

  assert.deepEqual(
    { ...FiberState },
    expected,
    'FiberState mirror has drifted from cordis source; update src/fiber-state.mjs',
  )

  // Order matters as much as values: a reorder changes every derived label.
  assert.deepEqual(
    Object.keys(FiberState),
    members.map((member) => member.name),
    'FiberState member order differs from cordis source',
  )
})

test('every declared state has a readable name', () => {
  for (const [key, value] of Object.entries(FiberState)) {
    assert.equal(FIBER_STATE_NAMES[value], key, `no name mapped for ${key}`)
    assert.equal(fiberStateName(value), key)
  }
})

test('unknown states render as UNKNOWN rather than throwing', () => {
  assert.equal(fiberStateName(99), 'UNKNOWN(99)')
  assert.equal(fiberStateName(undefined), 'UNKNOWN(undefined)')
  assert.equal(fiberStateName('ACTIVE'), 'UNKNOWN(ACTIVE)')
})

test('the enum is recognised as a const enum (hence runtime-erased)', (t) => {
  const source = findCordisSource()
  if (!source) {
    t.skip('cordis source not found; set DSH_CORDIS_SOURCE to enable this guard')
    return
  }
  // Documents *why* the mirror exists. If cordis ever ships a runtime enum this
  // fails and tells the author to import it instead of mirroring.
  assert.match(
    readFileSync(source, 'utf8'),
    /export\s+const\s+enum\s+FiberState/,
    'cordis now exports a runtime FiberState enum — import it and delete the mirror',
  )
})
