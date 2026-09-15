/**
 * A fake Cordis host for plugin contract tests.
 *
 * ## Why a fake host rather than a real DSH
 *
 * A plugin's contract tests must be able to *construct failure*: a fiber stuck in
 * PENDING, a FAILED plugin, a denied tool call, a service whose getter throws, a
 * loader that explodes. A real host cannot produce those states on demand, so
 * the unit-test seam is a fake shaped to the real Cordis contract rather than a
 * second Cordis.
 *
 * ## Fidelity
 *
 * The shapes below were checked against `vendor/cordis/src` **and** against a
 * live `Context`:
 *
 * - `ctx.on(event, listener)` -> returns a disposer (events.ts).
 * - `ctx.effect(callback)` -> the callback returns a dispose function; the effect
 *   owns restoration (fiber.ts).
 * - `ctx.provide(name, value)` -> registers a service (reflect.ts / service.ts).
 *   A DUPLICATE provide is refused with `service "x" has been registered at
 *   <root>` and the original survives (measured against a live `Context`).
 * - `ctx.get(name)` -> resolves a service (reflect.ts).
 * - `ctx.registry.entries()` -> `[callback, Plugin.Runtime]`, where a runtime is
 *   `{ name?, fibers, callback, Config? }` and `fibers` is iterable with a
 *   `.length` (registry.ts:136, utils.ts `DisposableList`).
 * - `ctx.reflect.store` -> the live service registration table: symbol-keyed
 *   `Impl` records of `{ name, fiber, value?, check? }` (reflect.ts:209, 288).
 * - `ctx.reflect.props` -> the *declaration* table, which mixes real services
 *   (`{type:'service'}`) with the reflection accessors (`{type:'accessor'}`).
 *   It is modelled faithfully so that code wrongly consulting it produces
 *   visibly wrong output instead of passing by luck.
 * - `ctx.logger.error(message)` -> where cordis routes plugin load failures
 *   (fiber.ts:126).
 *
 * `tests/fiber-state.test.mjs` proves the `FiberState` mirror matches the real
 * cordis source text, so this fake cannot silently disagree with the host about
 * state numbering.
 */

import { FiberState } from './fiber-state.mjs'

// Re-exported so a test that builds a host does not need a second import just to
// name a fiber state.
export { FiberState }

/**
 * A fiber stand-in carrying only the fields an inspector reads.
 *
 * @param {{state?: number, uid?: number, inject?: object|string[]}} [options]
 * @returns {{state: number, uid: number, inject: object|string[]}}
 */
export function fakeFiber(options = {}) {
  return {
    state: options.state ?? FiberState.PENDING,
    uid: options.uid ?? 1,
    inject: options.inject ?? {},
  }
}

/**
 * A plugin runtime stand-in matching `Plugin.Runtime`.
 *
 * `fibers` mimics `DisposableList`: iterable, with a `length`.
 *
 * The field set is deliberately identical to what the real registry yields —
 * measured on a live `Context`: `['Config', 'callback', 'fibers', 'name']`.
 * Omitting `Config` (as this once did) means inspector code reading a runtime's
 * configuration would see `undefined` here and a real value on the host: the
 * same class of divergence that hid the `handler` defect.
 *
 * @param {{name?: string, fibers?: object[], callback?: Function, Config?: object}} [options]
 * @returns {{name: string, callback: Function, Config: object, fibers: {length: number, [Symbol.iterator]: () => Iterator<object>}}}
 */
export function fakeRuntime(options = {}) {
  const fibers = options.fibers ?? []
  return {
    name: options.name ?? 'test-plugin',
    callback: options.callback ?? function testPlugin() {},
    Config: options.Config ?? {},
    fibers: {
      length: fibers.length,
      [Symbol.iterator]() {
        return fibers[Symbol.iterator]()
      },
    },
  }
}

/**
 * Create a fake Cordis context.
 *
 * @param {{
 *   plugins?: Array<{name?: string, fibers?: object[], callback?: Function}>,
 *   services?: object,
 *   serviceProviders?: Record<string, {name?: string, state?: number}>,
 *   failEntries?: boolean,
 *   failGet?: boolean,
 *   failOn?: boolean,
 * }} [options]
 * @returns {object} a context plus the test-only helpers documented below
 */
export function createFakeContext(options = {}) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const effects = []
  /** @type {object} */
  const provided = { ...(options.services ?? {}) }
  /** @type {unknown[][]} */
  const logErrors = []
  /** @type {Array<[Function, object]>} */
  const pluginEntries = []

  for (const plugin of options.plugins ?? []) {
    pluginEntries.push([plugin.callback ?? function named() {}, fakeRuntime(plugin)])
  }

  const registry = {
    entries() {
      if (options.failEntries) throw new Error('registry exploded')
      return pluginEntries[Symbol.iterator]()
    },
    values() {
      return pluginEntries.map(([, runtime]) => runtime)[Symbol.iterator]()
    },
    size: pluginEntries.length,
  }

  const logger = {
    error(...args) {
      logErrors.push(args)
    },
    info() {},
    warn() {},
    debug() {},
  }

  // The live service registration table, keyed by symbol as the real one is.
  const store = {}
  for (const [name, value] of Object.entries(options.services ?? {})) {
    if (value === undefined) continue
    const provider = options.serviceProviders?.[name]
    store[Symbol(name)] = {
      name,
      value,
      fiber: provider
        ? { name: provider.name ?? name, state: provider.state ?? FiberState.ACTIVE }
        : { name: `${name}-provider`, state: FiberState.ACTIVE },
    }
  }

  const ctx = {
    registry,
    logger,
    reflect: {
      store,
      props: {
        // The accessors real Cordis installs on every context.
        get: { type: 'accessor' },
        set: { type: 'accessor' },
        provide: { type: 'accessor' },
        accessor: { type: 'accessor' },
        mixin: { type: 'accessor' },
        on: { type: 'accessor' },
        once: { type: 'accessor' },
        waterfall: { type: 'accessor' },
        ...Object.fromEntries(
          Object.entries(options.services ?? {})
            .filter(([, value]) => value !== undefined)
            .map(([name]) => [name, { type: 'service' }]),
        ),
      },
    },
    events: {
      dispatch(_mode, args) {
        const list = listeners.get(args[0]) ?? []
        return list.map((fn) => fn)
      },
    },

    get(name) {
      if (options.failGet) throw new Error('ctx.get exploded')
      return provided[name]
    },

    provide(name, value) {
      // The real host REFUSES a duplicate registration and leaves the original
      // in place: `service "x" has been registered at <root>` (measured against
      // a live Context). Silently overwriting — as this fake used to — is
      // exactly the kind of leniency that hides defects: the debugger wraps its
      // `provide('debugger')` in a try/catch that RECORDS the failure, and on
      // the old fake that branch was unreachable.
      if (Object.prototype.hasOwnProperty.call(provided, name)) {
        throw new Error(`service "${name}" has been registered at <root>`)
      }
      // Real cordis writes the live registration table as well as resolving the
      // name (reflect.ts:288-292). Keeping only the lookup would make a provider
      // invisible to anything reading `reflect.store` — which is exactly how the
      // debugger enumerates services, so the omission would show a mounted
      // service as missing.
      provided[name] = value
      store[Symbol(name)] = {
        name,
        value,
        fiber: { name: `${name}-provider`, state: FiberState.ACTIVE },
      }
      if (!ctx.reflect.props[name]) ctx.reflect.props[name] = { type: 'service' }
    },

    on(event, listener) {
      if (options.failOn) throw new Error('event bus unavailable')
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index !== -1) current.splice(index, 1)
      }
    },

    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {
        const index = effects.indexOf(dispose)
        if (index !== -1) effects.splice(index, 1)
        dispose?.()
      }
    },

    // ------------------------------------------------------------ test API ----

    /**
     * Emit an event, calling every listener with only the payload.
     *
     * @param {string} event
     * @param {unknown} payload
     * @returns {unknown[]} each listener's return value
     */
    emit(event, payload) {
      const list = listeners.get(event) ?? []
      return list.map((fn) => fn(payload))
    },

    /**
     * Run a waterfall event, threading `next` exactly as cordis does.
     *
     * The final `next()` returns `terminal`, so a probe that fails to forward the
     * original value changes the observable result and the test catches it.
     *
     * @param {string} event
     * @param {unknown} payload
     * @param {unknown} [terminal] value the final `next()` resolves to
     * @returns {unknown}
     */
    waterfall(event, payload, terminal = { behavior: 'allow' }) {
      const list = listeners.get(event) ?? []
      let index = -1
      const next = () => {
        index += 1
        if (index < list.length) return list[index](payload, next)
        return terminal
      }
      return next()
    },

    /**
     * How many listeners are attached to an event.
     *
     * @param {string} event
     * @returns {number}
     */
    listenerCount(event) {
      return (listeners.get(event) ?? []).length
    },

    /**
     * Every argument list passed to `ctx.logger.error`.
     *
     * @returns {unknown[][]}
     */
    loggedErrors() {
      return logErrors
    },

    /**
     * Run every registered disposer in reverse, simulating unload.
     *
     * Reverse order matters: a later wrapper must come off before the one it
     * wrapped, which is the contract 设计文档 §4.3 requires of method wrappers.
     */
    disposeAll() {
      for (const dispose of [...effects].reverse()) dispose()
      effects.length = 0
    },

    /**
     * Services currently provided, as a plain object.
     *
     * @returns {object}
     */
    services() {
      return provided
    },

    /**
     * Add a service after construction, updating both the lookup table and the
     * live store so a later snapshot sees it.
     *
     * Unlike `provide`, this is a test affordance and REPLACES an existing
     * service: a test that wants to swap the `tools` implementation mid-flight
     * is a legitimate scenario the real host expresses by unloading and
     * remounting. It is deliberately more permissive than `provide`, and that
     * difference is intentional — do not "fix" it to throw.
     *
     * @param {string} name
     * @param {unknown} value
     * @param {{name?: string, state?: number}} [provider]
     */
    addService(name, value, provider) {
      provided[name] = value
      ctx.reflect.props[name] = { type: 'service' }
      store[Symbol(name)] = {
        name,
        value,
        fiber: provider
          ? { name: provider.name ?? name, state: provider.state ?? FiberState.ACTIVE }
          : { name: `${name}-provider`, state: FiberState.ACTIVE },
      }
    },
  }

  return ctx
}

/**
 * Build a minimal command-registry service.
 *
 * ## Signature fidelity
 *
 * The real `CommandRuntime.execute` is `@Remote async execute(agent, line,
 * attachments, signal)` (`packages/interaction/commands/src/index.ts:361`) — an
 * Agent first, then a line like `/debug health`. An earlier version of this fake
 * took `(name, ...)`, and that difference hid a real bug: the debugger's wrapper
 * read `args[0]` for the command name, so against the true signature every
 * command was recorded as the generic `"command"` while every test still passed.
 *
 * The fake now matches the real shape. `executeByName` remains for tests that
 * just want to invoke a registered command without spelling a line.
 *
 * ## Registration fidelity
 *
 * `register` validates the definition the way the real `normalizeDefinition`
 * does (`interaction/commands/src/index.ts:179`). It previously stored anything
 * at all and dispatched through `definition.execute`, which is not part of the
 * contract — so a plugin registering `execute` instead of `handler` registered
 * fine here and threw on the real host. That is exactly what happened to
 * `/debug`: it mounted, announced itself, and never existed as a command. A fake
 * that accepts what the host rejects is worse than no fake.
 *
 * @param {{executeThrows?: boolean}} [options]
 * @returns {object}
 */
export function createFakeCommands(options = {}) {
  const registered = new Map()
  return {
    register(definition) {
      // Mirrors normalizeDefinition's rejections, so a wrong field name fails
      // here instead of only on a real host.
      if (typeof definition?.name !== 'string' || !/^[a-z][\w:-]*$/.test(definition.name)) {
        throw new TypeError(`command name "${String(definition?.name)}" must match /^[a-z][\\w:-]*$/`)
      }
      if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
        throw new TypeError(`command "${definition.name}" description must not be empty`)
      }
      if (typeof definition.handler !== 'function') {
        throw new TypeError(`command "${definition.name}" handler must be a function`)
      }
      if (definition.input !== undefined) {
        const hint = definition.input?.hint
        if (typeof hint !== 'string' || hint.trim().length === 0) {
          throw new TypeError(`command "${definition.name}" input hint must be a string`)
        }
      }
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    /**
     * Real shape: `execute(agent, line, attachments, signal)`.
     *
     * @param {unknown} agent
     * @param {string} line a line such as `/debug health`
     * @returns {Promise<unknown>}
     */
    async execute(agent, line) {
      if (options.executeThrows) throw new Error('command failed')
      const parsed = /^\s*\/?([\w:-]+)/.exec(String(line ?? ''))
      if (!parsed) return undefined
      const definition = registered.get(parsed[1])
      // An unresolved name returns undefined, exactly as the real
      // CommandRuntime does (index.ts:368-370) — it does not round-trip the
      // name, so a caller cannot mistake "not found" for "ran".
      if (!definition) return undefined
      const rawInput = String(line ?? '').slice(parsed[0].length)
      const result = await definition.handler({
        commandId: `cmd-${registered.size}`,
        agent,
        rawInput,
        attachments: [],
        signal: new AbortController().signal,
      })
      return { commandId: `cmd-${registered.size}`, result }
    },
    /**
     * Convenience: invoke a registered command directly by name.
     *
     * @param {string} name
     * @param {...unknown} args
     * @returns {Promise<unknown>}
     */
    async executeByName(name, ...args) {
      if (options.executeThrows) throw new Error('command failed')
      const definition = registered.get(name)
      if (!definition) return undefined
      const result = await definition.handler({
        commandId: `cmd-${registered.size}`,
        agent: undefined,
        rawInput: args.join(' '),
        attachments: [],
        signal: new AbortController().signal,
      })
      return { commandId: `cmd-${registered.size}`, result }
    },
    registry: {
      keys: () => registered.keys(),
    },
    registered,
  }
}

/**
 * Build a minimal tools service.
 *
 * @param {{executeThrows?: boolean}} [options]
 * @returns {object}
 */
export function createFakeTools(options = {}) {
  return {
    async execute(name, args) {
      if (options.executeThrows) throw new Error('tool exploded')
      return { name, args, ok: true }
    },
    list() {
      return ['read', 'write']
    },
  }
}
