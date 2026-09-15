/**
 * Collection layer: probes attached to real Cordis extension points.
 *
 * Every probe may only `record()`. Nothing here decides anything, and nothing
 * here owns state that outlives the fiber.
 *
 * Three constraints are discharged in this file:
 *
 * 1. **Pass-through.** Every waterfall probe returns `next(...)`'s original
 *    return value, unchanged and unwrapped. Emit probes return nothing.
 * 2. **No throwing.** Every probe body is wrapped in `guard()`. A probe failure
 *    loses one record at most; it never fails the tool or command.
 * 8. **Reversible.** Method wrappers (`commands.execute`, `console.*`) capture
 *    the original implementation and restore it on dispose, so removing the
 *    plugin leaves the host exactly as it was found.
 */

import { describeThrown } from './sanitize.mjs'

/**
 * Wrap a probe body so it can never throw into the observed code.
 *
 * @param {() => void} body
 * @param {(error: unknown) => void} [onError]
 * @returns {() => void}
 */
export function guard(body, onError) {
  return () => {
    try {
      body()
    } catch (error) {
      try {
        onError?.(error)
      } catch {
        // An error reporter that throws would defeat the purpose.
      }
    }
  }
}

/**
 * Install every enabled probe.
 *
 * @param {{
 *   ctx: object,
 *   recorder: ReturnType<import('./recorder.mjs').createRecorder>,
 *   config: object,
 * }} deps
 * @returns {{dispose: () => void, installed: object, failures: object}}
 */
export function installProbes(deps) {
  const { ctx, recorder, config } = deps
  const disposers = []
  const installed = {}
  const failures = {}

  /**
   * Register one probe, recording failure instead of propagating it.
   *
   * A failed installation degrades that probe only: the command entry and the
   * other probes stay alive (constraint 2).
   *
   * @param {string} key
   * @param {() => (void | (() => void))} setup
   */
  function install(key, setup) {
    try {
      const dispose = setup()
      installed[key] = true
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      installed[key] = false
      failures[key] = describeThrown(error)
    }
  }

  // ---------------------------------------------------------------- tools ----
  // `tools` is deliberately NOT declared in `inject`: a minimal composition
  // without tools must still load the debugger (acceptance A2).
  //
  // Note the split: the *event* probes (`tools/pre-execute`, `tools/execute`,
  // `tools/result`) are registered whenever an event bus exists, regardless of
  // whether a `tools` service is mounted — those events may still fire, and
  // gating them on the service would silently lose the whole tool timeline.
  // Only service-object access requires `ctx.get('tools')`.
  const tools = safeGet(ctx, 'tools')
  if (config.probes) {
    install('tools', () => installToolProbes(ctx, recorder))
  } else {
    installed.tools = false
  }

  // ------------------------------------------------------------- commands ----
  // `commands/change` is an event, so it is available whenever the bus is; the
  // `commands.execute` wrapper needs the service object.
  const commands = safeGet(ctx, 'commands')
  if (config.probes) {
    install('commands', () => installCommandProbes(ctx, recorder, commands))
  } else {
    installed.commands = false
  }
  // Report service availability separately so `/debug health` can distinguish
  // "probe disabled" from "service absent".
  installed.toolsService = tools !== undefined
  installed.commandsService = commands !== undefined

  // ----------------------------------------------------------------- llm ----
  // Found by watching a real session: the kernel recorded NOTHING for a
  // text-only model turn, because it had no LLM probe at all. Only `tools/*`
  // was covered, so a turn that called no tool left the timeline empty and
  // `/debug` could not explain how long a model call took or that it failed.
  //
  // `llm/stream` is a genuine waterfall: the listener receives
  // `(options, next)` and must return `next()`'s value untouched (constraint 1).
  if (config.probes) {
    install('llm', () => installLlmProbes(ctx, recorder))
  } else {
    installed.llm = false
  }
  installed.llmService = safeGet(ctx, 'llm') !== undefined

  // -------------------------------------------------------------- console ----
  if (config.captureConsole) {
    install('console', () => installConsoleProbe(recorder))
  } else {
    installed.console = false
  }

  // -------------------------------------------------------------- process ----
  if (config.captureProcessErrors) {
    install('process', () => installProcessProbes(recorder))
  } else {
    installed.process = false
  }

  return {
    installed,
    failures,
    dispose() {
      // Restore in reverse order: a later wrapper must come off before the one
      // it wrapped, or the original implementation is restored incorrectly
      // (design document 4.3).
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // Restoration failure must not break unload.
        }
      }
      disposers.length = 0
    },
  }
}

/**
 * Attach probes to the tool extension points.
 *
 * Registers event listeners only. Whether a `tools` service is mounted is not
 * consulted here: these events fire from the tool runtime, and a composition
 * that emits them deserves a timeline even if `ctx.get('tools')` returns
 * `undefined`.
 *
 * @param {object} ctx
 * @param {object} recorder
 * @returns {() => void}
 */
function installToolProbes(ctx, recorder) {
  const disposers = []

  // `tools/pre-execute` is a waterfall: the decision object it returns must be
  // returned untouched (constraint 1). The probe observes the decision and
  // forwards the original value by reference.
  if (typeof ctx.on === 'function') {
    const offPre = ctx.on('tools/pre-execute', (payload, next) => {
      let decision
      try {
        decision = next()
      } catch (error) {
        guard(() => {
          recorder.push('tool', nameOf(payload), {
            correlation: correlationOf(payload),
            data: { phase: 'pre-execute', args: payload?.args },
            error,
          })
        })()
        throw error
      }
      // Observe only; never return a substitute object.
      guard(() => {
        recorder.push('tool', nameOf(payload), {
          correlation: correlationOf(payload),
          data: {
            phase: 'pre-execute',
            args: payload?.args,
            decision: decisionText(decision),
          },
        })
      })()
      return decision
    })
    if (typeof offPre === 'function') disposers.push(offPre)

    const offExec = ctx.on('tools/execute', (payload, next) => {
      const started = Date.now()
      let result
      try {
        result = next()
      } catch (error) {
        guard(() => {
          recorder.push('tool', nameOf(payload), {
            correlation: correlationOf(payload),
            durationMs: Date.now() - started,
            error,
            data: { phase: 'execute' },
          })
        })()
        throw error
      }
      guard(() => {
        recorder.push('tool', nameOf(payload), {
          correlation: correlationOf(payload),
          durationMs: Date.now() - started,
          data: { phase: 'execute' },
        })
      })()
      return result
    })
    if (typeof offExec === 'function') disposers.push(offExec)

    // emit probe: returns nothing.
    const offResult = ctx.on('tools/result', (payload) => {
      guard(() => {
        recorder.push('tool', nameOf(payload), {
          correlation: correlationOf(payload),
          error: payload?.error,
          data: { phase: 'result', ok: !payload?.error },
        })
      })()
    })
    if (typeof offResult === 'function') disposers.push(offResult)
  }

  return () => {
    for (const off of disposers.reverse()) {
      try {
        off()
      } catch {
        // Restoration failure must not break unload.
      }
    }
  }
}

/**
 * Wrap `commands.execute`.
 *
 * Design document 4.3: this is a known shallow seam. Cordis exposes no command
 * execution event, so the method itself must be replaced. The wrapper is
 * registered for restoration through the caller's disposer list, and the
 * original is restored verbatim.
 *
 * Also subscribes to `commands/change`, which is a genuine event and therefore
 * independent of whether the service object is reachable.
 *
 * @param {object} ctx
 * @param {object} recorder
 * @param {unknown} [commandsService] resolved `ctx.get('commands')`, if any
 * @returns {() => void}
 */function installCommandProbes(ctx, recorder, commandsService) {
  const disposers = []

  // Registry-change events are observable whenever there is an event bus.
  if (typeof ctx.on === 'function') {
    const offChange = ctx.on('commands/change', () => {
      guard(() => {
        recorder.push('command', 'commands/change', {
          data: { registry: describeCommandNames(ctx) },
        })
      })()
    })
    if (typeof offChange === 'function') disposers.push(offChange)
  }

  const commands = commandsService
  if (commands && typeof commands.execute === 'function') {
    const original = commands.execute
    const wrapped = function (...args) {
      const started = Date.now()
      const name = commandNameOf(args)
      let result
      try {
        result = original.apply(this, args)
      } catch (error) {
        guard(() => {
          recorder.push('command', name, {
            correlation: name,
            durationMs: Date.now() - started,
            error,
          })
        })()
        throw error
      }
      if (result && typeof result.then === 'function') {
        return result.then(
          (value) => {
            guard(() => {
              recorder.push('command', name, { correlation: name, durationMs: Date.now() - started })
            })()
            return value
          },
          (error) => {
            guard(() => {
              recorder.push('command', name, {
                correlation: name,
                durationMs: Date.now() - started,
                error,
              })
            })()
            throw error
          },
        )
      }
      guard(() => {
        recorder.push('command', name, { correlation: name, durationMs: Date.now() - started })
      })()
      return result
    }
    commands.execute = wrapped

    disposers.push(() => {
      // Restore the exact original reference, not a re-derived one.
      commands.execute = original
    })
  }

  return () => {
    for (const off of disposers.reverse()) {
      try {
        off()
      } catch {
        // Restoration failure must not break unload.
      }
    }
  }
}

/**
 * Attach probes to the LLM extension points.
 *
 * ## Why this exists
 *
 * Measured on a real session: the kernel recorded **nothing** for a text-only
 * model turn. The probes covered `tools/*`, `commands/*`, console and process,
 * so a turn that called no tool left the timeline empty — the observer could not
 * say how long a model call took, which provider/model was used, or that it
 * failed. Those are exactly the questions an observation kernel exists to
 * answer, so the gap was closed here.
 *
 * ## Constraint 1 (pass-through) is the whole difficulty
 *
 * `llm/stream` is a waterfall: the listener receives `(options, next)` and its
 * return value IS the provider stream. Returning anything other than `next()`'s
 * own value — a copy, a wrapper, even `undefined` on a mistake — would break
 * generation. So the probe:
 *
 * - captures the original value and returns **that exact reference**;
 * - never awaits, copies or transforms the stream;
 * - records only scalars read off `options` (provider, model, message count),
 *   which cannot be confused with forwarding the stream.
 *
 * `llm/retry` is an ordinary emit event and carries no such risk.
 *
 * ## Category choice
 *
 * These records use the existing **`event`** category rather than a new `llm`
 * one. 设计文档 §4.4 fixes the category enum, and while the recorder accepts an
 * unknown category it silently reclassifies it as `mark` (recorder.mjs:57) — so
 * an invented category would have produced plausible-looking but wrongly
 * labelled records instead of an error. `event` exists for exactly this: an
 * observation of a host event, and it was previously declared but unused.
 *
 * @param {object} ctx
 * @param {object} recorder
 * @returns {() => void}
 */
function installLlmProbes(ctx, recorder) {
  const disposers = []
  if (typeof ctx.on !== 'function') return () => {}

  // Waterfall: observe the request, forward the stream by reference.
  const offStream = ctx.on('llm/stream', (options, next) => {
    let result
    try {
      result = next()
    } catch (error) {
      guard(() => {
        recorder.push('event', 'llm/stream', {
          correlation: sessionIdOf(options),
          error,
          data: { phase: 'request', provider: options?.provider, model: options?.model },
        })
      })()
      throw error
    }
    guard(() => {
      recorder.push('event', 'llm/stream', {
        correlation: sessionIdOf(options),
        data: {
          phase: 'request',
          // Each field is read independently: one hostile getter must cost that
          // one value, not the whole record. Building all of them in a single
          // expression meant a single bad field discarded the record entirely,
          // so the model call vanished from the timeline instead of appearing
          // with a missing detail — the opposite of what an observer is for.
          provider: safeRead(options, 'provider'),
          model: safeRead(options, 'model'),
          messages: lengthOf(safeRead(options, 'messages')),
          tools: lengthOf(safeRead(options, 'tools')),
        },
      })
    })()
    // Return the ORIGINAL reference. Not a copy, not a wrapper.
    return result
  })
  if (typeof offStream === 'function') disposers.push(offStream)

  // Emit: a retry is worth surfacing, since it explains latency that nothing
  // else in the timeline accounts for.
  const offRetry = ctx.on('llm/retry', (payload) => {
    guard(() => {
      recorder.push('event', 'llm/retry', {
        data: {
          phase: 'retry',
          turn: payload?.turn,
          step: payload?.step,
          retry: payload?.retry,
          provider: payload?.provider,
          code: payload?.failure?.code,
        },
      })
    })()
  })
  if (typeof offRetry === 'function') disposers.push(offRetry)

  return () => {
    for (const off of disposers.reverse()) {
      try {
        off()
      } catch {
        // Restoration failure must not break unload.
      }
    }
  }
}

/**
 * Read a field off a payload without letting a hostile getter escape.
 *
 * Returns `undefined` for a throwing getter, a wrong type, or a missing field —
 * never throws. This is what keeps one bad field from costing a whole record.
 *
 * @param {unknown} source
 * @param {string} key
 * @returns {unknown}
 */
function safeRead(source, key) {
  try {
    const value = source?.[key]
    // A nested object read is only safe if the value itself is primitive; the
    // caller decides, so return whatever was read and let it be sanitized.
    return value
  } catch {
    return undefined
  }
}

/**
 * `Array.length` of a value, or `undefined` when it is not an array.
 *
 * @param {unknown} value
 * @returns {number|undefined}
 */
function lengthOf(value) {
  try {
    return Array.isArray(value) ? value.length : undefined
  } catch {
    return undefined
  }
}

/**
 * Read a session id off `GenerateOptions` without trusting its shape.
 *
 * The loop stamps session identity for request routing; correlating an LLM call
 * to its session is what lets `/debug trace` connect a model call to the tool
 * calls it produced.
 *
 * @param {unknown} options
 * @returns {string|undefined}
 */
function sessionIdOf(options) {
  const direct = safeRead(options, 'sessionId')
  if (typeof direct === 'string' && direct) return direct
  // `safeRead` twice, not `options?.session?.id`: a throwing `session` getter
  // must not escape, and a nested read needs its own guard.
  const nested = safeRead(safeRead(options, 'session'), 'id')
  return typeof nested === 'string' && nested ? nested : undefined
}

/**
 * Wrap `console.*` so plugin logs land on the timeline.
 *
 * The original behaviour is fully preserved: whichever console method is
 * replaced is still called with all original arguments.
 *
 * ## Re-entrancy (considered and rejected)
 *
 * A depth guard was evaluated here on the theory that `recorder.push` could call
 * back into `console` while recording — `sanitize` runs inside the push, and a
 * hostile value's `toString` might log. Measurement shows that path is
 * unreachable: `sanitize` reads own enumerable keys and primitive values and
 * never stringifies a plain object, so no user code runs during a push.
 *
 * The guard was removed rather than kept "just in case": it added per-call state
 * to a hot path and no test could distinguish its presence from its absence.
 * If `sanitize` ever gains a `toString`/`toJSON` call, add the guard *with* a
 * test that fails without it.
 *
 * @param {object} recorder
 * @returns {() => void}
 */
function installConsoleProbe(recorder) {
  const target = globalThis.console
  if (!target) return () => {}

  const methods = ['log', 'info', 'warn', 'error', 'debug']
  const originals = new Map()

  for (const method of methods) {
    const original = target[method]
    if (typeof original !== 'function') continue
    originals.set(method, original)
    target[method] = function (...args) {
      guard(() => {
        recorder.push('log', method, { data: { args } })
      })()
      return original.apply(this, args)
    }
  }

  return () => {
    for (const [method, original] of originals) {
      target[method] = original
    }
    originals.clear()
  }
}

/**
 * Listen for silent failures.
 *
 * Design document 9: these listeners only record. Whether the process exits is
 * the host's decision, never the observer's.
 *
 * @param {object} recorder
 * @returns {() => void}
 */
function installProcessProbes(recorder) {
  const proc = globalThis.process
  if (!proc || typeof proc.on !== 'function') return () => {}

  const onUncaught = (error) => {
    guard(() => {
      recorder.push('error', 'uncaughtException', { error })
    })()
  }
  const onRejection = (reason) => {
    guard(() => {
      recorder.push('error', 'unhandledRejection', {
        error: reason instanceof Error ? reason : { name: 'UnhandledRejection', message: describeThrown(reason) },
      })
    })()
  }

  proc.on('uncaughtException', onUncaught)
  proc.on('unhandledRejection', onRejection)

  return () => {
    try {
      proc.off?.('uncaughtException', onUncaught)
      proc.off?.('unhandledRejection', onRejection)
    } catch {
      // ignore
    }
  }
}

/**
 * Render a tool decision as a short label.
 *
 * The probe must not *change* the decision, but summarising it for display is
 * exactly its job.
 *
 * @param {unknown} decision
 * @returns {string}
 */
function decisionText(decision) {
  try {
    if (decision === undefined || decision === null) return 'allow'
    if (typeof decision === 'string') return decision
    if (typeof decision === 'object') {
      if (typeof decision.behavior === 'string') return decision.behavior
      if (typeof decision.decision === 'string') return decision.decision
      if (decision.deny) return 'deny'
      if (decision.ask) return 'ask'
    }
    return 'allow'
  } catch {
    return 'unknown'
  }
}

/**
 * Read a tool name from an event payload without trusting its shape.
 *
 * @param {unknown} payload
 * @returns {string}
 */
function nameOf(payload) {
  try {
    const name = payload?.name ?? payload?.toolName ?? payload?.call?.name
    return typeof name === 'string' && name ? name : 'tool'
  } catch {
    return 'tool'
  }
}

/**
 * Read a correlation id (tool call id or command id) from a payload.
 *
 * @param {unknown} payload
 * @returns {string|undefined}
 */
function correlationOf(payload) {
  try {
    const id = payload?.callId ?? payload?.id ?? payload?.call?.id
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Derive a command name from `commands.execute` arguments.
 *
 * ## The real signature, verified against the source
 *
 * `CommandRuntime.execute` is `@Remote async execute(agent, line, attachments,
 * signal)` (`packages/interaction/commands/src/index.ts:361`). The **first**
 * argument is an Agent, and the name comes from parsing the **second**, a line
 * like `/debug health`.
 *
 * Reading `args[0]` was therefore wrong in a way that failed silently: every
 * command was recorded as the generic `"command"`, so `/debug trace <id>` could
 * never correlate a command and `/debug stats` could not rank them. The earlier
 * tests missed it because the fake host's `execute(name, ...)` took a plain
 * string, which is not the shape the real service has.
 *
 * The line is parsed conservatively: the leading `/name` token is the command,
 * and a bare word (no slash) is accepted too, since a definition may be invoked
 * either way.
 *
 * @param {unknown[]} args
 * @returns {string}
 */
function commandNameOf(args) {
  try {
    // Position 1 is the command line; position 0 is the calling Agent.
    const line = args?.[1]
    if (typeof line === 'string' && line.trim()) {
      const match = /^\s*\/?([\w:-]+)/.exec(line)
      if (match) return match[1]
      return line.trim().slice(0, 64)
    }
    // Tolerate a host whose execute takes the name first: a plain string in
    // position 0 is still a name, and some surfaces may call it that way.
    const first = args?.[0]
    if (typeof first === 'string' && first.trim()) {
      const match = /^\s*\/?([\w:-]+)/.exec(first)
      if (match) return match[1]
    }
    if (first && typeof first.name === 'string') return first.name
    if (first && typeof first.command === 'string') return first.command
  } catch {
    // ignore
  }
  return 'command'
}

/**
 * List registered command names for the `commands/change` record.
 *
 * @param {object} ctx
 * @returns {string[]}
 */
function describeCommandNames(ctx) {
  try {
    const commands = ctx.get?.('commands')
    const registry = commands?.registry ?? commands?.commands
    if (registry && typeof registry.keys === 'function') return [...registry.keys()].map(String)
  } catch {
    // ignore
  }
  return []
}

/**
 * `ctx.get` that cannot throw.
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
