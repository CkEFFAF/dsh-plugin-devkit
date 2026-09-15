/**
 * Boot-plan tests: the integration layer.
 *
 * `planBoot` combines arg parsing, entry resolution, overlay generation, and
 * pre-flight checks into either a complete plan or a classified failure. These
 * tests exercise all three required failure paths end to end, plus the exact
 * `dsh` argv the CLI would spawn — without launching a real DSH.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planBoot, buildDshArgs, renderBootBanner, renderBootJson, findDebuggerEntry } from '../src/plan.mjs'
import { FAILURE } from '../src/failures.mjs'

/** A fake DSH_HOME with the shipped `web` template present. */
function makeHome(profiles = ['web']) {
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-plan-'))
  for (const name of profiles) mkdirSync(join(root, 'profiles', name), { recursive: true })
  return root
}

/** A plugin directory with a valid entry file. */
function makePlugin(root, name = 'my-plugin') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, 'index.mjs')
  writeFileSync(entry, 'export const name = "my-plugin"\nexport function apply() {}\n')
  return { dir, entry }
}

/** Deps that make pre-flight deterministic and never touch the network. */
function deps(home, overrides = {}) {
  return {
    env: { DSH_HOME: home },
    listen: async () => {},
    ...overrides,
  }
}

// -------------------------------------------------------------- happy path --

test('a valid invocation produces a complete plan', async () => {
  const home = makeHome()
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-src-'))
  try {
    const plugin = makePlugin(root)
    const plan = await planBoot(['--plugin', plugin.dir], deps(home))

    assert.equal(plan.ok, true)
    assert.equal(plan.pluginEntry, plugin.entry)
    assert.equal(plan.options.profile, 'dbgtest')
    assert.equal(plan.url, 'http://127.0.0.1:8080/')
    // The overlay lives beside the profiles, never inside the profile directory:
    // writing it there would create the directory and break initialization.
    assert.equal(plan.overlayPath, join(home, 'debug-boot', 'dbgtest.overlay.yml'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('the plan inserts both the plugin and the debugger kernel', async () => {
  const home = makeHome()
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-src-'))
  try {
    const plugin = makePlugin(root)
    const plan = await planBoot(['--plugin', plugin.dir], deps(home))

    const ids = plan.overlayRows[0].insert.map((row) => row.id)
    assert.equal(ids.length, 2)
    assert.deepEqual(ids, ['my-plugin', 'dsh-debugger'])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('every emitted overlay name is a file, never a directory (trap 1)', async () => {
  const home = makeHome()
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-src-'))
  try {
    const plugin = makePlugin(root)
    const plan = await planBoot(['--plugin', plugin.dir], deps(home))

    for (const row of plan.overlayRows[0].insert) {
      assert.doesNotMatch(row.name, /[\\/]$/, `${row.id} ends with a separator`)
      assert.match(row.name, /\.(mjs|js|cjs)$/, `${row.id} has no file extension: ${row.name}`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('the kernel row points at the real dsh-debugger entry', async () => {
  const home = makeHome()
  try {
    const plan = await planBoot([], deps(home))
    // The kernel really exists in this workspace, so the default must find it.
    assert.ok(plan.debuggerEntry, 'the debugger entry should be located')
    assert.match(plan.debuggerEntry.replace(/\\/g, '/'), /packages\/dsh-debugger\/index\.mjs$/)
    assert.deepEqual(plan.overlayRows[0].insert.map((r) => r.id), ['dsh-debugger'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--no-debugger produces a kernel-free plan', async () => {
  const home = makeHome()
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-src-'))
  try {
    const plugin = makePlugin(root)
    const plan = await planBoot(['--plugin', plugin.dir, '--no-debugger'], deps(home))

    assert.equal(plan.debuggerEntry, null)
    assert.deepEqual(plan.overlayRows[0].insert.map((r) => r.id), ['my-plugin'])
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('the plan does not touch the daily web profile', async () => {
  const home = makeHome(['web'])
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-src-'))
  try {
    const plugin = makePlugin(root)
    const plan = await planBoot(['--plugin', plugin.dir], deps(home))

    assert.notEqual(plan.options.profile, 'web')
    assert.ok(!plan.profileDir.replace(/\\/g, '/').endsWith('/profiles/web'))
    assert.ok(!plan.overlayPath.replace(/\\/g, '/').includes('/profiles/web/'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

// -------------------------------------------------- failure 1: missing template --

test('a missing template fails with the template-missing class', async () => {
  // No profiles at all under this DSH_HOME.
  const home = mkdtempSync(join(tmpdir(), 'debug-boot-plan-'))
  try {
    const plan = await planBoot([], deps(home))

    assert.equal(plan.ok, false)
    assert.equal(plan.failure.code, FAILURE.TEMPLATE_MISSING.code)
    assert.equal(plan.failure.exit, FAILURE.TEMPLATE_MISSING.exit)
    assert.match(plan.failure.message, /template 'web' was not found/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the template failure names the profiles that do exist', async () => {
  const home = makeHome(['rescue', 'dbgtest'])
  try {
    const plan = await planBoot(['--from-default-profile', 'web'], deps(home))
    assert.equal(plan.ok, false)
    // Alphabetical, so the message is stable across runs and filesystem order.
    assert.match(plan.failure.detail, /available profiles: dbgtest, rescue/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the template failure suggests how to fix it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'debug-boot-plan-'))
  try {
    const plan = await planBoot([], deps(home))
    assert.ok(plan.failure.hints.some((h) => h.includes('--profile web')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ------------------------------------------------------ failure 2: port in use --

test('a busy port fails with the port-in-use class', async () => {
  const home = makeHome()
  try {
    const plan = await planBoot(['--port', '8080'], deps(home, {
      listen: async () => {
        const error = new Error('listen EADDRINUSE')
        error.code = 'EADDRINUSE'
        throw error
      },
    }))

    assert.equal(plan.ok, false)
    assert.equal(plan.failure.code, FAILURE.PORT_IN_USE.code)
    assert.equal(plan.failure.exit, FAILURE.PORT_IN_USE.exit)
    assert.match(plan.failure.message, /port 8080 on 127\.0\.0\.1 is already in use/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the port failure suggests another port', async () => {
  const home = makeHome()
  try {
    const plan = await planBoot(['--port', '8080'], deps(home, {
      listen: async () => {
        const error = new Error('busy')
        error.code = 'EADDRINUSE'
        throw error
      },
    }))
    assert.ok(plan.failure.hints.some((h) => h.includes('--port 8081')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the port failure reports the port actually requested', async () => {
  const home = makeHome()
  try {
    const plan = await planBoot(['--port', '9321'], deps(home, {
      listen: async () => {
        throw new Error('busy')
      },
    }))
    assert.match(plan.failure.message, /9321/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------- failure 3: invalid overlay --

test('an unresolvable plugin fails with the overlay class before pre-flight', async () => {
  const home = makeHome()
  try {
    // A directory with no entry file cannot produce a valid overlay row.
    const root = mkdtempSync(join(tmpdir(), 'debug-boot-src-'))
    const empty = join(root, 'not-a-plugin')
    mkdirSync(empty, { recursive: true })
    try {
      const plan = await planBoot(['--plugin', empty], deps(home))

      assert.equal(plan.ok, false)
      assert.equal(plan.failure.code, FAILURE.PLUGIN_UNRESOLVED.code)
      assert.equal(plan.failure.exit, FAILURE.PLUGIN_UNRESOLVED.exit)
      assert.match(plan.failure.message, /no entry file found/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a missing plugin path is classified, not crashed', async () => {
  const home = makeHome()
  try {
    const plan = await planBoot(['--plugin', 'D:/definitely/not/here'], deps(home))
    assert.equal(plan.ok, false)
    assert.equal(plan.failure.code, FAILURE.PLUGIN_UNRESOLVED.code)
    assert.match(plan.failure.message, /does not exist/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a missing debugger entry is an overlay failure', async () => {
  const home = makeHome()
  try {
    const plan = await planBoot([], deps(home, { debuggerEntry: null }))
    assert.equal(plan.ok, false)
    assert.equal(plan.failure.code, FAILURE.OVERLAY_INVALID.code)
    assert.match(plan.failure.message, /dsh-debugger entry could not be located/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the three failure classes are distinguishable from each other', async () => {
  const noTemplateHome = mkdtempSync(join(tmpdir(), 'debug-boot-plan-'))
  const home = makeHome()
  try {
    const missingTemplate = await planBoot([], deps(noTemplateHome))
    const busyPort = await planBoot([], deps(home, {
      listen: async () => {
        throw new Error('busy')
      },
    }))
    const badPlugin = await planBoot(['--plugin', 'D:/nope'], deps(home))

    const codes = [missingTemplate.failure.code, busyPort.failure.code, badPlugin.failure.code]
    assert.equal(new Set(codes).size, 3, 'each failure must be distinguishable')
    for (const result of [missingTemplate, busyPort, badPlugin]) {
      assert.notEqual(result.failure.exit, 0)
    }
  } finally {
    rmSync(noTemplateHome, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// -------------------------------------------------------------- usage errors --

test('a usage error is classified and lists every problem', async () => {
  const home = makeHome()
  try {
    const plan = await planBoot(['--bogus', '--port', 'bad'], deps(home))
    assert.equal(plan.ok, false)
    assert.equal(plan.failure.code, FAILURE.USAGE.code)
    assert.match(plan.failure.detail, /--bogus/)
    assert.match(plan.failure.detail, /--port/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--help short-circuits before any pre-flight', async () => {
  // No DSH_HOME at all: help must not require one.
  const plan = await planBoot(['--help'], { env: {}, listen: async () => { throw new Error('no listen') } })
  assert.equal(plan.ok, true)
  assert.equal(plan.help, true)
})

// ----------------------------------------------------------------- dsh argv --

test('the dsh argv uses the verified launcher flag shape', () => {
  const options = { profile: 'dbgtest', fromDefaultProfile: 'web', port: 8080, host: '127.0.0.1', open: true }
  const args = buildDshArgs(options, ['/o/overlay.yml'], { profileInitialized: false })

  assert.deepEqual(args, [
    '--profile', 'dbgtest',
    '--from-default-profile', 'web',
    '--patch', '/o/overlay.yml',
    '--port', '8080',
    '--host', '127.0.0.1',
  ])
})

test('an already-initialized profile omits --from-default-profile', () => {
  // Found only by a real boot: DSH treats --from-default-profile as an
  // initialization directive and hard-fails when the target profile already has
  // a package.json (apps/cli/src/profile-boot.ts:131). Always passing it makes
  // the second run of this CLI fail.
  const options = { profile: 'dbgtest', fromDefaultProfile: 'web', port: 8080, host: '127.0.0.1', open: true }
  const args = buildDshArgs(options, ['/o.yml'], { profileInitialized: true })

  assert.ok(!args.includes('--from-default-profile'))
  assert.equal(args[args.indexOf('--profile') + 1], 'dbgtest')
  assert.ok(args.includes('--patch'))
  assert.ok(args.includes('--port'))
})

test('a first run targets a fresh profile directory and passes the template', async () => {
  const home = makeHome()
  try {
    // `dbgtest` has no package.json yet, so this is an initialization run.
    const plan = await planBoot([], deps(home))
    assert.equal(plan.profileInitialized, false)
    assert.ok(plan.dshArgs.includes('--from-default-profile'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a second run against an initialized profile drops the template flag', async () => {
  const home = makeHome()
  try {
    // State 2: directory + package.json. DSH loads this; it must not be asked
    // to initialize.
    mkdirSync(join(home, 'profiles', 'dbgtest'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'dbgtest', 'package.json'), '{"name":"dsh-profile-dbgtest"}')

    const plan = await planBoot([], deps(home))
    assert.equal(plan.ok, true)
    assert.equal(plan.profileInitialized, true)
    assert.ok(!plan.dshArgs.includes('--from-default-profile'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a directory with real content but no manifest is refused (state 3)', async () => {
  // Found by a real boot. DSH cannot boot this state by either path:
  // --from-default-profile refuses the existing directory (profile-boot.ts:137),
  // and omitting it reports "profile does not exist" (profile.ts:823).
  const home = makeHome()
  try {
    const dir = join(home, 'profiles', 'dbgtest')
    mkdirSync(dir, { recursive: true })
    // A file the user might have put there: must never be deleted.
    writeFileSync(join(dir, 'notes.txt'), 'my own notes')

    const plan = await planBoot([], deps(home))
    assert.equal(plan.ok, false)
    assert.equal(plan.failure.code, FAILURE.PROFILE_CORRUPT.code)
    assert.equal(plan.failure.exit, FAILURE.PROFILE_CORRUPT.exit)
    assert.match(plan.failure.message, /exists but has no package\.json/)
    assert.match(plan.failure.detail, /notes\.txt/, 'the refusal must name what is in there')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('refusing a populated directory leaves its contents intact', async () => {
  const home = makeHome()
  try {
    const dir = join(home, 'profiles', 'dbgtest')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'precious.txt'), 'do not delete')

    await planBoot([], deps(home))
    // The CLI must not destroy user data to make its own boot succeed.
    assert.equal(existsSync(join(dir, 'precious.txt')), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the corrupt-profile failure names the exact remedy', async () => {
  const home = makeHome()
  try {
    const dir = join(home, 'profiles', 'dbgtest')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'x')

    const plan = await planBoot([], deps(home))
    const hints = plan.failure.hints.join('\n')
    assert.match(hints, /remove it/)
    assert.match(hints, /--profile dbgtest2/, 'must offer the non-destructive alternative')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a directory holding only our own leftover overlay is cleared', async () => {
  // An earlier version of this CLI wrote its overlay into the profile directory,
  // creating the very directory that breaks initialization. That leftover is
  // ours, so it is cleared instead of reported — otherwise the documented first
  // run could never succeed.
  const home = makeHome()
  try {
    const dir = join(home, 'profiles', 'dbgtest')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'debug-boot.overlay.yml'), '# stale\n')

    const plan = await planBoot([], deps(home))
    assert.equal(plan.ok, true)
    assert.ok(plan.dshArgs.includes('--from-default-profile'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an empty profile directory is cleared rather than reported', async () => {
  // An empty directory holds nothing to lose, and DSH would refuse it.
  const home = makeHome()
  try {
    mkdirSync(join(home, 'profiles', 'dbgtest'), { recursive: true })
    const plan = await planBoot([], deps(home))
    assert.equal(plan.ok, true)
    assert.ok(plan.dshArgs.includes('--from-default-profile'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a fresh profile name works even when another is corrupt', async () => {
  // The non-destructive escape hatch the hint promises must actually work.
  const home = makeHome()
  try {
    mkdirSync(join(home, 'profiles', 'dbgtest'), { recursive: true })
    const plan = await planBoot(['--profile', 'dbgtest2'], deps(home))

    assert.equal(plan.ok, true)
    assert.ok(plan.dshArgs.includes('--from-default-profile'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('running twice in a row yields a usable argv both times', async () => {
  const home = makeHome()
  try {
    // Run 1: nothing exists yet -> initialize.
    const first = await planBoot([], deps(home))
    assert.ok(first.dshArgs.includes('--from-default-profile'))

    // Run 2: DSH has written the manifest -> load, do not re-initialize.
    mkdirSync(join(home, 'profiles', 'dbgtest'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'dbgtest', 'package.json'), '{"name":"p"}')

    const second = await planBoot([], deps(home))
    assert.equal(second.ok, true)
    assert.ok(!second.dshArgs.includes('--from-default-profile'))
    assert.ok(second.dshArgs.includes('--profile'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the banner explains which mode the run is in', async () => {
  const home = makeHome()
  try {
    const fresh = renderBootBanner(await planBoot([], deps(home)))
    assert.match(fresh, /will be initialized from the 'web' template/)

    mkdirSync(join(home, 'profiles', 'dbgtest'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'dbgtest', 'package.json'), '{"name":"p"}')
    const existing = renderBootBanner(await planBoot([], deps(home)))
    assert.match(existing, /profile exists/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('launcher flags precede the web app arguments', () => {
  // apps/cli/src/args.ts stops parsing launcher flags at the first unknown
  // token, so the app's own flags must come last or they are swallowed.
  const args = buildDshArgs(
    { profile: 'dbgtest', fromDefaultProfile: 'web', port: 8080, host: '127.0.0.1', open: true },
    ['/o.yml'],
  )
  assert.ok(args.indexOf('--patch') < args.indexOf('--port'))
})

test('--no-open is forwarded to the web app, not eaten by the launcher', () => {
  const args = buildDshArgs(
    { profile: 'dbgtest', fromDefaultProfile: 'web', port: 8080, host: '127.0.0.1', open: false },
    [],
  )
  assert.ok(args.includes('--no-open'))
  assert.equal(args[args.length - 1], '--no-open')
})

test('the generated overlay is patched before any user overlay', () => {
  // So the debug wiring wins on an id collision.
  const planArgs = buildDshArgs(
    { profile: 'p', fromDefaultProfile: 'web', port: 1, host: 'h', open: true },
    ['/generated.yml', '/user.yml'],
  )
  assert.ok(planArgs.indexOf('/generated.yml') < planArgs.indexOf('/user.yml'))
})

test('the plan forwards extra patches after the generated overlay', async () => {
  const home = makeHome()
  try {
    const plan = await planBoot(['--patch', 'extra.yml'], deps(home, { cwd: 'D:/work' }))
    assert.equal(plan.patches[0], plan.overlayPath)
    assert.equal(plan.patches[1].replace(/\\/g, '/'), 'D:/work/extra.yml')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------- output --

test('the banner prints all four things 功能文档 §6.1 requires', async () => {
  const home = makeHome()
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-src-'))
  try {
    const plugin = makePlugin(root)
    const plan = await planBoot(['--plugin', plugin.dir], deps(home))
    const banner = renderBootBanner(plan)

    assert.match(banner, /profile/i, 'profile path')
    assert.match(banner, new RegExp(plan.profileDir.replace(/[\\]/g, '\\\\')), 'the profile path itself')
    assert.match(banner, /http:\/\/127\.0\.0\.1:8080\//, 'the URL')
    assert.match(banner, /token/, 'the token hint')
    assert.match(banner, /\/debug health/, 'the health hint')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('the banner states the isolation guarantee', async () => {
  const home = makeHome()
  try {
    const banner = renderBootBanner(await planBoot([], deps(home)))
    assert.match(banner, /isolated/)
    assert.match(banner, /daily profile is not modified/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the JSON rendering is parseable and stable', async () => {
  const home = makeHome()
  try {
    const parsed = JSON.parse(renderBootJson(await planBoot([], deps(home))))
    assert.equal(parsed.profile, 'dbgtest')
    assert.equal(parsed.fromDefaultProfile, 'web')
    assert.equal(parsed.port, 8080)
    assert.equal(parsed.url, 'http://127.0.0.1:8080/')
    assert.ok(Array.isArray(parsed.dshArgs))
    assert.ok(Array.isArray(parsed.overlay))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--no-open is reflected in the banner', async () => {
  const home = makeHome()
  try {
    const banner = renderBootBanner(await planBoot(['--no-open'], deps(home)))
    assert.match(banner, /--no-open/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('findDebuggerEntry locates the sibling package', () => {
  const entry = findDebuggerEntry()
  assert.ok(entry)
  assert.match(entry.replace(/\\/g, '/'), /dsh-debugger\/index\.mjs$/)
})

// -------------------------------------------------------- real overlay write --

test('the plan can be written and read back as valid YAML-shaped text', async () => {
  const home = makeHome()
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-src-'))
  try {
    const plugin = makePlugin(root)
    const plan = await planBoot(['--plugin', plugin.dir], deps(home))

    const { writeOverlay } = await import('../src/plan.mjs')
    writeOverlay(plan)

    const text = readFileSync(plan.overlayPath, 'utf8')
    assert.match(text, /- insert:/)
    assert.match(text, /dsh-debugger/)
    assert.match(text, /my-plugin/)
    // The real plugin entry, so the loader would import a genuine file.
    assert.ok(text.includes(plugin.entry))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('--overlay redirects the overlay outside the profile', async () => {
  const home = makeHome()
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-src-'))
  try {
    const out = join(root, 'custom-overlay.yml')
    const plan = await planBoot(['--overlay', out], deps(home))
    assert.equal(plan.overlayPath, out)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
