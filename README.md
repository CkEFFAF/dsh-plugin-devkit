# DSH Plugin DevKit

**English** | [中文](README.zh-CN.md)

Tools for developing [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugins: a runtime
inspector you can query from a live session, an isolated boot for testing, host contract tests
without a browser, and a slot preview for client halves.

**Status:** all four modules implemented. 547 unit tests, plus six real-machine checks that run
against a real cordis runtime, a real DSH boot, and a real model turn. Verified against DSH
`0.1.5-rc.2`.

> **Community project.** This DevKit is community-maintained and is **not** affiliated with,
> endorsed by, or supported by DeepSeek AI. "DeepSeek Harness" and "DSH" name the upstream
> platform it is built for.

---

## Getting started

The DevKit is a monorepo and is **not published to npm**. Install the packages you need from a
clone by path:

```sh
git clone https://github.com/CkEFFAF/dsh-plugin-devkit.git dsh-plugin-devkit
cd dsh-plugin-devkit
npm install                      # links the four packages into ./node_modules
```

Then, in **your plugin's** directory, point at the packages you want:

```sh
npm install --save-dev \
  file:../dsh-plugin-devkit/packages/dsh-debugger \
  file:../dsh-plugin-devkit/packages/dsh-plugin-test \
  file:../dsh-plugin-devkit/packages/dsh-debug-boot \
  file:../dsh-plugin-devkit/packages/dsh-plugin-preview
```

Adjust the relative path to wherever you cloned it. Each package is exported under its own name
(`dsh-debugger`, `dsh-plugin-test`, …) and the three with a CLI install a command.

### Install the runtime inspector into a DSH profile

`dsh-debugger` is a runtime plugin, so it is mounted in a profile through the DSH CLI:

```sh
dsh plugin --profile web add /path/to/dsh-plugin-devkit/packages/dsh-debugger
```

`dsh plugin` runs pnpm inside the profile directory and then reconciles `dsh.profile.bundles`,
so the package joins the layer stack because it declares `dsh.bundle.patch`. Restart DSH and
`/debug health` answers.

> The four packages are **not published to npm**, so the spec above is a path to the cloned
> package. The bare `dsh plugin --profile web add dsh-debugger` form needs an npm release first.

> **Why not `npm install git+https://…`?** npm only gained git-subdirectory support in 10.5, and
> older versions **silently install the repository root** instead of the package you asked for —
> you get a folder with no entry point and no error. Installing by path after a clone works
> everywhere. Verified against npm 10.1 and node 22.

### Requirements

**DSH `0.1.5-rc.2`** — the release this DevKit is developed and verified against, declared as
`engines.dsh` by every package. The DevKit reaches the host only through public seams
(`ctx.debugger`, `/debug`, CLI exit codes, JSON reports), so a nearby release will usually work,
but anything else is untested.

Node 22 or newer. `dsh-plugin-preview` optionally uses a system Edge/Chrome for screenshots and
esbuild for bundling; both are probed at runtime and their absence is reported, never downloaded.

---

## What each module is for

| Package | What it does | Learn |
|---|---|---|
| `dsh-debugger` | Observe a live composition: a bounded timeline, the `/debug` command, and a programmable `ctx.debugger` | `ctx.debugger`, `/debug` |
| `dsh-debug-boot` | Boot an isolated DSH profile so live checks never touch your daily setup | the `debug-boot` CLI |
| `dsh-plugin-test` | Assert host behaviour without a browser, with a fake Cordis host and a JSON report | the `dsh-plugin-test` CLI |
| `dsh-plugin-preview` | Mount your client half into a fake slot shell at approximate official theme sizes | the `dsh-plugin-preview` CLI |

`dsh-debugger` is a **runtime** inspector. It is not a source-level stepper — for breakpoints use
`NODE_OPTIONS=--inspect` and your editor's attach (the DevKit's own `/debug health` reminds you).

---

## The workflow

```sh
# 1. Contract tests against a fake host — no browser, no server.
node --test tests/*.test.mjs
dsh-plugin-test tests/cases.mjs --plugin .

# 2. Look at your client half.
dsh-plugin-preview --slot tool.view.mine --client ./client.mjs --serve

# 3. Boot an isolated instance with your plugin mounted.
debug-boot --plugin ./index.mjs --port 8080

# 4. In that session:
#    /debug health            is everything active?
#    /debug plugins --name mine
#    /debug plugins --not-active
#    /debug events --category tool -v
#    /debug trace <callId>
```

### `dsh-plugin-test`

```js
import { noPending, serviceActive, noSecrets } from 'dsh-plugin-test'

// The runner mounts this on its host before running your cases.
export const plugin = { name: 'my-plugin', apply }

export const cases = [
  {
    name: 'my service is provided',
    run: ({ ctx, plugin: mine }) => {
      if (!ctx.get('mine')) throw new Error('not provided')
    },
  },
  { name: 'nothing is stuck pending', run: ({ debugger: d }) => noPending(d) },
]
```

`run` receives `{ ctx, debugger, host, plugin, pluginError }`. It may return nothing (success),
`true`, or an assertion result from the helpers — throwing on failure is the normal style and is
reported with your own message.

Exit codes: `0` all passed, `1` a case failed, `2` usage, `3` a module or plugin could not load.
The report is stable-schema JSON and includes `summary.overflowed` and `recordsDropped`, so a run
that lost evidence cannot read as a clean pass.

### `dsh-plugin-preview`

Your client half exports `mount(el, { fixture, slot, scheme, viewport })`, or a default function
with that signature. The page renders **light/dark × narrow/wide**, and defines the official
`--dsw-alias-*` token names, so CSS written against them resolves.

```sh
# Live view while you work.
dsh-plugin-preview --slot tool.view.mine --client ./client.mjs --serve

# A self-contained HTML file you can open directly.
dsh-plugin-preview --slot tool.view.mine --client ./client.mjs --inline-client --out page.html

# One PNG per variant, for your own screenshot diff.
dsh-plugin-preview --slot tool.view.mine --client ./client.mjs --serve --shot ./shots
```

`--serve` and `--inline-client` are two different paths for a measured reason: an inlined module
(`blob:`/`data:`) resolves neither bare specifiers nor relative paths, so a client importing
`react` is first flattened with esbuild — and if esbuild is missing the tool **refuses** rather
than writing a page that silently shows the placeholder.

**It does not promise pixel parity.** Sizes are approximations and the page says so; layout
regressions need a screenshot diff against the live shell. `--shot` captures, it does not compare.

---

## Repository layout

| Path | What |
|---|---|
| `packages/` | the four packages |
| `skills/plugin-devkit/` | an agent skill describing the product's invariants |

---

## Running the tests

```sh
npm test                                                    # 547 tests

node --test "packages/dsh-debugger/tests/*.test.mjs"        # 232
node --test "packages/dsh-debug-boot/tests/*.test.mjs"      # 178
node --test "packages/dsh-plugin-test/tests/*.test.mjs"     # 74
node --test "packages/dsh-plugin-preview/tests/*.test.mjs"  # 63
```

**Free port 8080 first.** The debug-boot CLI tests assert a successful boot; a live `debug-boot`
instance still holding 8080 makes twelve of them fail with `port-in-use`.

### Checks that need a real machine

These are **not** part of `npm test` — they need the DSH checkout or a real server. Run them from
your DSH checkout:

```sh
cd /path/to/deepseek-harness
node --import tsx/esm /path/to/dsh-plugin-devkit/packages/dsh-debugger/tests/real-cordis.mjs
node --import tsx/esm /path/to/dsh-plugin-devkit/packages/dsh-plugin-test/tests/real-process.mjs
node --import tsx/esm /path/to/dsh-plugin-devkit/packages/dsh-debugger/tests/real-registration.mjs
node --import tsx/esm /path/to/dsh-plugin-devkit/packages/dsh-debugger/tests/real-llm-probe.mjs
node --import tsx/esm /path/to/dsh-plugin-devkit/packages/dsh-plugin-test/tests/real-fake-audit.mjs
```

| Check | Expected |
|---|---|
| `real-cordis.mjs` | `14/14` |
| `real-process.mjs` | `15/15` |
| `real-registration.mjs` | `8/8` |
| `real-llm-probe.mjs` | `6/6` |
| `real-fake-audit.mjs` | `20/20 surfaces AGREE` |

And the isolated boot smoke, which spawns a real server on 8099 and seeds its own throwaway
`DSH_HOME`:

```sh
node packages/dsh-debug-boot/tests/real-boot.mjs    # 6/6
```

---

## Two traps worth knowing before you start

**A 0-byte `$DSH_HOME/cordis.patch.yml` breaks every boot.** DSH rejects an empty patch list, so
plain `dsh --profile rescue --dump-config` fails too — nothing to do with this project. An empty
file is not an empty array: the contents must be `[]`.

**A plugin that never activates stops the boot entirely.** If your plugin `inject`s a service the
composition does not provide, DSH refuses to start and `/debug` never runs — so the inspector
cannot explain it. `debug-boot` recognises this case and reports it as `plugin-pending` (exit 7)
naming the service you are waiting for.

---

## License

MIT — see [LICENSE](LICENSE).
