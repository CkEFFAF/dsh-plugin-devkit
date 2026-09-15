/**
 * Real isolated boot smoke (acceptance A1).
 *
 * Boots a real DSH process against a throwaway DSH_HOME with the debugger mounted
 * as a `--patch` overlay, then asserts the pass condition 功能文档 §8 gives for A1:
 * the kernel announces itself, the web instance serves, and it is genuinely
 * isolated (the daily profile and its port are untouched).
 *
 * The other tests in this repository use a fake host on purpose — it can
 * construct PENDING, FAILED, and deny on demand. That fake cannot prove the
 * plugin survives contact with a real DSH boot, which is the whole point of A1.
 *
 * ## Running it
 *
 * ```sh
 * node packages/dsh-debug-boot/tests/real-boot.mjs
 * ```
 *
 * Not part of `node --test`: it spawns a real server and needs the DSH checkout
 * plus a spare port. It builds its own template rather than copying the user's
 * daily `web` profile, because that profile carries third-party plugins and
 * 功能文档 §1 records that `dsh-capability-union` + any `--patch` overlay fails
 * with `Invalid effect` — the exact breakage this tool exists to avoid.
 *
 * ## Why it seeds its own template
 *
 * The shipped `web` template lives in the *user's* DSH_HOME (installed by the
 * deployment), so a genuinely fresh DSH_HOME has no template to derive from and
 * `debug-boot` correctly fails with `template-missing`. The smoke therefore
 * writes a minimal template of its own — base + web-app bundles, no third-party
 * dependencies — which is also what makes this reproducible for anyone.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const workspace = resolve(here, '../../..')
const bootBin = join(workspace, 'packages/dsh-debug-boot/bin/debug-boot.mjs')

/** Spare port, deliberately not the daily 3080. */
const PORT = Number(process.env.SMOKE_PORT ?? 8099)

/** Where the DSH checkout lives; overridable for a different layout. */
const DSH_CHECKOUT = process.env.DSH_CHECKOUT ?? 'D:/DSH/deepseek-harness'

const results = []

/**
 * Run one check, awaiting it so an async assertion failure is recorded rather
 * than escaping as an unhandled rejection.
 *
 * @param {string} label
 * @param {() => unknown} fn
 */
async function check(label, fn) {
  try {
    await fn()
    results.push({ label, ok: true })
  } catch (error) {
    results.push({ label, ok: false, error: error.message })
  }
}

/**
 * Write a minimal, third-party-free profile template into a throwaway home.
 *
 * @param {string} home
 */
function seedTemplate(home) {
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        // Only the shipped bundles: no marketplace, no capability-union.
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        patchReload: 'live',
      },
    },
  }, null, 2))
  // Both layers must be a top-level YAML array; an empty file is rejected by
  // app-boot (index.ts:360) — the very failure that blocks a boot on this machine.
  writeFileSync(join(profile, 'cordis.patch.yml'), '# smoke template: no user patches\n[]\n')
  writeFileSync(join(profile, 'cordis.yml'), '# profile root: composed from patches\n[]\n')
}

/**
 * Wait until the server is actually serving the app, not merely listening.
 *
 * A socket can accept before the web app finishes routing and answer 404 in the
 * meantime, so readiness means "the gate answered" — 401 without a token is the
 * healthy signal — rather than "something responded".
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<number|null>} final status code, or null on timeout
 */
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      last = response.status
      // 401 = the token gate is up and the app is behind it. Anything else
      // (404 during routing, 5xx during boot) is not ready yet.
      if (response.status === 401) return response.status
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return last
}

async function main() {
  if (!existsSync(bootBin)) {
    console.error(`real-boot: debug-boot not found at ${bootBin}`)
    process.exit(1)
  }

  const home = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
  seedTemplate(home)

  console.log(`real-boot: home=${home}`)
  console.log(`real-boot: port=${PORT} (daily 3080 must stay untouched)`)

  const child = spawn(process.execPath, [
    bootBin,
    '--dsh-home', home,
    '--profile', 'smoke',
    '--port', String(PORT),
    '--no-open',
  ], {
    // `--import tsx/esm` resolves tsx from the spawn cwd, and tsx lives in the
    // DSH checkout rather than this workspace.
    cwd: DSH_CHECKOUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })

  const status = await waitForServer(`http://127.0.0.1:${PORT}/`, 90_000)

  // The token line is written just before the server starts listening, but give
  // it a moment so the assertion reads a settled buffer rather than racing it.
  for (let i = 0; i < 40 && !/token=/.test(stdout); i += 1) {
    await new Promise((r) => setTimeout(r, 250))
  }

  try {
    await check('the debugger announced itself on a real boot', () => {
      assert.match(stdout, /\[dsh-debugger\] probes active/, `stdout was:\n${stdout}\nstderr:\n${stderr}`)
    })

    await check('the boot printed a web URL with a token', () => {
      assert.match(stdout, /dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=/)
    })

    await check('the isolated instance serves HTTP', async () => {
      // Re-check now that the server has had time to finish routing.
      const response = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' })
      assert.ok(response.status > 0, `no response; stderr:\n${stderr}`)
      assert.notEqual(response.status, 404, 'the web app is not routed yet')
    })

    await check('an unauthenticated request is refused', async () => {
      // Re-measure here rather than trusting `waitForServer`'s probe: that call
      // is made as soon as the socket accepts, which can land before routing is
      // ready and answer 404. Asserting on a stale status would report a routing
      // race as an auth failure.
      const response = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' })
      assert.equal(response.status, 401, `expected 401 without a token, got ${response.status}`)
    })

    await check('a token-authenticated request succeeds', async () => {
      const match = /token=([A-Za-z0-9_-]+)/.exec(stdout)
      assert.ok(match, `no token in the boot output:\n${stdout}\nstderr:\n${stderr}`)
      const token = match[1]

      // The token URL does not answer 200 directly: it returns 303 to `/` and
      // hands the caller a session cookie. A client that drops the cookie (or
      // the redirect) sees 401 and would wrongly conclude the boot failed —
      // measured, not assumed. So this drives the sequence a browser performs:
      // present the token, keep the cookie, then fetch `/`.
      const first = await fetch(`http://127.0.0.1:${PORT}/?token=${token}`, { redirect: 'manual' })
      assert.ok(
        first.status === 200 || first.status === 303,
        `expected 200 or a 303 token exchange, got ${first.status}`,
      )

      const cookie = first.headers.getSetCookie?.().map((c) => c.split(';')[0]).join('; ')
        ?? first.headers.get('set-cookie')?.split(';')[0]

      const body = await (await fetch(`http://127.0.0.1:${PORT}/`, {
        headers: cookie ? { cookie } : {},
      })).text()

      assert.ok(body.length > 1000, `authenticated body suspiciously small: ${body.length} bytes`)
      assert.match(body, /<html/i, 'authenticated response should be the web app')
    })

    await check('the daily 3080 instance was not disturbed', async () => {
      // A 401 is the healthy answer: it means 3080 is still serving its own
      // token-gated UI and we did not replace it.
      const response = await fetch('http://127.0.0.1:3080/', { redirect: 'manual' })
      assert.equal(response.status, 401)
    })
  } finally {
    child.kill()
    await new Promise((r) => setTimeout(r, 1500))
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }

  let failed = 0
  for (const result of results) {
    if (result.ok) console.log(`ok    ${result.label}`)
    else {
      failed += 1
      console.log(`FAIL  ${result.label}\n        ${result.error}`)
    }
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
