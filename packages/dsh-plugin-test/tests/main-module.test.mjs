/**
 * `isMainModule` tests.
 *
 * The defect this guards against is the worst kind: when the comparison is wrong
 * the CLI does not error, it **skips `main()` and exits 0 with no output**. Found
 * by installing the package from a sibling directory, where npm creates a symlink
 * under `node_modules`, so `import.meta.url` (the real path) never equals
 * `pathToFileURL(argv[1])` (the link path).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { isMainModule } from '../src/main-module.mjs'

test('a directly-invoked script is the main module', () => {
  const url = pathToFileURL('D:/proj/bin/tool.mjs').href
  assert.equal(
    isMainModule(url, { argv: ['node', 'D:\\proj\\bin\\tool.mjs'], platform: 'win32' }),
    true,
  )
})

test('a script reached through a symlink is still the main module', () => {
  // This is the real case: npm symlinks a local dependency, so the entry path is
  // the LINK while import.meta.url is the REAL path.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mainmodule-'))
  try {
    const realDir = join(dir, 'real')
    const linkDir = join(dir, 'link')
    mkdirSync(realDir, { recursive: true })
    const realFile = join(realDir, 'tool.mjs')
    writeFileSync(realFile, '// tool\n', 'utf8')

    let linkFile
    try {
      symlinkSync(realDir, linkDir, 'junction')
      linkFile = join(linkDir, 'tool.mjs')
    } catch {
      // A platform that refuses to make the link cannot test this branch.
      return
    }

    // import.meta.url would be the REAL path; argv[1] is the LINK path.
    assert.equal(
      isMainModule(pathToFileURL(realFile).href, { argv: ['node', linkFile], platform: process.platform }),
      true,
      'the link path and the real path must be recognised as the same file',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an imported module is not the main module', () => {
  assert.equal(
    isMainModule(pathToFileURL('D:/proj/src/lib.mjs').href, {
      argv: ['node', 'D:\\proj\\bin\\tool.mjs'],
      platform: 'win32',
    }),
    false,
  )
})

test('case differences on Windows do not defeat the comparison', () => {
  assert.equal(
    isMainModule(pathToFileURL('D:/Proj/Bin/Tool.mjs').href, {
      argv: ['node', 'd:\\proj\\bin\\tool.mjs'],
      platform: 'win32',
    }),
    true,
  )
})

test('a missing argv[1] is never the main module', () => {
  const url = pathToFileURL('D:/proj/bin/tool.mjs').href
  assert.equal(isMainModule(url, { argv: ['node'], platform: 'win32' }), false)
  assert.equal(isMainModule(url, { argv: [], platform: 'win32' }), false)
})

test('a non-path entry does not throw', () => {
  // A CLI that dies while deciding whether to start is worse than one that starts.
  const url = pathToFileURL('D:/proj/bin/tool.mjs').href
  assert.doesNotThrow(() => isMainModule(url, { argv: ['node', ''], platform: 'win32' }))
  assert.equal(isMainModule(url, { argv: ['node', ''], platform: 'win32' }), false)
})

test('a file:// entry is accepted directly', () => {
  const url = pathToFileURL('D:/proj/bin/tool.mjs').href
  assert.equal(isMainModule(url, { argv: ['node', url], platform: 'win32' }), true)
})

test('a malformed module URL does not throw', () => {
  assert.doesNotThrow(() => isMainModule('not-a-url', { argv: ['node', 'x'], platform: 'win32' }))
})
