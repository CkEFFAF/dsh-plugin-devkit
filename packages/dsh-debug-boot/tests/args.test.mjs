/**
 * Argument-parsing tests.
 *
 * Parsing is pure, so every case here runs without a filesystem or a process.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseArgs, DEFAULTS, USAGE } from '../src/args.mjs'

test('defaults match 功能文档 §6.1 and 设计文档 §5', () => {
  const options = parseArgs([])
  assert.equal(options.profile, 'dbgtest')
  assert.equal(options.fromDefaultProfile, 'web')
  assert.equal(options.host, '127.0.0.1')
  assert.equal(options.port, 8080)
  assert.equal(options.open, true)
  assert.equal(options.includeDebugger, true)
  assert.deepEqual(options.errors, [])
})

test('the default profile is never the daily web profile', () => {
  // Deriving into `web` would overwrite the profile the user runs every day.
  assert.notEqual(DEFAULTS.profile, 'web')
})

test('--profile overrides the derived profile name', () => {
  assert.equal(parseArgs(['--profile', 'dbg2']).profile, 'dbg2')
})

test('--profile=value form parses', () => {
  assert.equal(parseArgs(['--profile=dbg3']).profile, 'dbg3')
})

test('an invalid profile name is rejected', () => {
  assert.match(parseArgs(['--profile', 'Bad Name']).errors[0], /invalid/)
  assert.match(parseArgs(['--profile', '-bad']).errors[0], /needs a value|invalid/)
  assert.match(parseArgs(['--profile', 'UPPER']).errors[0], /invalid/)
})

test('--from-default-profile overrides the template', () => {
  assert.equal(parseArgs(['--from-default-profile', 'tui']).fromDefaultProfile, 'tui')
})

test('--port parses a number', () => {
  assert.equal(parseArgs(['--port', '9090']).port, 9090)
})

test('--port 0 is allowed (OS-assigned)', () => {
  assert.equal(parseArgs(['--port', '0']).port, 0)
})

test('an out-of-range or non-numeric port is rejected', () => {
  assert.match(parseArgs(['--port', '70000']).errors[0], /not a valid port/)
  assert.match(parseArgs(['--port', 'abc']).errors[0], /not a valid port/)
  assert.match(parseArgs(['--port', '-1']).errors[0], /needs a value|not a valid port/)
  assert.match(parseArgs(['--port', '80.5']).errors[0], /not a valid port/)
})

test('--host overrides the listen address', () => {
  assert.equal(parseArgs(['--host', '0.0.0.0']).host, '0.0.0.0')
})

test('--no-open suppresses the browser', () => {
  assert.equal(parseArgs(['--no-open']).open, false)
})

test('--no-debugger drops the kernel row', () => {
  assert.equal(parseArgs(['--no-debugger']).includeDebugger, false)
})

test('--plugin captures the plugin path', () => {
  assert.equal(parseArgs(['--plugin', './my-plugin']).plugin, './my-plugin')
})

test('--patch is repeatable', () => {
  const options = parseArgs(['--patch', 'a.yml', '--patch', 'b.yml'])
  assert.deepEqual(options.patches, ['a.yml', 'b.yml'])
})

test('--overlay and --dsh-home capture their values', () => {
  const options = parseArgs(['--overlay', 'out.yml', '--dsh-home', 'D:/home'])
  assert.equal(options.overlay, 'out.yml')
  assert.equal(options.dshHome, 'D:/home')
})

test('--help and --json are flags', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['-h']).help, true)
  assert.equal(parseArgs(['--json']).json, true)
})

test('an unknown option is rejected, not ignored', () => {
  assert.match(parseArgs(['--bogus']).errors[0], /unknown option '--bogus'/)
})

test('a value option without a value is rejected', () => {
  assert.match(parseArgs(['--plugin']).errors[0], /--plugin needs a value/)
})

test('a bare positional argument is rejected', () => {
  assert.match(parseArgs(['my-plugin']).errors[0], /unexpected argument 'my-plugin'/)
})

test('args after -- are rejected rather than silently dropped', () => {
  // Forwarding unknown inner args would make the printed URL a guess.
  const options = parseArgs(['--port', '8080', '--', '--foo'])
  assert.match(options.errors[0], /unexpected arguments after '--'/)
})

test('all problems are reported at once, not just the first', () => {
  const options = parseArgs(['--bogus', '--port', 'bad', '--profile', 'BAD'])
  assert.equal(options.errors.length, 3)
})

test('the CLI shape from 设计文档 §5 parses', () => {
  const options = parseArgs([
    '--profile', 'dbgtest',
    '--port', '8080',
    '--plugin', './my-plugin',
    '--no-open',
  ])
  assert.deepEqual(options.errors, [])
  assert.equal(options.profile, 'dbgtest')
  assert.equal(options.port, 8080)
  assert.equal(options.plugin, './my-plugin')
  assert.equal(options.open, false)
})

test('usage text documents every option the parser accepts', () => {
  for (const option of ['--plugin', '--profile', '--from-default-profile', '--port', '--host', '--patch', '--overlay', '--dsh-home', '--no-open', '--no-debugger', '--json', '--help']) {
    assert.ok(USAGE.includes(option), `usage should document ${option}`)
  }
})

test('usage text states the isolation guarantee', () => {
  assert.match(USAGE, /third-party/)
})
