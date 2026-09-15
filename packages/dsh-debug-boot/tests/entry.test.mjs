/**
 * Plugin-entry resolution tests.
 *
 * ## Trap 1 (璁捐鏂囨。 搂5)
 *
 * The overlay `name` must point at an entry FILE, never a directory. Node's ESM
 * `import()` cannot directory-import, and a directory produces the confusing
 * failure `Cannot find module '.../index.json'` 鈥?a file the author never wrote.
 *
 * These tests use an injected filesystem so each resolution path is exercised
 * without creating fixtures on disk for every case, plus a real-filesystem suite
 * at the end proving the same behaviour against actual files.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolvePluginEntry,
  assertEntryFile,
  looksLikeFile,
  toFileUrl,
  pickExportsRoot,
  ENTRY_CANDIDATES,
} from '../src/entry.mjs'

/**
 * Build a fake filesystem from a set of absolute paths.
 *
 * Paths are written POSIX-style for readability and translated to the host's
 * native form, because `resolvePluginEntry` uses `path.resolve`/`path.join`,
 * which are platform-native. Without the translation these tests would assert
 * POSIX behaviour against Windows semantics.
 *
 * @param {string[]} paths files that "exist"
 * @param {Record<string, unknown>} [json] manifest contents, by path
 */
function fakeFs(paths, json = {}) {
  const files = new Set(paths.map(seededKey))
  const dirs = new Set()
  for (const path of files) {
    let dir = path
    // Every ancestor directory of a known file implicitly exists.
    while (dir.includes('/') && dir !== '/') {
      dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
      dirs.add(dir)
    }
  }

  // Manifest keys are authored POSIX-style; index them the same way as files.
  const manifests = new Map()
  for (const [key, value] of Object.entries(json)) manifests.set(seededKey(key), value)

  const probe = (path) => probeKey(path)
  return {
    exists: (path) => files.has(probe(path)) || dirs.has(probe(path)),
    readFile: (path) => {
      const value = manifests.get(probe(path))
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return typeof value === 'string' ? value : JSON.stringify(value)
    },
    cwd: seededKey('/work'),
  }
}

/**
 * Normalize a fixture path authored POSIX-style into the host's native form.
 *
 * Only single-leading-slash paths are translated: a path the code under test has
 * already resolved (`D:\p`) must pass through untouched, or the drive prefix
 * would be applied twice.
 *
 * @param {string} path
 * @returns {string}
 */
function seededKey(path) {
  const text = String(path)
  if (process.platform === 'win32' && /^\/[^/]/.test(text)) return `D:${text}`
  return text
}

/**
 * Normalize any path (fixture or already-resolved) into one comparable key.
 *
 * @param {string} path
 * @returns {string}
 */
function probeKey(path) {
  return normalize(seededKey(path))
}

/**
 * Assert a resolved path equals a POSIX-style fixture expectation.
 *
 * Resolution is platform-native, so the expectation is translated the same way
 * the fixture is; otherwise every assertion would encode the host it was written
 * on.
 *
 * @param {string|null} actual
 * @param {string} expectedFixturePath POSIX-style, e.g. `/p/index.mjs`
 */
function expectPath(actual, expectedFixturePath) {
  assert.equal(probeKey(actual), probeKey(expectedFixturePath))
}

/** Collapse separators so comparisons are platform-independent. */
function normalize(path) {
  return String(path).replace(/\\/g, '/').replace(/\/+/g, '/')
}

// ------------------------------------------------- directory -> file (trap 1) --

test('a directory resolves to index.mjs when present', () => {
  const fs = fakeFs(['/p/index.mjs', '/p/other.js'])
  const result = resolvePluginEntry('/p', fs)

  assert.equal(result.ok, true)
  expectPath(result.entry, '/p/index.mjs')
  assert.equal(result.resolvedFrom, 'index.mjs')
})

test('a directory resolves to index.js when index.mjs is absent', () => {
  const fs = fakeFs(['/p/index.js'])
  const result = resolvePluginEntry('/p', fs)

  assert.equal(result.ok, true)
  expectPath(result.entry, '/p/index.js')
  assert.equal(result.resolvedFrom, 'index.js')
})

test('index.mjs wins over index.js when both exist', () => {
  const fs = fakeFs(['/p/index.mjs', '/p/index.js'])
  expectPath(resolvePluginEntry('/p', fs).entry, '/p/index.mjs')
})

test('a directory falls back to package.json main', () => {
  const fs = fakeFs(['/p/package.json', '/p/dist/plugin.js'], {
    '/p/package.json': { name: 'p', main: './dist/plugin.js' },
  })
  const result = resolvePluginEntry('/p', fs)

  assert.equal(result.ok, true)
  expectPath(result.entry, '/p/dist/plugin.js')
  assert.equal(result.resolvedFrom, 'main')
})

test('a directory falls back to package.json module', () => {
  const fs = fakeFs(['/p/package.json', '/p/dist/plugin.mjs'], {
    '/p/package.json': { name: 'p', module: './dist/plugin.mjs' },
  })
  const result = resolvePluginEntry('/p', fs)

  assert.equal(result.ok, true)
  expectPath(result.entry, '/p/dist/plugin.mjs')
  assert.equal(result.resolvedFrom, 'module')
})

test('a sibling index.mjs is preferred over a package.json main', () => {
  // A `main` pointing at a build artifact that does not exist yet must not
  // shadow a perfectly good sibling index.mjs.
  const fs = fakeFs(['/p/index.mjs', '/p/package.json'], {
    '/p/package.json': { name: 'p', main: './dist/missing.js' },
  })
  expectPath(resolvePluginEntry('/p', fs).entry, '/p/index.mjs')
})

test('a package.json exports["."] resolves to a file', () => {
  const fs = fakeFs(['/p/package.json', '/p/lib/entry.mjs'], {
    '/p/package.json': { name: 'p', exports: { '.': './lib/entry.mjs' } },
  })
  const result = resolvePluginEntry('/p', fs)

  assert.equal(result.ok, true)
  expectPath(result.entry, '/p/lib/entry.mjs')
  assert.equal(result.resolvedFrom, 'exports["."]')
})

test('a conditional exports["."] resolves through import first', () => {
  const fs = fakeFs(['/p/package.json', '/p/lib/entry.mjs'], {
    '/p/package.json': {
      name: 'p',
      exports: { '.': { types: './lib/entry.d.ts', import: './lib/entry.mjs' } },
    },
  })
  expectPath(resolvePluginEntry('/p', fs).entry, '/p/lib/entry.mjs')
})

test('a wildcard export is not treated as a concrete entry', () => {
  const fs = fakeFs(['/p/package.json'], {
    '/p/package.json': { name: 'p', exports: { './*': './src/*.mjs' } },
  })
  const result = resolvePluginEntry('/p', fs)
  assert.equal(result.ok, false)
  assert.match(result.reason, /no entry file found/)
})

test('a directory with no entry at all fails with every candidate listed', () => {
  const fs = fakeFs(['/p/README.md'])
  const result = resolvePluginEntry('/p', fs)

  assert.equal(result.ok, false)
  assert.match(result.reason, /no entry file found/)
  // The error must name what was tried, so the author can see the gap.
  for (const name of ENTRY_CANDIDATES) {
    assert.ok(
      result.candidates.some((c) => c.endsWith(name)),
      `candidates should include ${name}`,
    )
  }
})

test('a direct file path is accepted unchanged', () => {
  const fs = fakeFs(['/p/plugin.mjs'])
  const result = resolvePluginEntry('/p/plugin.mjs', fs)

  assert.equal(result.ok, true)
  expectPath(result.entry, '/p/plugin.mjs')
  assert.equal(result.resolvedFrom, 'direct file')
})

test('a missing direct file fails with a clear reason', () => {
  const result = resolvePluginEntry('/p/nope.mjs', fakeFs([]))
  assert.equal(result.ok, false)
  assert.match(result.reason, /does not exist/)
})

test('a missing directory fails with a clear reason', () => {
  const result = resolvePluginEntry('/p', fakeFs([]))
  assert.equal(result.ok, false)
  assert.match(result.reason, /does not exist/)
})

test('a relative path resolves against cwd', () => {
  const fs = fakeFs(['/work/plugins/demo/index.mjs'])
  const result = resolvePluginEntry('plugins/demo', fs)

  assert.equal(result.ok, true)
  expectPath(result.entry, '/work/plugins/demo/index.mjs')
})

test('an empty or missing plugin path fails rather than defaulting', () => {
  assert.equal(resolvePluginEntry('', fakeFs([])).ok, false)
  assert.equal(resolvePluginEntry(null, fakeFs([])).ok, false)
  assert.equal(resolvePluginEntry(undefined, fakeFs([])).ok, false)
})

test('an unreadable package.json is reported, not thrown', () => {
  // Only the manifest and its directory exist; the manifest is corrupt.
  const dir = probeKey('/p')
  const manifest = probeKey('/p/package.json')
  const fs = {
    exists: (p) => {
      const key = probeKey(p)
      return key === dir || key === manifest
    },
    readFile: () => '{ not json',
    cwd: probeKey('/work'),
  }
  const result = resolvePluginEntry('/p', fs)
  assert.equal(result.ok, false)
  assert.match(result.reason, /unreadable package\.json/)
})

// -------------------------------------------------------------- assertEntryFile --

test('assertEntryFile rejects a directory-shaped path (trap 1)', () => {
  // No extension and not a known file: this is the exact value that must never
  // reach an overlay, because ESM import() would fail on it.
  assert.throws(
    () => assertEntryFile('/p/my-plugin'),
    /must point at a file, not a directory/,
  )
})

test('assertEntryFile rejects a path with a trailing separator', () => {
  assert.throws(() => assertEntryFile('/p/my-plugin/'), /must point at a file/)
  assert.throws(() => assertEntryFile('D:\\mods\\thing\\'), /must point at a file/)
})

test('assertEntryFile rejects an empty value', () => {
  assert.throws(() => assertEntryFile(''), /non-empty file path/)
  assert.throws(() => assertEntryFile(null), /non-empty file path/)
})

test('assertEntryFile rejects a missing file', () => {
  assert.throws(
    () => assertEntryFile('/p/gone.mjs', { exists: () => false }),
    /does not exist/,
  )
})

test('assertEntryFile accepts a real file and returns it', () => {
  const entry = assertEntryFile('/p/plugin.mjs', { exists: () => true })
  expectPath(entry, '/p/plugin.mjs')
})

test('the emitted entry is never a bare directory for any accepted input', () => {
  const fs = fakeFs(['/p/index.mjs', '/q/index.js', '/r/package.json', '/r/main.js'], {
    '/r/package.json': { name: 'r', main: './main.js' },
  })

  for (const input of ['/p', '/q', '/r', '/p/index.mjs']) {
    const result = resolvePluginEntry(input, fs)
    assert.equal(result.ok, true, `${input} should resolve`)
    // The invariant 璁捐鏂囨。 搂5 exists to protect.
    assert.ok(looksLikeFile(result.entry), `${input} resolved to a directory: ${result.entry}`)
    assert.doesNotThrow(() => assertEntryFile(result.entry, { exists: () => true }))
  }
})

// ------------------------------------------------------------------ looksLikeFile --

test('looksLikeFile distinguishes files from directories', () => {
  assert.equal(looksLikeFile('/p/index.mjs'), true)
  assert.equal(looksLikeFile('/p/index.js'), true)
  assert.equal(looksLikeFile('D:\\mods\\thing\\index.mjs'), true)
  assert.equal(looksLikeFile('D:\\mods\\thing'), false)
  assert.equal(looksLikeFile('D:\\mods\\thing\\'), false)
  assert.equal(looksLikeFile('/p/.hidden'), false)
  assert.equal(looksLikeFile(''), false)
})

// -------------------------------------------------------- trap 2: file:// URLs --

test('a Windows path becomes a valid file:// URL (trap 2)', () => {
  const url = toFileUrl('D:\\Grok\\DSH_debugger\\index.mjs')

  // The naive `'file://' + path` produces `file://D:\Grok\...`, which is not a
  // URL: backslashes, a drive letter in the authority position, no encoding.
  assert.equal(url, 'file:///D:/Grok/DSH_debugger/index.mjs')
  assert.ok(url.startsWith('file:///'), 'Windows URLs need three slashes')
  assert.doesNotMatch(url, /\\/, 'a URL must not contain backslashes')
  assert.equal(new URL(url).protocol, 'file:')
  assert.equal(new URL(url).pathname, '/D:/Grok/DSH_debugger/index.mjs')
})

test('a Windows path with spaces is percent-encoded', () => {
  const url = toFileUrl('D:\\My Mods\\my plugin\\index.mjs')
  assert.doesNotMatch(url, / /)
  assert.match(url, /%20/)
  assert.equal(new URL(url).pathname, '/D:/My%20Mods/my%20plugin/index.mjs')
})

test('a POSIX path becomes a valid file:// URL', () => {
  const url = toFileUrl('/home/dev/plugin/index.mjs')
  if (process.platform === 'win32') {
    // On Windows a leading `/` is drive-relative, so Node resolves it against the
    // current drive. Documenting that here keeps this test honest on both hosts
    // rather than asserting POSIX behaviour the platform does not have.
    assert.equal(url, 'file:///D:/home/dev/plugin/index.mjs')
  } else {
    assert.equal(url, 'file:///home/dev/plugin/index.mjs')
  }
  assert.ok(url.startsWith('file:///'))
  assert.doesNotMatch(url, /\\/)
})

test('a Windows path with a drive letter survives a URL round trip', () => {
  const original = 'D:\\a\\b c\\index.mjs'
  const url = toFileUrl(original)
  // `fileURLToPath` is Node's inverse of `pathToFileURL`; parsing back proves
  // the URL is valid enough for Node itself to consume.
  assert.equal(normalize(fileURLToPath(url)), normalize(original))
})

// ----------------------------------------------------------- pickExportsRoot --

test('pickExportsRoot handles the string form', () => {
  assert.equal(pickExportsRoot('./index.mjs'), './index.mjs')
})

test('pickExportsRoot handles the root-key object form', () => {
  assert.equal(pickExportsRoot({ '.': './index.mjs' }), './index.mjs')
})

test('pickExportsRoot handles a bare condition map', () => {
  assert.equal(pickExportsRoot({ import: './a.mjs', require: './b.cjs' }), './a.mjs')
})

test('pickExportsRoot prefers import over require', () => {
  assert.equal(pickExportsRoot({ '.': { require: './b.cjs', import: './a.mjs' } }), './a.mjs')
})

test('pickExportsRoot returns null for absent or unusable values', () => {
  assert.equal(pickExportsRoot(undefined), null)
  assert.equal(pickExportsRoot(null), null)
  assert.equal(pickExportsRoot({ '.': {} }), null)
})

// ------------------------------------------------------ real filesystem suite --

test('resolution works against real files on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-entry-'))
  try {
    const dir = join(root, 'my-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.mjs'), 'export const name = "my-plugin"\n')

    const result = resolvePluginEntry(dir)
    assert.equal(result.ok, true)
    assert.equal(result.entry, join(dir, 'index.mjs'))
    assert.equal(result.resolvedFrom, 'index.mjs')

    // The value that would reach the overlay is a file, verifiably.
    assert.doesNotThrow(() => assertEntryFile(result.entry))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a real directory with no entry is rejected without touching the loader', () => {
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-entry-'))
  try {
    const dir = join(root, 'empty-plugin')
    mkdirSync(dir, { recursive: true })

    const result = resolvePluginEntry(dir)
    assert.equal(result.ok, false)
    assert.match(result.reason, /no entry file found/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('assertEntryFile rejects a real directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-entry-'))
  try {
    // A directory with a dot in its name must still be rejected: the extension
    // heuristic alone would not catch it, so the stat check must.
    const dir = join(root, 'plugin.d')
    mkdirSync(dir, { recursive: true })

    assert.throws(() => assertEntryFile(dir), /not a regular file|must point at a file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
