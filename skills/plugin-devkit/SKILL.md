---
name: plugin-devkit
description: Develop the DSH Plugin DevKit including runtime inspector, debug-boot, host contract tests, and client slot preview. Use when the user says Plugin DevKit, dsh-debugger, plugin test harness, slot preview, or debug-boot.
license: MIT
metadata:
  version: "0.1.0"
  type: workflow
  product: dsh-plugin-devkit
---

# Plugin DevKit

Guide work on the DeepSeek Harness Plugin DevKit. This skill encodes the product's invariants and the working order; each module's behaviour is described by its own README and source.

References

- [glossary](references/glossary.md), [non-goals](references/non-goals.md)

Start from the repository root, then work inside `packages/<module>/`.

## Product shape

Four modules behind one product name. Do not collapse them into one plugin.

| Module | Job | Interface callers learn |
|---|---|---|
| dsh-debugger | Observe a live composition | ctx.debugger and /debug |
| dsh-debug-boot | Boot an isolated profile | CLI only |
| dsh-plugin-preview | Mount a client half into a fake slot shell | preview CLI plus fixture snapshot |
| dsh-plugin-test | Assert host behavior without a browser | test helper plus JSON reports |

dsh-debugger is the observation kernel, not the whole DevKit, and not a source-level F5 debugger.

## Invariants (do not violate)

1. Observer must not change observed behavior. Waterfall probes forward next() unchanged.
2. Probe failures never fail the tool or command under test.
3. Sanitize secrets before they enter any buffer or report.
4. Buffers are bounded. Overflow is counted and visible.
5. Debugger inject is only commands (plus optional debugger for consumers). Never inject tools.
6. Isolated profile for all live checks. Never require the user's daily web profile.
7. Layout preview and runtime inspection stay separate packages.
8. No marketplace, no agent-trajectory workbench, no fork of official Web UI.

## Working order

1. Read the module's own README and source before changing it.
2. Implement one module at a time. Host contract first, CLI second, Client last.
3. Tests use a fake Cordis context that can construct PENDING, FAILED, and deny. Add one real dsh web --patch smoke per module, not instead of the fake host.
4. Public surface is ctx.debugger, CLI exit codes, and JSON reports. UI is a consumer, never the only acceptance path.
5. After a change, update any README or doc comment whose interface description moved.

## When the user asks for layout or UI tests

- Host functional tests go to dsh-plugin-test plus ctx.debugger.
- Click-to-RPC tests use Playwright against debug-boot and stay optional in v1.
- Layout uses dsh-plugin-preview fixtures and screenshots only. Do not promise automatic layout repair.

## Naming

Say runtime inspector when talking about dsh-debugger. Say source debugger only for NODE_OPTIONS=--inspect. Do not advertise F5-in-apply as a DevKit feature.
