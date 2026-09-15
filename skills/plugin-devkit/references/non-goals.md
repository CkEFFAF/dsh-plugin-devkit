# Non-goals for v1

Do not implement these unless the user explicitly reopens scope.

- Plugin marketplace, awesome list, or install UI
- Agent trajectory / maze / LLM call DevTools (that is a different product)
- Source-level stepping inside `apply` (tell users to use `--inspect`)
- Automatic CSS/layout repair
- Persisting raw debug timelines to disk by default
- Replacing official `@deepseek-ai/dsh-experimental-inspector`
- Forking `dsh-web-app`
- Injecting `tools` into the inspector so it can PENDING on the thing it diagnoses
- Wrapping additional host methods beyond the ones already documented (today only `commands.execute` is an admitted debt)
