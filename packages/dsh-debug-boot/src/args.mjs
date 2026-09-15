/**
 * Argument parsing for `debug-boot`.
 *
 * Pure: it turns an argv array into a validated options object and never touches
 * the filesystem, the network, or the process. That separation is what lets the
 * whole CLI surface be unit-tested without launching a real DSH — the design
 * document's "keep pure logic separable from process-spawning side effects".
 */

/** Defaults fixed by 功能文档 §6.1 and 设计文档 §5. */
export const DEFAULTS = Object.freeze({
  /** Profile name to derive. Deliberately not `web`, so the daily profile is never touched. */
  profile: 'dbgtest',
  /** The shipped template the new profile is derived from. */
  fromDefaultProfile: 'web',
  /** Loopback only: 设计文档 §9 forbids turning DevKit into a 0.0.0.0 gateway. */
  host: '127.0.0.1',
  /** Debug port, distinct from the daily instance's 3080. */
  port: 8080,
})

/** Options that take a value, as `--name <value>` or `--name=value`. */
const VALUE_OPTIONS = new Set([
  'profile',
  'from-default-profile',
  'port',
  'host',
  'plugin',
  'patch',
  'dsh-home',
  'overlay',
])

/** Boolean flags. */
const FLAG_OPTIONS = new Set(['no-open', 'help', 'json', 'dry-run', 'no-debugger'])

/**
 * Parse and validate an argv array.
 *
 * Returns `{ errors }` rather than throwing, so the CLI can print a complete
 * usage message listing *every* problem instead of only the first.
 *
 * @param {string[]} argv arguments after the script name
 * @returns {{
 *   profile: string, fromDefaultProfile: string, host: string, port: number,
 *   plugin: string|null, patches: string[], dshHome: string|null,
 *   overlay: string|null, open: boolean, includeDebugger: boolean,
 *   help: boolean, json: boolean, errors: string[]
 * }}
 */
export function parseArgs(argv = []) {
  const options = {
    profile: DEFAULTS.profile,
    fromDefaultProfile: DEFAULTS.fromDefaultProfile,
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    plugin: null,
    patches: [],
    dshHome: null,
    overlay: null,
    open: true,
    includeDebugger: true,
    help: false,
    json: false,
    dryRun: false,
    errors: [],
  }

  // Normalize `--name=value` into a two-token form so one loop handles both
  // spellings; the CLI shape in 设计文档 §5 uses the two-token form.
  const tokens = []
  for (const arg of argv) {
    if (typeof arg !== 'string') continue
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    if (match) tokens.push(`--${match[1]}`, match[2])
    else tokens.push(arg)
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]

    if (token === '--') {
      // Everything after `--` is an inner argument for the booted app.
      // Unsupported on purpose: passing through unknown inner args would make
      // the port/URL this CLI prints a guess rather than a statement of fact.
      const rest = tokens.slice(i + 1)
      if (rest.length) options.errors.push(`unexpected arguments after '--': ${rest.join(' ')}`)
      break
    }

    if (!token.startsWith('-')) {
      options.errors.push(`unexpected argument '${token}'`)
      continue
    }

    const name = token.startsWith('--') ? token.slice(2) : token.slice(1)

    if (name === 'no-open') {
      options.open = false
      continue
    }

    if (name === 'h') {
      options.help = true
      continue
    }

    if (FLAG_OPTIONS.has(name)) {
      if (name === 'help') options.help = true
      if (name === 'json') options.json = true
      if (name === 'dry-run') options.dryRun = true
      if (name === 'no-debugger') options.includeDebugger = false
      continue
    }

    if (!VALUE_OPTIONS.has(name)) {
      options.errors.push(`unknown option '--${name}'`)
      continue
    }

    const value = tokens[i + 1]
    if (value === undefined || value.startsWith('-')) {
      options.errors.push(`--${name} needs a value`)
      continue
    }
    i += 1
    applyValue(options, name, value)
  }

  return options
}

/**
 * Apply one validated option value.
 *
 * @param {object} options mutated in place
 * @param {string} name
 * @param {string} value
 */
function applyValue(options, name, value) {
  switch (name) {
    case 'profile':
      if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
        options.errors.push(`--profile '${value}' is invalid (expected lowercase letters, digits and hyphens)`)
        return
      }
      options.profile = value
      return

    case 'from-default-profile':
      if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
        options.errors.push(`--from-default-profile '${value}' is invalid`)
        return
      }
      options.fromDefaultProfile = value
      return

    case 'port': {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        options.errors.push(`--port '${value}' is not a valid port (0-65535)`)
        return
      }
      options.port = port
      return
    }

    case 'host':
      options.host = value
      return

    case 'plugin':
      options.plugin = value
      return

    case 'patch':
      options.patches.push(value)
      return

    case 'dsh-home':
      options.dshHome = value
      return

    case 'overlay':
      options.overlay = value
      return

    default:
      options.errors.push(`unhandled option '--${name}'`)
  }
}

/** Usage text. Mirrors the CLI shape in 设计文档 §5. */
export const USAGE = `debug-boot — boot an isolated DSH profile for plugin development

Usage:
  debug-boot [--plugin <dir-or-entry>] [options]

Options:
  --plugin <path>          plugin under test: a directory or an entry file
  --profile <name>         profile to derive            (default: ${DEFAULTS.profile})
  --from-default-profile <name>
                           shipped template to derive from (default: ${DEFAULTS.fromDefaultProfile})
  --port <n>               debug port                   (default: ${DEFAULTS.port})
  --host <addr>            listen address               (default: ${DEFAULTS.host})
  --patch <path>           extra overlay, repeatable
  --overlay <path>         write the generated overlay here instead of the profile
  --dsh-home <path>        override DSH_HOME
  --no-open                do not open a browser
  --no-debugger            do not insert the dsh-debugger row
  --json                   emit the resolved plan as JSON
  --dry-run                resolve and report, then exit without booting
  -h, --help               print this help

Booting is what this command does, so a run without --dry-run starts a real DSH
and stays in the foreground until it exits. Use --dry-run to inspect the plan
(alone, or with --json for scripting) and return immediately.

The derived profile is created from the shipped template, so third-party
plugins installed in your daily 'web' profile are never copied in.
`
