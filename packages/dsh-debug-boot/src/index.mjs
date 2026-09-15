/**
 * Public surface of `dsh-debug-boot`.
 *
 * The CLI is the product interface (设计文档 §5: "调用方只给被测插件路径 + 端口"),
 * but the planning pieces are exported so tests and future tooling can compose
 * them without spawning a process.
 */

export { parseArgs, USAGE, DEFAULTS } from './args.mjs'
export { resolvePluginEntry, assertEntryFile, looksLikeFile, toFileUrl } from './entry.mjs'
export {
  buildOverlayRows,
  renderOverlay,
  derivePluginId,
  sanitizeId,
  DEBUGGER_ID,
  DEFAULT_PLUGIN_ID,
} from './overlay.mjs'
export {
  planBoot,
  writeOverlay,
  renderBootBanner,
  renderBootJson,
  buildDshArgs,
  findDebuggerEntry,
} from './plan.mjs'
export { FAILURE, bootFailure, bootSuccess, renderFailure } from './failures.mjs'
export {
  resolveDshHome,
  profilesDir,
  profileDir,
  listProfiles,
  checkTemplate,
  checkPort,
} from './preflight.mjs'
