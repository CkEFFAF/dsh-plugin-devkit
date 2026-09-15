/**
 * Overlay-generation tests.
 *
 * The overlay format is not a guess: it is the shape shipped in
 * `packages/experimental/inspector/cordis.patch.yml` 鈥?a top-level array of
 * patch entries, with `- insert:` holding rows of `{id, name, config}`. These
 * tests pin that shape so a change to the generator cannot silently emit
 * something the DSH loader would reject.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOverlayRows,
  renderOverlay,
  yamlScalar,
  derivePluginId,
  sanitizeId,
  DEBUGGER_ID,
  DEFAULT_PLUGIN_ID,
} from '../src/overlay.mjs'

/** An entry that passes `assertEntryFile` without touching the disk. */
const FILE = 'D:\\mods\\my-plugin\\index.mjs'
const ANY = () => true
const KERNEL = 'D:\\DSH_workspace\\dsh-plugin-devkit-pack\\packages\\dsh-debugger\\index.mjs'

test('rows are a top-level array of patch entries', () => {
  const rows = buildOverlayRows({ pluginEntry: FILE, debuggerEntry: KERNEL, exists: ANY })
  assert.ok(Array.isArray(rows))
  assert.equal(rows.length, 1)
  assert.ok(Array.isArray(rows[0].insert))
})

test('the insert list carries the plugin first, then the kernel', () => {
  const rows = buildOverlayRows({ pluginEntry: FILE, pluginId: 'my-plugin', debuggerEntry: KERNEL, exists: ANY })
  const [plugin, kernel] = rows[0].insert

  assert.equal(plugin.id, 'my-plugin')
  assert.equal(plugin.name, FILE)
  assert.equal(kernel.id, DEBUGGER_ID)
  assert.equal(kernel.name, KERNEL)
})

test('the kernel row is configurable and announces itself', () => {
  const rows = buildOverlayRows({ debuggerEntry: KERNEL, exists: ANY })
  // `announce` is what makes the readiness banner appear, which the boot output
  // promises the user.
  assert.deepEqual(rows[0].insert[0].config, { announce: true })
})

test('the kernel row can be excluded', () => {
  const rows = buildOverlayRows({ pluginEntry: FILE, debuggerEntry: null, includeDebugger: false, exists: ANY })
  assert.equal(rows[0].insert.length, 1)
  assert.equal(rows[0].insert[0].id, DEFAULT_PLUGIN_ID)
})

test('a kernel-only overlay is valid', () => {
  const rows = buildOverlayRows({ debuggerEntry: KERNEL, includeDebugger: true, exists: ANY })
  assert.equal(rows[0].insert.length, 1)
  assert.equal(rows[0].insert[0].id, DEBUGGER_ID)
})

test('no entries means no patch rows at all', () => {
  assert.deepEqual(buildOverlayRows({}), [])
})

// A real boot exposed this: `derivePluginId` and `buildOverlayRows` were each
// tested, but never *composed*. Feeding the derived id back in is what makes the
// collision visible, and cordis refuses the whole tree when it happens.
test('debugging the kernel itself does not emit a duplicate entry id', () => {
  const derived = derivePluginId(KERNEL)
  // The precondition that makes this a real risk, not a hypothetical one.
  assert.equal(derived, DEBUGGER_ID)

  const rows = buildOverlayRows({
    pluginEntry: KERNEL,
    pluginId: derived,
    debuggerEntry: KERNEL,
    includeDebugger: true,
    exists: ANY,
  })

  const ids = rows[0].insert.map((row) => row.id)
  assert.equal(ids.length, 1, `expected one row, got ${JSON.stringify(ids)}`)
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique: cordis rejects duplicates')
  assert.equal(ids[0], DEBUGGER_ID)
})

test('debugging the kernel itself still announces', () => {
  const rows = buildOverlayRows({
    pluginEntry: KERNEL,
    pluginId: derivePluginId(KERNEL),
    debuggerEntry: KERNEL,
    includeDebugger: true,
    exists: ANY,
  })
  // Folding the rows must not silently drop the readiness banner.
  assert.deepEqual(rows[0].insert[0].config, { announce: true })
})

test('derived ids never collide with the kernel id across mount forms', () => {
  // Every way `--plugin` can name a plugin, run through the real derivation and
  // then into the real builder, asserting the emitted ids stay unique.
  for (const file of [
    'D:\\mods\\my-plugin\\index.mjs',
    'D:\\mods\\dsh-debugger\\index.mjs',
    'D:\\mods\\dsh-debugger\\main.mjs',
    'D:\\mods\\my-plugin\\entry.mjs',
  ]) {
    const rows = buildOverlayRows({
      pluginEntry: file,
      pluginId: derivePluginId(file),
      debuggerEntry: KERNEL,
      includeDebugger: true,
      exists: ANY,
    })
    const ids = rows[0].insert.map((row) => row.id)
    assert.equal(new Set(ids).size, ids.length, `duplicate ids for ${file}: ${JSON.stringify(ids)}`)
  }
})

test('a directory entry is refused when building rows (trap 1)', () => {
  // This is the enforcement point: a directory can never reach `name`.
  assert.throws(
    () => buildOverlayRows({ pluginEntry: 'D:\\mods\\my-plugin' }),
    /must point at a file, not a directory/,
  )
})

test('a directory kernel entry is refused too', () => {
  assert.throws(
    () => buildOverlayRows({ debuggerEntry: 'D:\\kernel-dir' }),
    /must point at a file/,
  )
})

test('plugin config is carried when provided', () => {
  const rows = buildOverlayRows({ pluginEntry: FILE, pluginConfig: { capacity: 50 }, exists: ANY })
  assert.deepEqual(rows[0].insert[0].config, { capacity: 50 })
})

test('rendered YAML has the shipped insert shape', () => {
  const yaml = renderOverlay(buildOverlayRows({
    pluginEntry: FILE,
    pluginId: 'my-plugin',
    debuggerEntry: KERNEL,
    exists: ANY,
  }))

  // Exactly the indentation the shipped overlay uses. Values are quoted, which
  // is valid YAML and sidesteps every scalar hazard a Windows path introduces.
  assert.match(yaml, /^- insert:$/m)
  assert.match(yaml, /^ {4}- id: 'my-plugin'$/m)
  assert.match(yaml, /^ {6}name: /m)
  assert.match(yaml, /^ {4}- id: 'dsh-debugger'$/m)
})

test('rendered YAML quotes Windows paths so they stay scalars', () => {
  const yaml = renderOverlay(buildOverlayRows({ pluginEntry: FILE, exists: ANY }))
  // A backslash and a colon in an unquoted YAML scalar is a parse hazard.
  assert.match(yaml, new RegExp(`name: '${FILE.replace(/\\/g, '\\\\')}'`))
})

test('rendered YAML is parseable as the loader expects', () => {
  const yaml = renderOverlay(buildOverlayRows({ pluginEntry: FILE, debuggerEntry: KERNEL, exists: ANY }))
  // Every non-comment, non-blank line must belong to the insert structure.
  for (const line of yaml.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    assert.match(line, /^- insert:$|^ {4}- id: |^ {6}(name|config):|^ {8}\w+: /, `unexpected line: ${line}`)
  }
})

test('rendered YAML ends with a newline', () => {
  assert.ok(renderOverlay(buildOverlayRows({ pluginEntry: FILE, exists: ANY })).endsWith('\n'))
})

test('rendered YAML explains why names are absolute', () => {
  const yaml = renderOverlay(buildOverlayRows({ pluginEntry: FILE, exists: ANY }))
  assert.match(yaml, /anchored/)
  assert.match(yaml, /directory-import/)
})

test('yamlScalar quotes strings and leaves literals bare', () => {
  assert.equal(yamlScalar('D:\\a\\b.mjs'), "'D:\\a\\b.mjs'")
  assert.equal(yamlScalar(true), 'true')
  assert.equal(yamlScalar(false), 'false')
  assert.equal(yamlScalar(42), '42')
})

test('yamlScalar escapes an embedded single quote', () => {
  assert.equal(yamlScalar("it's"), "'it''s'")
})

// ------------------------------------------------------------------- ids --

test('a plugin id is derived from a named entry file', () => {
  // A distinctly named entry file names the plugin better than its directory.
  assert.equal(derivePluginId('D:\\mods\\some-dir\\my-plugin.mjs'), 'my-plugin')
  assert.equal(derivePluginId('/home/dev/some-dir/cool-thing.js'), 'cool-thing')
})

test('index/main fall back to the directory name', () => {
  // These filenames describe the file, not the plugin, so the directory wins.
  assert.equal(derivePluginId('D:\\mods\\my-plugin\\index.mjs'), 'my-plugin')
  assert.equal(derivePluginId('/home/dev/cool-thing/main.js'), 'cool-thing')
})

test('a derived id is loader-safe', () => {
  const id = derivePluginId('D:\\My Mods\\Cool Plugin!\\index.mjs')
  assert.match(id, /^[a-z0-9._-]+$/)
})

test('an underivable id falls back to the documented default', () => {
  assert.equal(derivePluginId('index.mjs'), DEFAULT_PLUGIN_ID)
})

test('sanitizeId normalizes separators and case', () => {
  assert.equal(sanitizeId('My Plugin'), 'my-plugin')
  assert.equal(sanitizeId('  spaced  '), 'spaced')
  assert.equal(sanitizeId('a/b'), 'a-b')
  assert.equal(sanitizeId(''), DEFAULT_PLUGIN_ID)
  assert.equal(sanitizeId('!!!'), DEFAULT_PLUGIN_ID)
})

test('the debugger id matches the plugin name it mounts', () => {
  // `dsh-debugger` is the `name` exported by packages/dsh-debugger/index.mjs.
  assert.equal(DEBUGGER_ID, 'dsh-debugger')
})
