/**
 * Optional bundling for `--inline-client`.
 *
 * ## The problem this solves
 *
 * A real DSH client half is TypeScript (or JSX) that imports `react` and the
 * client packages by bare specifier. Two measured facts make that impossible to
 * inline as-is:
 *
 * - a `file://` page cannot import a `file://` module under modern browser rules;
 * - an inlined module (blob:/data:) resolves **neither** bare specifiers nor
 *   relative paths.
 *
 * So a client with imports cannot be inlined without first being flattened into a
 * single dependency-free module. That is what a bundler does.
 *
 * ## Why bundling is optional, not required
 *
 * esbuild is not a dependency of this package. Adding a native-binary bundler to
 * a test/dev tool is a heavy, platform-specific commitment, and the DevKit's
 * other three packages need nothing of the kind. So bundling is **best-effort**:
 *
 * - resolvable → the client is bundled and can be inlined;
 * - not resolvable → the caller is told plainly and pointed at `--serve`, which
 *   needs no bundler because the browser fetches the module normally.
 *
 * Nothing here silently degrades into a page that shows the placeholder. A
 * preview that quietly displays the wrong thing is worse than a refusal.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/** Packages probed for bundling, in preference order. */
const BUNDLER_CANDIDATES = ['esbuild']

/**
 * Try to load a bundler without making it a hard dependency.
 *
 * @returns {Promise<{name: string, version: string, build: Function}|null>}
 */
export async function loadBundler() {
  for (const name of BUNDLER_CANDIDATES) {
    try {
      const resolved = require.resolve(name)
      const module = await import(pathToFileURL(resolved).href)
      const build = module.build ?? module.default?.build
      if (typeof build !== 'function') continue
      return { name, version: String(module.version ?? module.default?.version ?? 'unknown'), build }
    } catch {
      // Not installed, or not importable: try the next candidate.
    }
  }
  return null
}

/**
 * Bundle a client entry into a single dependency-free ES module.
 *
 * @param {string} entryPath absolute path to the client entry
 * @param {{bundler: {build: Function}|null}} options
 * @returns {Promise<{ok: true, source: string, bytes: number} | {ok: false, reason: string, detail: string}>}
 */
export async function bundleClient(entryPath, options) {
  const bundler = options?.bundler
  if (!bundler || typeof bundler.build !== 'function') {
    return { ok: false, reason: 'no bundler available', detail: '' }
  }

  try {
    const result = await bundler.build({
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      format: 'esm',
      // The preview always runs in a browser. `platform: browser` makes esbuild
      // honour the packages' browser conditions and fail loudly on a Node
      // builtin, which is the right failure for a client half.
      platform: 'browser',
      // JSX/TS loaders so a `.tsx` client works without a separate build step.
      loader: { '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx' },
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
      logLevel: 'silent',
      metafile: false,
    })

    const file = result.outputFiles?.[0]
    if (!file) return { ok: false, reason: 'bundler produced no output', detail: '' }
    const source = file.text
    return { ok: true, source, bytes: source.length }
  } catch (error) {
    // esbuild reports diagnostics in `errors`; surface them, because "it did not
    // bundle" is useless without the reason.
    const errors = Array.isArray(error?.errors) ? error.errors : []
    const detail = errors.length
      ? errors
        .map((entry) => `${entry.text}${entry.location ? ` (${entry.location.file}:${entry.location.line})` : ''}`)
        .join('; ')
      : (error?.message ?? String(error))
    return { ok: false, reason: 'bundling failed', detail }
  }
}
