/**
 * Presentation layer: pure functions from records to text or JSON.
 *
 * Nothing here reads live runtime state or mutates the recorder — presentation
 * may not reach back into collection (design document 4). Every function is
 * deterministic given its arguments, which is what makes the command layer
 * testable without a host.
 */

import { truncate } from './sanitize.mjs'

/**
 * Format one record as a single text line.
 *
 * @param {object} record
 * @param {{verbose?: boolean}} [options]
 * @returns {string}
 */
export function renderRecord(record, options = {}) {
  const parts = [
    pad(String(record.seq), 5),
    String(record.ts ?? ''),
    pad(record.category ?? '?', 7),
    record.name ?? '',
  ]
  if (record.source) parts.push(`[${record.source}]`)
  if (record.correlation) parts.push(`#${record.correlation}`)
  if (Number.isFinite(record.durationMs)) parts.push(`${record.durationMs}ms`)
  if (record.error) parts.push(`! ${record.error.name}: ${record.error.message}`)

  let line = parts.join(' ')
  if (options.verbose && record.data !== undefined) {
    line += `\n      ${JSON.stringify(record.data)}`
  }
  return line
}

/**
 * Render a list of records.
 *
 * @param {object[]} records
 * @param {{verbose?: boolean}} [options]
 * @returns {string}
 */
export function renderRecords(records, options = {}) {
  if (!records.length) return '(no records)'
  return records.map((r) => renderRecord(r, options)).join('\n')
}

/**
 * Render the `health` conclusion.
 *
 * The requirement is a one-line combined verdict, not a wall of tables: a user
 * asking "is this composition healthy" should get an answer in the first line.
 *
 * The source-breakpoint note is appended per 功能文档 §6.5; pass
 * `{showSourceDebugHint: false}` to omit it once it has been read.
 *
 * @param {object} snapshot
 * @param {object} stats
 * @param {object} probes
 * @returns {string}
 */
export function renderHealth(snapshot, stats, probes, options = {}) {
  const c = snapshot.counts ?? {}
  const active = c.active ?? 0
  const total = c.total ?? 0
  const pending = c.pending ?? 0
  const failed = c.failed ?? 0
  const other = c.other ?? 0

  const bits = [`${active}/${total} active`, `${pending} pending`, `${failed} failed`]
  // Only worth showing when non-zero; naming it keeps the verdict honest below.
  if (other > 0) bits.push(`${other} in transition`)

  // The verdict must account for every non-active fiber, not just failed/pending.
  // A composition where everything is stuck in LOADING would otherwise print
  // "OK: plugins 0/3 active" — a false green, which is the single worst output
  // this tool can produce. `other` covers LOADING, UNLOADING and DISPOSED.
  const verdict = failed > 0
    ? 'UNHEALTHY'
    : pending > 0 || other > 0
      ? 'DEGRADED'
      : 'OK'

  const lines = [`${verdict}: plugins ${bits.join(', ')}`]

  // If the verdict is not OK but no individual cause is listed, say why: an
  // unexplained non-OK verdict sends the reader to `/debug plugins` with no clue.
  if (verdict !== 'OK' && !(snapshot.findings ?? []).length) {
    lines.push('  (no per-plugin findings: fibers are still settling; re-run /debug health)')
  }

  if (stats.evicted > 0) {
    lines.push(`timeline: ${stats.size}/${stats.capacity} records, ${stats.evicted} dropped (buffer overflowed)`)
  } else {
    lines.push(`timeline: ${stats.size}/${stats.capacity} records`)
  }

  // Separate genuine probe failures from capability reports. `toolsService` /
  // `commandsService` record whether a service was reachable, not whether a
  // probe broke; listing them as "inactive probes" would blame the debugger for
  // an absent service, which is exactly the false signal this tool must not give.
  const CAPABILITY_FLAGS = ['toolsService', 'commandsService']
  const failedProbes = Object.entries(probes?.installed ?? {})
    .filter(([name, ok]) => !ok && !CAPABILITY_FLAGS.includes(name))
    .map(([name]) => name)
  if (failedProbes.length) {
    lines.push(`probes: inactive [${failedProbes.join(', ')}]`)
  } else {
    lines.push('probes: active')
  }

  // Report missing optional services as a fact about the composition instead.
  const missingServices = CAPABILITY_FLAGS
    .filter((flag) => probes?.installed?.[flag] === false)
    .map((flag) => (flag === 'toolsService' ? 'tools' : 'commands'))
  if (missingServices.length) {
    lines.push(`optional services absent: [${missingServices.join(', ')}]`)
  }

  if (snapshot.degraded) lines.push(`inspector: degraded — ${snapshot.degraded}`)

  // The top reason is the actionable part; list it right under the verdict.
  for (const finding of (snapshot.findings ?? []).slice(0, 5)) {
    lines.push(`  - ${finding.name}: ${finding.reason}`)
  }
  if ((snapshot.findings ?? []).length > 5) {
    lines.push(`  … ${snapshot.findings.length - 5} more (run /debug plugins)`)
  }

  // 功能文档 §6.5 requires this note in `/debug health`, because the debugger
  // answers "is the composition wired correctly" and users then ask "why did my
  // line not run" — a different tool (`node --inspect`). Naming the boundary at
  // the moment the question arises is cheaper than documenting it elsewhere.
  // `verbose` suppresses it once it has been read; the default keeps it visible.
  if (options?.showSourceDebugHint !== false) {
    lines.push('')
    lines.push('source breakpoints (different tool, not this one):')
    lines.push('  NODE_OPTIONS=--inspect=9229 dsh-debug-boot …  then VS Code Attach or chrome://inspect')
  }

  return lines.join('\n')
}

/**
 * Render the plugin list with root causes.
 *
 * @param {object} snapshot
 * @param {{filterNote?: string|null}} [options]
 * @returns {string}
 */
export function renderPlugins(snapshot, options = {}) {
  const plugins = snapshot.plugins ?? []
  if (!plugins.length) {
    // A filter that matched nothing is NOT an empty composition, and saying so
    // would send the author looking for a problem they do not have.
    if (options.filterNote) return `no plugins match (${options.filterNote})`
    return snapshot.degraded
      ? `no plugins visible — ${snapshot.degraded}`
      : '(no plugins registered)'
  }

  const lines = plugins.map((p) => {
    const id = p.uid === null || p.uid === undefined ? '?' : String(p.uid)
    let line = `${pad(p.stateName, 9)} ${p.name} (fiber ${id})`
    if (p.inject?.length) line += ` inject=[${p.inject.join(', ')}]`
    return line
  })

  // A narrowed list must say it is narrowed, so it is never read as the whole
  // composition. A silent filter is its own kind of false green.
  if (options.filterNote) lines.unshift(`(${options.filterNote})`)

  const unhealthy = (snapshot.findings ?? []).filter((f) => f.id.startsWith('fiber:'))
  if (unhealthy.length) {
    lines.push('')
    lines.push('root causes:')
    for (const f of unhealthy) lines.push(`  - ${f.name}: ${f.reason}`)
  }
  return lines.join('\n')
}

/**
 * Render the service list.
 *
 * @param {object} snapshot
 * @returns {string}
 */
export function renderServices(snapshot) {
  const services = snapshot.services ?? []
  if (!services.length) {
    return snapshot.degraded
      ? `no services visible — ${snapshot.degraded}`
      : '(no services registered)'
  }
  return services
    .map((s) => {
      const state = s.provider?.stateName ?? (s.available ? 'AVAILABLE' : 'UNAVAILABLE')
      // Mark an inferred identity so a reader never mistakes the owning fiber's
      // name for the service's own declared name.
      const marker = s.nameReliable === false ? ' ~' : ''
      return `${pad(state, 9)} ${s.name}${marker}`
    })
    .join('\n')
}

/**
 * Render the stats report, including the overflow count.
 *
 * @param {object} stats
 * @returns {string}
 */
export function renderStats(stats) {
  const lines = [
    `records:    ${stats.size}/${stats.capacity}`,
    `emitted:    ${stats.seq}`,
    // Surfaced prominently: an invisible overflow is a wrong conclusion.
    `dropped:    ${stats.dropped}${stats.dropped > 0 ? '  (buffer overflowed; timeline is incomplete)' : ''}`,
  ]

  const counts = Object.entries(stats.counts ?? {})
  if (counts.length) {
    lines.push(`by category: ${counts.map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }

  const timings = Object.entries(stats.timings ?? {})
  if (timings.length) {
    lines.push('timings:')
    for (const [cat, t] of timings) {
      lines.push(`  ${pad(cat, 9)} n=${t.count} avg=${t.avgMs}ms max=${t.maxMs}ms`)
    }
  }

  if (stats.topTools?.length) {
    lines.push('top tools:')
    for (const t of stats.topTools) lines.push(`  ${pad(t.name, 24)} ${t.count}`)
  }

  return lines.join('\n')
}

/**
 * Render a trace: records sharing one correlation id.
 *
 * @param {string} id
 * @param {object[]} records
 * @param {{verbose?: boolean}} [options]
 * @returns {string}
 */
export function renderTrace(id, records, options = {}) {
  if (!records.length) return `no records for correlation '${id}'`
  return [`trace ${id} (${records.length} records)`, ...records.map((r) => renderRecord(r, options))].join('\n')
}

/**
 * Render the current configuration.
 *
 * @param {object} config
 * @returns {string}
 */
export function renderConfig(config) {
  return Object.entries(config)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join('\n')
}

/**
 * Build the machine-readable report.
 *
 * Field names are a stable contract for CI; formatting is explicitly not
 * (design document 3).
 *
 * @param {string} subcommand
 * @param {object} body
 * @returns {string}
 */
export function renderJson(subcommand, body) {
  return JSON.stringify({ subcommand, ...body }, null, 2)
}

/**
 * Right-pad for column alignment.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function pad(text, width) {
  const s = truncate(String(text ?? ''), width)
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}
