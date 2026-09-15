/**
 * Is this module the process entry point?
 *
 * ## Why the obvious comparison is wrong
 *
 * The usual spelling is:
 *
 * ```js
 * import.meta.url === pathToFileURL(resolve(process.argv[1])).href
 * ```
 *
 * That is correct only when the entry path is the path Node loaded. It breaks
 * whenever the script is reached through a **symlink**, which is not exotic:
 * `npm install` creates one for every local/`file:` dependency (a Junction under
 * `node_modules` on Windows, a symlink elsewhere). Node resolves the module
 * through the link, so `import.meta.url` holds the REAL path while `process.argv[1]`
 * holds the LINK path.
 *
 * The failure mode is the worst kind: the comparison is false, `main()` is
 * skipped, and the process exits **0 with no output** — a command that did
 * nothing reporting success. Measured against a real `npm install` of this
 * package from a sibling directory.
 *
 * ## What this does instead
 *
 * Both sides are reduced to a real path (`realpathSync`) and compared with
 * case-insensitive equality on Windows, where the two sources can disagree on
 * case for the same file. Every step is best-effort: if the filesystem refuses
 * to resolve a path, the comparison falls back to the un-resolved form rather
 * than throwing, because a CLI that dies while deciding whether to start is
 * worse than one that starts.
 *
 * The npm-generated `.cmd` / shell shims run `node <this file>`, so this stays
 * the deciding test in every supported invocation.
 *
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @param {{argv?: string[], platform?: string}} [deps] injectable for tests
 * @returns {boolean}
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMainModule(moduleUrl, deps = {}) {
  const argv = deps.argv ?? process.argv
  const platform = deps.platform ?? process.platform
  const entry = argv?.[1]
  if (!entry) return false

  const normalize = (value) => {
    if (typeof value !== 'string' || !value) return null
    let path = value
    // Strip a file:// prefix if one is present, so both sides start as paths.
    if (path.startsWith('file://')) {
      try {
        path = fileURLToPath(path)
      } catch {
        return null
      }
    }
    let resolved
    try {
      resolved = realpathSync(path)
    } catch {
      // The path may not exist as given; compare it un-resolved rather than throw.
      resolved = path
    }
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  const self = normalize(moduleUrl)
  const given = normalize(entry)
  if (self === null || given === null) return false
  return self === given
}

