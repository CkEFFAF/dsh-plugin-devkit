/**
 * dsh-debugger — DSH plugin development runtime inspector.
 *
 * Entry point. `apply` only assembles: it provides the `debugger` service,
 * registers the `/debug` command, installs probes, and registers restoration
 * through `ctx.effect`. All real work lives in the layered modules, which are
 * independently testable.
 *
 * ## Injection choice
 *
 * `inject` declares **only** `commands` (design document 4.2). Diagnosing
 * "the composition has no tools" is this plugin's job, so it must not itself
 * stall in PENDING waiting for a service that may legitimately be absent.
 * Tool probes attach opportunistically via `ctx.get('tools')`; when tools are
 * missing, `probes.tools` reports `false` and the debugger stays ACTIVE.
 */

import { createRecorder } from './src/recorder.mjs'
import { createInspector } from './src/inspector.mjs'
import { installProbes } from './src/probes.mjs'
import { runCommand, SUBCOMMANDS } from './src/command.mjs'
import { describeThrown, redactString, truncate } from './src/sanitize.mjs'

export const name = 'dsh-debugger'

/** Hard dependency: see the module docstring for why `tools` is excluded. */
export const inject = ['commands']

/** Default configuration. */
const DEFAULTS = {
  capacity: 1000,
  probes: true,
  captureConsole: true,
  captureProcessErrors: true,
  announce: false,
}

/**
 * Mount the debugger.
 *
 * @param {object} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  config.enabled = rawConfig?.enabled ?? true

  const recorder = createRecorder({ capacity: config.capacity })

  // ---------------------------------------------------------------------------
  // Error capture.
  //
  // A FAILED fiber's root cause is routed to the logger by cordis (fiber.ts:126)
  // rather than stored on the fiber, so the inspector needs a capture to report
  // "apply threw: <message>". Bounded per plugin name: this is a diagnostic aid,
  // not a log store.
  // ---------------------------------------------------------------------------
  const errorLog = createErrorLog(50)

  // The inspector must exist before the service closure below, since
  // `api.snapshot()` delegates to it.
  const inspector = createInspector({ ctx, recorder, errorLog })

  // ---------------------------------------------------------------------------
  // The `debugger` service provided to downstream plugins.
  //
  // Declared with `provide` so a later plugin can `inject: ['debugger']` and
  // write onto the same timeline (acceptance A9).
  // ---------------------------------------------------------------------------
  const api = {
    mark(markName, data) {
      if (!config.enabled) return
      return recorder.push('mark', markName, { data })
    },
    record(category, recordName, payload) {
      if (!config.enabled) return
      return recorder.push(category, recordName, payload)
    },
    query(filter) {
      return recorder.query(filter ?? {})
    },
    trace(id) {
      return recorder.trace(id)
    },
    snapshot() {
      // Sampled live on every call, never cached.
      return inspector.snapshot()
    },
    stats() {
      return recorder.stats()
    },
    get recorder() {
      return recorder
    },
    config,
  }

  const debuggerApi = { recorder, inspector, config }

  // Providing the service is the one step that cannot be skipped: without it
  // downstream plugins cannot consume the timeline. If the host refuses, the
  // returned API is still usable by the caller that mounted us.
  try {
    ctx.provide('debugger', api)
  } catch (error) {
    recorder.noteEarlyError(`provide('debugger') failed: ${describeThrown(error)}`)
  }

  // ---------------------------------------------------------------------------
  // Probe-state reporting is exposed on the service and to the command layer.
  //
  // Every step below degrades instead of throwing. Constraint 2 says installation
  // failure is per-probe, and 用户故事 #13 says the debugger survives a minimal
  // composition; the same reasoning applies to the host's own surfaces. A host
  // whose `ctx.get` or `ctx.on` throws is exactly the host a user most needs to
  // inspect, so `apply` must still return a working service.
  // ---------------------------------------------------------------------------
  let probeState = { installed: {}, failures: {} }
  try {
    probeState = installProbes({ ctx, recorder, config })
  } catch (error) {
    // A total probe failure still leaves `/debug` usable.
    probeState = { installed: {}, failures: { all: describeThrown(error) }, dispose() {} }
    recorder.noteEarlyError(error)
  }

  const probesReport = {
    installed: probeState.installed,
    failures: probeState.failures,
  }
  debuggerApi.probes = probesReport

  // Restoration is owned by the fiber: unload must restore `console` and
  // `commands.execute` (acceptance A8).
  safeEffect(ctx, () => () => {
    try {
      probeState.dispose?.()
    } catch {
      // ignore
    }
  })

  // The logger capture is also fiber-owned.
  safeEffect(ctx, () => {
    const restore = errorLog.attach(ctx)
    return () => restore()
  })

  // ---------------------------------------------------------------------------
  // `/debug` command registration.
  //
  // A missing or hostile command registry costs only the command surface; the
  // programmable `ctx.debugger` API below stays available either way.
  // ---------------------------------------------------------------------------
  const commands = safeGet(ctx, 'commands')
  if (commands && typeof commands.register === 'function') {
    safeEffect(ctx, () => commands.register({
      name: 'debug',
      description: `Runtime inspector (${SUBCOMMANDS.join(', ')})`,
      // The real `CommandDefinition` declares the hint as `input: { hint }`
      // (interaction/commands/src/index.ts:69). An `arguments` string is not
      // part of the contract and is silently dropped, so capable clients would
      // advertise no hint at all.
      input: { hint: '[subcommand] [options]' },
      // The handler field is `handler` — NOT `execute`. `normalizeDefinition`
      // rejects anything else with `command "debug" handler must be a function`
      // (index.ts:189), and `register()` therefore THROWS. Because registration
      // is wrapped in `safeEffect`, that throw used to be swallowed: the plugin
      // mounted, announced "probes active", and `/debug` simply did not exist.
      // Verified against the real CommandRuntime: the old shape threw, the new
      // one registers.
      handler: (invocation) => {
        // The invocation carries the argument string only, without the leading
        // `/debug` name (index.ts:376 records `parsed.rawInput`, and the
        // CommandInvocation field is `rawInput`).
        const raw = invocation?.rawInput
        const result = runCommand(typeof raw === 'string' ? raw : '', debuggerApi)
        return { kind: 'success', text: result.output }
      },
    }))
  } else {
    // Without a command registry the service surface is still fully usable.
    recorder.noteEarlyError('commands service unavailable: /debug was not registered')
  }

  if (config.announce) {
    try {
      console.log(`[dsh-debugger] probes active; run /debug health`)
    } catch {
      // ignore
    }
  }

  return api
}

/**
 * `ctx.get` that cannot throw.
 *
 * A host with a broken service resolver is precisely the host worth inspecting,
 * so a failed lookup must cost a capability, never the whole mount.
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {unknown}
 */
function safeGet(ctx, name) {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * `ctx.effect` that cannot throw, and whose cleanup still runs.
 *
 * Keeps every registration fiber-owned while tolerating a host that rejects
 * effect creation. A cleanup that cannot be registered is still invoked so the
 * side effect does not leak.
 *
 * @param {object} ctx
 * @param {() => (void | (() => void))} callback
 */
function safeEffect(ctx, callback) {
  try {
    ctx.effect?.(callback)
  } catch {
    // The host refused ownership. Run the callback and immediately dispose it
    // rather than abandoning the side effect, so nothing leaks on unload.
    try {
      const dispose = callback()
      if (typeof dispose === 'function') dispose()
    } catch {
      // Nothing further can be done; the mount continues.
    }
  }
}

/**
 * Create a bounded, per-plugin error capture layered over the host logger.
 *
 * Wraps `ctx.logger.error` (through whatever logger surface the context
 * exposes) so fiber load failures become readable root causes. The wrapper is
 * reversible and always forwards to the original, so host logging is unchanged.
 *
 * @param {number} maxPerName
 */
function createErrorLog(maxPerName) {
  /** @type {Map<string, string[]>} */
  const byName = new Map()
  /** @type {string[]} */
  const recent = []

  function note(name, message) {
    const key = name || '(unknown)'
    const list = byName.get(key) ?? []
    list.push(message)
    if (list.length > maxPerName) list.shift()
    byName.set(key, list)
    recent.push(message)
    if (recent.length > maxPerName) recent.shift()
  }

  return {
    note,
    get(name) {
      return byName.get(name)
    },
    /** Most recent message for a plugin name, else the most recent anywhere. */
    top(name) {
      const list = byName.get(name)
      if (list?.length) return list[list.length - 1]
      return recent.length ? recent[recent.length - 1] : undefined
    },
    /** All recorded messages, newest first. */
    all() {
      return [...recent].reverse()
    },
    /**
     * Install the logger wrapper; returns a restore function.
     *
     * @param {object} ctx
     * @returns {() => void}
     */
    attach(ctx) {
      let logger
      try {
        logger = ctx.logger
      } catch {
        return () => {}
      }
      if (!logger || typeof logger.error !== 'function') return () => {}

      const original = logger.error
      const wrapped = function (...args) {
        try {
          // Only the first argument is inspected; it carries the thrown error.
          const first = args[0]
          const text = first instanceof Error
            ? `${first.name}: ${first.message}`
            : typeof first === 'string'
              ? first
              : first === undefined
                ? ''
                : describeThrown(first)
          if (text) note(nameFromError(first), redactString(truncate(text, 512)))
        } catch {
          // Capture must never disturb host logging.
        }
        return original.apply(this, args)
      }
      logger.error = wrapped

      return () => {
        logger.error = original
      }
    },
  }
}

/**
 * Derive a plugin name from a thrown error's message when possible.
 *
 * Cordis prefixes plugin failures with the plugin name in most paths; this is a
 * best-effort attribution that falls back to a generic bucket.
 *
 * @param {unknown} error
 * @returns {string}
 */
function nameFromError(error) {
  try {
    const message = error instanceof Error ? error.message : String(error)
    const match = /^([\w@/.-]+)[:>]/.exec(message)
    if (match) return match[1]
  } catch {
    // ignore
  }
  return '(unknown)'
}
