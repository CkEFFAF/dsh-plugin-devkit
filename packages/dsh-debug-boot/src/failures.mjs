/**
 * The three distinguishable boot failures.
 *
 * 设计文档 §5 and 功能文档 §6.1 both require that a failed derivation says
 * *which* failure it was: a missing template, a busy port, or an invalid overlay.
 * A single "boot failed" message would force the user to re-derive by hand the
 * one thing this CLI exists to work out for them.
 *
 * Each code has a fixed exit code so a script can branch on it without parsing
 * English, and a stable machine-readable `code` for `--json`.
 */

/**
 * Failure classes, with their exit codes.
 *
 * Each member is individually frozen: `Object.freeze` is shallow, so freezing
 * only the outer object would still let `FAILURE.PORT_IN_USE.exit = 0` succeed
 * and silently break the exit-code contract a script branches on.
 */
const CLASSES = {
  /** The shipped template profile does not exist. */
  TEMPLATE_MISSING: Object.freeze({ code: 'template-missing', exit: 2 }),
  /** The requested debug port is already bound. */
  PORT_IN_USE: Object.freeze({ code: 'port-in-use', exit: 3 }),
  /** The generated overlay is not valid for the loader. */
  OVERLAY_INVALID: Object.freeze({ code: 'overlay-invalid', exit: 4 }),
  /** The plugin path could not be resolved to an entry file. */
  PLUGIN_UNRESOLVED: Object.freeze({ code: 'plugin-unresolved', exit: 5 }),
  /**
   * The profile directory exists without a package.json.
   *
   * DSH cannot boot this state by either path: `--from-default-profile` refuses
   * the existing directory, and omitting it reports "profile does not exist".
   * It is a leftover from an interrupted initialization.
   */
  PROFILE_CORRUPT: Object.freeze({ code: 'profile-corrupt', exit: 6 }),
  /**
   * The plugin under test never activated, so DSH refused to boot at all.
   *
   * This is the author's most common failure — an `inject` naming a service the
   * composition does not provide — and it is the one case where the usual
   * diagnostic loop is unavailable: the instance never starts, so `/debug` never
   * runs. It is therefore reported as a first-class failure naming the awaited
   * service, rather than surfacing as a raw stack trace from deep in app-boot.
   */
  PLUGIN_PENDING: Object.freeze({ code: 'plugin-pending', exit: 7 }),
  /** Bad command-line usage. */
  USAGE: Object.freeze({ code: 'usage', exit: 64 }),
  /** Anything unclassified. */
  INTERNAL: Object.freeze({ code: 'internal', exit: 1 }),
}

export const FAILURE = Object.freeze(CLASSES)

/**
 * Build a structured boot failure.
 *
 * @param {{code: string, exit: number}} kind one of {@link FAILURE}
 * @param {string} message one-line human explanation
 * @param {{detail?: string, hints?: string[]}} [extra]
 * @returns {{ok: false, failure: {kind: string, code: string, exit: number, message: string, detail: string|null, hints: string[]}}}
 */
export function bootFailure(kind, message, extra = {}) {
  return {
    ok: false,
    failure: {
      kind: Object.keys(FAILURE).find((key) => FAILURE[key] === kind) ?? 'INTERNAL',
      code: kind.code,
      exit: kind.exit,
      message,
      detail: extra.detail ?? null,
      hints: extra.hints ?? [],
    },
  }
}

/**
 * Render a failure for a terminal.
 *
 * Accepts either a bare failure object or a `bootFailure()` result, because both
 * shapes reach this function in practice (the CLI passes the inner object; a
 * caller holding a full result passes the wrapper). Taking one and rejecting the
 * other is a footgun that produces an empty "internal: unknown failure" line for
 * a perfectly good failure.
 *
 * Tolerant of a partially populated object too: the renderer that explains a boot
 * failure must not itself be the thing that throws.
 *
 * @param {{code?: string, message?: string, detail?: string|null, hints?: string[],
 *          failure?: {code?: string, message?: string, detail?: string|null, hints?: string[]}}} failure
 * @returns {string}
 */
export function renderFailure(failure) {
  // Unwrap a `bootFailure()` result when given one.
  const inner = failure?.failure ?? failure
  const code = inner?.code ?? 'internal'
  const message = inner?.message ?? 'unknown failure'
  const lines = [`debug-boot: ${code}: ${message}`]
  if (inner?.detail) lines.push('', inner.detail)

  const hints = inner?.hints ?? []
  if (hints.length) {
    lines.push('')
    for (const hint of hints) lines.push(`hint: ${hint}`)
  }
  return lines.join('\n')
}

/**
 * Build a successful boot result.
 *
 * @param {object} value
 * @returns {{ok: true} & object}
 */
export function bootSuccess(value) {
  return { ok: true, ...value }
}

/**
 * Recognise a boot failure caused by the plugin under test never activating.
 *
 * ## Why this is parsed rather than read from a structured source
 *
 * DSH reports this as a plain thrown `Error` from `assertEntriesActivated`
 * (`app-boot/src/index.ts:~753`) whose message contains the entry URL, the state
 * and the awaited service:
 *
 * ```
 * dsh: plugin tree failed to load: dsh: 1 entry did not activate
 * file:///D:/proj/plugin/index.mjs: pending (waiting for service: storage)
 * ```
 *
 * There is no structured field to read, so the text is matched. That is a
 * deliberate trade: the alternative is the author staring at a stack trace for
 * the single most common plugin defect. Failure to match degrades to the
 * generic path, so a wording change upstream costs the nicer message, never
 * correctness.
 *
 * @param {string} text captured stderr
 * @returns {{entry: string|null, service: string|null, state: string}|null}
 */
export function parseInactiveEntry(text) {
  if (typeof text !== 'string' || !text) return null

  // "…did not activate" is the DSH-side summary; require it so an unrelated
  // message that happens to contain "pending" is not misread.
  if (!/did not activate/i.test(text)) return null

  // `file:///D:/proj/plugin/index.mjs: pending (waiting for service: storage)`
  const match = /(\S+?):\s*(pending|loading|failed)\s*\(([^)]*)\)/i.exec(text)
  if (!match) {
    return { entry: null, service: null, state: 'pending' }
  }

  const entry = fileUrlToPathSafe(match[1])
  const detail = match[3] ?? ''
  const serviceMatch = /waiting for service:\s*([^)\s]+)/i.exec(detail)
  const injectMatch = /waiting for\s+([^)\s]+)/i.exec(detail)

  return {
    entry,
    // A service name is the actionable part; fall back to whatever it waits for.
    service: serviceMatch?.[1] ?? injectMatch?.[1] ?? null,
    state: match[2].toLowerCase(),
  }
}

/**
 * Turn a `file://` URL into a path, leaving anything else untouched.
 *
 * The plugin's own path is worth showing as a path, not a URL: it is what the
 * author typed and what they will open in an editor.
 *
 * @param {string} value
 * @returns {string}
 */
function fileUrlToPathSafe(value) {
  try {
    if (value.startsWith('file://')) return decodeURIComponent(new URL(value).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    return value
  } catch {
    return value
  }
}

/**
 * Build the failure for a plugin that never activated.
 *
 * @param {{entry: string|null, service: string|null, state: string}} parsed
 * @param {string} capturedStderr
 * @returns {object} a `bootFailure()` result
 */
export function bootPendingFailure(parsed, capturedStderr) {
  const where = parsed.entry ? ` (${parsed.entry})` : ''
  const waits = parsed.service ? `, waiting for service "${parsed.service}"` : ''
  const message = `the plugin under test did not activate${waits}`

  const hints = []
  if (parsed.service) {
    hints.push(`provide "${parsed.service}" in the composition, or remove it from the plugin's \`inject\` list`)
    hints.push('`inject` is a hard dependency: an unprovided name keeps the fiber PENDING forever')
  }
  hints.push('run `dsh-debug-boot --dry-run` to inspect the plan without booting')
  hints.push('the observation kernel cannot help here: the instance never starts, so /debug never runs')

  return bootFailure(FAILURE.PLUGIN_PENDING, message, {
    detail: [
      `state: ${parsed.state}${where}`,
      '',
      capturedStderr.trim().split('\n').slice(0, 6).join('\n'),
    ].join('\n'),
    hints,
  })
}
