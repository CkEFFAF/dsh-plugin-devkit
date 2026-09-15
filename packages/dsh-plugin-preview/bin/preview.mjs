#!/usr/bin/env node
/**
 * `dsh-plugin-preview` CLI.
 *
 * 功能文档 §6.4: input is a client bundle path + slot id + a fixture snapshot;
 * output is a local static shell. This writes the shell and, unless suppressed,
 * serves it on loopback.
 *
 * Binding is `127.0.0.1` only. 设计文档 §9 requires it: the DevKit does not build a
 * gateway, and a preview page that mounted a plugin's client half is not
 * something to expose on a network interface.
 */

import { createServer } from 'node:http'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

import { renderShell, VIEWPORTS } from '../src/shell.mjs'
import { createFixture } from '../src/fixture.mjs'
import { isMainModule } from '../src/main-module.mjs'
import { tokenNames } from '../src/tokens.mjs'
import { loadBundler, bundleClient } from '../src/bundle.mjs'
import { captureShots } from '../src/screenshot.mjs'

/** Exit codes. */
export const EXIT = Object.freeze({ OK: 0, USAGE: 2, IO: 3 })

const USAGE = `dsh-plugin-preview — mount a client half into a fake slot

Usage:
  dsh-plugin-preview --slot <id> [options]

Options:
  --slot <id>          the slot to preview (required)
  --client <path>      client entry exporting mount(el, ctx) or a default function
  --out <path.html>    write the shell to a file
  --serve              serve the shell on 127.0.0.1
  --port <n>           port for --serve (default 8090)
  --scheme <s>         light, dark, or both (default both)
  --viewport <v>       narrow, wide, or both (default both)
  --fixture <path>     JSON fixture to use instead of the built-in one
  --inline-client      embed the client's source so a written file mounts it
  --no-bundle          do not bundle for --inline-client; fail instead if needed
  --shot <dir>         with --serve: capture one PNG per variant, then exit
  --tokens             print the theme token names the shell defines
  -h, --help           show this help

--inline-client embeds the client into the page, which works from a plain file://
URL. A client whose imports cannot be resolved in a browser (react, relative
paths) is first flattened with esbuild when it is installed; without esbuild the
command refuses rather than writing a page that silently shows the placeholder.
Use --serve for the same case with no bundler at all.

The shell defines the official --dsw-alias-* token names at approximate values,
so CSS written against them resolves. It does not match the live shell
pixel-for-pixel: layout regressions need a screenshot diff. --shot captures the
images for such a diff; it does not perform the comparison.
`

/**
 * Parse argv.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const options = {
    slot: null,
    client: null,
    out: null,
    serve: false,
    port: 8090,
    scheme: 'both',
    viewport: 'both',
    fixture: null,
    shot: null,
    tokens: false,
    inlineClient: false,
    noBundle: false,
    help: false,
  }
  const wantsValue = new Set(['--slot', '--client', '--out', '--port', '--scheme', '--viewport', '--fixture', '--shot'])

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '-h' || token === '--help') { options.help = true; continue }
    if (token === '--serve') { options.serve = true; continue }
    if (token === '--tokens') { options.tokens = true; continue }
    if (token === '--inline-client') { options.inlineClient = true; continue }
    if (token === '--no-bundle') { options.noBundle = true; continue }
    if (token === '--no-shutdown-message') { options.quietShutdown = true; continue }

    if (wantsValue.has(token)) {
      const value = argv[i + 1]
      i += 1
      if (value === undefined) continue
      switch (token) {
        case '--slot': options.slot = value; break
        case '--client': options.client = value; break
        case '--out': options.out = value; break
        case '--scheme': options.scheme = value; break
        case '--viewport': options.viewport = value; break
        case '--fixture': options.fixture = value; break
        case '--shot': options.shot = value; break
        case '--port': {
          const port = Number(value)
          if (Number.isFinite(port) && port > 0 && port < 65536) options.port = Math.floor(port)
          break
        }
        default: break
      }
    }
  }
  return options
}

/**
 * Expand a `--scheme`/`--viewport` selector into a list.
 *
 * @param {string} value
 * @param {string[]} allowed
 * @returns {string[]}
 */
export function expandSelector(value, allowed) {
  if (value === 'both' || value === undefined) return [...allowed]
  const parts = String(value).split(',').map((part) => part.trim()).filter(Boolean)
  const valid = parts.filter((part) => allowed.includes(part))
  return valid.length ? valid : [...allowed]
}

/**
 * Build the shell for a set of options.
 *
 * @param {object} options parsed argv
 * @param {object} [fixture] fixture override
 * @param {string|null} [clientUrl] client module URL to embed
 * @param {string|null} [clientSource] client source to inline instead of a URL
 * @returns {string} HTML
 */
export function buildShell(options, fixture, clientUrl, clientSource = null) {
  const slot = options.slot
  const data = fixture ?? createFixture({ slot })

  // A client module is imported by the page, so it must be an absolute file URL
  // — the same Node ESM constraint 设计文档 §5 records for overlay entries.
  const clientModule = clientUrl !== undefined
    ? clientUrl
    : (options.client ? pathToFileURL(resolve(options.client)).href : null)

  return renderShell({
    slot,
    fixture: data,
    clientModule: clientSource ? null : clientModule,
    clientSource,
    schemes: expandSelector(options.scheme, ['light', 'dark']),
    viewports: expandSelector(options.viewport, Object.keys(VIEWPORTS)),
  })
}

/** Path the client module is served under when `--serve` is used. */
export const CLIENT_ROUTE = '/__preview_client.mjs'

/**
 * Module specifiers a client half uses that an inlined copy cannot resolve.
 *
 * Measured in a real browser: a `data:`/`blob:` module resolves **neither** bare
 * specifiers (`react`, `@deepseek-ai/...`) **nor** relative paths (`./slots.ts`),
 * and cannot fetch an absolute `file://` URL either. Only a dependency-free
 * module survives inlining.
 *
 * Real DSH client halves import `react` and the client packages almost without
 * exception, so this check is what keeps `--inline-client` from producing a page
 * that looks fine and silently shows the placeholder instead.
 *
 * @param {string} source
 * @returns {string[]} the offending specifiers, deduplicated
 */
export function unresolvableImports(source) {
  const found = new Set()
  // Static imports, dynamic imports, and re-exports all carry a specifier.
  const patterns = [
    /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[\w*{}\s,$]+\s+from\s+)['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1]
      // Node builtins never work in a browser either.
      if (specifier.startsWith('node:')) found.add(specifier)
      else found.add(specifier)
    }
  }
  // Type-only imports are erased by a real build and carry no runtime weight,
  // but they are still unresolvable text if pasted in raw — flag them too.
  return [...found]
}

/**
 * Read a client module for inlining, refusing when it cannot work.
 *
 * @param {string} clientPath
 * @returns {{ok: true, source: string} | {ok: false, reason: string, specifiers: string[]}}
 */
export function readInlineableClient(clientPath) {
  let source
  try {
    source = readFileSync(clientPath, 'utf8')
  } catch (error) {
    return { ok: false, reason: `could not read ${clientPath}: ${error.message}`, specifiers: [] }
  }

  const specifiers = unresolvableImports(source)
  if (specifiers.length) {
    return {
      ok: false,
      reason: 'this client imports modules that an inlined page cannot resolve',
      specifiers,
    }
  }
  return { ok: true, source }
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function run(argv) {
  const options = parseArgs(argv)

  if (options.help) {
    process.stdout.write(USAGE)
    return EXIT.OK
  }
  if (options.tokens) {
    process.stdout.write(`${tokenNames().join('\n')}\n`)
    return EXIT.OK
  }
  if (!options.slot) {
    process.stderr.write('dsh-plugin-preview: --slot <id> is required\n\n')
    process.stderr.write(USAGE)
    return EXIT.USAGE
  }

  let fixture
  if (options.fixture) {
    const path = resolve(options.fixture)
    if (!existsSync(path)) {
      process.stderr.write(`dsh-plugin-preview: fixture not found: ${path}\n`)
      return EXIT.IO
    }
    try {
      const { readFileSync } = await import('node:fs')
      fixture = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      process.stderr.write(`dsh-plugin-preview: fixture is not valid JSON: ${error.message}\n`)
      return EXIT.IO
    }
  }

  if (options.client && !existsSync(resolve(options.client))) {
    process.stderr.write(`dsh-plugin-preview: client entry not found: ${resolve(options.client)}\n`)
    return EXIT.IO
  }

  // The client module URL depends on how the page will be loaded.
  //
  // Found by rendering the page in a real browser: a `file:///` client URL cannot
  // be imported from an `http://` origin, so a served page silently fell back to
  // the placeholder instead of mounting the author's client half — with no error
  // the author could see. When serving, the module must come from the same
  // origin as the page.
  // Resolve how the client half will be delivered, and refuse early when the
  // requested combination cannot work. Writing a page that silently shows the
  // placeholder is the failure mode this whole block exists to prevent.
  let clientSource = null
  if (options.inlineClient) {
    if (!options.client) {
      process.stderr.write('dsh-plugin-preview: --inline-client needs --client <path>\n')
      return EXIT.USAGE
    }
    const clientPath = resolve(options.client)
    const inlined = readInlineableClient(clientPath)

    if (inlined.ok) {
      clientSource = inlined.source
    } else if (inlined.specifiers.length === 0) {
      // A read error, not an import problem.
      process.stderr.write(`dsh-plugin-preview: cannot inline the client: ${inlined.reason}\n`)
      return EXIT.IO
    } else {
      // The client has imports. A plain inline cannot work, so try to bundle it
      // into a dependency-free module. Bundling is best-effort: esbuild is not a
      // dependency of this package, so its absence is reported, not hidden.
      const bundler = options.noBundle ? null : await loadBundler()
      const bundled = await bundleClient(clientPath, { bundler })
      if (bundled.ok) {
        clientSource = bundled.source
        process.stderr.write(
          `dsh-plugin-preview: bundled ${inlined.specifiers.length} import(s) with ${bundler.name} `
          + `(${Math.round(bundled.bytes / 1024)} KB inlined)\n`,
        )
      } else {
        process.stderr.write(`dsh-plugin-preview: cannot inline the client: ${bundled.reason}\n`)
        if (bundled.detail) process.stderr.write(`  ${bundled.detail}\n`)
        process.stderr.write(`  unresolvable specifier(s): ${inlined.specifiers.join(', ')}\n`)
        if (options.noBundle) {
          process.stderr.write('  --no-bundle was given, so the imports were left as-is\n')
        } else if (bundler) {
          process.stderr.write('  the client could not be bundled into a dependency-free module\n')
        } else {
          process.stderr.write('  no bundler is installed, so the imports cannot be flattened\n')
          process.stderr.write('  install esbuild to enable this, or use --serve (needs no bundler)\n')
        }
        return EXIT.IO
      }
    }
  }

  const servedClientUrl = options.serve && options.client ? CLIENT_ROUTE : undefined
  const html = buildShell(
    options,
    fixture,
    options.serve && options.client ? servedClientUrl : undefined,
    clientSource,
  )

  if (options.out) {
    // What the written file can do depends on how the client was supplied:
    //  - inlined source  -> a file:// page mounts it (no fetch involved)
    //  - served route    -> only the served copy can mount; the file cannot
    //  - file:// URL     -> the file cannot import it either; say so
    const fileHtml = options.inlineClient
      ? html
      : (options.serve && options.client ? buildShell(options, fixture, undefined, null) : html)
    const out = resolve(options.out)
    try {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, fileHtml)
    } catch (error) {
      process.stderr.write(`dsh-plugin-preview: could not write ${out}: ${error.message}\n`)
      return EXIT.IO
    }
    process.stdout.write(`wrote ${out}\n`)
    if (options.client && !options.inlineClient) {
      // Stated plainly rather than left to be discovered from a blank frame.
      process.stdout.write('note: the written file cannot import your client module (a file:// page\n')
      process.stdout.write('      cannot load it); open the served URL, or pass --inline-client if the\n')
      process.stdout.write('      client has no imports of its own\n')
    }
  }

  if (options.serve) {
    const clientPath = options.client ? resolve(options.client) : null
    const server = createServer((request, response) => {
      const url = request.url ?? '/'
      if (clientPath && url.startsWith(CLIENT_ROUTE)) {
        // Same origin as the page, so the module import is allowed.
        try {
          const source = readFileSync(clientPath, 'utf8')
          response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
          response.end(source)
        } catch (error) {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          response.end(`could not read client module: ${error.message}`)
        }
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
    })
    // Loopback only (设计文档 §9).
    await new Promise((settle) => server.listen(options.port, '127.0.0.1', settle))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : options.port
    process.stdout.write(`preview: http://127.0.0.1:${port}/\n`)

    // Screenshot mode is a one-shot run: capture, then exit. Leaving a server up
    // after asking for files would surprise a script that wants them and a shell
    // that wants its prompt back.
    if (options.shot) {
      const variants = []
      for (const scheme of expandSelector(options.scheme, ['light', 'dark'])) {
        for (const viewport of expandSelector(options.viewport, Object.keys(VIEWPORTS))) {
          variants.push({ scheme, viewport })
        }
      }

      const captured = await captureShots({
        url: `http://127.0.0.1:${port}/`,
        outDir: resolve(options.shot),
        variants,
        widths: VIEWPORTS,
      })

      await new Promise((settle) => server.close(settle))
      server.closeAllConnections?.()

      if (!captured.ok) {
        process.stderr.write(`dsh-plugin-preview: ${captured.reason}\n`)
        if (captured.detail) process.stderr.write(`  ${captured.detail}\n`)
        return EXIT.IO
      }
      process.stdout.write(`captured ${captured.files.length} shot(s) via ${captured.driver}:\n`)
      for (const file of captured.files) process.stdout.write(`  ${file}\n`)
      process.stdout.write('note: these are captures, not a visual regression check\n')
      return EXIT.OK
    }

    process.stdout.write('press Ctrl+C to stop\n')

    // Stay in the foreground until interrupted, then close the listener.
    //
    // A bare `new Promise(() => {})` keeps the process alive but never releases
    // the port, so a stopped preview left it bound until the OS reclaimed it —
    // which is exactly what makes "port already in use" appear on the next run.
    return await serveUntilSignal(server)
  }

  if (options.shot && !options.serve) {
    // Screenshots drive a browser against a URL, so a page must be reachable.
    process.stderr.write('dsh-plugin-preview: --shot needs --serve (the browser loads the page over HTTP)\n')
    return EXIT.USAGE
  }

  if (!options.out) {
    process.stdout.write(html)
  }
  return EXIT.OK
}

/**
 * Resolve when the process is asked to stop, closing the server first.
 *
 * Handles SIGINT (Ctrl+C in a console) and SIGTERM, and resolves on `close` so
 * the port is genuinely released before the caller exits.
 *
 * ## Windows caveat, measured rather than assumed
 *
 * `child.kill()` on Windows terminates the target outright and the handler never
 * runs — verified: the process dies with `signal: 'SIGTERM'` and no shutdown
 * output. A real Ctrl+C in a console *does* deliver SIGINT, and the handler is
 * registered (verified: `listenerCount('SIGINT') === 1`). So this graceful path
 * covers interactive use, while a programmatic kill relies on the OS reclaiming
 * the port — which it does, immediately.
 *
 * @param {import('node:http').Server} server
 * @param {{sigint?: boolean}} [options] register the SIGINT handler
 * @returns {Promise<number>} exit code
 */
export function serveUntilSignal(server, options = {}) {
  return new Promise((settle) => {
    let closing = false

    const shutdown = (signal) => {
      if (closing) return
      closing = true
      process.stdout.write(`\npreview: ${signal}, closing\n`)
      server.close(() => {
        // `close` fires once every connection has ended, so the port is free.
        process.stdout.write('preview: stopped\n')
        settle(EXIT.OK)
      })
      // A browser holding a keep-alive connection would otherwise delay `close`
      // indefinitely; the preview has nothing to lose by dropping it.
      server.closeAllConnections?.()
      // Belt and braces: if a connection refuses to end, do not hang forever.
      const failsafe = setTimeout(() => settle(EXIT.OK), 3000)
      failsafe.unref?.()
    }

    if (options.sigint !== false) process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    server.once('error', () => settle(EXIT.IO))
  })
}

// See `src/main-module.mjs` for why the obvious
// `import.meta.url === pathToFileURL(argv[1])` comparison silently skips `run()`
// when the package was installed through a symlink — which `npm install` makes
// for every local/`file:` dependency.
if (isMainModule(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => {
    // Setting `exitCode` rather than calling `process.exit()` lets stdout drain.
    // On Windows `process.exit()` can truncate piped output, which would lose the
    // shutdown lines the user is waiting to see.
    process.exitCode = code
  }).catch((error) => {
    process.stderr.write(`dsh-plugin-preview: ${error?.message ?? error}\n`)
    process.exitCode = EXIT.IO
  })
}
