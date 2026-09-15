/**
 * Pre-flight checks that run before a real DSH process is spawned.
 *
 * Two questions the CLI must answer *before* booting, because answering them
 * afterwards produces a much worse error:
 *
 * 1. Does the shipped template profile exist? A missing template makes
 *    `--from-default-profile` fail deep inside the loader with a message that
 *    does not mention the template by the name the user typed.
 * 2. Is the debug port free? A busy port otherwise surfaces as an
 *    `EADDRINUSE` stack trace from the webserver fiber, after the whole tree
 *    has loaded.
 *
 * Both checks are pure apart from injectable probes, so tests can construct
 * each failure without touching the network or DSH_HOME.
 */

import { existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

/**
 * Resolve DSH_HOME the way the harness does.
 *
 * Matches `resolveDshHome` from `@deepseek-ai/dsh-home-paths`: the env var wins,
 * then `~/.dsh`.
 *
 * @param {{env?: object, homedir?: string, override?: string|null}} [deps]
 * @returns {string}
 */
export function resolveDshHome(deps = {}) {
  if (deps.override) return deps.override
  const env = deps.env ?? process.env
  if (env.DSH_HOME) return env.DSH_HOME
  const homedir = deps.homedir ?? defaultHomedir()
  return join(homedir, '.dsh')
}

/** Default home directory probe. */
function defaultHomedir() {
  return process.env.USERPROFILE ?? process.env.HOME ?? '.'
}

/**
 * The directory holding this DSH_HOME's profiles.
 *
 * @param {string} dshHome
 * @returns {string}
 */
export function profilesDir(dshHome) {
  return join(dshHome, 'profiles')
}

/**
 * The directory a named profile would occupy.
 *
 * @param {string} dshHome
 * @param {string} name
 * @returns {string}
 */
export function profileDir(dshHome, name) {
  return join(profilesDir(dshHome), name)
}

/**
 * List profile names present under DSH_HOME.
 *
 * @param {string} dshHome
 * @param {{readdir?: (path: string) => string[]}} [deps]
 * @returns {string[]}
 */
export function listProfiles(dshHome, deps = {}) {
  const readdir = deps.readdir ?? defaultReaddir
  try {
    // Sorted so failure messages are stable and diffable across runs.
    return readdir(profilesDir(dshHome)).slice().sort()
  } catch {
    return []
  }
}

/**
 * Check that a shipped profile template is available to derive from.
 *
 * A template is a profile directory that already exists under
 * `$DSH_HOME/profiles`, which is where the shipped bundles materialize it.
 * 功能文档 §6.1 requires deriving from the *shipped* template rather than
 * cloning the user's daily profile.
 *
 * @param {string} template name, e.g. `web`
 * @param {string} dshHome
 * @param {{exists?: (path: string) => boolean, names?: string[]}} [deps]
 * @returns {{ok: boolean, dir: string, reason: string|null, available: string[]}}
 */
export function checkTemplate(template, dshHome, deps = {}) {
  const exists = deps.exists ?? existsSync
  const dir = profileDir(dshHome, template)
  // Sorted at the point of use, so the guarantee holds even when `names` is
  // injected directly rather than produced by `listProfiles`.
  const available = (deps.names ?? listProfiles(dshHome, deps)).slice().sort()

  // The profile directory is what `--from-default-profile` reads.
  if (exists(dir)) return { ok: true, dir, reason: null, available }

  // Tolerate a template that only exists as a bundle, so a first run on a fresh
  // DSH_HOME is not reported as "missing" when DSH would in fact initialize it.
  if (available.includes(template)) return { ok: true, dir, reason: null, available }

  return {
    ok: false,
    dir,
    reason: `profile template '${template}' was not found under ${profilesDir(dshHome)}`,
    available,
  }
}

/**
 * Check whether a TCP port can be bound on a host.
 *
 * Binds and immediately releases. This is a race in principle — something else
 * could take the port in the gap — but it converts the overwhelmingly common
 * case (a stale debug instance still listening) into a clear message instead of
 * an `EADDRINUSE` stack trace from deep inside the boot.
 *
 * @param {number} port
 * @param {string} host
 * @param {{listen?: (options: object) => Promise<void>}} [deps] injectable for tests
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function checkPort(port, host = '127.0.0.1', deps = {}) {
  // Port 0 asks the OS for a free port, so it can never be "in use".
  if (port === 0) return { ok: true, reason: null }

  const listen = deps.listen
  if (listen) {
    try {
      await listen({ port, host })
      return { ok: true, reason: null }
    } catch (error) {
      // An injected probe surfaces real `EADDRINUSE`/`EACCES` errors too, so it
      // goes through the same formatter as the real path. Formatting only one of
      // them would make the injected path report a raw `listen EADDRINUSE`
      // instead of the actionable sentence the user needs.
      return { ok: false, reason: formatListenError(error, port, host) }
    }
  }

  return new Promise((resolveCheck) => {
    let settled = false
    const server = createServer()

    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        server.close()
      } catch {
        // Already closed or never listening.
      }
      resolveCheck(result)
    }

    server.once('error', (error) => finish({ ok: false, reason: formatListenError(error, port, host) }))
    server.once('listening', () => finish({ ok: true, reason: null }))

    try {
      server.listen({ port, host, exclusive: true })
    } catch (error) {
      finish({ ok: false, reason: formatListenError(error, port, host) })
    }
  })
}

/**
 * Turn a listen error into an actionable sentence.
 *
 * @param {any} error
 * @param {number} port
 * @param {string} host
 * @returns {string}
 */
function formatListenError(error, port, host) {
  const code = error?.code
  if (code === 'EADDRINUSE') return `port ${port} on ${host} is already in use`
  if (code === 'EACCES') return `not permitted to bind ${host}:${port}`
  if (code === 'EADDRNOTAVAIL') return `address ${host} is not available on this machine`
  // Any other reason still names the address: "busy" alone does not tell the
  // user which port to change, and that is the whole point of this check.
  const detail = error?.message ? `: ${error.message}` : ''
  return `cannot bind ${host}:${port}${detail}`
}

/** Default directory reader. */
function defaultReaddir(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}
