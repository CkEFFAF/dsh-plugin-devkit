/**
 * Resolve a plugin path to a concrete entry FILE.
 *
 * ## Trap 1: Node ESM cannot directory-import
 *
 * 设计文档 §5 calls this out explicitly. The DSH loader mounts overlay rows with
 * a bare ESM `import()`, and Node's ESM resolver does not perform CommonJS-style
 * directory resolution: pointing an overlay `name` at a directory fails with
 * `Cannot find module '.../index.json'` — a confusing error that names a file the
 * author never wrote.
 *
 * `dsh-repository-plugin` can accept a directory because it reads
 * `package.json#dsh.entry` itself and then imports the concrete file. A raw
 * loader entry has no such wrapper, so an overlay must always name a file.
 *
 * Therefore `--plugin <dir>` is resolved to a real file here, and the value that
 * reaches the overlay is guaranteed to be a file path. `assertEntryFile` is the
 * enforcement point; `tests/entry.test.mjs` pins it.
 *
 * Resolution order for a directory:
 *   1. `index.mjs`         — the convention this DevKit's own packages use
 *   2. `index.js`          — the convention the inspector overlay uses
 *   3. `package.json` main / module / exports["."]
 *
 * `package.json` is consulted last on purpose: a package whose `main` points at
 * a TypeScript source or a build artifact that does not exist yet would otherwise
 * shadow a perfectly good sibling `index.mjs`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Entry filenames tried, in order, when handed a directory. */
export const ENTRY_CANDIDATES = ['index.mjs', 'index.js', 'index.cjs', 'main.mjs', 'main.js']

/** Module specifier fields inside `package.json`, in preference order. */
const PACKAGE_ENTRY_FIELDS = ['module', 'main']

/**
 * Resolve a caller-supplied plugin path to an absolute entry file.
 *
 * @param {string} input a directory or a file, absolute or relative
 * @param {{cwd?: string, exists?: (path: string) => boolean, readFile?: (path: string) => string}} [deps]
 *   injectable for tests; the defaults hit the real filesystem
 * @returns {{
 *   ok: boolean, entry: string|null, input: string, resolvedFrom: string|null,
 *   candidates: string[], reason: string|null
 * }}
 */
export function resolvePluginEntry(input, deps = {}) {
  const exists = deps.exists ?? defaultExists
  const readFile = deps.readFile ?? defaultReadFile
  const cwd = deps.cwd ?? process.cwd()
  const candidates = []

  if (typeof input !== 'string' || input.trim() === '') {
    return failure(input, candidates, 'no plugin path was given')
  }

  const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input)

  // A file was named directly: accept it as-is, but still verify it exists so
  // the failure is reported here rather than as a loader stack trace later.
  if (looksLikeFile(absolute)) {
    if (!exists(absolute)) {
      return failure(input, candidates, `entry file does not exist: ${absolute}`)
    }
    return {
      ok: true,
      entry: absolute,
      input,
      resolvedFrom: 'direct file',
      candidates,
      reason: null,
    }
  }

  if (!exists(absolute)) {
    return failure(input, candidates, `plugin path does not exist: ${absolute}`)
  }

  if (!isDirectory(absolute, deps, exists)) {
    // Neither a recognised file nor a directory: refuse rather than guess.
    return failure(input, candidates, `plugin path is not a file or directory: ${absolute}`)
  }

  // 1 & 2: well-known sibling entry filenames.
  for (const name of ENTRY_CANDIDATES) {
    const candidate = join(absolute, name)
    candidates.push(candidate)
    if (exists(candidate) && isFile(candidate, deps, exists)) {
      return { ok: true, entry: candidate, input, resolvedFrom: name, candidates, reason: null }
    }
  }

  // 3: the package manifest.
  const manifestPath = join(absolute, 'package.json')
  candidates.push(manifestPath)
  if (exists(manifestPath)) {
    const fromManifest = resolveFromManifest(absolute, manifestPath, readFile, exists, candidates)
    if (fromManifest.entry) {
      return {
        ok: true,
        entry: fromManifest.entry,
        input,
        resolvedFrom: fromManifest.field,
        candidates,
        reason: null,
      }
    }
    if (fromManifest.reason) {
      return failure(input, candidates, fromManifest.reason)
    }
  }

  return failure(
    input,
    candidates,
    `no entry file found in ${absolute} (tried ${ENTRY_CANDIDATES.join(', ')} and package.json)`,
  )
}

/**
 * Read a `package.json` and resolve its declared entry to a real file.
 *
 * @param {string} dir
 * @param {string} manifestPath
 * @param {(path: string) => string} readFile
 * @param {(path: string) => boolean} exists
 * @param {string[]} candidates accumulator
 * @returns {{entry: string|null, field: string|null, reason: string|null}}
 */
function resolveFromManifest(dir, manifestPath, readFile, exists, candidates) {
  let manifest
  try {
    manifest = JSON.parse(readFile(manifestPath))
  } catch (error) {
    return { entry: null, field: null, reason: `unreadable package.json at ${manifestPath}: ${error.message}` }
  }

  const declared = []

  // `exports["."]` wins when it names a concrete file, because it is what Node
  // itself would resolve for a bare import of this package.
  const exported = pickExportsRoot(manifest.exports)
  if (exported) declared.push({ field: 'exports["."]', value: exported })

  for (const field of PACKAGE_ENTRY_FIELDS) {
    if (typeof manifest[field] === 'string' && manifest[field]) {
      declared.push({ field, value: manifest[field] })
    }
  }

  for (const { field, value } of declared) {
    // A wildcard export (`./*`) is not a concrete entry.
    if (value.includes('*')) continue
    if (looksLikeFile(value) === false && !extname(value)) continue

    const candidate = isAbsolute(value) ? resolve(value) : resolve(dir, value)
    candidates.push(candidate)
    if (exists(candidate) && isFile(candidate, undefined, exists)) {
      return { entry: candidate, field, reason: null }
    }
  }

  return { entry: null, field: null, reason: null }
}

/**
 * Extract a concrete root target from a `package.json#exports` value.
 *
 * Handles the bare-string form and the conditional-object form Node supports.
 *
 * @param {unknown} exports
 * @returns {string|null}
 */
export function pickExportsRoot(exports) {
  if (!exports) return null
  if (typeof exports === 'string') return exports

  if (typeof exports === 'object') {
    // Either `{ ".": ... }` or a bare condition map like `{ import: "./x.mjs" }`.
    const root = Object.hasOwn(exports, '.') ? exports['.'] : exports
    return pickCondition(root)
  }
  return null
}

/**
 * Walk a conditional export object to the first concrete string.
 *
 * Preference order follows Node's own resolution for an `import` in an ESM
 * package, then falls back to the remaining conditions.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function pickCondition(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null

  const order = ['import', 'module', 'default', 'require', 'node']
  for (const key of order) {
    if (Object.hasOwn(value, key)) {
      const picked = pickCondition(value[key])
      if (picked) return picked
    }
  }
  for (const key of Object.keys(value)) {
    if (key === 'types' || key === 'typings') continue
    const picked = pickCondition(value[key])
    if (picked) return picked
  }
  return null
}

/**
 * Throw unless a resolved entry is a real file.
 *
 * The overlay writer calls this so a directory can never reach the emitted
 * `name` — the failure mode 设计文档 §5 exists to prevent.
 *
 * @param {string} entry
 * @param {{exists?: (path: string) => boolean, stat?: (path: string) => {isFile: () => boolean}}} [deps]
 * @returns {string} the entry, for chaining
 */
export function assertEntryFile(entry, deps = {}) {
  const exists = deps.exists ?? defaultExists

  if (typeof entry !== 'string' || entry.trim() === '') {
    throw new Error('overlay entry must be a non-empty file path')
  }

  // The primary guarantee does not depend on the filesystem: a path with no
  // extension is treated as a directory reference and rejected outright.
  if (!looksLikeFile(entry)) {
    throw new Error(
      `overlay entry must point at a file, not a directory: ${entry}\n` +
      "Node's ESM import() cannot directory-import; name index.mjs, index.js, or the package main.",
    )
  }

  if (!exists(entry)) {
    throw new Error(`overlay entry file does not exist: ${entry}`)
  }

  const stat = deps.stat ?? defaultStat
  try {
    if (stat(entry).isFile() === false) {
      throw new Error(`overlay entry is not a regular file: ${entry}`)
    }
  } catch (error) {
    if (/is not a regular file/.test(error.message)) throw error
    // A stat failure on an existing path is not worth failing the boot over;
    // the extension check above already excluded the directory case.
  }

  return entry
}

/**
 * Test whether a path looks like a file rather than a directory.
 *
 * Heuristic and deliberately strict: it decides the error message for an
 * unresolvable path, and `assertEntryFile` uses it as the no-filesystem-needed
 * guarantee that a directory can never be emitted.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function looksLikeFile(path) {
  if (typeof path !== 'string' || path === '') return false
  const base = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  if (base === '' || base === '.' || base === '..') return false
  return extname(base) !== ''
}

/**
 * Convert an absolute path to a `file://` URL.
 *
 * ## Trap 2: Windows `file://` correctness
 *
 * 设计文档 §5 requires valid Windows URLs. Hand-rolling this is where it goes
 * wrong: `'file://' + 'D:\\a\\b.mjs'` yields `file://D:\a\b.mjs`, which is not a
 * URL at all (backslashes, a drive letter where an authority belongs, no
 * percent-encoding). `pathToFileURL` from `node:url` is the correct tool and is
 * available because this is Node, not the Cordis evaluation sandbox.
 *
 * The overlay does not strictly require a URL — a plain path works — but the
 * URL form is what a caller prints or pastes, so it must be right.
 *
 * @param {string} path
 * @returns {string}
 */
export function toFileUrl(path) {
  return pathToFileURL(path).href
}

/** Default filesystem probe. */
function defaultExists(path) {
  return existsSync(path)
}

/** Default file reader. */
function defaultReadFile(path) {
  return readFileSync(path, 'utf8')
}

/** Default stat. */
function defaultStat(path) {
  return statSync(path)
}

/**
 * Directory test.
 *
 * Uses the injected `stat` when one is supplied, and otherwise falls back to the
 * injected `exists` — NOT to the real `statSync`. That fallback matters: a caller
 * that injects a virtual filesystem provides `exists` only, and probing the real
 * disk for a path that only exists virtually would report every directory as
 * missing and silently skip the whole directory-resolution branch.
 *
 * With neither probe available the real filesystem is used, which is the
 * production path.
 *
 * @param {string} path
 * @param {{stat?: (path: string) => {isDirectory: () => boolean}}} deps
 * @param {((path: string) => boolean)|undefined} exists
 * @returns {boolean}
 */
function isDirectory(path, deps, exists) {
  if (typeof deps.stat === 'function') {
    try {
      return deps.stat(path).isDirectory()
    } catch {
      return false
    }
  }
  if (typeof exists === 'function' && exists !== defaultExists) {
    // A virtual filesystem: treat "exists and is not one of the entry files we
    // would have matched" as a directory. The candidate probes below decide.
    return true
  }
  try {
    return defaultStat(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * File test.
 *
 * Same injection rule as {@link isDirectory}: prefer an injected `stat`, then
 * fall back to `exists` for a virtual filesystem, then the real disk.
 *
 * @param {string} path
 * @param {{stat?: (path: string) => {isFile: () => boolean}}} [deps]
 * @param {(path: string) => boolean} [exists]
 * @returns {boolean}
 */
function isFile(path, deps = {}, exists) {
  if (typeof deps.stat === 'function') {
    try {
      return deps.stat(path).isFile()
    } catch {
      return false
    }
  }
  if (typeof exists === 'function' && exists !== defaultExists) return true
  try {
    return defaultStat(path).isFile()
  } catch {
    return false
  }
}

/**
 * Build a failure result.
 *
 * @param {unknown} input
 * @param {string[]} candidates
 * @param {string} reason
 */
function failure(input, candidates, reason) {
  return {
    ok: false,
    entry: null,
    input: typeof input === 'string' ? input : String(input),
    resolvedFrom: null,
    candidates,
    reason,
  }
}
