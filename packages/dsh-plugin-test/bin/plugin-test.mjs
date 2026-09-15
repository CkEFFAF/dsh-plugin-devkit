#!/usr/bin/env node
/**
 * `dsh-plugin-test` CLI.
 *
 * 功能文档 §6.3 asks for "a CLI or test entry that outputs a JSON report
 * (pass / fail / overflow counts)". This is that entry: it loads a test module
 * the author wrote, runs its exported cases against a real debugger mounted on a
 * fake host, and prints the report.
 *
 * ## Why the author supplies the module
 *
 * DevKit tests the *diagnostic facility*; the author's business assertions are
 * theirs to write. So this CLI supplies the host, the debugger, and the report
 * shape, and the module under test supplies the cases. That keeps the package
 * useful without pretending to know what any particular plugin should do.
 *
 * ## Module contract
 *
 * The module exports `cases`, an array of `{ name, run }` where `run` receives
 * `{ ctx, debugger, host }` and returns an assertion result or a boolean:
 *
 * ```js
 * export const cases = [
 *   { name: 'no plugin is pending', run: ({ debugger }) => noPending(debugger) },
 * ]
 * ```
 *
 * ## Exit codes
 *
 * `0` all cases passed, `1` a case failed, `2` usage error, `3` the module could
 * not be loaded.
 */

import { pathToFileURL } from 'node:url'
import { resolve, join, dirname } from 'node:path'
import { existsSync, statSync, readFileSync } from 'node:fs'

import { isMainModule } from '../src/main-module.mjs'

import { apply } from '../../dsh-debugger/index.mjs'
import { createFakeContext, createFakeCommands } from '../src/fake-host.mjs'
import { runCases, renderReportJson, renderReportSummary } from '../src/report.mjs'

/** Exit codes, documented above. */
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, LOAD: 3 })

const USAGE = `dsh-plugin-test — run host contract tests and print a JSON report

Usage:
  dsh-plugin-test <module.mjs> [options]

Options:
  --plugin <path>  the plugin under test: a directory or an entry file.
                   Defaults to the package beside the test module, or to the
                   plugin the module exports as \\\`plugin\\\`.
  --json           print the report as JSON (default when not a TTY)
  --quiet          print only the one-line summary
  --capacity <n>   debugger buffer capacity (default 1000)
  -h, --help       show this help

The module must export \\\`cases\\\`: an array of { name, run }.
Each \\\`run\\\` receives { ctx, debugger, host, plugin, pluginError } and returns an
assertion result ({ ok, message }), a boolean, or nothing at all — returning
nothing means the case passed, so the usual "throw on failure" style works.
`

/**
 * Parse argv.
 *
 * @param {string[]} argv
 * @returns {{module: string|null, json: boolean, quiet: boolean, capacity: number, plugin: string|null, help: boolean}}
 */
export function parseArgs(argv) {
  const options = {
    module: null, json: false, quiet: false, capacity: 1000, plugin: null, help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '-h' || token === '--help') options.help = true
    else if (token === '--json') options.json = true
    else if (token === '--quiet') options.quiet = true
    else if (token === '--plugin') {
      options.plugin = argv[i + 1] ?? null
      i += 1
    } else if (token === '--capacity') {
      const value = Number(argv[i + 1])
      if (Number.isFinite(value) && value > 0) options.capacity = Math.floor(value)
      i += 1
    } else if (!token.startsWith('-') && options.module === null) options.module = token
  }
  return options
}

/**
 * Load a test module and run its cases.
 *
 * ## The plugin under test is mounted
 *
 * The host starts with `commands` + the debugger, and then **the plugin under
 * test is applied to it** before any case runs. Without that final step the
 * cases could only inspect the composition, never the plugin's own service,
 * command or tool — which is what a host contract test is for. (This was a real
 * defect: the CLI used to mount only the debugger, so `ctx.get('<your service>')`
 * was always absent and no case could pass.)
 *
 * The plugin is located, in order:
 *
 * 1. `--plugin <path>` — an entry file or a directory containing one.
 * 2. `export const plugin` in the test module — for a plugin that needs setup.
 * 3. `package.json`'s `main`/`exports['.']` beside the test module, walking up.
 *
 * A run with no resolvable plugin is reported as a usage error rather than
 * silently testing an empty composition, because that silent case is exactly
 * how the original defect hid.
 *
 * @param {string} modulePath
 * @param {{capacity?: number, plugin?: string|null, cwd?: string}} [options]
 * @returns {Promise<object>} the report
 */
export async function runModule(modulePath, options = {}) {
  const absolute = resolve(modulePath)
  if (!existsSync(absolute)) {
    const error = new Error(`test module not found: ${absolute}`)
    error.code = 'MODULE_NOT_FOUND'
    throw error
  }

  // A cache-busting query keeps repeated runs in one process honest.
  const imported = await import(`${pathToFileURL(absolute).href}?t=${Date.now()}`)
  const cases = imported.cases ?? imported.default?.cases
  if (!Array.isArray(cases)) {
    const error = new Error(`test module must export an array 'cases': ${absolute}`)
    error.code = 'NO_CASES'
    throw error
  }

  const resolvedPlugin = await resolvePlugin(imported, absolute, options)
  if (!resolvedPlugin.ok) {
    const error = new Error(resolvedPlugin.reason)
    error.code = 'NO_PLUGIN'
    error.hints = resolvedPlugin.hints
    throw error
  }

  // One host and one debugger for the whole run: the cases observe a single
  // composition, which is what makes their findings comparable.
  const ctx = createFakeContext({ services: { commands: createFakeCommands() } })
  const debuggerService = apply(ctx, { capacity: options.capacity ?? 1000 })

  // Mount the plugin under test on the same host, AFTER the debugger, so the
  // cases can inspect both the plugin and the composition it joined.
  let pluginApi
  let pluginError = null
  try {
    pluginApi = resolvedPlugin.apply(ctx, resolvedPlugin.config)
  } catch (error) {
    // A plugin that throws on mount is a legitimate finding, not a crash: the
    // report must still be produced so the author sees it.
    pluginError = error
  }

  const bound = cases.map((entry) => ({
    name: entry.name ?? '(unnamed)',
    run: () => entry.run({
      ctx,
      debugger: debuggerService,
      host: ctx,
      plugin: pluginApi,
      pluginError,
    }),
  }))

  const report = await runCases(bound, {
    suite: imported.suite ?? absolute,
    debugger: debuggerService,
  })

  // Surface the mount result alongside the cases, so a plugin that failed to
  // mount cannot read as "every case happened to pass".
  report.plugin = {
    module: resolvedPlugin.module,
    source: resolvedPlugin.source,
    mounted: pluginError === null,
    ...(pluginError === null ? {} : { error: pluginError.message }),
  }
  if (pluginError !== null) report.ok = false

  // Unload the plugin so any wrapper it installed is restored before the process
  // exits. A test runner that leaves `console` patched is its own bug.
  try {
    ctx.disposeAll()
  } catch {
    // best effort
  }

  return report
}

/**
 * Locate the plugin under test.
 *
 * @param {object} imported the test module's exports
 * @param {string} absolute the test module's absolute path
 * @param {{plugin?: string|null, cwd?: string}} options
 * @returns {Promise<object>} a descriptor, or a failure with hints
 */
async function resolvePlugin(imported, absolute, options) {
  // An explicit `--plugin` is authoritative: if the author named a path, a typo
  // must fail loudly rather than silently falling back to something else. This
  // is the same silent-failure class the mount fix exists to remove.
  if (options.plugin) {
    const target = resolve(options.cwd ?? process.cwd(), options.plugin)
    return loadPluginFrom(target, `--plugin ${options.plugin}`)
  }

  // An explicit plugin exported by the test module. This wins over the package
  // beside it because it is the only form that can carry per-test configuration.
  const exported = imported.plugin ?? imported.default?.plugin
  if (exported && typeof exported.apply === 'function') {
    return {
      ok: true,
      apply: exported.apply,
      module: exported.name ?? '(exported plugin)',
      source: 'exported by the test module',
      config: imported.pluginConfig ?? imported.default?.pluginConfig,
    }
  }

  // The package beside the test module.
  const beside = findPackageEntry(absolute)
  if (beside) return loadPluginFrom(beside, 'the package.json beside the test module')

  return {
    ok: false,
    reason: 'no plugin under test could be located',
    hints: [
      'pass --plugin <dir-or-entry>, or',
      'export the plugin from the test module: export const plugin = { apply }',
      'a run without a plugin can only inspect the composition, not your plugin',
    ],
  }
}

/**
 * Import a plugin entry and validate that it looks like a DSH plugin.
 *
 * @param {string} target an absolute path
 * @param {string} source how it was found, for the report
 * @returns {Promise<object>}
 */
async function loadPluginFrom(target, source) {
  const entry = resolveEntryFile(target)
  if (!entry) {
    return {
      ok: false,
      reason: `no plugin entry file found at ${target}`,
      hints: ['expected index.mjs, index.js, main.mjs or main.js in that directory'],
    }
  }
  let module
  try {
    module = await import(pathToFileURL(entry).href)
  } catch (error) {
    return {
      ok: false,
      reason: `could not import ${entry}: ${error?.message ?? error}`,
      hints: ['fix the import error above, then re-run'],
    }
  }
  if (typeof module.apply !== 'function') {
    return {
      ok: false,
      reason: `${entry} does not export apply()`,
      hints: ['a DSH plugin exports { name, apply, inject? }'],
    }
  }
  return {
    ok: true,
    apply: module.apply,
    module: module.name ?? '(unnamed plugin)',
    source,
  }
}

/**
 * Resolve a directory to its entry file, or accept a file directly.
 *
 * @param {string} target
 * @returns {string|null}
 */
function resolveEntryFile(target) {
  if (!existsSync(target)) return null
  // A file is taken as-is.
  if (!statSync(target).isDirectory()) return target
  for (const candidate of ['index.mjs', 'index.js', 'index.cjs', 'main.mjs', 'main.js']) {
    const full = join(target, candidate)
    if (existsSync(full)) return full
  }
  return null
}

/**
 * Walk up from the test module looking for a package.json with an entry.
 *
 * @param {string} from absolute path of the test module
 * @returns {string|null}
 */
function findPackageEntry(from) {
  let dir = dirname(from)
  for (let depth = 0; depth < 4; depth += 1) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
        const declared = typeof pkg.exports === 'object'
          ? pkg.exports?.['.'] ?? null
          : pkg.exports ?? null
        const rel = typeof declared === 'string' ? declared : (pkg.main ?? null)
        if (typeof rel === 'string') {
          const entry = resolve(dir, rel)
          if (existsSync(entry)) return entry
        }
        // A manifest with no usable entry: fall back to a conventional file.
        const fallback = resolveEntryFile(dir)
        if (fallback) return fallback
      } catch {
        // A malformed manifest is not this tool's problem; keep walking.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help || !options.module) {
    process.stdout.write(USAGE)
    process.exit(options.help ? EXIT.OK : EXIT.USAGE)
  }

  let report
  try {
    report = await runModule(options.module, {
      capacity: options.capacity,
      plugin: options.plugin,
    })
  } catch (error) {
    process.stderr.write(`dsh-plugin-test: ${error.message}\n`)
    for (const hint of error.hints ?? []) process.stderr.write(`hint: ${hint}\n`)
    const loadCodes = ['MODULE_NOT_FOUND', 'NO_CASES', 'NO_PLUGIN']
    process.exit(loadCodes.includes(error.code) ? EXIT.LOAD : EXIT.FAILED)
  }

  const asJson = options.json || !process.stdout.isTTY
  if (options.quiet) {
    process.stdout.write(`${renderReportSummary(report)}\n`)
  } else if (asJson) {
    process.stdout.write(`${renderReportJson(report)}\n`)
  } else {
    // Naming the plugin under test removes the doubt the old output left: a
    // passing run used to be indistinguishable from a run against nothing.
    process.stdout.write(`plugin under test: ${report.plugin?.module ?? '(none)'} (${report.plugin?.source ?? '?'})\n`)
    process.stdout.write(`${renderReportSummary(report)}\n\n`)
    for (const entry of report.cases) {
      process.stdout.write(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.ok ? '' : `\n        ${entry.message}`}\n`)
    }
  }

  process.exit(report.ok ? EXIT.OK : EXIT.FAILED)
}

// Only run when invoked directly, so the module stays importable for tests.
//
// ## Why this is not a plain `import.meta.url === pathToFileURL(argv[1])`
//
// That comparison fails whenever the script is reached through a symlink, and
// npm makes one for every `file:` / local install on Windows (a Junction under
// node_modules). Node resolves the module through the link, so `import.meta.url`
// is the REAL path while `argv[1]` is the LINK path; they never match, `main()`
// is skipped, and the process exits 0 with no output at all — a silent success
// for a command that did nothing.
//
// Both sides are therefore resolved to a real path before comparing, and the
// comparison is case-insensitive on Windows, where the same path can differ in
// case between the two sources.
if (isMainModule(import.meta.url)) {
  await main()
}
