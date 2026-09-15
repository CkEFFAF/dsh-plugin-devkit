/**
 * Real-host check: the /debug command definition must satisfy the ACTUAL
 * `CommandDefinition` contract, and must register through the debugger's own
 * `apply`.
 *
 * ## Why this file exists
 *
 * The debugger shipped registering `execute` + `arguments`. The real contract is
 * `handler` + `input.hint`, and `normalizeDefinition`
 * (`packages/interaction/commands/src/index.ts:189`) **throws** on a missing
 * `handler`. Because registration is wrapped in `safeEffect`, that throw was
 * swallowed: the plugin mounted, printed "probes active", and `/debug` did not
 * exist at all. 490 unit tests and all four real-machine checks passed anyway,
 * because every fake host stored anything and dispatched through
 * `definition.execute` — the same wrong assumption the plugin was written from.
 *
 * The previous version of this file mounted the real debugger and drove
 * `registered.get('debug').execute('health')` — reading the wrong field directly
 * off the definition, so it could not detect the defect either. It now invokes
 * the command the way a session does: through `CommandRuntime.execute`, which
 * appends the command/run + command/done lifecycle records.
 *
 * Run from the DSH checkout:
 *   cd D:/DSH/deepseek-harness
 *   node --import tsx/esm <workspace>/packages/dsh-debugger/tests/real-registration.mjs
 */

import assert from 'node:assert/strict'

import { Context } from 'file:///D:/DSH/deepseek-harness/vendor/cordis/src/index.ts'
import { CommandRuntime } from 'file:///D:/DSH/deepseek-harness/packages/interaction/commands/src/index.ts'

import { apply } from '../index.mjs'

const results = []
async function check(label, fn) {
  try {
    await fn()
    results.push({ ok: true, label })
  } catch (error) {
    results.push({ ok: false, label, error })
  }
}

/** Mount the debugger over a real CommandRuntime and hand back both. */
function mount() {
  const ctx = new Context()
  // `new CommandRuntime(ctx)` already provides the `commands` service
  // (TypertRemoteService registers itself), so it must NOT be provided again.
  // The debugger declares `inject: ['commands']` and resolves it from here.
  const commands = new CommandRuntime(ctx)
  const api = apply(ctx, { capacity: 100 })
  return { ctx, commands, api }
}

/**
 * The smallest Agent `execute` will accept.
 *
 * `execute` appends `command/run` and `command/done` to `agent.session`, so an
 * agent whose `session` is undefined cannot be used at all. A minimal object
 * with a session carrying the append surface is enough to reach the handler.
 */
function probeAgent() {
  const appended = []
  return {
    appended,
    agent: {
      session: {
        append: (type, data) => {
          appended.push({ type, data })
          return { seq: appended.length }
        },
      },
    },
  }
}

await check('the real CommandRuntime rejects a definition without `handler`', () => {
  const ctx = new Context()
  const commands = new CommandRuntime(ctx)
  // This is the exact shape the debugger used to register.
  assert.throws(
    () => commands.register({
      name: 'broken',
      description: 'no handler',
      arguments: '[sub]',
      execute: () => 'output',
    }),
    /handler must be a function/,
  )
})

await check('the real CommandRuntime accepts the shape the debugger now uses', () => {
  const ctx = new Context()
  const commands = new CommandRuntime(ctx)
  assert.doesNotThrow(() => commands.register({
    name: 'ok',
    description: 'correct shape',
    input: { hint: '[subcommand]' },
    handler: () => ({ kind: 'success', text: 'fine' }),
  }))
})

await check('apply() registers /debug on a real CommandRuntime', () => {
  const { commands } = mount()
  const list = commands.list(undefined)
  const names = list.map((d) => d.name)
  assert.ok(
    names.includes('debug'),
    `/debug is not registered; the composition exposes: ${names.join(', ') || '(none)'}`,
  )
})

await check('the registered definition uses handler, not execute', () => {
  const { commands } = mount()
  const definition = commands.find(undefined, 'debug')
  assert.ok(definition, 'the debug definition must be resolvable')
  assert.equal(typeof definition.handler, 'function', 'the field must be `handler`')
  assert.equal(definition.execute, undefined, '`execute` is not part of the contract')
  assert.equal(definition.arguments, undefined, '`arguments` is not part of the contract')
})

await check('the registered definition advertises input.hint', () => {
  const { commands } = mount()
  const descriptor = commands.list(undefined).find((d) => d.name === 'debug')
  assert.equal(typeof descriptor?.input?.hint, 'string')
})

await check('/debug answers through the real execute() path', async () => {
  const { commands } = mount()
  const { agent } = probeAgent()
  const execution = await commands.execute(
    agent,
    '/debug health',
    [],
    new AbortController().signal,
  )
  assert.ok(execution, 'execute returned undefined: the command did not resolve')
  assert.equal(execution.result.kind, 'success')
  assert.match(String(execution.result.text), /plugins/)
})

await check('/debug health --json is JSON-parseable through execute()', async () => {
  const { commands } = mount()
  const { agent } = probeAgent()
  const execution = await commands.execute(
    agent,
    '/debug health --json',
    [],
    new AbortController().signal,
  )
  const parsed = JSON.parse(String(execution?.result?.text))
  assert.equal(typeof parsed.counts.total, 'number')
})

await check('executing /debug records the command lifecycle', async () => {
  const { commands } = mount()
  const { agent, appended } = probeAgent()
  await commands.execute(agent, '/debug health', [], new AbortController().signal)
  const types = appended.map((entry) => entry.type)
  // A definition the registry never resolved records nothing, which is exactly
  // how the execute-vs-handler defect presented on a live host.
  assert.deepEqual(types, ['command/run', 'command/done'])
})

let failed = 0
for (const result of results) {
  if (result.ok) console.log(`ok    ${result.label}`)
  else {
    failed += 1
    console.log(`FAIL  ${result.label}`)
    console.log(`        ${result.error?.message ?? result.error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) process.exit(1)
