# dsh-debug-boot

Boot an **isolated** DSH profile for plugin development, with the `dsh-debugger`
kernel mounted and no risk of touching your daily instance.

```sh
debug-boot --plugin ./my-plugin --port 8080
```

```sh
node --test "packages/dsh-debug-boot/tests/*.test.mjs"   # 178 tests
```

## What it does

One command does the whole job:

1. Derives a profile from the **shipped** `web` template (default name `dbgtest`).
   Third-party plugins installed in your daily `web` profile are never copied in.
2. Generates an overlay that inserts your plugin and `dsh-debugger`.
3. Pre-checks the template, the port, and the plugin entry, so a failure names
   *which* thing was wrong instead of surfacing as a loader stack trace.
4. Hands off to `dsh` with inherited stdio, so the token-bearing URL line reaches you.

Defaults: `127.0.0.1:8080`, profile `dbgtest`, template `web`.

## Options

| Option | Meaning |
|---|---|
| `--plugin <dir-or-entry>` | plugin under test; a directory is resolved to its entry file |
| `--profile <name>` | profile to derive (default `dbgtest`) |
| `--from-default-profile <name>` | shipped template (default `web`) |
| `--port <n>` / `--host <addr>` | listen address (default `127.0.0.1:8080`) |
| `--patch <path>` | extra overlay, repeatable |
| `--overlay <path>` | write the generated overlay elsewhere |
| `--dsh-home <path>` | override `DSH_HOME` |
| `--no-open` | do not open a browser |
| `--no-debugger` | boot without the observation kernel |
| `--json` | machine-readable result |
| `--dry-run` | resolve and report the plan, then exit without booting |
| `-h`, `--help` | print usage |

A run **without** `--dry-run` starts a real DSH and stays in the foreground until it
exits — use `--dry-run` (alone, or with `--json` for scripting) to inspect the plan and
return immediately.

## Exit codes

A script can branch on *which* failure happened.

| Code | Exit | Meaning |
|---|---|---|
| `internal` | 1 | an unexpected internal failure |
| `template-missing` | 2 | the shipped template profile was not found |
| `port-in-use` | 3 | the debug port is already bound |
| `overlay-invalid` | 4 | the overlay could not be generated |
| `plugin-unresolved` | 5 | `--plugin` did not resolve to an entry file |
| `profile-corrupt` | 6 | the profile directory exists without a `package.json` |
| `plugin-pending` | 7 | the plugin never activated (names the awaited service) |
| `usage` | 64 | bad arguments |

## Two traps this handles for you

**The overlay `name` must be a file, never a directory.** Node's ESM `import()`
cannot directory-import, and a directory fails with the confusing
`Cannot find module '.../index.json'`. `--plugin <dir>` is resolved to a real file
(in order: `index.mjs`, `index.js`, `index.cjs`, `main.mjs`, `main.js`, then the
package's `exports["."]` / `module` / `main`). `assertEntryFile` is the enforcement
point, and `tests/entry.test.mjs` pins it.

**Windows `file://` URLs.** Built with `pathToFileURL`, never string concatenation,
which would produce `file://D:\...` — backslashes and a drive letter in the
authority position.

## Three profile states (found by really booting)

DSH is not two-state here, and the difference decides the launcher flags:

| State | Behaviour |
|---|---|
| directory absent | `--from-default-profile` is passed; DSH initializes it |
| directory + `package.json` | the flag is **omitted**; DSH loads it |
| directory, no `package.json` | **neither works** — reported as `profile-corrupt` |

The third state is refused rather than worked around, and the CLI never deletes a
directory that holds files it did not create. The one exception is a directory
containing only this tool's own stale overlay, which is cleared because it is ours.

## Verified real boot

Run against an isolated `DSH_HOME` with the kernel mounted:

```sh
debug-boot --dsh-home <empty-dir> --profile smoke --port 8081 --no-open
```

```
[dsh-debugger] probes active; run /debug health
dsh web: http://127.0.0.1:8081/?token=<per-process token>
```

`GET /` returned **401** without the token and **200** with it, while a
concurrently running instance stayed up throughout.

## Known DSH quirk (not this package)

An **empty (0-byte)** `$DSH_HOME/cordis.patch.yml` makes *every* DSH boot fail
with `must be a top-level YAML array of loader patch entries`. Plain
`dsh --profile rescue --dump-config` fails identically, with no DevKit involved,
so it is a pre-existing environment fault. Remove or empty-array (`[]`) that file
to boot anything at all.
