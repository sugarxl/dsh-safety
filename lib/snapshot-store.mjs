/**
 * dsh-safety snapshot store: incremental snapshots.
 *
 * dsh-safety 快照存储：增量快照。
 *
 * This module implements an incremental snapshot strategy:
 *   1. On first run, scan all policy roots and build a full baseline.
 *   2. On subsequent runs, diff against the previous snapshot to
 *      identify only the files that changed (by checksum).
 *   3. The resulting record contains only the delta, but the full
 *      baseline is retained for recovery.
 *
 * The full baseline is stored under snapshots/<baseline-id>/baseline.json.
 * Each incremental snapshot stores its delta under snapshots/<id>/delta.json.
 *
 * 本模块实现增量快照策略：
 *   1. 首次运行时扫描所有策略根目录，构建完整基线。
 *   2. 后续运行时与上一次快照对比，仅识别变更的文件（通过校验和）。
 *   3. 增量记录仅包含差异，完整基线保留在 snapshots/<baseline-id>/baseline.json。
 *
 * This is a standalone utility (exported from the package): the enforcement
 * path uses the full-snapshot store in `safety-core.mjs`; this module is for
 * consumers that want cheap incremental snapshots of a directory tree.
 */

import { promises as fsp, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const SNAPSHOT_BASELINE = 'baseline.json'
export const SNAPSHOT_DELTA = 'delta.json'
export const SNAPSHOT_META = 'meta.json'

export const defaultHome = () => path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))

export const snapshotsDir = (home = defaultHome()) => path.join(home, '.dsh-safety', 'snapshots')

/**
 * Compute the SHA-256 checksum of a file (streamed in chunks).
 * Modern Node `FileHandle.read()` returns `{ bytesRead, buffer }` (not a raw
 * number), so the loop must branch on `bytesRead` to terminate.
 */
async function checksumFile(file) {
  const hash = crypto.createHash('sha256')
  const fd = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    for (;;) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      hash.update(buf.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await fd.close()
  }
}

/**
 * Scan a directory tree and return a full manifest.
 * `maxDepth` bounds the recursion depth (0 = current dir only).
 * Every entry carries `size`, `mtimeMs` and `checksum` so diffs can detect
 * modifications reliably.
 *
 * 扫描目录树并返回完整清单；maxDepth 限制递归深度。
 */
export async function scanDir(dir, maxDepth = 10) {
  const entries = []
  const walk = async (cur, depth) => {
    if (depth < 0) return
    let d
    try {
      d = await fsp.readdir(cur, { withFileTypes: true })
    } catch {
      return // skip inaccessible entries
    }
    for (const e of d) {
      const entryPath = path.join(cur, e.name)
      if (e.isDirectory()) {
        await walk(entryPath, depth - 1)
      } else if (e.isFile()) {
        try {
          const st = await fsp.stat(entryPath)
          entries.push({
            rel: path.relative(dir, entryPath),
            abs: entryPath,
            size: st.size,
            mtimeMs: st.mtimeMs,
            checksum: await checksumFile(entryPath),
          })
        } catch {
          /* skip unreadable files */
        }
      }
    }
  }
  await walk(dir, maxDepth)
  return entries.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * Diff two file manifests by checksum.
 *
 * - baseline: the full manifest from the previous snapshot (or initial scan).
 * - current: the manifest from the current scan.
 *
 * Returns a delta manifest containing only files whose checksum changed
 * or whose presence changed. Each entry is marked with the operation:
 *   "added"   — new file
 *   "removed" — file no longer exists
 *   "modified"— checksum changed
 */
export function diffManifests(baseline, current) {
  const delta = []
  const currentByRel = new Map()
  for (const e of current) {
    if (!currentByRel.has(e.rel)) currentByRel.set(e.rel, e)
  }
  const baselineByRel = new Map()
  for (const e of baseline) {
    if (!baselineByRel.has(e.rel)) baselineByRel.set(e.rel, e)
  }
  for (const [rel, base] of baselineByRel) {
    const cur = currentByRel.get(rel)
    if (!cur) {
      delta.push({ rel, op: 'removed' })
    } else if (cur.checksum !== base.checksum) {
      delta.push({ rel, op: 'modified', size: cur.size })
    }
  }
  for (const [rel, cur] of currentByRel) {
    if (!baselineByRel.has(rel)) {
      delta.push({ rel, op: 'added', size: cur.size })
    }
  }
  return delta
}

/**
 * Build an incremental snapshot record.
 */
export async function buildIncrementalSnapshot(dir, baselinePath) {
  const [current, baselineText] = await Promise.all([
    scanDir(dir),
    fsp.readFile(baselinePath, 'utf8'),
  ])
  const baseline = JSON.parse(baselineText)
  const delta = diffManifests(baseline, current)
  const record = {
    type: 'incremental',
    baselineId: path.basename(path.dirname(baselinePath)),
    createdAt: Date.now(),
    delta,
    fullCount: current.length,
    deltaCount: delta.length,
  }
  return record
}

/**
 * Build a full (baseline) snapshot record.
 */
export async function buildBaselineSnapshot(dir) {
  const files = await scanDir(dir)
  return {
    type: 'baseline',
    createdAt: Date.now(),
    files,
    fileCount: files.length,
  }
}

/**
 * Load a snapshot record from disk.
 */
export async function loadSnapshotRecord(home, id) {
  const recPath = path.join(snapshotsDir(home), String(id), SNAPSHOT_META)
  try {
    await fsp.access(recPath)
  } catch {
    return null // missing or unreadable
  }
  try {
    return JSON.parse(await fsp.readFile(recPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Save a snapshot record to disk.
 */
export async function saveSnapshotRecord(home, id, record) {
  const dir = path.join(snapshotsDir(home), String(id))
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, SNAPSHOT_META),
    JSON.stringify(record, null, 2) + '\n',
    'utf8'
  )
  // persist the full baseline if this is a baseline snapshot
  if (record.type === 'baseline') {
    const baselinePath = path.join(dir, SNAPSHOT_BASELINE)
    await fsp.writeFile(baselinePath, JSON.stringify(record.files, null, 2) + '\n', 'utf8')
  }
  // persist the delta if this is an incremental snapshot
  if (record.type === 'incremental') {
    const deltaPath = path.join(dir, SNAPSHOT_DELTA)
    await fsp.writeFile(deltaPath, JSON.stringify(record.delta, null, 2) + '\n', 'utf8')
  }
  return true
}

/**
 * List all snapshot directories.
 */
export async function listSnapshotDirs(home = defaultHome()) {
  const dir = snapshotsDir(home)
  try {
    await fsp.access(dir)
  } catch {
    return []
  }
  try {
    const d = await fsp.readdir(dir, { withFileTypes: true })
    return d.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

async function readMeta(home, id) {
  const meta = path.join(snapshotsDir(home), String(id), SNAPSHOT_META)
  try {
    await fsp.access(meta)
    return JSON.parse(await fsp.readFile(meta, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Get the latest baseline snapshot id (by createdAt).
 */
export async function getLatestBaseline(home = defaultHome()) {
  const dirs = await listSnapshotDirs(home)
  let latest = null
  for (const d of dirs) {
    const meta = await readMeta(home, d)
    if (meta && meta.type === 'baseline') {
      if (!latest || (meta.createdAt || 0) > (latest.createdAt || 0)) {
        latest = { id: d, createdAt: meta.createdAt || 0 }
      }
    }
  }
  return latest ? latest.id : null
}

/**
 * Get the latest incremental snapshot for a given baseline.
 */
export async function getLatestIncremental(home, baselineId) {
  const dirs = await listSnapshotDirs(home)
  let latest = null
  for (const d of dirs) {
    const meta = await readMeta(home, d)
    if (meta && meta.type === 'incremental' && meta.baselineId === baselineId) {
      if (!latest || (meta.createdAt || 0) > (latest.createdAt || 0)) {
        latest = { id: d, createdAt: meta.createdAt || 0 }
      }
    }
  }
  return latest ? latest.id : null
}

/**
 * Get the combined baseline + delta manifest.
 */
export async function getCombinedManifest(home, baselineId, incrementalId) {
  const baseline = await loadSnapshotRecord(home, baselineId)
  if (!baseline) return null
  const inc = await loadSnapshotRecord(home, incrementalId)
  if (!inc) return baseline
  // apply delta on top of baseline
  const combined = [...(baseline.files || [])]
  for (const d of inc.delta || []) {
    const idx = combined.findIndex((f) => f.rel === d.rel)
    if (idx === -1) {
      combined.push(d)
    } else {
      combined[idx] = { ...combined[idx], ...d }
    }
  }
  return {
    type: 'combined',
    baselineId,
    incrementalId,
    createdAt: inc.createdAt,
    files: combined,
  }
}

/**
 * Compute the checksum of a directory tree.
 * Used for detecting whether a baseline is still valid.
 */
export async function dirTreeChecksum(dir) {
  const entries = await scanDir(dir)
  const hash = crypto.createHash('sha256')
  for (const e of entries) {
    hash.update(e.rel)
    hash.update(e.checksum)
  }
  return hash.digest('hex')
}
