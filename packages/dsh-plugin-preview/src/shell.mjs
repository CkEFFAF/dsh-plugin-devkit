/**
 * The preview shell: a standalone HTML page that mounts a client half into a
 * fake slot.
 *
 * ## What this is for
 *
 * 功能文档 §6.4 / user story 17: a dual-half plugin author wants to see their
 * Client half in a slot *before* starting a full Agent conversation. The shell
 * gives a local page with the official token names defined at approximate sizes,
 * a correctly-sized slot frame, and light/dark plus two widths.
 *
 * ## What this deliberately is not
 *
 * - It does **not** patch or fork the official client (设计文档 §7, 功能文档 §3).
 * - It does **not** claim pixel parity. 功能文档 §6.4 says layout regressions are
 *   found by screenshot diff against the live shell; the preview only says
 *   "it mounted, and it is roughly this size".
 * - It does **not** `provide('debugger')` or install tool probes (设计文档 §7).
 *   Keeping inspection and layout in separate packages is what stops the
 *   observer from growing a DOM dependency.
 *
 * ## The client factory contract
 *
 * The mounted module exports `mount(slotElement, { fixture, slot })`, or a
 * default function with that signature. The shell calls it once per rendered
 * variant and surfaces any throw in the page rather than failing silently —
 * a preview that shows a blank box when mounting failed is worse than useless.
 */

import { tokenDeclarations } from './tokens.mjs'
import { serializeFixture } from './fixture.mjs'

/**
 * Slot frame sizes, in CSS pixels.
 *
 * Approximations of the host's layout, not measurements of it. The two widths
 * exist because 功能文档 §6.4 asks for a narrow and a wide shot: a slot that
 * only looks right at 1680px is a layout bug the author should see here.
 */
export const VIEWPORTS = Object.freeze({
  narrow: { width: 420, label: 'narrow (420px)' },
  wide: { width: 900, label: 'wide (900px)' },
})

/**
 * Escape text for safe inclusion in HTML.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Serialize a value for safe embedding inside a `<script>` element.
 *
 * `JSON.stringify` alone is **not** safe here: it does not escape `</script>`,
 * so a string containing that sequence terminates the script element and the
 * rest of the payload is parsed as HTML. Every value interpolated into the page's
 * script must go through this — a client module path is user input like any
 * other, and the preview is run by the plugin author on their own machine but
 * with paths that may come from a config file or a command line.
 *
 * Escaping `<` (plus the two other line terminators JSON permits literally) keeps
 * the result valid JSON while making the sequence unrepresentable in the source.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function serializeForScript(value) {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * Build the preview page.
 *
 * @param {{
 *   slot: string,
 *   fixture: object,
 *   clientModule?: string|null,
 *   clientSource?: string|null,
 *   title?: string,
 *   schemes?: string[],
 *   viewports?: string[],
 * }} options
 * @returns {string} a complete HTML document
 */
export function renderShell(options) {
  const slot = String(options.slot ?? '')
  const title = options.title ?? `slot preview: ${slot}`
  const clientModule = options.clientModule ?? null
  const schemes = options.schemes?.length ? options.schemes : ['light', 'dark']
  const viewports = options.viewports?.length ? options.viewports : ['narrow', 'wide']

  const variants = []
  for (const scheme of schemes) {
    for (const viewport of viewports) {
      variants.push({ scheme, viewport })
    }
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  /* Official alias token names, preview values. A plugin's CSS written against
     var(--dsw-alias-*) resolves here instead of falling back to nothing. */
  :root {
${indent(tokenDeclarations('light'), 4)}
  }
  :root[data-scheme="dark"] {
${indent(tokenDeclarations('dark'), 4)}
  }

  /* Preview chrome. Preview-owned tokens use the --dsh-preview- prefix so they
     are never mistaken for host tokens. */
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--dsh-preview-gap);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: var(--dsh-content-font-size);
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
  }
  .preview-banner {
    padding: 8px 12px;
    margin-bottom: var(--dsh-preview-gap);
    border: 1px solid var(--dsw-alias-border-l1);
    border-radius: var(--dsh-preview-radius);
    background: var(--dsw-alias-bg-layer-1);
    color: var(--dsw-alias-label-secondary);
    font-size: 12px;
  }
  .preview-banner strong { color: var(--dsw-alias-label-primary); }
  .variants { display: flex; flex-wrap: wrap; gap: var(--dsh-preview-gap); align-items: flex-start; }
  .variant { display: flex; flex-direction: column; gap: 6px; }
  .variant-label {
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--dsw-alias-label-secondary);
  }
  /* The slot frame stands in for the host's slot: correct width, honest border. */
  .slot-frame {
    width: var(--slot-width);
    min-height: 120px;
    padding: 10px;
    border: 1px dashed var(--dsw-alias-border-l2);
    border-radius: var(--dsh-preview-radius);
    background: var(--dsw-alias-bg-layer-1);
    overflow: auto;
  }
  .slot-frame[data-failed="true"] { border-color: var(--dsw-alias-state-error-primary); }
  .mount-error {
    margin: 0;
    padding: 8px;
    white-space: pre-wrap;
    color: var(--dsw-alias-state-error-primary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
</style>
</head>
<body>
<div class="preview-banner">
  <strong>Preview shell</strong> — slot <code>${escapeHtml(slot)}</code>, fixture data.
  Sizes are approximate and do not match the live shell pixel-for-pixel;
  layout regressions need a screenshot diff.
</div>

<div class="variants" id="variants"></div>

<script type="module">
const FIXTURE = ${serializeFixture(options.fixture)};
const SLOT = ${serializeForScript(slot)};
const CLIENT_MODULE = ${serializeForScript(clientModule)};
const CLIENT_SOURCE = ${serializeForScript(options.clientSource ?? null)};
const VARIANTS = ${serializeForScript(variants)};
const VIEWPORTS = ${serializeForScript(VIEWPORTS)};
const SCHEMES = ${serializeForScript(schemes)};

/** Mount one variant, surfacing any failure into the page. */
async function mountInto(factory, element, variant) {
  try {
    await factory(element, { fixture: FIXTURE, slot: SLOT, scheme: variant.scheme, viewport: variant.viewport });
    return null;
  } catch (error) {
    element.setAttribute('data-failed', 'true');
    const pre = document.createElement('pre');
    pre.className = 'mount-error';
    pre.textContent = 'mount() threw:\\n' + (error && error.stack ? error.stack : String(error));
    element.appendChild(pre);
    return error;
  }
}

/** A factory that shows the fixture, used when no client module is supplied. */
function placeholderFactory(element, context) {
  const heading = document.createElement('div');
  heading.textContent = context.slot;
  heading.style.fontWeight = '600';
  element.appendChild(heading);

  for (const message of (context.fixture.messages ?? [])) {
    const row = document.createElement('div');
    row.textContent = message.role + ': ' + message.text;
    row.style.color = 'var(--dsw-alias-label-secondary)';
    row.style.marginTop = '6px';
    element.appendChild(row);
  }

  if (!CLIENT_MODULE && CLIENT_SOURCE === null) {
    const note = document.createElement('div');
    note.textContent = '(no client module supplied — pass --client <entry.mjs> to mount yours)';
    note.style.marginTop = '10px';
    note.style.color = 'var(--dsw-alias-state-warn-primary)';
    element.appendChild(note);
  }
}

let factory = placeholderFactory;
if (CLIENT_SOURCE !== null) {
  // Inlined source: no network fetch, so this works from a plain file:// page.
  // The CLI refuses to inline a module with imports it cannot resolve, because a
  // data:/blob: module can resolve neither bare specifiers nor relative paths —
  // measured in a real browser, not assumed.
  try {
    const url = URL.createObjectURL(new Blob([CLIENT_SOURCE], { type: 'text/javascript' }));
    const mod = await import(url);
    const candidate = typeof mod.mount === 'function' ? mod.mount : mod.default;
    if (typeof candidate === 'function') {
      factory = candidate;
    } else {
      throw new Error('inlined client must export mount(slotElement, context) or a default function');
    }
  } catch (error) {
    const host = document.getElementById('variants');
    const pre = document.createElement('pre');
    pre.className = 'mount-error';
    pre.textContent = 'failed to evaluate inlined client:\\n' + (error && error.stack ? error.stack : String(error));
    host.appendChild(pre);
  }
} else if (CLIENT_MODULE) {
  try {
    const mod = await import(CLIENT_MODULE);
    const candidate = typeof mod.mount === 'function' ? mod.mount : mod.default;
    if (typeof candidate === 'function') {
      factory = candidate;
    } else {
      throw new Error('client module must export mount(slotElement, context) or a default function');
    }
  } catch (error) {
    const host = document.getElementById('variants');
    const pre = document.createElement('pre');
    pre.className = 'mount-error';
    pre.textContent = 'failed to import client module:\\n' + (error && error.stack ? error.stack : String(error));
    host.appendChild(pre);
  }
}

const root = document.getElementById('variants');
for (const variant of VARIANTS) {
  const wrapper = document.createElement('div');
  wrapper.className = 'variant';
  wrapper.setAttribute('data-scheme', variant.scheme);

  const label = document.createElement('div');
  label.className = 'variant-label';
  label.textContent = variant.scheme + ' · ' + (VIEWPORTS[variant.viewport]?.label ?? variant.viewport);

  const frame = document.createElement('div');
  frame.className = 'slot-frame';
  frame.style.setProperty('--slot-width', (VIEWPORTS[variant.viewport]?.width ?? 600) + 'px');

  wrapper.appendChild(label);
  wrapper.appendChild(frame);
  root.appendChild(wrapper);

  await mountInto(factory, frame, variant);
}

// Signal readiness for a screenshot tool, so it never captures a half-mounted page.
document.documentElement.setAttribute('data-preview-ready', 'true');
</script>
</body>
</html>
`
}

/**
 * Indent every line of a block.
 *
 * @param {string} text
 * @param {number} spaces
 * @returns {string}
 */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text.split('\n').map((line) => (line ? pad + line : line)).join('\n')
}
