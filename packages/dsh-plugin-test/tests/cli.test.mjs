/**
 * `dsh-plugin-test` CLI tests.
 *
 * The CLI's job is to build a host, **mount the plugin under test on it**, run
 * the author's cases, and print a report. It used to build the host and mount
 * only the debugger, so no case could reach the author's own service — every
 * case failed with the same unhelpful message and there was no way to tell why.
 * These tests pin the mounting behaviour and the resolution order.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { runModule, parseArgs, EXIT } from '../bin/plugin-test.mjs'

/** A throwaway project directory with a plugin and a case module. */
function makeProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugin-test-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
  return dir
}

const PLUGIN = `
export const name = 'demo-plugin'
export function apply(ctx) {
  const api = { ping: () => 'pong' }
  ctx.provide('demo', api)
  return api
}
`

test('the CLI mounts the plugin exported by the test module', async () => {
  const dir = makeProject({
    'plugin.mjs': PLUGIN,
    'cases.mjs': `
import { apply } from './plugin.mjs'
export const plugin = { name: 'demo-plugin', apply }
export const cases = [
  {
    name: 'the plugin service is reachable',
    run: ({ ctx, plugin: mounted }) => {
      if (!ctx.get('demo')) throw new Error('the plugin was not mounted')
      if (mounted.ping() !== 'pong') throw new Error('wrong API')
    },
  },
]
`,
  })
  try {
    const report = await runModule(join(dir, 'cases.mjs'))
    assert.equal(report.cases[0].ok, true, report.cases[0].message)
    assert.equal(report.plugin.mounted, true)
    assert.equal(report.plugin.module, 'demo-plugin')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--plugin loads the plugin from a path', async () => {
  const dir = makeProject({
    'my-plugin/index.mjs': PLUGIN,
    'cases.mjs': `
export const cases = [
  {
    name: 'reaches the plugin through --plugin',
    run: ({ ctx }) => { if (!ctx.get('demo')) throw new Error('not mounted') },
  },
]
`,
  })
  try {
    const report = await runModule(join(dir, 'cases.mjs'), {
      plugin: join(dir, 'my-plugin'),
      cwd: dir,
    })
    assert.equal(report.cases[0].ok, true, report.cases[0].message)
    assert.match(report.plugin.source, /--plugin/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the plugin is found from the package.json beside the test module', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'demo', main: 'index.mjs' }),
    'index.mjs': PLUGIN,
    'tests/cases.mjs': `
export const cases = [
  {
    name: 'found via package.json',
    run: ({ ctx }) => { if (!ctx.get('demo')) throw new Error('not mounted') },
  },
]
`,
  })
  try {
    const report = await runModule(join(dir, 'tests/cases.mjs'))
    assert.equal(report.cases[0].ok, true, report.cases[0].message)
    assert.match(report.plugin.source, /package\.json/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a run with no plugin under test fails instead of passing silently', async () => {
  const dir = makeProject({
    // No package.json, no exported plugin, no --plugin.
    'cases.mjs': `export const cases = [{ name: 'x', run: () => {} }]`,
  })
  try {
    await assert.rejects(
      () => runModule(join(dir, 'cases.mjs')),
      (error) => {
        assert.equal(error.code, 'NO_PLUGIN')
        // The hints must tell the author how to fix it.
        assert.ok(error.hints.some((h) => h.includes('--plugin')), 'hints must mention --plugin')
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bad --plugin path fails loudly rather than falling back', async () => {
  // Silent fallback would be the same class of defect the mount fix removes: a
  // typo'd path that still reports green.
  const dir = makeProject({
    'plugin.mjs': PLUGIN,
    'cases.mjs': `
import { apply } from './plugin.mjs'
export const plugin = { name: 'demo-plugin', apply }
export const cases = [{ name: 'x', run: () => {} }]
`,
  })
  try {
    await assert.rejects(
      () => runModule(join(dir, 'cases.mjs'), { plugin: './does-not-exist', cwd: dir }),
      (error) => {
        assert.equal(error.code, 'NO_PLUGIN')
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a plugin that throws on mount is reported, not crashed on', async () => {
  const dir = makeProject({
    'cases.mjs': `
export const plugin = {
  name: 'exploding',
  apply() { throw new Error('apply blew up') },
}
export const cases = [{ name: 'still runs', run: () => {} }]
`,
  })
  try {
    const report = await runModule(join(dir, 'cases.mjs'))
    assert.equal(report.plugin.mounted, false)
    assert.match(report.plugin.error, /apply blew up/)
    // A failed mount must not read as a clean pass.
    assert.equal(report.ok, false)
    // The case is still usable: it can assert on the mount error itself.
    assert.equal(report.cases.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the run object carries plugin and pluginError', async () => {
  const dir = makeProject({
    'plugin.mjs': PLUGIN,
    'cases.mjs': `
import { apply } from './plugin.mjs'
export const plugin = { name: 'demo-plugin', apply }
export const cases = [
  {
    name: 'sees plugin and pluginError',
    run: (run) => {
      if (!('plugin' in run)) throw new Error('run has no plugin')
      if (!('pluginError' in run)) throw new Error('run has no pluginError')
      if (run.pluginError !== null) throw new Error('pluginError should be null on success')
    },
  },
]
`,
  })
  try {
    const report = await runModule(join(dir, 'cases.mjs'))
    assert.equal(report.cases[0].ok, true, report.cases[0].message)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------- parseArgs --

test('--plugin is parsed', () => {
  assert.equal(parseArgs(['a.mjs', '--plugin', './p']).plugin, './p')
  assert.equal(parseArgs(['a.mjs']).plugin, null)
})

test('exit codes are unchanged', () => {
  assert.deepEqual(EXIT, { OK: 0, FAILED: 1, USAGE: 2, LOAD: 3 })
})
