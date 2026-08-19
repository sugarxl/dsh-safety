/**
 * dsh-safety audit logger.
 *
 * dsh-safety 审计日志器。
 *
 * Provides a structured JSONL audit log with threshold-based alerting.
 *
 * 提供结构化 JSONL 审计日志及基于阈值的告警。
 *
 * All paths are derived from an explicit `home` so the log always lives under
 * the same `.dsh-safety` dir the plugin uses (never a hardcoded OS home).
 */

import { promises as fsp, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const defaultHome = () => path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))

export const auditFile = (home = defaultHome()) => path.join(home, '.dsh-safety', 'audit.jsonl')
export const alertsFile = (home = defaultHome()) => path.join(home, '.dsh-safety', 'alerts.json')

/**
 * Default alert thresholds.
 */
const DEFAULT_THRESHOLDS = {
  blocksPerMin: 10,
  blocksPerHour: 100,
  deletesPerMin: 5,
  deletesPerHour: 20,
  snapshotsPerHour: 10,
}

/**
 * Load the current thresholds (synchronous — reads a JSON file).
 */
export function getThresholds(home = defaultHome()) {
  try {
    const raw = readFileSync(auditFile(home) + '.thresholds', 'utf8')
    return { ...DEFAULT_THRESHOLDS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_THRESHOLDS }
  }
}

/**
 * Set thresholds.
 */
export async function setThresholds(home, thresholds) {
  await fsp.mkdir(path.dirname(auditFile(home)), { recursive: true })
  await fsp.writeFile(
    auditFile(home) + '.thresholds',
    JSON.stringify({ ...DEFAULT_THRESHOLDS, ...thresholds }, null, 2) + '\n',
    'utf8'
  )
}

/**
 * Append a single audit entry.
 *
 * @param {string} home  - DSH home
 * @param {string} kind  - 'guard' | 'delete' | 'snapshot' | 'restore' | 'check' | 'degrade'
 * @param {object} data  - structured payload
 * @returns {object}     - the entry that was written
 */
export async function appendAudit(home, kind, data) {
  const entry = {
    ts: Date.now(),
    caller: process.env.DSH_SESSION_ID || 'unknown',
    tool: (data && data.tool) || 'unknown',
    target: (data && data.target) || 'unknown',
    kind,
    reason: (data && data.reason) || '',
  }
  const line = JSON.stringify(entry) + '\n'
  await fsp.mkdir(path.dirname(auditFile(home)), { recursive: true })
  await fsp.appendFile(auditFile(home), line, 'utf8')
  await checkAlerts(home, entry)
  return entry
}

/**
 * Check thresholds and emit alerts.
 *
 * The audit file is scanned ONCE per append and both the 1-minute and 1-hour
 * windows are aggregated in a single pass — previously every append triggered
 * five full-file reads (one per threshold), making appends O(n²) overall.
 */
async function checkAlerts(home, entry) {
  const thresholds = getThresholds(home)
  const now = entry.ts
  const oneMinAgo = now - 60 * 1000
  const oneHourAgo = now - 60 * 60 * 1000

  const counts = await countKindsInRange(home, oneMinAgo, oneHourAgo)

  const alerts = []

  // count blocks in the last minute
  const blocksInMin = counts.guard.min
  if (blocksInMin > thresholds.blocksPerMin) {
    alerts.push({
      ts: now,
      kind: 'high-block-rate',
      detail: `blocks/min=${blocksInMin} > threshold=${thresholds.blocksPerMin}`,
    })
  }

  // count blocks in the last hour
  const blocksInHour = counts.guard.hour
  if (blocksInHour > thresholds.blocksPerHour) {
    alerts.push({
      ts: now,
      kind: 'high-block-rate-hour',
      detail: `blocks/hour=${blocksInHour} > threshold=${thresholds.blocksPerHour}`,
    })
  }

  // count deletes in the last minute
  const deletesInMin = counts.delete.min
  if (deletesInMin > thresholds.deletesPerMin) {
    alerts.push({
      ts: now,
      kind: 'high-delete-rate',
      detail: `deletes/min=${deletesInMin} > threshold=${thresholds.deletesPerMin}`,
    })
  }

  // count deletes in the last hour
  const deletesInHour = counts.delete.hour
  if (deletesInHour > thresholds.deletesPerHour) {
    alerts.push({
      ts: now,
      kind: 'high-delete-rate-hour',
      detail: `deletes/hour=${deletesInHour} > threshold=${thresholds.deletesPerHour}`,
    })
  }

  // count snapshots in the last hour
  const snapsInHour = counts.snapshot.hour
  if (snapsInHour > thresholds.snapshotsPerHour) {
    alerts.push({
      ts: now,
      kind: 'high-snapshot-rate',
      detail: `snapshots/hour=${snapsInHour} > threshold=${thresholds.snapshotsPerHour}`,
    })
  }

  if (alerts.length) {
    await fsp.mkdir(path.dirname(alertsFile(home)), { recursive: true })
    const alert = {
      id: crypto.randomUUID(),
      ts: now,
      kind: alerts.map((a) => a.kind).join(';'),
      detail: alerts.map((a) => a.detail).join('; '),
    }
    await fsp.appendFile(alertsFile(home), JSON.stringify(alert) + '\n', 'utf8')
  }
}

/**
 * Count guard/delete/snapshot events in the last minute AND last hour with a
 * single pass over the audit file. The file is JSONL (one object per line) —
 * parse line by line, never as a single JSON document.
 */
async function countKindsInRange(home, oneMinAgo, oneHourAgo) {
  const counts = { guard: { min: 0, hour: 0 }, delete: { min: 0, hour: 0 }, snapshot: { min: 0, hour: 0 } }
  const file = auditFile(home)
  if (!existsSync(file)) return counts
  try {
    const text = await fsp.readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      const l = line.trim()
      if (!l) continue
      try {
        const e = JSON.parse(l)
        if (e.kind !== 'guard' && e.kind !== 'delete' && e.kind !== 'snapshot') continue
        if (e.ts >= oneMinAgo) counts[e.kind].min++
        if (e.ts >= oneHourAgo) counts[e.kind].hour++
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    /* ignore read errors */
  }
  return counts
}

/**
 * Read all audit entries.
 */
export async function readAudit(home = defaultHome()) {
  const file = auditFile(home)
  if (!existsSync(file)) return []
  try {
    const text = await fsp.readFile(file, 'utf8')
    const out = []
    for (const l of text.split('\n')) {
      const line = l.trim()
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* skip malformed lines */
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Read all alerts.
 */
export async function readAlerts(home = defaultHome()) {
  const file = alertsFile(home)
  if (!existsSync(file)) return []
  try {
    const text = await fsp.readFile(file, 'utf8')
    const out = []
    for (const l of text.split('\n')) {
      const line = l.trim()
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* skip malformed lines */
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Clear the audit log.
 */
export async function clearAudit(home = defaultHome()) {
  await fsp.unlink(auditFile(home)).catch(() => {})
  await fsp.unlink(alertsFile(home)).catch(() => {})
}

/**
 * Get the last N entries of a given kind.
 */
export async function tail(home, kind, n = 100) {
  const entries = await readAudit(home)
  return entries
    .filter((e) => e.kind === kind)
    .slice(-n)
}

/**
 * Get the last N alerts.
 */
export async function tailAlerts(home = defaultHome(), n = 50) {
  const alerts = await readAlerts(home)
  return alerts.slice(-n)
}

/**
 * Export audit entries as CSV.
 */
export async function exportToCSV(home = defaultHome(), kind) {
  const entries = await readAudit(home)
  const filtered = kind ? entries.filter((e) => e.kind === kind) : entries
  const headers = ['ts', 'caller', 'tool', 'target', 'kind', 'reason']
  const lines = [headers.join(',')].concat(
    filtered.map((e) =>
      [
        new Date(e.ts).toISOString(),
        e.caller,
        e.tool,
        e.target,
        e.kind,
        e.reason || '',
      ].join(',')
    )
  )
  return lines.join('\n')
}
