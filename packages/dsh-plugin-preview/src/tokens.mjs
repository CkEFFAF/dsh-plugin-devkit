/**
 * Official theme token names, mirrored for the preview shell.
 *
 * ## Where these come from
 *
 * `packages/client/ui-theme/src/client/index.ts:131-145` publishes the token set a
 * third-party plugin may read or override. The preview shell uses those **real**
 * names so a plugin's CSS written against `var(--dsw-alias-bg-layer-1)` resolves
 * inside the preview — an invented token name would render as an unstyled box and
 * teach the author nothing.
 *
 * ## Approximate values, deliberately
 *
 * 设计文档 §7 says the preview uses "近似值" of the official tokens and does not
 * patch the official client. These are stand-in colours chosen to be plausible in
 * light and dark, not the shipped palette. That is the honest trade: the preview
 * answers "did my client half mount, and is it roughly the right size", never
 * "is this pixel-identical to production".
 *
 * 功能文档 §6.4 reinforces it: layout regressions are found by screenshot diff,
 * and the preview does not promise to match the live shell.
 */

/**
 * The published alias tokens, with preview stand-in values.
 *
 * `name` matches the real CSS custom property exactly; `light`/`dark` are the
 * preview's own approximations.
 */
export const ALIAS_TOKENS = Object.freeze([
  { name: '--dsw-alias-bg-base', description: 'Application base background.', light: '#ffffff', dark: '#1a1a1e' },
  { name: '--dsw-alias-bg-layer-1', description: 'Primary raised surface.', light: '#f7f7f9', dark: '#232329' },
  { name: '--dsw-alias-bg-layer-2', description: 'Secondary nested surface.', light: '#efeff2', dark: '#2c2c34' },
  { name: '--dsw-alias-bg-overlay', description: 'Overlay and popover background.', light: '#ffffff', dark: '#2c2c34' },
  { name: '--dsw-alias-border-l1', description: 'Primary subtle border.', light: '#e3e3e8', dark: '#3a3a44' },
  { name: '--dsw-alias-border-l2', description: 'Secondary stronger border.', light: '#cfcfd6', dark: '#4a4a56' },
  { name: '--dsw-alias-brand-primary', description: 'Primary brand accent.', light: '#4d6bfe', dark: '#7b93ff' },
  { name: '--dsw-alias-label-primary', description: 'Primary text color.', light: '#1c1c22', dark: '#ecedf1' },
  { name: '--dsw-alias-label-secondary', description: 'Secondary text color.', light: '#5f5f6b', dark: '#a2a3ad' },
  { name: '--dsw-alias-state-error-primary', description: 'Error state color.', light: '#d93a3a', dark: '#ff6b6b' },
  { name: '--dsw-alias-state-success-primary', description: 'Success state color.', light: '#1f9d55', dark: '#4ecb7d' },
  { name: '--dsw-alias-state-warn-primary', description: 'Warning state color.', light: '#b7791f', dark: '#e0a94a' },
  { name: '--dsw-specific-sidebar-fill', description: 'Sidebar column background.', light: '#f2f2f5', dark: '#202027' },
])

/**
 * Preview-local tokens the shell needs that the official set does not publish.
 *
 * Named with the same `--dsh-` prefix the host uses, and documented as
 * preview-owned so nobody mistakes them for official ones.
 */
export const PREVIEW_TOKENS = Object.freeze([
  { name: '--dsh-preview-gap', value: '12px', description: 'Spacing between preview chrome and the mounted slot.' },
  { name: '--dsh-preview-radius', value: '8px', description: 'Corner radius of the previewed slot frame.' },
  { name: '--dsh-content-font-size', value: '14px', description: 'Body font size (mirrors the host token of the same name).' },
  { name: '--dsh-content-font-delta', value: '0px', description: 'Font axis delta (mirrors the host token of the same name).' },
])

/** The two schemes the preview can render. */
export const SCHEMES = Object.freeze(['light', 'dark'])

/**
 * Build the CSS custom-property block for one scheme.
 *
 * @param {'light'|'dark'} scheme
 * @returns {string} declarations without a selector
 */
export function tokenDeclarations(scheme) {
  const key = scheme === 'dark' ? 'dark' : 'light'
  const alias = ALIAS_TOKENS.map((token) => `  ${token.name}: ${token[key]};`)
  const preview = PREVIEW_TOKENS.map((token) => `  ${token.name}: ${token.value};`)
  return [...alias, ...preview].join('\n')
}

/**
 * Every token name the preview defines.
 *
 * Used by tests to assert the shell does not invent names, and by the CLI to
 * print what a plugin author can rely on.
 *
 * @returns {string[]}
 */
export function tokenNames() {
  return [...ALIAS_TOKENS.map((token) => token.name), ...PREVIEW_TOKENS.map((token) => token.name)]
}
