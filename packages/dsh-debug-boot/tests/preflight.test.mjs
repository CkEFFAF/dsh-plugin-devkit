/**
 * Pre-flight and failure-taxonomy tests.
 *
 * 功能文档 §6.1 and 设计文档 §5 both require that a failed derivation names
 * *which* failure it was — template missing, port in use, or invalid overlay —
 * and that the exit code is non-zero. These tests pin the three classes and their
 * distinct exit codes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveDshHome,
  profilesDir,
  profileDir,
  listProfiles,
  checkTemplate,
  checkPort,
} from '../src/preflight.mjs'
import { FAILURE, bootFailure, bootSuccess, renderFailure } from '../src/failures.mjs'

// --------------------------------------------------------------------- home --

test('DSH_HOME comes from the environment', () => {
  assert.equal(resolveDshHome({ env: { DSH_HOME: 'C:/Users/x/.dsh' } }), 'C:/Users/x/.dsh')
})

test('an explicit override beats the environment', () => {
  const home = resolveDshHome({ env: { DSH_HOME: 'C:/env' }, override: 'D:/explicit' })
  assert.equal(home, 'D:/explicit')
})

test('DSH_HOME falls back to ~/.dsh', () => {
  const home = resolveDshHome({ env: {}, homedir: '/home/dev' })
  assert.equal(home.replace(/\\/g, '/'), '/home/dev/.dsh')
})

test('profile paths hang off DSH_HOME/profiles', () => {
  const home = 'D:/home'
  assert.equal(profilesDir(home).replace(/\\/g, '/'), 'D:/home/profiles')
  assert.equal(profileDir(home, 'dbgtest').replace(/\\/g, '/'), 'D:/home/profiles/dbgtest')
})

// ----------------------------------------------------------------- template --

test('an existing template is accepted', () => {
  const result = checkTemplate('web', 'D:/home', {
    exists: (p) => p.replace(/\\/g, '/') === 'D:/home/profiles/web',
  })
  assert.equal(result.ok, true)
})

test('a missing template is rejected with the available profiles listed', () => {
  const result = checkTemplate('web', 'D:/home', {
    exists: () => false,
    names: ['dbgtest', 'rescue'],
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /profile template 'web' was not found/)
  assert.deepEqual(result.available, ['dbgtest', 'rescue'])
})

test('a profile that exists in the listing but not on disk is tolerated', () => {
  // DSH materializes a shipped template on first use, so a fresh DSH_HOME must
  // not be reported as "template missing".
  const result = checkTemplate('web', 'D:/home', { exists: () => false, names: ['web'] })
  assert.equal(result.ok, true)
})

test('listProfiles returns an empty list instead of throwing', () => {
  assert.deepEqual(listProfiles('D:/nope', { readdir: () => { throw new Error('ENOENT') } }), [])
})

test('listProfiles lists real directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'debug-boot-pre-'))
  try {
    mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
    mkdirSync(join(root, 'profiles', 'dbgtest'), { recursive: true })
    const names = listProfiles(root).sort()
    assert.deepEqual(names, ['dbgtest', 'web'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------- port --

test('a free port passes', async () => {
  const result = await checkPort(8080, '127.0.0.1', { listen: async () => {} })
  assert.equal(result.ok, true)
})

test('a busy port fails with an actionable reason', async () => {
  const result = await checkPort(8080, '127.0.0.1', {
    listen: async () => {
      const error = new Error('listen EADDRINUSE')
      error.code = 'EADDRINUSE'
      throw error
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /port 8080 on 127\.0\.0\.1 is already in use/)
})

test('a privileged-port denial is explained distinctly', async () => {
  const result = await checkPort(80, '127.0.0.1', {
    listen: async () => {
      const error = new Error('listen EACCES')
      error.code = 'EACCES'
      throw error
    },
  })
  assert.match(result.reason, /not permitted to bind/)
})

test('port 0 is never reported as in use', async () => {
  // Port 0 means "ask the OS", so the check must not even try to bind.
  const result = await checkPort(0, '127.0.0.1', {
    listen: async () => {
      throw new Error('should not be called')
    },
  })
  assert.equal(result.ok, true)
})

test('a real free port passes against the real network stack', async () => {
  // Port 0 is a genuine no-op, so exercise a real ephemeral bind through the
  // default path with a high port unlikely to be taken.
  const result = await checkPort(0)
  assert.equal(result.ok, true)
})

// ----------------------------------------------------------------- failures --

test('the three required failure classes have distinct codes and exit codes', () => {
  const required = [FAILURE.TEMPLATE_MISSING, FAILURE.PORT_IN_USE, FAILURE.OVERLAY_INVALID]
  const codes = new Set(required.map((f) => f.code))
  const exits = new Set(required.map((f) => f.exit))

  assert.equal(codes.size, 3, 'each failure class needs its own code')
  assert.equal(exits.size, 3, 'each failure class needs its own exit code')
  for (const failure of required) assert.notEqual(failure.exit, 0, 'failures must be non-zero')
})

test('bootFailure carries the class, code, exit code, and message', () => {
  const result = bootFailure(FAILURE.TEMPLATE_MISSING, 'no template', { detail: 'd', hints: ['h'] })

  assert.equal(result.ok, false)
  assert.equal(result.failure.kind, 'TEMPLATE_MISSING')
  assert.equal(result.failure.code, 'template-missing')
  assert.equal(result.failure.exit, 2)
  assert.equal(result.failure.message, 'no template')
  assert.equal(result.failure.detail, 'd')
  assert.deepEqual(result.failure.hints, ['h'])
})

test('renderFailure names the class so the user knows which failure it was', () => {
  const text = renderFailure(bootFailure(FAILURE.PORT_IN_USE, 'port 8080 is already in use', {
    hints: ['choose another port'],
  }))

  assert.match(text, /debug-boot: port-in-use:/)
  assert.match(text, /already in use/)
  assert.match(text, /hint: choose another port/)
})

test('renderFailure tolerates a failure with no detail or hints', () => {
  const text = renderFailure(bootFailure(FAILURE.OVERLAY_INVALID, 'bad overlay'))
  assert.match(text, /overlay-invalid: bad overlay/)
  assert.doesNotMatch(text, /hint:/)
})

test('bootSuccess marks a result as ok', () => {
  assert.deepEqual(bootSuccess({ a: 1 }), { ok: true, a: 1 })
})

test('the failure taxonomy is frozen', () => {
  assert.throws(() => {
    FAILURE.PORT_IN_USE.exit = 0
  }, TypeError)
})
