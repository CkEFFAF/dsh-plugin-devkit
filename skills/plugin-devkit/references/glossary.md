# Glossary

Use these words as written.

- **DevKit** — the product spanning inspector, boot, preview, and test. Not a single npm package.
- **Runtime inspector** — `dsh-debugger`. Live Fiber/service/tool timeline. Not VS Code breakpoints.
- **Source debugger** — Node inspector / Chrome DevTools on the DSH process.
- **Host half** — Node `apply(ctx)` of a plugin.
- **Client half** — browser bundle loaded by DSH `__ModuleLoader__` into a slot.
- **Profile** — bootable composition under `$DSH_HOME/profiles/<name>`.
- **Bundle** — installable patch + code (`dsh.bundle.patch`).
- **Overlay** — `--patch` file, last config layer.
- **Fiber** — Cordis lifecycle of one plugin row (`PENDING` / `LOADING` / `ACTIVE` / `FAILED`).
- **Slot** — official Web UI mount point (`conversation.view`, `settings.section`, …).
- **Seam** — the interface tests and callers share (`ctx.debugger`, CLI, JSON report).
- **Recipe** — out of v1 scope. A locked set of plugins for an end user.
