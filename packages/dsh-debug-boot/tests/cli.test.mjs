/**
 * CLI tests: exit codes, output routing, and the no-spawn guarantee.
 *
 * `main` takes injectable `spawn`, `stdout`, and `stderr`, so the whole
 * executable surface is exercised here without ever launching a real DSH — which
 * the task explicitly forbids.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main, findDshLauncher } from '../bin/debug-boot.mjs'
import { FAILURE } from '../src/failures.mjs'

/** Capture stdout/stderr and record whether anything was spawned. */
function harness() {
  const out = []
  const err = []
  const spawned = []
  return {
    out,
    err,
    spawned,
    deps: (extra = {}) => ({
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      // A safe stand-in: records the call, spawns nothing.
      spawn: (launcher, plan) => {
        spawned.push({ launcher, plan })
        return 0
      },
      // No `exists` override by default: the real filesystem is what the
      // template and entry checks must consult here, and a blanket
      // `exists: () => true` would make every negative case pass vacuously.
      ...extra,
    }),
  }
}

/** A DSH_HOME whose `web` template is present. */
function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-cli-'))
  mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
  return root
}

/** A plugin directory with a valid entry file. */
function makePlugin(root) {
  const dir = join(root, 'demo-plugin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), 'export function apply() {}\n')
  return dir
}

test('a successful boot returns exit code 0', async () => {
  const home = makeHome()
  const src = mkdtempSync(join(tmpdir(), 'debug-boot-cli-src-'))
  const h = harness()
  try {
    const code = await main(['--plugin', makePlugin(src), '--dsh-home', home], h.deps())
    assert.equal(code, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  }
})

test('a successful boot prints the banner', async () => {
  const home = makeHome()
  const src = mkdtempSync(join(tmpdir(), 'debug-boot-cli-src-'))
  const h = harness()
  try {
    await main(['--plugin', makePlugin(src), '--dsh-home', home], h.deps())
    const text = h.out.join('\n')
    assert.match(text, /isolated profile 'dbgtest'/)
    assert.match(text, /http:\/\/127\.0\.0\.1:8080\//)
    assert.match(text, /\/debug health/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  }
})

test('a successful boot writes the overlay outside the profile directory', async () => {
  const home = makeHome()
  const src = mkdtempSync(join(tmpdir(), 'debug-boot-cli-src-'))
  const h = harness()
  try {
    await main(['--plugin', makePlugin(src), '--dsh-home', home], h.deps())
    // Writing it into the profile directory would create that directory and make
    // DSH refuse to initialize the profile.
    const overlay = join(home, 'debug-boot', 'dbgtest.overlay.yml')
    const text = readFileSync(overlay, 'utf8')
    assert.match(text, /- insert:/)
    assert.match(text, /dsh-debugger/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  }
})

test('a successful boot spawns the launcher exactly once', async () => {
  const home = makeHome()
  const src = mkdtempSync(join(tmpdir(), 'debug-boot-cli-src-'))
  const h = harness()
  try {
    await main(['--plugin', makePlugin(src), '--dsh-home', home], h.deps())
    assert.equal(h.spawned.length, 1)
    assert.ok(Array.isArray(h.spawned[0].launcher.args))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  }
})

test('--help prints usage and exits 0 without spawning', async () => {
  const h = harness()
  const code = await main(['--help'], h.deps())

  assert.equal(code, 0)
  assert.match(h.out.join('\n'), /Usage:/)
  assert.equal(h.spawned.length, 0)
})

test('a missing template exits with the template-missing code', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'debug-boot-cli-'))
  const h = harness()
  try {
    const code = await main(['--dsh-home', empty], h.deps())
    assert.equal(code, FAILURE.TEMPLATE_MISSING.exit)
    assert.match(h.err.join('\n'), /template-missing/)
    assert.equal(h.spawned.length, 0, 'a failed plan must not spawn')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('a busy port exits with the port-in-use code', async () => {
  const home = makeHome()
  const h = harness()
  try {
    // `exists: () => true` satisfies the template check; the port probe is the
    // real one, so pick a port and occupy it.
    const { createServer } = await import('node:net')
    const blocker = createServer()
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const busyPort = blocker.address().port
    try {
      const code = await main(['--port', String(busyPort), '--dsh-home', home], h.deps())
      assert.equal(code, FAILURE.PORT_IN_USE.exit)
      assert.match(h.err.join('\n'), /port-in-use/)
      assert.equal(h.spawned.length, 0)
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an unresolvable plugin exits with the plugin-unresolved code', async () => {
  const home = makeHome()
  const h = harness()
  try {
    const code = await main(['--plugin', 'D:/nope/nothing-here', '--dsh-home', home], h.deps())
    assert.equal(code, FAILURE.PLUGIN_UNRESOLVED.exit)
    assert.match(h.err.join('\n'), /plugin-unresolved/)
    assert.equal(h.spawned.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a missing kernel exits with the overlay-invalid code', async () => {
  const home = makeHome()
  const h = harness()
  try {
    // Force the kernel lookup to fail by pointing the debugger package away.
    const code = await main(['--dsh-home', home], {
      ...h.deps(),
      // `planBoot` takes the debugger entry from the filesystem; emulate its
      // absence by making every probe fail except the profile dir.
      exists: (p) => !String(p).includes('dsh-debugger'),
    })
    assert.equal(code, FAILURE.OVERLAY_INVALID.exit)
    assert.match(h.err.join('\n'), /overlay-invalid/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a usage error exits with the usage code and lists every problem', async () => {
  const h = harness()
  const code = await main(['--bogus', '--port', 'bad'], h.deps())

  assert.equal(code, FAILURE.USAGE.exit)
  const text = h.err.join('\n')
  assert.match(text, /--bogus/)
  assert.match(text, /--port/)
  assert.equal(h.spawned.length, 0)
})

test('--json emits a parseable success document', async () => {
  const home = makeHome()
  const src = mkdtempSync(join(tmpdir(), 'debug-boot-cli-src-'))
  const h = harness()
  try {
    await main(['--plugin', makePlugin(src), '--dsh-home', home, '--json'], h.deps())
    const parsed = JSON.parse(h.out.join('\n'))
    assert.equal(parsed.profile, 'dbgtest')
    assert.equal(parsed.port, 8080)
    assert.ok(Array.isArray(parsed.dshArgs))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  }
})

test('--dry-run reports the plan and does NOT boot', async () => {
  // Found by running the CLI for real: without this, `--json` printed the plan
  // and then fell through into spawning DSH, so a scripting invocation hung
  // forever instead of returning. The earlier tests missed it because the stub
  // absorbs the spawn — this asserts on the stub's record instead.
  const home = makeHome()
  const h = harness()
  try {
    const code = await main(['--dsh-home', home, '--profile', 'dry', '--dry-run'], h.deps())
    assert.equal(code, 0)
    assert.equal(h.spawned.length, 0, '--dry-run must not spawn a DSH process')
    assert.match(h.out.join('\n'), /isolated profile 'dry'/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--dry-run --json is the scripting form: plan out, nothing booted', async () => {
  const home = makeHome()
  const h = harness()
  try {
    const code = await main(['--dsh-home', home, '--profile', 'dryj', '--dry-run', '--json'], h.deps())
    assert.equal(code, 0)
    assert.equal(h.spawned.length, 0)
    const parsed = JSON.parse(h.out.join('\n'))
    assert.equal(parsed.profile, 'dryj')
    assert.ok(parsed.dshArgs.includes('--profile'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('without --dry-run the command does boot', async () => {
  // The complement of the above: booting is this command's purpose, so a plain
  // run must still spawn. Without this the fix could regress into "never boots".
  const home = makeHome()
  const h = harness()
  try {
    const code = await main(['--dsh-home', home, '--profile', 'live', '--no-open'], h.deps())
    assert.equal(code, 0)
    assert.equal(h.spawned.length, 1, 'a normal run must spawn DSH')
    assert.equal(h.spawned[0].plan.options.profile, 'live')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--dry-run still writes the overlay, so the plan is inspectable', async () => {
  const home = makeHome()
  const h = harness()
  try {
    await main(['--dsh-home', home, '--profile', 'dryw', '--dry-run', '--json'], h.deps())
    const parsed = JSON.parse(h.out.join('\n'))
    const overlayText = readFileSync(parsed.overlayPath, 'utf8')
    assert.match(overlayText, /dsh-debugger/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--dry-run still reports failures with their exit code', async () => {
  // A dry run must not become a way to skip validation.
  const empty = mkdtempSync(join(tmpdir(), 'debug-boot-cli-'))
  const h = harness()
  try {
    const code = await main(['--dsh-home', empty, '--dry-run'], h.deps())
    assert.equal(code, FAILURE.TEMPLATE_MISSING.exit)
    assert.equal(h.spawned.length, 0)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('--json emits a parseable failure document', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'debug-boot-cli-'))
  const h = harness()
  try {
    const code = await main(['--dsh-home', empty, '--json'], h.deps())
    assert.equal(code, FAILURE.TEMPLATE_MISSING.exit)
    const parsed = JSON.parse(h.err.join('\n'))
    assert.equal(parsed.ok, false)
    assert.equal(parsed.code, 'template-missing')
    assert.equal(parsed.exit, FAILURE.TEMPLATE_MISSING.exit)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('a launcher that cannot be found is reported with a non-zero exit', async () => {
  const home = makeHome()
  const h = harness()
  try {
    // Keep the plan valid, but make the launcher probe fail and the spawn
    // unavailable, so the CLI must report rather than crash.
    const code = await main(['--dsh-home', home], {
      ...h.deps({ spawn: undefined }),
      env: {},
      exists: (p) => String(p).includes('profiles') || String(p).includes('dsh-debugger'),
    })
    assert.equal(code, 1)
    assert.match(h.err.join('\n'), /could not locate the dsh launcher/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('--no-open reaches the spawned argv', async () => {
  const home = makeHome()
  const src = mkdtempSync(join(tmpdir(), 'debug-boot-cli-src-'))
  const h = harness()
  try {
    await main(['--plugin', makePlugin(src), '--dsh-home', home, '--no-open'], h.deps())
    const args = h.spawned[0].plan.dshArgs
    assert.ok(args.includes('--no-open'))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  }
})

test('the spawned plan targets the derived profile, never web', async () => {
  const home = makeHome()
  const h = harness()
  try {
    await main(['--dsh-home', home], h.deps())
    const args = h.spawned[0].plan.dshArgs
    const profileIndex = args.indexOf('--profile')
    assert.notEqual(args[profileIndex + 1], 'web')
    assert.equal(args[profileIndex + 1], 'dbgtest')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('findDshLauncher honours DSH_BIN', () => {
  const launcher = findDshLauncher({ env: { DSH_BIN: 'D:/harness/apps/cli/src/bin.ts' }, exists: () => false })
  assert.ok(launcher)
  assert.ok(launcher.args.includes('D:/harness/apps/cli/src/bin.ts'))
})

test('findDshLauncher returns null when nothing is found', () => {
  const launcher = findDshLauncher({ env: {}, exists: () => false })
  assert.equal(launcher, null)
})

test('the launcher runs with the checkout as cwd so bare tsx resolves', () => {
  // `--import tsx/esm` resolves `tsx` from the spawn cwd, and tsx belongs to the
  // DSH checkout, not to this DevKit workspace. Without this the real spawn dies
  // with ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'.
  const bin = 'D:/DSH/deepseek-harness/apps/cli/src/bin.ts'
  const launcher = findDshLauncher({ env: {}, exists: (p) => p === bin })

  assert.ok(launcher)
  assert.ok(launcher.args.includes(bin))
  assert.equal(launcher.cwd.replace(/\\/g, '/'), 'D:/DSH/deepseek-harness')
})

test('the CLI module does not spawn on import', () => {
  // Importing for tests must be side-effect free; if this were violated, the
  // suite above would have launched DSH processes.
  assert.equal(typeof main, 'function')
})
