/**
 * dsh-plugin-preview — see a client half in a slot without a session.
 *
 * 设计文档 §7 fixes the shape: an independent package whose seam is
 * **slot id + fixture snapshot + client factory**, using approximate official
 * theme tokens and never patching the official client.
 *
 * Two prohibitions hold by construction:
 *
 * - Nothing here calls `provide('debugger')` or installs a tool probe. The
 *   observation kernel is a separate package on purpose: letting the observer
 *   grow a DOM dependency is the shallow-interface failure 设计文档 §2 forbids.
 * - `layout` is not a record category in the debugger and never becomes one
 *   (设计文档 §7). The preview owns layout concerns alone.
 */

export { renderShell, VIEWPORTS, escapeHtml } from './src/shell.mjs'
export { ALIAS_TOKENS, PREVIEW_TOKENS, SCHEMES, tokenDeclarations, tokenNames } from './src/tokens.mjs'
export { createFixture, serializeFixture, validateFixture } from './src/fixture.mjs'
