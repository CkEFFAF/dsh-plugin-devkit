#!/usr/bin/env node
/**
 * `debug-boot` — boot an isolated DSH profile for plugin development.
 *
 * Thin by design: it plans (`planBoot`), acts (write the overlay, spawn `dsh`),
 * and reports. Every decision lives in `src/`, where it is unit-tested without
 * launching a real DSH.
 *
 * Exit codes are fixed per failure class (see `src/failures.mjs`) so a script can
 * branch on *which* failure happened instead of parsing English.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { USAGE } from '../src/args.mjs'
import { planBoot, writeOverlay, renderBootBanner, renderBootJson } from '../src/plan.mjs'
import {
  renderFailure,
  parseInactiveEntry,
  bootPendingFailure,
  FAILURE,
} from '../src/failures.mjs'
import { isMainModule } from '../src/main-module.mjs'

/**
 * Locate the `dsh` launcher.
 *
 * Preference order:
 *   1. `DSH_BIN` — an explicit override, for a checkout or an installed CLI.
 *   2. `--dsh-home`'s sibling checkout is NOT assumed; instead the local
 *      deepseek-harness checkout is probed, because that is how this DevKit is
 *      developed against the harness.
 *
 * The CLI does not guess a global `dsh` on PATH: silently running a different
 * DSH version than the checkout being developed against would be worse than a
 * clear "cannot find dsh" error.
 *
 * @param {{env?: object, exists?: (path: string) => boolean}} [deps]
 * @returns {{command: string, args: string[]}|null}
 */
export function findDshLauncher(deps = {}) {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync

  if (env.DSH_BIN) {
    // `tsx` is resolved from the launcher's own directory, so a DSH_BIN outside
    // a checkout still needs the caller's cwd to supply it.
    return {
      command: process.execPath,
      args: ['--import', 'tsx/esm', env.DSH_BIN],
      cwd: env.DSH_CHECKOUT ? resolve(env.DSH_CHECKOUT) : undefined,
    }
  }

  const candidates = [
    env.DSH_CHECKOUT ? resolve(env.DSH_CHECKOUT, 'apps/cli/src/bin.ts') : null,
    'D:/DSH/deepseek-harness/apps/cli/src/bin.ts',
  ].filter(Boolean)

  for (const bin of candidates) {
    if (!exists(bin)) continue
    // `--import tsx/esm` resolves `tsx` relative to the *spawn cwd*, and `tsx`
    // is a devDependency of the DSH checkout, not of this DevKit package.
    // Running from the DevKit workspace therefore fails with
    // ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'. The checkout root must
    // be the cwd for the bare specifier to resolve.
    return {
      command: process.execPath,
      args: ['--import', 'tsx/esm', bin],
      cwd: resolve(bin, '..', '..', '..', '..'),
    }
  }

  return null
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv
 * @param {{spawn?: Function, writeFile?: Function, mkdir?: Function, stdout?: Function, stderr?: Function}} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? ((text) => process.stdout.write(`${text}\n`))
  const err = deps.stderr ?? ((text) => process.stderr.write(`${text}\n`))

  // Planning probes are forwarded so the CLI is testable without a real
  // filesystem, network, or DSH_HOME. In production `deps` is empty and every
  // probe falls back to its real implementation.
  const plan = await planBoot(argv, {
    cwd: deps.cwd,
    env: deps.env,
    exists: deps.exists,
    readFile: deps.readFile,
    listen: deps.listen,
    names: deps.names,
    debuggerEntry: deps.debuggerEntry,
  })

  if (!plan.ok) {
    // `--json` must still emit machine-readable output on failure, or a script
    // driving this CLI cannot distinguish the failure classes at all.
    const wantsJson = argv.includes('--json')
    err(wantsJson ? JSON.stringify({ ok: false, ...plan.failure }, null, 2) : renderFailure(plan.failure))
    return plan.failure.exit
  }

  if (plan.help) {
    out(USAGE)
    return 0
  }

  try {
    writeOverlay(plan, { writeFile: deps.writeFile, mkdir: deps.mkdir })
  } catch (error) {
    err(renderFailure({
      code: 'overlay-invalid',
      message: `could not write the overlay to ${plan.overlayPath}`,
      detail: error.message,
      hints: ['check that the profile directory is writable, or pass --overlay <path>'],
    }))
    return 4
  }

  if (plan.options.json) {
    out(renderBootJson(plan))
  } else {
    out(renderBootBanner(plan))
  }

  // `--dry-run` reports and returns without booting.
  //
  // Found by running the CLI for real: `--json` printed the plan and then fell
  // straight through into spawning DSH, so a scripting invocation hung forever
  // instead of exiting. The tests never caught it because they inject a stubbed
  // `deps.spawn`, which is exactly the blind spot a stub creates.
  //
  // Neither flag alone could express "just tell me the plan": booting is this
  // command's whole purpose, so `--json` on its own still boots and reports.
  if (plan.options.dryRun) {
    return 0
  }

  const launcher = findDshLauncher({ env: deps.env, exists: deps.exists })
  if (!launcher) {
    err(renderFailure({
      code: 'internal',
      message: 'could not locate the dsh launcher',
      detail: 'looked for $DSH_BIN and apps/cli/src/bin.ts',
      hints: [
        'set DSH_BIN to the CLI entry (for example D:/DSH/deepseek-harness/apps/cli/src/bin.ts)',
        `then run: dsh ${plan.dshArgs.join(' ')}`,
      ],
    }))
    return 1
  }

  if (deps.spawn) {
    return deps.spawn(launcher, plan, { out, err })
  }

  return spawnDsh(launcher, plan, { out, err })
}

/**
 * Spawn `dsh` and inherit its stdio.
 *
 * Inherited stdio is required, not cosmetic: the web app prints the token-bearing
 * URL line to its own stdout, and capturing it would hide the one thing the user
 * needs. It also means Ctrl-C reaches the child.
 *
 * ## stderr is piped-and-echoed, not inherited
 *
 * One failure can only be explained by reading what DSH wrote: the plugin under
 * test never activating. That message, and the awaited service name inside it,
 * exist only as stderr text. So stderr is captured, echoed through verbatim (so
 * the user still sees everything), and then inspected to turn an opaque stack
 * trace into a named failure — see `parseInactiveEntry`.
 *
 * The tail is bounded: only the last few KB are kept, because this runs for the
 * lifetime of a server and an unbounded buffer on a long-lived process is a leak.
 *
 * @param {{command: string, args: string[], cwd?: string}} launcher
 * @param {object} plan
 * @param {{out: Function, err: Function}} io
 * @returns {Promise<number>}
 */
function spawnDsh(launcher, plan, io) {
  return new Promise((resolveExit) => {
    const child = spawn(launcher.command, [...launcher.args, ...plan.dshArgs], {
      stdio: ['inherit', 'inherit', 'pipe'],
      // `cwd` matters: it is where the bare `tsx` specifier resolves from.
      cwd: launcher.cwd,
      env: { ...process.env, DSH_HOME: plan.dshHome },
    })

    let captured = ''
    const CAPTURE_LIMIT = 16 * 1024

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      // Echo first: the user must always see the real output, whatever we make
      // of it afterwards.
      process.stderr.write(text)
      captured += text
      if (captured.length > CAPTURE_LIMIT) captured = captured.slice(-CAPTURE_LIMIT)
    })

    child.on('error', (error) => {
      io.err(renderFailure({
        code: 'internal',
        message: 'failed to start dsh',
        detail: error.message,
        hints: [`run it yourself: dsh ${plan.dshArgs.join(' ')}`],
      }))
      resolveExit(1)
    })

    child.on('exit', (code, signal) => {
      if (signal) {
        resolveExit(130)
        return
      }
      const exit = code ?? 0
      // A non-zero exit whose stderr names an inactive entry is the plugin's
      // fault, not DSH's, and the author needs to be told which service is
      // missing — the instance never starts, so /debug cannot tell them.
      if (exit !== 0) {
        const parsed = parseInactiveEntry(captured)
        if (parsed) {
          io.err('')
          io.err(renderFailure(bootPendingFailure(parsed, captured).failure))
          resolveExit(FAILURE.PLUGIN_PENDING.exit)
          return
        }
      }
      resolveExit(exit)
    })
  })
}

// Only run when executed directly, so importing this module in a test costs
// nothing and never spawns a process.
//
// `src/main-module.mjs` explains why this is not a plain URL comparison: through
// a symlink — which `npm install` creates for every local/`file:` dependency —
// `import.meta.url` is the real path and `argv[1]` is the link path, so the
// comparison fails and the CLI would exit 0 having done nothing.
if (isMainModule(import.meta.url)) {
  const code = await main()
  process.exitCode = code
}
