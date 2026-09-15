/**
 * The boot plan: everything decided before any process is spawned.
 *
 * `planBoot` is pure apart from injectable probes. It resolves the plugin entry,
 * builds the overlay, checks the template and port, and returns either a complete
 * plan or a structured failure. The CLI's only remaining job is to act on it —
 * write the overlay, spawn `dsh`, print the result.
 *
 * That split is why the whole CLI is testable without launching a real DSH.
 */

import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { parseArgs, DEFAULTS } from './args.mjs'
import { resolvePluginEntry, toFileUrl } from './entry.mjs'
import { buildOverlayRows, renderOverlay, derivePluginId, DEBUGGER_ID } from './overlay.mjs'
import { FAILURE, bootFailure, bootSuccess } from './failures.mjs'
import { resolveDshHome, checkTemplate, checkPort, profileDir } from './preflight.mjs'

/**
 * List a directory's entries, or return `[]` when it cannot be read.
 *
 * `[]` is treated as "empty" by the caller, which then clears the directory —
 * so an unreadable directory is also the safe thing to clear, since nothing in
 * it can be a user's profile content.
 *
 * @param {string} dir
 * @param {{readdir?: (path: string) => string[]}} deps
 * @returns {string[]}
 */
function listDir(dir, deps = {}) {
  const readdir = deps.readdir ?? defaultReaddir
  try {
    return readdir(dir)
  } catch {
    return []
  }
}

/** Default directory lister. */
function defaultReaddir(path) {
  return readdirSync(path)
}

/**
 * Describe a thrown value for a failure detail.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeThrown(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Locate the dsh-debugger entry shipped alongside this package.
 *
 * `--no-debugger` exists so the CLI can still boot a substrate without the
 * kernel; the default keeps them together, which is the product's point.
 *
 * @param {{exists?: (path: string) => boolean}} [deps]
 * @returns {string|null}
 */
export function findDebuggerEntry(deps = {}) {
  const exists = deps.exists ?? existsSync
  // packages/dsh-debug-boot/src -> packages/dsh-debugger/index.mjs
  const candidate = resolve(import.meta.dirname, '..', '..', 'dsh-debugger', 'index.mjs')
  return exists(candidate) ? candidate : null
}

/**
 * Build a complete boot plan.
 *
 * @param {string[]} argv
 * @param {{
 *   cwd?: string, env?: object, exists?: Function, readFile?: Function,
 *   listen?: Function, debuggerEntry?: string|null, hostname?: string
 * }} [deps]
 * @returns {Promise<object>} a bootSuccess or bootFailure value
 */
export async function planBoot(argv, deps = {}) {
  const options = parseArgs(argv)

  if (options.help) {
    return bootSuccess({ help: true, options })
  }

  if (options.errors.length) {
    return bootFailure(FAILURE.USAGE, 'invalid arguments', {
      detail: options.errors.map((e) => `  - ${e}`).join('\n'),
    })
  }

  // ---------------------------------------------------------------- plugin --
  let pluginEntry = null
  let pluginId = null
  if (options.plugin) {
    const resolved = resolvePluginEntry(options.plugin, {
      cwd: deps.cwd,
      exists: deps.exists,
      readFile: deps.readFile,
    })
    if (!resolved.ok) {
      return bootFailure(FAILURE.PLUGIN_UNRESOLVED, resolved.reason ?? 'could not resolve the plugin entry', {
        detail: resolved.candidates.length
          ? `tried:\n${resolved.candidates.map((c) => `  - ${c}`).join('\n')}`
          : null,
        hints: [
          'pass either a directory containing index.mjs, or the entry file itself',
          "Node's ESM import() cannot import a directory, so --plugin must resolve to a file",
        ],
      })
    }
    pluginEntry = resolved.entry
    pluginId = derivePluginId(pluginEntry)
  }

  // --------------------------------------------------------------- overlay --
  const debuggerEntry = deps.debuggerEntry !== undefined
    ? deps.debuggerEntry
    : findDebuggerEntry({ exists: deps.exists })

  if (options.includeDebugger && !debuggerEntry) {
    return bootFailure(FAILURE.OVERLAY_INVALID, 'the dsh-debugger entry could not be located', {
      detail: 'expected packages/dsh-debugger/index.mjs beside this package',
      hints: ['pass --no-debugger to boot without the observation kernel'],
    })
  }

  let rows
  try {
    rows = buildOverlayRows({
      pluginEntry,
      pluginId,
      debuggerEntry: options.includeDebugger ? debuggerEntry : null,
      includeDebugger: options.includeDebugger,
    })
  } catch (error) {
    // `assertEntryFile` is the guard that keeps a directory out of the overlay.
    return bootFailure(FAILURE.OVERLAY_INVALID, error.message, {
      hints: ["the overlay `name` must be a file: Node's ESM import() cannot directory-import"],
    })
  }

  const overlayText = renderOverlay(rows)

  // -------------------------------------------------------------- preflight --
  const dshHome = resolveDshHome({ env: deps.env, override: options.dshHome })
  const template = checkTemplate(options.fromDefaultProfile, dshHome, {
    exists: deps.exists,
    names: deps.names,
  })

  if (!template.ok) {
    return bootFailure(FAILURE.TEMPLATE_MISSING, template.reason, {
      detail: template.available.length
        ? `available profiles: ${template.available.join(', ')}`
        : `no profiles exist under ${join(dshHome, 'profiles')}`,
      hints: [
        `initialize it first: dsh --profile ${options.fromDefaultProfile}`,
        'or point --dsh-home at the DSH_HOME that has it',
      ],
    })
  }

  const port = await checkPort(options.port, options.host, { listen: deps.listen })
  if (!port.ok) {
    return bootFailure(FAILURE.PORT_IN_USE, port.reason, {
      hints: [
        `choose another port: --port ${options.port + 1}`,
        'or stop the process already listening on it',
      ],
    })
  }

  // ----------------------------------------------------------------- profile --
  //
  // DSH has THREE profile states, not two, and each needs different flags. This
  // was discovered by actually booting, not by reading:
  //
  //   1. directory absent                -> pass --from-default-profile; DSH
  //                                         initializes it (profile-boot.ts:127).
  //   2. directory + package.json        -> omit the flag; DSH loads it
  //                                         (profile.ts:820).
  //   3. directory, NO package.json      -> NEITHER works. --from-default-profile
  //                                         refuses on the existing directory
  //                                         (profile-boot.ts:137), and omitting it
  //                                         fails with "profile does not exist"
  //                                         (profile.ts:823). This is a corrupt
  //                                         leftover, usually from an interrupted
  //                                         initialization.
  //
  // State 3 is reported rather than silently worked around: deleting a user's
  // profile directory is destructive, so the CLI names the exact remedy and lets
  // them choose.
  const target = profileDir(dshHome, options.profile)
  const exists = deps.exists ?? existsSync
  const profileDirExists = exists(target)
  const profileManifestExists = exists(join(target, 'package.json'))

  if (profileDirExists && !profileManifestExists) {
    const contents = listDir(target, deps)
    // A directory holding nothing but our own overlay is a leftover from an
    // earlier version of this tool, which used to write it into the profile.
    // It is removed rather than reported: the user never put anything there, and
    // removing it is what makes the documented first run work.
    const onlyOurOverlay = contents.length > 0
      && contents.every((name) => name === 'debug-boot.overlay.yml')

    if (onlyOurOverlay || contents.length === 0) {
      try {
        rmSync(target, { recursive: true, force: true })
      } catch (error) {
        return bootFailure(FAILURE.PROFILE_CORRUPT, `could not clear the stale profile directory ${target}`, {
          detail: describeThrown(error),
          hints: [`remove it manually: rmdir /s /q "${target}"`],
        })
      }
    } else {
      // Real user content: refuse rather than delete anything.
      return bootFailure(
        FAILURE.PROFILE_CORRUPT,
        `profile directory ${target} exists but has no package.json`,
        {
          detail:
            'This directory is not a usable profile: DSH refuses to initialize over it and '
            + `refuses to load it. It contains: ${contents.join(', ')}`,
          hints: [
            `remove it: rmdir /s /q "${target}"    (or use a different name: --profile ${options.profile}2)`,
            're-running without removing it cannot succeed by design',
          ],
        },
      )
    }
  }

  // ------------------------------------------------------------------ output --
  //
  // The overlay must NOT live inside the profile directory before that profile
  // is initialized. Writing it there creates the directory, and DSH then refuses
  // to initialize over it ("profile directory ... already exists",
  // profile-boot.ts:137) — so the very act of writing the overlay would break the
  // first boot. This was found by an actual boot: every fresh profile failed with
  // a directory containing nothing but our overlay file.
  //
  // It therefore goes beside the profiles, in DSH_HOME/debug-boot/, still
  // overwritten on every run so it can never go stale.
  const overlayPath = options.overlay
    ? resolve(deps.cwd ?? process.cwd(), options.overlay)
    : join(dshHome, 'debug-boot', `${options.profile}.overlay.yml`)

  // Extra `--patch` overlays are forwarded after the generated one, so the
  // generated rows win on an id collision and the debug wiring stays intact.
  const patches = [overlayPath, ...options.patches.map((p) => resolve(deps.cwd ?? process.cwd(), p))]

  // `profileInitialized` is true exactly when DSH should NOT be told to
  // initialize, i.e. when a manifest is already present.
  const profileInitialized = profileManifestExists

  return bootSuccess({
    help: false,
    options,
    pluginEntry,
    pluginId,
    debuggerEntry: options.includeDebugger ? debuggerEntry : null,
    overlayRows: rows,
    overlayText,
    overlayPath,
    dshHome,
    profileDir: target,
    templateDir: template.dir,
    patches,
    profileInitialized,
    // The argv the CLI hands to `dsh`. Built here, not in the CLI, so tests can
    // assert the exact invocation without spawning anything.
    dshArgs: buildDshArgs(options, patches, { profileInitialized }),
    url: `http://${options.host}:${options.port}/`,
  })
}

/**
 * Build the `dsh` argv for a plan.
 *
 * Shape verified against `apps/cli/src/args.ts`: launcher flags come first and
 * end at the first token the launcher does not know, so the web app's own
 * `--port` / `--no-open` must come *after* the launcher flags.
 *
 * `--from-default-profile` is emitted **only** when the profile has not been
 * initialized yet. DSH treats it as an initialization directive and refuses to
 * boot an existing profile with it, so always passing it makes the second run of
 * this CLI fail — which is exactly what a real boot revealed.
 *
 * @param {object} options
 * @param {string[]} patches
 * @param {{profileInitialized?: boolean}} [state]
 * @returns {string[]}
 */
export function buildDshArgs(options, patches, state = {}) {
  const args = ['--profile', options.profile]
  if (!state.profileInitialized) {
    args.push('--from-default-profile', options.fromDefaultProfile)
  }
  for (const patch of patches) args.push('--patch', patch)

  // Inner arguments for the booted web app. `--no-open` is the web app's flag,
  // not the launcher's: it is parsed by the `web-startup` row.
  args.push('--port', String(options.port), '--host', options.host)
  if (!options.open) args.push('--no-open')

  return args
}

/**
 * Write the overlay to disk.
 *
 * Side effecting, and kept out of `planBoot` so planning stays pure. The overlay
 * lives inside the derived profile directory, which DSH creates on first boot;
 * the directory is created here because the overlay is needed *during* that boot.
 *
 * @param {object} plan
 * @param {{writeFile?: Function, mkdir?: Function}} [deps]
 */
export function writeOverlay(plan, deps = {}) {
  const writeFile = deps.writeFile ?? writeFileSync
  const mkdir = deps.mkdir ?? mkdirSync
  mkdir(dirname(plan.overlayPath), { recursive: true })
  writeFile(plan.overlayPath, plan.overlayText, 'utf8')
  return plan.overlayPath
}

/**
 * Render the boot banner.
 *
 * 功能文档 §6.1 requires four things in the output: profile path, URL, token
 * hint, and the `/debug health` hint.
 *
 * @param {object} plan
 * @returns {string}
 */
export function renderBootBanner(plan) {
  const lines = [
    `debug-boot: isolated profile '${plan.options.profile}' from template '${plan.options.fromDefaultProfile}'`,
    `  profile   ${plan.profileDir}`,
    `  overlay   ${plan.overlayPath}`,
    `  plugin    ${plan.pluginEntry ?? '(none: kernel only)'}${plan.pluginId ? `  [${plan.pluginId}]` : ''}`,
    `  kernel    ${plan.debuggerEntry ?? '(disabled)'}`,
    `  url       ${plan.url}`,
  ]

  if (plan.options.open) {
    lines.push('            (a browser will open; the printed URL carries the session token)')
  } else {
    lines.push('            (--no-open: open it yourself; the URL line below carries the token)')
  }

  lines.push(
    '',
    plan.profileInitialized
      ? `  note      profile exists; patching it in place (not re-deriving)`
      : `  note      profile will be initialized from the '${plan.options.fromDefaultProfile}' template`,
    `  token     printed by dsh on the "dsh web:" line below; it is per-process and never stored`,
  )

  if (plan.debuggerEntry) {
    lines.push(`  next      run /debug health once the session is up`)
  }

  lines.push(
    '',
    'This instance is isolated: your daily profile is not modified and its port is untouched.',
  )

  return lines.join('\n')
}

/**
 * Render the plan as JSON for `--json`.
 *
 * @param {object} plan
 * @returns {string}
 */
export function renderBootJson(plan) {
  return JSON.stringify({
    profile: plan.options.profile,
    fromDefaultProfile: plan.options.fromDefaultProfile,
    profileDir: plan.profileDir,
    profileInitialized: plan.profileInitialized,
    overlayPath: plan.overlayPath,
    overlay: plan.overlayRows,
    pluginEntry: plan.pluginEntry,
    pluginId: plan.pluginId,
    debuggerEntry: plan.debuggerEntry,
    dshHome: plan.dshHome,
    host: plan.options.host,
    port: plan.options.port,
    url: plan.url,
    dshArgs: plan.dshArgs,
  }, null, 2)
}

export { DEFAULTS, DEBUGGER_ID, toFileUrl }
