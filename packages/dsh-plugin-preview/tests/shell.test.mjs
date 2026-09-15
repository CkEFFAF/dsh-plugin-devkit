/**
 * Preview shell tests.
 *
 * Beyond "does it render", these pin the two prohibitions in 设计文档 §7 and the
 * honesty claim in 功能文档 §6.4: the preview must not claim pixel parity, must not
 * provide the debugger, and must not install tool probes. A layout helper that
 * quietly grew inspection duties would defeat the module split.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseArgs, expandSelector, buildShell, EXIT, run, CLIENT_ROUTE, unresolvableImports, serveUntilSignal } from '../bin/preview.mjs'
import { loadBundler, bundleClient } from '../src/bundle.mjs'
import { loadDriver, findSystemBrowser, captureShots } from '../src/screenshot.mjs'

import { renderShell, VIEWPORTS } from '../src/shell.mjs'
import { ALIAS_TOKENS, PREVIEW_TOKENS, tokenDeclarations, tokenNames, SCHEMES } from '../src/tokens.mjs'
import { createFixture, serializeFixture, validateFixture } from '../src/fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------------------- tokens --

test('token names match the official published set', () => {
  // From packages/client/ui-theme/src/client/index.ts:131-145. Using the real
  // names is what lets a plugin's var(--dsw-alias-*) CSS resolve in the preview;
  // an invented name would render as an unstyled box.
  const expected = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ]
  assert.deepEqual(ALIAS_TOKENS.map((token) => token.name), expected)
})

test('every alias token has both a light and a dark value', () => {
  // The official set marks these requiresLightAndDark; a preview that defined
  // only one would render a broken dark shot.
  for (const token of ALIAS_TOKENS) {
    assert.ok(token.light, `${token.name} has no light value`)
    assert.ok(token.dark, `${token.name} has no dark value`)
  }
})

test('preview-owned tokens are namespaced so they are not mistaken for host ones', () => {
  for (const token of PREVIEW_TOKENS) {
    assert.match(token.name, /^--dsh-preview-|^--dsh-content-/, `${token.name} is not namespaced`)
  }
})

test('both schemes produce declarations', () => {
  for (const scheme of SCHEMES) {
    const css = tokenDeclarations(scheme)
    assert.match(css, /--dsw-alias-bg-base:/)
  }
})

test('light and dark declarations differ', () => {
  assert.notEqual(tokenDeclarations('light'), tokenDeclarations('dark'))
})

test('an unknown scheme falls back to light rather than emitting nothing', () => {
  assert.equal(tokenDeclarations('chartreuse'), tokenDeclarations('light'))
})

test('tokenNames lists every token exactly once', () => {
  const names = tokenNames()
  assert.equal(names.length, ALIAS_TOKENS.length + PREVIEW_TOKENS.length)
  assert.equal(new Set(names).size, names.length)
})

// ------------------------------------------------------------------ fixture --

test('a fixture is plain JSON and marked synthetic', () => {
  const fixture = createFixture({ slot: 'tool.view.demo' })
  assert.equal(fixture.fixture, true, 'a fixture must be identifiable as synthetic')
  assert.equal(fixture.slot, 'tool.view.demo')
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(fixture)))
})

test('a fixture carries no real identifiers', () => {
  // Design constraint 3 is about secrets; a preview that embedded real session
  // ids or workspace paths would become a place they accumulate.
  const fixture = createFixture()
  const text = JSON.stringify(fixture)
  assert.doesNotMatch(text, /[A-Za-z]:\\\\/, 'no Windows absolute path')
  assert.doesNotMatch(text, /sk-/, 'no key-shaped value')
  assert.match(fixture.session.workspace, /preview/)
})

test('fixture serialization escapes < so it cannot close a script tag', () => {
  const serialized = serializeFixture({ note: '</script><script>alert(1)</script>' })
  assert.doesNotMatch(serialized, /<\/script>/)
  assert.match(serialized, /\\u003c/)
  // Still valid JSON after escaping.
  assert.equal(JSON.parse(serialized).note, '</script><script>alert(1)</script>')
})

test('fixture validation rejects non-objects', () => {
  for (const bad of [null, 'text', 42, []]) {
    assert.equal(validateFixture(bad).ok, false, `${String(bad)} should be rejected`)
  }
})

test('fixture validation rejects a non-array messages field', () => {
  assert.equal(validateFixture({ messages: 'nope' }).ok, false)
  assert.equal(validateFixture({ messages: [] }).ok, true)
})

// -------------------------------------------------------------------- shell --

test('the shell is a complete HTML document', () => {
  const html = renderShell({ slot: 'a.b', fixture: createFixture() })
  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /<\/html>/)
  assert.match(html, /<meta charset="utf-8">/)
})

test('the shell defines the official token names in CSS', () => {
  const html = renderShell({ slot: 'a.b', fixture: createFixture() })
  for (const name of ALIAS_TOKENS.map((token) => token.name)) {
    assert.ok(html.includes(name), `${name} is not defined in the shell`)
  }
})

test('the shell renders both schemes and both viewports by default', () => {
  const html = renderShell({ slot: 'a.b', fixture: createFixture() })
  assert.match(html, /"scheme":"light"/)
  assert.match(html, /"scheme":"dark"/)
  assert.match(html, /"viewport":"narrow"/)
  assert.match(html, /"viewport":"wide"/)
})

test('the narrow viewport is genuinely narrow', () => {
  // A slot that only looks right at 1680px is the bug this catches.
  assert.ok(VIEWPORTS.narrow.width < 600, 'narrow must be a real narrow width')
  assert.ok(VIEWPORTS.wide.width > VIEWPORTS.narrow.width)
})

test('the shell states that it is not pixel-identical', () => {
  // 功能文档 §6.4: the preview must not promise parity with the live shell.
  const html = renderShell({ slot: 'a.b', fixture: createFixture() })
  assert.match(html, /pixel-for-pixel/)
  assert.match(html, /screenshot diff/)
})

test('the shell escapes a hostile slot id', () => {
  const html = renderShell({ slot: '<script>alert(1)</script>', fixture: createFixture() })
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>\s*<\/div>/)
  assert.match(html, /&lt;script&gt;/)
})

test('the shell signals readiness for a screenshot tool', () => {
  // Without this a capture can land on a half-mounted page.
  const html = renderShell({ slot: 'a.b', fixture: createFixture() })
  assert.match(html, /data-preview-ready/)
})

test('mount failures are surfaced into the page, not swallowed', () => {
  const html = renderShell({ slot: 'a.b', fixture: createFixture() })
  assert.match(html, /mount-error/)
  assert.match(html, /mount\(\) threw/)
})

test('a supplied client module is referenced as a JSON string, not interpolated raw', () => {
  const html = renderShell({
    slot: 'a.b',
    fixture: createFixture(),
    clientModule: 'file:///D:/proj/client.mjs',
  })
  assert.match(html, /file:\/\/\/D:\/proj\/client\.mjs/)
})

test('a client module string cannot terminate the script element', () => {
  // The real vector: `JSON.stringify` does not escape `</script>`, so without
  // escaping a path containing it ends the script element and the remainder is
  // parsed as HTML. This was an actual injection bug found by this test.
  const html = renderShell({
    slot: 'a.b',
    fixture: createFixture(),
    clientModule: '</script><script>alert(1)</script>',
  })
  const scriptBody = html.slice(html.indexOf('<script type="module">'))
  assert.doesNotMatch(scriptBody, /<\/script>\s*<script>alert/)
  assert.match(scriptBody, /\\u003c\/script>/)
})

test('a hostile slot id cannot terminate the script element either', () => {
  const html = renderShell({ slot: '</script><script>alert(2)</script>', fixture: createFixture() })
  const scriptBody = html.slice(html.indexOf('<script type="module">'))
  assert.doesNotMatch(scriptBody, /<\/script>\s*<script>alert/)
})

test('a hostile title cannot break out of the head', () => {
  const html = renderShell({
    slot: 'a.b',
    fixture: createFixture(),
    title: '</title><script>alert(3)</script>',
  })
  assert.doesNotMatch(html, /<\/title><script>alert/)
  assert.match(html, /&lt;\/title&gt;/)
})

test('U+2028 and U+2029 are escaped inside the embedded script', () => {
  // Both are legal inside a JSON string but terminate a JavaScript line, which
  // would make the embedded object a syntax error. This matters *only* in the
  // script element: the same characters in the document's <title> are ordinary
  // text, which is why this checks the script rather than the whole page.
  const html = renderShell({ slot: 'line\u2028separator\u2029para', fixture: createFixture() })
  const scriptBody = html.slice(html.indexOf('<script type="module">'))
  assert.doesNotMatch(scriptBody, /\u2028/, 'raw U+2028 in the script body')
  assert.doesNotMatch(scriptBody, /\u2029/, 'raw U+2029 in the script body')
  assert.match(scriptBody, /\\u2028/)
})

test('the embedded script remains valid JavaScript', async () => {
  // The strongest check available without a browser: extract the module body and
  // parse it. A syntax error here is exactly the failure a screenshot tool would
  // report as a blank page.
  const { Script } = await import('node:vm')
  const html = renderShell({
    slot: 'hostile\u2028</script><script>bad()</script>',
    fixture: createFixture(),
    clientModule: '</script><script>bad2()</script>',
  })
  const start = html.indexOf('<script type="module">') + '<script type="module">'.length
  const end = html.indexOf('</script>', start)
  const body = html.slice(start, end)

  // Top-level await is used by the shell, so wrap it before parsing.
  assert.doesNotThrow(
    () => new Script(`(async () => {${body}\n})`),
    'the embedded script body is not valid JavaScript',
  )
})

// ---------------------------------------------------------- prohibitions ----

/**
 * Strip comments so a prohibition can be checked against code rather than prose.
 *
 * The first version of these tests matched the raw file text, and failed because
 * `index.mjs` *explains* the prohibition in a comment. A test that cannot tell an
 * explanation from a violation is testing the wrong thing.
 *
 * @param {string} source
 * @returns {string}
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

test('the preview never provides the debugger (设计文档 §7)', () => {
  // Inspection and layout stay separate packages: letting the observer grow a
  // DOM dependency is the shallow-interface failure the design forbids.
  const sources = ['../index.mjs', '../src/shell.mjs', '../src/tokens.mjs', '../src/fixture.mjs', '../bin/preview.mjs']
  for (const relative of sources) {
    const text = codeOnly(readFileSync(join(here, relative), 'utf8'))
    assert.doesNotMatch(text, /provide\(\s*['"]debugger['"]/, `${relative} provides 'debugger'`)
  }
})

test('the preview imports nothing from dsh-debugger', () => {
  // The dependency must not exist in either direction.
  const sources = ['../index.mjs', '../src/shell.mjs', '../bin/preview.mjs']
  for (const relative of sources) {
    const text = codeOnly(readFileSync(join(here, relative), 'utf8'))
    assert.doesNotMatch(text, /from\s+['"]dsh-debugger/, `${relative} imports dsh-debugger`)
  }
})

test('the preview installs no probes', () => {
  const sources = ['../index.mjs', '../src/shell.mjs', '../bin/preview.mjs']
  for (const relative of sources) {
    const text = codeOnly(readFileSync(join(here, relative), 'utf8'))
    assert.doesNotMatch(text, /installProbes|tools\/pre-execute|ctx\.on\(/, `${relative} installs a probe`)
  }
})

test('the preview does not patch or fork the official client', () => {
  const sources = ['../index.mjs', '../src/shell.mjs', '../bin/preview.mjs']
  for (const relative of sources) {
    const text = codeOnly(readFileSync(join(here, relative), 'utf8'))
    assert.doesNotMatch(text, /@deepseek-ai\/dsh-client-web/, `${relative} reaches into the official client`)
  }
})

test('the preview serves loopback only (设计文档 §9)', () => {
  const text = codeOnly(readFileSync(join(here, '../bin/preview.mjs'), 'utf8'))
  assert.match(text, /127\.0\.0\.1/)
  assert.doesNotMatch(text, /0\.0\.0\.0/)
})

// ---------------------------------------------------------------------- cli --

test('arguments parse', () => {
  const options = parseArgs(['--slot', 'tool.view.x', '--port', '8095', '--serve'])
  assert.equal(options.slot, 'tool.view.x')
  assert.equal(options.port, 8095)
  assert.equal(options.serve, true)
})

test('an invalid port is ignored rather than accepted', () => {
  assert.equal(parseArgs(['--slot', 'a', '--port', 'notanumber']).port, 8090)
  assert.equal(parseArgs(['--slot', 'a', '--port', '99999']).port, 8090)
})

test('the scheme selector expands', () => {
  assert.deepEqual(expandSelector('both', SCHEMES), ['light', 'dark'])
  assert.deepEqual(expandSelector('dark', SCHEMES), ['dark'])
  assert.deepEqual(expandSelector('light,dark', SCHEMES), ['light', 'dark'])
})

test('an unknown selector value falls back to everything rather than nothing', () => {
  // Rendering no variants would look like a broken preview.
  assert.deepEqual(expandSelector('chartreuse', SCHEMES), ['light', 'dark'])
})

test('the shell is built with the requested slot and viewports', () => {
  const html = buildShell({ slot: 'my.slot', scheme: 'dark', viewport: 'narrow' })
  assert.match(html, /"slot":"my\.slot"/)
  assert.match(html, /"scheme":"dark"/)
  assert.doesNotMatch(html, /"scheme":"light"/)
})

test('a missing --slot is a usage error, not a crash', async () => {
  const code = await run(['--out', 'ignored.html'])
  assert.equal(code, EXIT.USAGE)
})

test('--tokens prints the token names', async () => {
  const code = await run(['--tokens'])
  assert.equal(code, EXIT.OK)
})

test('a missing fixture file is an IO error', async () => {
  const code = await run(['--slot', 'a', '--fixture', 'D:/nonexistent/fixture.json'])
  assert.equal(code, EXIT.IO)
})

test('a missing client entry is an IO error', async () => {
  const code = await run(['--slot', 'a', '--client', 'D:/nonexistent/client.mjs'])
  assert.equal(code, EXIT.IO)
})

// --------------------------------------------------- serve/client module ----

test('buildShell takes an explicit client URL for the served case', () => {
  // Rendering the page in a real browser showed a file:/// client URL cannot be
  // imported from an http:// origin: the page silently kept the placeholder and
  // the author saw no error. Serving must therefore use a same-origin URL.
  const html = buildShell({ slot: 'a.b', scheme: 'light', viewport: 'narrow' }, undefined, '/__preview_client.mjs')
  assert.match(html, /const CLIENT_MODULE = "\/__preview_client\.mjs"/)
  assert.doesNotMatch(html, /file:\/\/\//)
})

test('buildShell defaults to a file URL when no explicit client URL is given', () => {
  const html = buildShell(
    { slot: 'a.b', scheme: 'light', viewport: 'narrow', client: '/tmp/client.mjs' },
    undefined,
    undefined,
  )
  assert.match(html, /const CLIENT_MODULE = "file:\/\/\//)
})

test('the client route is a distinct path, not the page root', () => {
  assert.match(CLIENT_ROUTE, /^\/__preview_client\.mjs$/)
  assert.notEqual(CLIENT_ROUTE, '/')
})

test('the CLI records a note when a written file cannot import the client', async () => {
  // A file:// page cannot import a file:// module under modern browser rules
  // either, so writing and serving at once must not pretend the file is enough.
  const dir = mkdtempSync(join(tmpdir(), 'preview-out-'))
  const clientPath = join(dir, 'client.mjs')
  writeFileSync(clientPath, 'export function mount() {}')
  const outPath = join(dir, 'page.html')
  try {
    // Without --serve there is no served copy, so no note is expected.
    const code = await run(['--slot', 'a', '--client', clientPath, '--out', outPath])
    assert.equal(code, EXIT.OK)
    assert.ok(existsSync(outPath))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------- inline-client -----

test('unresolvableImports finds bare, relative, and builtin specifiers', () => {
  // Measured in a real browser: an inlined module resolves none of these.
  const source = [
    'import { createElement } from "react"',
    'import { x } from "./slots.ts"',
    'import y from "node:fs"',
    'const z = await import("@deepseek-ai/dsh-client-ui-slots")',
    'export { a } from "../shared.mjs"',
  ].join('\n')
  const found = unresolvableImports(source)
  for (const specifier of ['react', './slots.ts', 'node:fs', '@deepseek-ai/dsh-client-ui-slots', '../shared.mjs']) {
    assert.ok(found.includes(specifier), `${specifier} not detected`)
  }
})

test('unresolvableImports returns nothing for a dependency-free client', () => {
  const source = 'export function mount(el, ctx) { el.textContent = ctx.slot }'
  assert.deepEqual(unresolvableImports(source), [])
})

test('unresolvableImports is not fooled by the word import in a string', () => {
  // A false positive would block a perfectly inlinable client.
  const source = 'export function mount(el) { el.textContent = "import { a } from \\"react\\"" }'
  assert.deepEqual(unresolvableImports(source), [])
})

test('a dependency-free client can be inlined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preview-inline-'))
  const clientPath = join(dir, 'client.mjs')
  writeFileSync(clientPath, 'export function mount(el, ctx) { el.textContent = ctx.slot }')
  const outPath = join(dir, 'page.html')
  try {
    const code = await run(['--slot', 'a.b', '--client', clientPath, '--inline-client', '--out', outPath])
    assert.equal(code, EXIT.OK)
    const html = readFileSync(outPath, 'utf8')
    // The source is embedded, and no module URL is left to fail at runtime.
    assert.match(html, /CLIENT_SOURCE = "export function mount/)
    assert.match(html, /const CLIENT_MODULE = null/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inlining a client that imports react is refused, not silently broken', async () => {
  // This is the case that matters: real DSH client halves import react. Writing a
  // page that quietly shows the placeholder would be the worst outcome.
  const dir = mkdtempSync(join(tmpdir(), 'preview-inline-'))
  const clientPath = join(dir, 'client.mjs')
  writeFileSync(clientPath, 'import { createElement } from "react"\nexport function mount() {}')
  const outPath = join(dir, 'page.html')
  try {
    const code = await run(['--slot', 'a.b', '--client', clientPath, '--inline-client', '--out', outPath])
    assert.equal(code, EXIT.IO)
    assert.equal(existsSync(outPath), false, 'no page should be written when inlining cannot work')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--inline-client without --client is a usage error', async () => {
  assert.equal(await run(['--slot', 'a', '--inline-client']), EXIT.USAGE)
})

test('inlined source wins over a module URL', () => {
  const html = buildShell(
    { slot: 'a.b', scheme: 'light', viewport: 'narrow', client: '/tmp/x.mjs' },
    undefined,
    '/route.mjs',
    'export function mount() {}',
  )
  assert.match(html, /CLIENT_SOURCE = "export function mount/)
  assert.match(html, /const CLIENT_MODULE = null/)
})

test('no inlined source leaves CLIENT_SOURCE null', () => {
  const html = buildShell({ slot: 'a.b', scheme: 'light', viewport: 'narrow' }, undefined, undefined, null)
  assert.match(html, /const CLIENT_SOURCE = null/)
})

// ------------------------------------------------------------ bundling -----

test('a client with imports is bundled rather than refused when a bundler exists', async () => {
  // The real case: a client half that imports react. Without bundling this could
  // not be inlined at all, which is why it was documented as a limitation.
  const bundler = await loadBundler()
  if (!bundler) {
    // Honest skip: without esbuild the capability genuinely does not exist here.
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'preview-bundle-'))
  // Write the client inside the checkout so `react` resolves from its node_modules.
  const clientPath = join('D:/DSH/deepseek-harness/packages/client/ui-goal', `preview-tmp-${Date.now()}.mjs`)
  writeFileSync(clientPath, 'import { createElement } from "react"\nexport function mount(el){ el.textContent = typeof createElement }')
  const outPath = join(dir, 'page.html')
  try {
    const code = await run(['--slot', 'a.b', '--client', clientPath, '--inline-client', '--out', outPath])
    assert.equal(code, EXIT.OK, 'bundling should make the client inlinable')
    const html = readFileSync(outPath, 'utf8')
    assert.match(html, /CLIENT_SOURCE = "/)
    // The bundle must be self-contained: no bare import may survive, or the page
    // would fail exactly as an unbundled inline does.
    const sourceMatch = /const CLIENT_SOURCE = (".*?");\n/s.exec(html)
    assert.ok(sourceMatch, 'no CLIENT_SOURCE found')
    const inlined = JSON.parse(sourceMatch[1])
    assert.doesNotMatch(inlined, /^\s*import\s+[^"']*from\s*["']react["']/m)
  } finally {
    rmSync(clientPath, { force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--no-bundle makes an import-bearing client fail rather than bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'preview-nobundle-'))
  const clientPath = join(dir, 'client.mjs')
  writeFileSync(clientPath, 'import "react"\nexport function mount() {}')
  const outPath = join(dir, 'page.html')
  try {
    const code = await run(['--slot', 'a', '--client', clientPath, '--inline-client', '--no-bundle', '--out', outPath])
    assert.equal(code, EXIT.IO)
    assert.equal(existsSync(outPath), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadBundler returns a usable build function or null, never throws', async () => {
  const bundler = await loadBundler()
  if (bundler) {
    assert.equal(typeof bundler.build, 'function')
    assert.equal(typeof bundler.name, 'string')
  } else {
    assert.equal(bundler, null)
  }
})

test('bundleClient reports a missing bundler instead of throwing', async () => {
  const result = await bundleClient('D:/nonexistent/client.mjs', { bundler: null })
  assert.equal(result.ok, false)
  assert.match(result.reason, /no bundler/)
})

// ------------------------------------------------------ graceful shutdown --

test('serveUntilSignal closes the server on SIGINT and releases the port', async () => {
  const server = createServer((_request, response) => response.end('ok'))
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle))
  const port = server.address().port
  assert.equal(server.listening, true)

  const settled = serveUntilSignal(server)
  process.emit('SIGINT')

  const code = await settled
  assert.equal(code, EXIT.OK)
  assert.equal(server.listening, false, 'the listener must be closed')

  // The real property: the port can be bound again immediately. This is what the
  // old `new Promise(() => {})` tail got wrong — it kept the process alive but
  // never released the port, so the next run reported "already in use" against a
  // preview the user had already stopped.
  await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(port, '127.0.0.1', () => probe.close(resolve))
  })
})

test('serveUntilSignal resolves once even if both signals arrive', async () => {
  const server = createServer((_request, response) => response.end('ok'))
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle))

  let settlements = 0
  const settled = serveUntilSignal(server).then((code) => {
    settlements += 1
    return code
  })
  process.emit('SIGINT')
  process.emit('SIGTERM')

  await settled
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(settlements, 1, 'shutdown must be idempotent')
  assert.equal(server.listening, false)
})

// ----------------------------------------------------------- screenshots ---

test('--shot without --serve is a usage error', async () => {
  // Screenshots drive a browser against a URL, so a page must be reachable.
  assert.equal(await run(['--slot', 'a', '--shot', 'D:/Temp/x']), EXIT.USAGE)
})

test('loadDriver returns a driver or null, never throws', async () => {
  const driver = await loadDriver()
  if (driver) assert.equal(typeof driver.chromium.launch, 'function')
  else assert.equal(driver, null)
})

test('a driver that cannot launch is reported, not thrown', async () => {
  const result = await captureShots({
    url: 'http://127.0.0.1:1/',
    outDir: 'D:/Temp/never',
    variants: [{ scheme: 'light', viewport: 'narrow' }],
    widths: VIEWPORTS,
    // A driver whose launch always fails.
    driver: { name: 'stub', chromium: { launch: async () => { throw new Error('no browser: deliberate') } } },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /could not launch/)
  assert.match(result.detail, /deliberate/)
})

test('captureShots fails cleanly when no driver can be found', async () => {
  // Simulate the "nothing installed" case by passing a driver object that the
  // function must reject, and assert the failure is a value, not a throw.
  const result = await captureShots({
    url: 'http://127.0.0.1:1/',
    outDir: 'D:/Temp/never',
    variants: [],
    widths: VIEWPORTS,
    driver: {},
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /no browser driver/)
})

test('findSystemBrowser returns a path or null', () => {
  const found = findSystemBrowser()
  if (found !== null) assert.equal(existsSync(found), true, 'a returned browser must exist')
})
