/**
 * The `/debug` command: argument parsing and subcommand dispatch.
 *
 * Kept separate from `index.mjs` so the whole surface is testable without a host
 * (design document's test layering: core / probes / inspector / command).
 * Parsing is pure; dispatch reads the recorder and inspector through the small
 * `debugger` object it is handed.
 */

import {
  renderHealth,
  renderPlugins,
  renderServices,
  renderRecords,
  renderStats,
  renderTrace,
  renderConfig,
  renderJson,
} from './render.mjs'
import { CATEGORIES } from './recorder.mjs'

/** Subcommands accepted by `/debug`. */
export const SUBCOMMANDS = ['health', 'plugins', 'services', 'events', 'trace', 'stats', 'config', 'clear']

/**
 * Filter the plugin list for the author's actual question.
 *
 * `--name` matches a substring case-insensitively, because the author knows part
 * of their plugin's name, not its exact id. A fiber whose identity could not be
 * recovered renders as an opaque `apply`; a name filter excludes those rather
 * than pretending to match.
 *
 * @param {object[]} plugins
 * @param {{name?: string, state?: string, notActive?: boolean}} filter
 * @returns {object[]}
 */
export function filterPlugins(plugins, filter = {}) {
  let rows = Array.isArray(plugins) ? plugins : []

  if (filter.state) {
    const wanted = String(filter.state).toUpperCase()
    rows = rows.filter((row) => String(row?.stateName ?? '').toUpperCase() === wanted)
  }

  if (filter.notActive) {
    rows = rows.filter((row) => String(row?.stateName ?? '').toUpperCase() !== 'ACTIVE')
  }

  if (filter.name) {
    const needle = String(filter.name).toLowerCase()
    rows = rows.filter((row) => {
      const name = typeof row?.name === 'string' ? row.name.toLowerCase() : ''
      return name.includes(needle)
    })
  }

  return rows
}

/**
 * Options that take a value.
 *
 * Needed because `--name todo` (two tokens) must consume the next token, and
 * `--json` must not. Before this set existed, every `--key value` form silently
 * became `key: true`: the value token fell through to `positional` and the
 * option filter was never applied. `--name=x` worked and `--name x` did not,
 * which is a trap for exactly the option an author reaches for first.
 */
const VALUED_OPTIONS = new Set(['category', 'name', 'source', 'state', 'limit', 'since'])

/**
 * Parse a `/debug` argument string.
 *
 * @param {string} input
 * @returns {{subcommand: string, positional: string[], options: object, errors: string[]}}
 */
export function parseArgs(input) {
  const tokens = tokenize(input)
  const options = {}
  const positional = []
  const errors = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      const key = eq === -1 ? body : body.slice(0, eq)
      let value = eq === -1 ? true : body.slice(eq + 1)

      // `--key value`: take the next token when this option expects a value and
      // none was attached with `=`.
      if (eq === -1 && VALUED_OPTIONS.has(key)) {
        const next = tokens[i + 1]
        if (next === undefined || next.startsWith('-')) {
          errors.push(`--${key} needs a value`)
          continue
        }
        value = next
        i += 1
      }

      applyOption(options, key, value, errors)
    } else if (token === '-v') {
      options.verbose = true
    } else {
      positional.push(token)
    }
  }

  const subcommand = positional.shift() ?? 'health'
  return { subcommand, positional, options, errors }
}

/**
 * Split on whitespace, honouring simple quoting.
 *
 * @param {string} input
 * @returns {string[]}
 */
function tokenize(input) {
  const out = []
  let current = ''
  let quote = null

  for (const ch of String(input ?? '')) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

/**
 * Record one parsed option, validating where the value has a closed set.
 *
 * @param {object} options
 * @param {string} key
 * @param {unknown} value
 * @param {string[]} errors
 */
function applyOption(options, key, value, errors) {
  switch (key) {
    case 'category':
      if (value === true) {
        errors.push('--category needs a value')
        return
      }
      if (!CATEGORIES.includes(String(value))) {
        errors.push(`unknown category '${value}' (expected one of: ${CATEGORIES.join('|')})`)
        return
      }
      options.category = String(value)
      return
    case 'name':
    case 'source':
      options[key] = String(value)
      return
    case 'state': {
      const allowed = ['ACTIVE', 'PENDING', 'FAILED', 'LOADING', 'UNLOADING', 'DISPOSED']
      const upper = String(value).toUpperCase()
      if (!allowed.includes(upper)) {
        errors.push(`unknown state '${value}' (expected one of: ${allowed.join('|')})`)
        return
      }
      options.state = upper
      return
    }
    case 'not-active':
      options.notActive = true
      return
    case 'limit': {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) {
        errors.push(`--limit needs a non-negative number, got '${value}'`)
        return
      }
      options.limit = Math.floor(n)
      return
    }
    case 'since': {
      const n = Number(value)
      if (!Number.isFinite(n)) {
        errors.push(`--since needs a number, got '${value}'`)
        return
      }
      options.since = Math.floor(n)
      return
    }
    case 'errors':
      options.errorsOnly = true
      return
    case 'verbose':
      options.verbose = true
      return
    case 'json':
      options.json = true
      return
    default:
      errors.push(`unknown option '--${key}'`)
  }
}

/**
 * Execute one `/debug` invocation.
 *
 * @param {string} input
 * @param {object} debuggerApi
 * @returns {{ok: boolean, output: string, json: object|null}}
 */
export function runCommand(input, debuggerApi) {
  const { subcommand, positional, options, errors } = parseArgs(input)
  const { recorder, inspector, config, probes } = debuggerApi

  if (errors.length) {
    return fail(errors.join('\n'), options, { usage: true })
  }
  if (!SUBCOMMANDS.includes(subcommand)) {
    return fail(
      `unknown subcommand '${subcommand}'\nexpected one of: ${SUBCOMMANDS.join(', ')}`,
      options,
    )
  }

  switch (subcommand) {
    case 'health': {
      const snapshot = inspector.snapshot()
      const stats = recorder.stats()
      const body = { counts: snapshot.counts, findings: snapshot.findings, stats, probes }
      return options.json
        ? ok(renderJson('health', body), body)
        // `-v` suppresses the source-breakpoint note (§6.5): a user who wants the
        // full picture has already read it once.
        : ok(renderHealth(snapshot, stats, probes, { showSourceDebugHint: !options.verbose }), null)
    }

    case 'plugins': {
      const snapshot = inspector.snapshot()

      // An author's real question is "is MY plugin here, and is it healthy?" —
      // not "list all 200 plugins". Measured on a real web composition:
      // 201 plugins, 117 distinct names, 45 rows rendering as an
      // unidentifiable `apply (fiber N)`. Filtering is what makes the
      // documented loop ("if PENDING, go fix inject") practical.
      const filtered = filterPlugins(snapshot.plugins, {
        name: options.name,
        state: options.state,
        notActive: options.notActive,
      })

      const body = {
        plugins: filtered,
        findings: snapshot.findings,
        degraded: snapshot.degraded,
        // Say what was filtered, so a narrowed list is never mistaken for the
        // whole composition — a silent filter is its own kind of false green.
        ...(filtered.length === snapshot.plugins.length
          ? {}
          : { filteredFrom: snapshot.plugins.length }),
      }
      return options.json
        ? ok(renderJson('plugins', body), body)
        : ok(renderPlugins({ ...snapshot, plugins: filtered }, {
          filterNote: filtered.length === snapshot.plugins.length
            ? null
            : `showing ${filtered.length} of ${snapshot.plugins.length}`,
        }), null)
    }

    case 'services': {
      const snapshot = inspector.snapshot()
      const body = { services: snapshot.services, degraded: snapshot.degraded }
      return options.json
        ? ok(renderJson('services', body), body)
        : ok(renderServices(snapshot), null)
    }

    case 'events': {
      const records = recorder.query({
        category: options.category,
        name: options.name,
        source: options.source,
        since: options.since,
        errorsOnly: options.errorsOnly,
        limit: options.limit ?? 40,
      })
      const body = { records, count: records.length }
      return options.json
        ? ok(renderJson('events', body), body)
        : ok(renderRecords(records, { verbose: options.verbose }), null)
    }

    case 'trace': {
      const id = positional[0]
      if (!id) return fail('usage: /debug trace <id>', options)
      const records = recorder.trace(id)
      const body = { correlation: id, records, count: records.length }
      return options.json
        ? ok(renderJson('trace', body), body)
        : ok(renderTrace(id, records, { verbose: options.verbose }), null)
    }

    case 'stats': {
      const stats = recorder.stats()
      return options.json ? ok(renderJson('stats', stats), stats) : ok(renderStats(stats), null)
    }

    case 'config': {
      // `/debug config capacity=5000 on=false` mutates; bare `/debug config` reads.
      if (!positional.length) {
        const body = { config: { ...config } }
        return options.json ? ok(renderJson('config', body), body) : ok(renderConfig(config), null)
      }
      return applyConfigChanges(positional, debuggerApi, options)
    }

    case 'clear': {
      recorder.clear()
      const body = { cleared: true }
      return options.json ? ok(renderJson('clear', body), body) : ok('timeline cleared (counters kept)', null)
    }

    default:
      return fail(`unhandled subcommand '${subcommand}'`, options)
  }
}

/**
 * Apply `key=value` mutations from `/debug config`.
 *
 * @param {string[]} assignments
 * @param {object} debuggerApi
 * @param {object} options
 * @returns {{ok: boolean, output: string, json: object|null}}
 */
function applyConfigChanges(assignments, debuggerApi, options) {
  const { recorder, config } = debuggerApi
  const applied = []
  const errors = []

  for (const assignment of assignments) {
    const eq = assignment.indexOf('=')
    if (eq === -1) {
      errors.push(`expected key=value, got '${assignment}'`)
      continue
    }
    const key = assignment.slice(0, eq)
    const raw = assignment.slice(eq + 1)

    switch (key) {
      case 'capacity': {
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 1) {
          errors.push(`capacity needs a positive number, got '${raw}'`)
          continue
        }
        config.capacity = recorder.setCapacity(Math.floor(n))
        applied.push(`capacity=${config.capacity}`)
        break
      }
      case 'on': {
        if (raw !== 'true' && raw !== 'false') {
          errors.push(`on needs true or false, got '${raw}'`)
          continue
        }
        config.enabled = raw === 'true'
        applied.push(`on=${config.enabled}`)
        break
      }
      default:
        errors.push(`unknown config key '${key}'`)
    }
  }

  if (errors.length) return fail(errors.join('\n'), options)
  const body = { applied, config: { ...config } }
  return options.json
    ? ok(renderJson('config', body), body)
    : ok(`applied: ${applied.join(' ')}`, null)
}

/**
 * @param {string} output
 * @param {object|null} json
 */
function ok(output, json) {
  return { ok: true, output, json }
}

/**
 * @param {string} message
 * @param {object} options
 * @param {object} [extra]
 */
function fail(message, options, extra = {}) {
  const body = { error: message, ...extra }
  return {
    ok: false,
    output: options.json ? renderJson('error', body) : message,
    json: options.json ? body : null,
  }
}
