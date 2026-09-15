/**
 * Optional screenshot capture for the preview.
 *
 * ## What this is for
 *
 * 功能文档 §6.4 lists screenshot capture as optional and says layout regressions
 * are found by comparing shots against the live shell. This module only *takes*
 * the shots — it does not compare them, and it does not claim a shot is correct.
 * A directory of PNGs is evidence for a human or a later diff step, nothing more.
 *
 * ## Why it is optional
 *
 * Driving a browser needs one installed. Like bundling, this is **best-effort**:
 * a driver is used when one is resolvable, and the caller is told plainly when
 * none is, rather than being handed a promise the tool cannot keep.
 *
 * Nothing here downloads a browser. If Playwright is present but its browsers are
 * not, that is reported as-is — installing ~150 MB as a side effect of asking for
 * a screenshot would be a surprising thing for a preview command to do.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/** Browser drivers probed, in preference order. */
const DRIVER_CANDIDATES = [
  { name: 'playwright', module: 'playwright' },
  { name: 'playwright-core', module: 'playwright-core' },
]

/**
 * Common system browser locations, used when the driver ships no browser.
 *
 * Reusing an installed browser avoids a large download and is what makes this
 * feature usable on a machine that never ran `playwright install`.
 *
 * @returns {string[]}
 */
function systemBrowserCandidates() {
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
}

/**
 * Load a browser driver, if one is resolvable.
 *
 * @returns {Promise<{name: string, chromium: object}|null>}
 */
export async function loadDriver() {
  for (const candidate of DRIVER_CANDIDATES) {
    try {
      const resolved = require.resolve(candidate.module)
      const module = await import(pathToFileURL(resolved).href)
      const chromium = module.chromium ?? module.default?.chromium
      if (chromium && typeof chromium.launch === 'function') {
        return { name: candidate.name, chromium }
      }
    } catch {
      // Not installed, or not importable: try the next candidate.
    }
  }
  return null
}

/**
 * Find an installed browser to drive.
 *
 * @returns {string|null}
 */
export function findSystemBrowser() {
  for (const candidate of systemBrowserCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Capture one PNG per rendered variant.
 *
 * @param {{
 *   url: string,
 *   outDir: string,
 *   variants: Array<{scheme: string, viewport: string}>,
 *   widths: Record<string, {width: number}>,
 *   driver?: {name: string, chromium: object}|null,
 *   executablePath?: string|null,
 * }} options
 * @returns {Promise<{ok: true, files: string[], driver: string} | {ok: false, reason: string, detail: string}>}
 */
export async function captureShots(options) {
  // `driver === undefined` means "probe"; an explicit value is used as given, so
  // a caller (and a test) can force the no-driver path.
  const driver = options.driver === undefined ? await loadDriver() : options.driver
  const usable = driver && typeof driver.chromium?.launch === 'function'
  if (!usable) {
    return {
      ok: false,
      reason: 'no browser driver available',
      detail: 'install playwright or playwright-core to enable screenshots',
    }
  }

  const executablePath = options.executablePath ?? findSystemBrowser()
  let browser
  try {
    // Passing `executablePath` reuses an installed browser; without it the driver
    // needs its own download, which is reported rather than performed.
    browser = await driver.chromium.launch(executablePath ? { executablePath } : {})
  } catch (error) {
    return {
      ok: false,
      reason: 'could not launch a browser',
      detail: `${error?.message ?? error}`,
    }
  }

  const files = []
  try {
    mkdirSync(options.outDir, { recursive: true })

    for (const variant of options.variants) {
      const page = await browser.newPage()
      try {
        // Sized to the variant's slot frame plus chrome, so the shot shows the
        // frame at its real width rather than a scaled rendering.
        const width = options.widths?.[variant.viewport]?.width ?? 600
        await page.setViewportSize({ width: width + 80, height: 600 })
        await page.goto(options.url)
        // Wait for the page's own readiness signal, so a shot is never taken
        // mid-mount and mistaken for a layout bug.
        await page.waitForSelector("html[data-preview-ready='true']", { timeout: 20000 })
        // Force this variant's scheme so one page yields both palettes.
        await page.evaluate((scheme) => {
          document.documentElement.setAttribute('data-scheme', scheme)
        }, variant.scheme)

        const file = join(options.outDir, `${variant.scheme}-${variant.viewport}.png`)
        await page.screenshot({ path: file, fullPage: true })
        files.push(file)
      } finally {
        await page.close()
      }
    }
  } catch (error) {
    return { ok: false, reason: 'capture failed', detail: `${error?.message ?? error}` }
  } finally {
    await browser.close().catch(() => {})
  }

  return { ok: true, files, driver: driver.name }
}
