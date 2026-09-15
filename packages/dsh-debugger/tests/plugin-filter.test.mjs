/**
 * `/debug plugins` filtering.
 *
 * Measured on a real `web` composition: 201 plugins, 117 distinct names, and 45
 * rows rendering as an unidentifiable `apply (fiber N)`. The author's question is
 * "is MY plugin here and is it healthy?", which a 203-line unfiltered list does
 * not answer. These tests pin the filters and — just as important — that a
 * narrowed list says it is narrowed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { filterPlugins } from '../src/command.mjs'
import { renderPlugins } from '../src/render.mjs'

const PLUGINS = [
  { name: 'dsh-plugin-todoist', stateName: 'ACTIVE', uid: 20, inject: ['commands', 'storage'] },
  { name: 'apply', stateName: 'ACTIVE', uid: 21, inject: [] },
  { name: 'tool-todo', stateName: 'ACTIVE', uid: 189, inject: ['tools'] },
  { name: '(anonymous plugin)', stateName: 'PENDING', uid: 175, inject: ['authorization'] },
  { name: 'LlmRuntime', stateName: 'ACTIVE', uid: 40, inject: [] },
]

test('no filter returns everything', () => {
  assert.equal(filterPlugins(PLUGINS, {}).length, 5)
  assert.equal(filterPlugins(PLUGINS).length, 5)
})

test('--name matches a substring, case-insensitively', () => {
  const rows = filterPlugins(PLUGINS, { name: 'todoist' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'dsh-plugin-todoist')

  assert.equal(filterPlugins(PLUGINS, { name: 'TODO' }).length, 2)
})

test('--name does not match an unrecovered identity', () => {
  // `apply` is a fiber whose name could not be recovered; a name filter must not
  // pretend it matched.
  assert.equal(filterPlugins(PLUGINS, { name: 'todoist' }).some((p) => p.name === 'apply'), false)
})

test('--not-active returns only what is not ACTIVE', () => {
  const rows = filterPlugins(PLUGINS, { notActive: true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].stateName, 'PENDING')
})

test('--state selects one state', () => {
  assert.equal(filterPlugins(PLUGINS, { state: 'PENDING' }).length, 1)
  assert.equal(filterPlugins(PLUGINS, { state: 'ACTIVE' }).length, 4)
})

test('filters combine', () => {
  assert.equal(filterPlugins(PLUGINS, { state: 'ACTIVE', name: 'todo' }).length, 2)
  assert.equal(filterPlugins(PLUGINS, { state: 'PENDING', name: 'todoist' }).length, 0)
})

test('a malformed row does not throw the filter', () => {
  const messy = [null, {}, { name: 42, stateName: undefined }, ...PLUGINS]
  assert.doesNotThrow(() => filterPlugins(messy, { name: 'todoist' }))
  assert.equal(filterPlugins(messy, { name: 'todoist' }).length, 1)
})

test('a narrowed list announces that it is narrowed', () => {
  const filtered = filterPlugins(PLUGINS, { name: 'todoist' })
  const text = renderPlugins(
    { plugins: filtered, findings: [] },
    { filterNote: `showing ${filtered.length} of ${PLUGINS.length}` },
  )
  assert.match(text, /showing 1 of 5/)
  assert.match(text, /dsh-plugin-todoist/)
})

test('an unfiltered list carries no filter note', () => {
  const text = renderPlugins({ plugins: PLUGINS, findings: [] }, { filterNote: null })
  assert.doesNotMatch(text, /showing/)
})

test('an empty filter result is not reported as an empty composition', () => {
  // The author must not go hunting for a missing plugin when the real answer is
  // "your filter matched nothing".
  const text = renderPlugins(
    { plugins: [], findings: [], degraded: null },
    { filterNote: 'showing 0 of 5' },
  )
  assert.match(text, /no plugins match/)
  assert.match(text, /showing 0 of 5/)
  assert.doesNotMatch(text, /no plugins registered/)
})

test('the rendered rows keep state, name, fiber and inject', () => {
  const text = renderPlugins({ plugins: [PLUGINS[0]], findings: [] }, {})
  assert.match(text, /ACTIVE\s+dsh-plugin-todoist \(fiber 20\) inject=\[commands, storage\]/)
})
