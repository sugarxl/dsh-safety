/**
 * dsh-safety state persistence layer.
 *
 * dsh-safety 状态持久化层。
 *
 * Provides a durable state store for:
 *   - guard block counters (per tool, per session)
 *   - trash entries (undo metadata)
 *   - snapshot metadata (id, timestamp, file list, checksums)
 *   - journal entries (structured, not just text log)
 *   - degradation mode flags
 *
 * State is stored in $DSH_HOME/.dsh-safety/state.json.
 * On boot, the state is loaded and validated; on shutdown, it is saved.
 *
 * 状态持久化层，为以下对象提供耐久存储：
 *   - 守卫拦截计数（按工具、按会话）
 *   - 回收站条目（撤销元数据）
 *   - 快照元数据（id、时间戳、文件列表、校验和）
 *   - 审计日志条目（结构化，非仅文本日志）
 *   - 降级模式标志
 *
 * 状态存储于 $DSH_HOME/.dsh-safety/state.json。
 * 启动时加载并校验；关机时保存。
 *
 * Every function takes an explicit `home` (the DSH home) so the state always
 * lives under the same `.dsh-safety` dir the rest of the plugin uses — never a
 * hardcoded OS home that drifts when DSH_HOME is customized.
 */

import { promises as fsp, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { keyOf, isUnder } from './safety-core.mjs'

export const MAX_STATE_SIZE = 10 * 1024 * 1024 // 10 MB

export const defaultHome = () => path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))

export const stateFile = (home = defaultHome()) => path.join(home, '.dsh-safety', 'state.json')

/**
 * State schema (for validation). Every field carries a default so a missing or
 * partial state file normalizes to a usable object instead of nulls.
 */
const SCHEMA = {
  version: { type: 'string', required: true, default: '1' },
  bootCount: { type: 'integer', required: true, default: 0 },
  lastBootTime: { type: 'string', required: true, default: () => String(Date.now()) },
  guard: {
    type: 'object',
    required: true,
    default: () => ({ blocks: {}, sessions: [] }),
  },
  trash: {
    type: 'object',
    required: true,
    default: () => ({ entries: [], maxSize: 1000, maxAgeMs: 30 * 24 * 60 * 60 * 1000 }),
  },
  snapshots: {
    type: 'object',
    required: true,
    default: () => ({ list: [], maxSize: 50 }),
  },
  journal: {
    type: 'object',
    required: true,
    default: () => ({ entries: [], maxSize: 10000, maxAgeMs: 7 * 24 * 60 * 60 * 1000 }),
  },
  approvals: {
    type: 'object',
    required: true,
    default: () => ({ list: [] }),
  },
  degraded: { type: 'string', required: true, default: 'none' },
  degradedReason: { type: 'string', default: null },
  degradedSince: { type: 'string', default: null },
  shutdownReason: { type: 'string', default: null },
  shutdownAt: { type: 'string', default: null },
}

/**
 * Normalize a value against a schema field.
 */
function normalize(field, value) {
  if (field.type === 'string') return String(value)
  if (field.type === 'integer') return Number.isInteger(value) ? value : 0
  if (field.type === 'boolean') return Boolean(value)
  if (field.type === 'array') return Array.isArray(value) ? value : []
  if (field.type === 'object') return typeof value === 'object' && !Array.isArray(value) ? value : {}
  return value
}

/** A fresh, fully-populated default state object. */
function defaultState() {
  const state = {}
  for (const [key, field] of Object.entries(SCHEMA)) {
    state[key] = typeof field.default === 'function' ? field.default() : (field.default ?? null)
  }
  return state
}

/**
 * Load the current state from disk (synchronous — called from sync getters).
 * Returns a fully-populated default state when no file exists (first boot),
 * so every record/read operation works without an explicit init step.
 */
export function loadState(home = defaultHome()) {
  const file = stateFile(home)
  if (!existsSync(file)) return defaultState()
  try {
    const raw = readFileSync(file, 'utf8')
    const rawJson = JSON.parse(raw)
    const normalized = defaultState()
    for (const [key, field] of Object.entries(SCHEMA)) {
      if (key in rawJson) normalized[key] = normalize(field, rawJson[key])
    }
    return normalized
  } catch (e) {
    console.error('[dsh-safety state] failed to load state.json:', e && e.message ? e.message : e)
    return defaultState()
  }
}

/**
 * A UNIQUE temporary filename per write. A shared `state.json.tmp` was the root
 * cause of a Linux-only race: an async `saveState` and a sync `saveStateSync`
 * could interleave, one renaming the shared tmp away while the other still
 * tries to rename it (ENOENT) — and, worse, the async writer could then commit
 * a STALE state over a freshly granted approval (lost update). Unique tmp names
 * make every rename find its own source; combined with the synchronous mutation
 * path (below) there is no interleaving at all inside one process.
 *
 * 每次写入使用唯一临时文件名。共享的 state.json.tmp 是 Linux 专属竞争的根因：
 * 异步 saveState 与同步 saveStateSync 交错时，一方把共享 tmp rename 走，另一方
 * rename 时源已不存在（ENOENT）；更糟的是异步写会把过期状态覆盖到刚批准的审批
 * 上（丢更新）。唯一 tmp 保证每次 rename 都能找到自己的源；再配合下方统一的
 * 同步变更路径，单进程内不再有交错。
 */
const tmpFor = (file) => `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * Save the current state to disk.
 */
export async function saveState(state, home = defaultHome()) {
  try {
    const file = stateFile(home)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    // Atomic write (tmp + rename): a crash mid-write must never leave a
    // truncated/corrupt state.json that silently wipes approvals.
    const tmp = tmpFor(file)
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await fsp.rename(tmp, file)
    return true
  } catch (e) {
    console.error('[dsh-safety state] failed to save state.json:', e && e.message ? e.message : e)
    return false
  }
}

/**
 * Save synchronously. This is the CANONICAL write path: every state mutation in
 * this module commits through it (the approval grant/consume paths already had
 * to, because they run from the synchronous tool guard). Keeping ALL writers
 * synchronous means load→mutate→save happens in one uninterruptible slice of
 * the event loop, so async writers can no longer commit a stale state over a
 * freshly granted approval (the Linux harness race).
 */
export function saveStateSync(state, home = defaultHome()) {
  try {
    const file = stateFile(home)
    mkdirSync(path.dirname(file), { recursive: true })
    // Atomic write (tmp + rename) — same crash-safety as the async variant.
    const tmp = tmpFor(file)
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return true
  } catch (e) {
    console.error('[dsh-safety state] failed to save state.json (sync):', e && e.message ? e.message : e)
    return false
  }
}

/**
 * Increment a guard block counter atomically (load → mutate → save).
 */
export async function recordBlock(home, toolName, session, reason, target) {
  const state = loadState(home)
  const now = Date.now()
  const sessionKey = session ? String(session).slice(0, 16) : 'unknown'
  state.guard.blocks[toolName] = (state.guard.blocks[toolName] || 0) + 1
  if (!state.guard.sessions.includes(sessionKey)) {
    state.guard.sessions.push(sessionKey)
  }
  // Bump the boot counter when more than an hour has passed since the last
  // recorded boot (lastBootTime is stored as an epoch-ms string).
  const lastBoot = Number(state.lastBootTime) || 0
  if (lastBoot === 0 || now - lastBoot > 60 * 60 * 1000) {
    state.bootCount++
    state.lastBootTime = String(now)
  }
  saveStateSync(state, home)
  return true
}

/**
 * Get guard block counts per tool.
 */
export function getBlockCounts(home = defaultHome()) {
  return loadState(home).guard.blocks || {}
}

/**
 * Get total blocks across all tools.
 */
export function getTotalBlocks(home = defaultHome()) {
  return Object.values(getBlockCounts(home)).reduce((a, b) => a + b, 0)
}

/**
 * Add a trash entry.
 */
export async function addTrashEntry(home, trashPath, size, deletedAt, originalPath) {
  const state = loadState(home)
  const entry = {
    id: crypto.randomUUID(),
    originalPath: originalPath || trashPath,
    path: trashPath,
    size: size,
    deletedAt: deletedAt || Date.now(),
  }
  state.trash.entries.push(entry)
  // enforce maxSize (soft)
  if (state.trash.entries.length > (state.trash.maxSize || 1000)) {
    state.trash.entries.shift()
  }
  saveStateSync(state, home)
  return entry
}

/**
 * List trash entries.
 */
export async function listTrash(home = defaultHome()) {
  return loadState(home).trash.entries || []
}

/**
 * Restore a single trash entry.
 */
export async function restoreTrashEntry(home, entryId) {
  const state = loadState(home)
  const idx = state.trash.entries.findIndex((e) => e.id === entryId)
  if (idx === -1) return { ok: false, reason: 'not found' }
  const entry = state.trash.entries[idx]
  state.trash.entries.splice(idx, 1)
  saveStateSync(state, home)
  return { ok: true, entry }
}

/**
 * Create a snapshot metadata record (no file copy yet).
 */
export async function createSnapshotRecord(home, name, files) {
  const state = loadState(home)
  const id = crypto.randomUUID()
  const now = Date.now()
  const record = {
    id,
    name,
    createdAt: now,
    files: (files || []).map((f) => ({
      rel: f.rel,
      checksum: f.checksum,
      size: f.size,
    })),
  }
  state.snapshots.list.push(record)
  // enforce maxSize
  if (state.snapshots.list.length > (state.snapshots.maxSize || 50)) {
    state.snapshots.list.shift()
  }
  saveStateSync(state, home)
  return record
}

/**
 * List snapshots.
 */
export async function listSnapshots(home = defaultHome()) {
  return loadState(home).snapshots.list || []
}

/**
 * Get a snapshot record by id.
 */
export async function getSnapshot(home, id) {
  return (await listSnapshots(home)).find((s) => s.id === id) || null
}

/**
 * Delete a snapshot record (keep the data under snapshots/<id>).
 */
export async function deleteSnapshot(home, id) {
  const state = loadState(home)
  const idx = state.snapshots.list.findIndex((s) => s.id === id)
  if (idx === -1) return false
  state.snapshots.list.splice(idx, 1)
  saveStateSync(state, home)
  return true
}

/**
 * Append a journal entry.
 */
export async function appendJournal(home, kind, data) {
  const state = loadState(home)
  const entry = {
    id: crypto.randomUUID(),
    at: Date.now(),
    kind,
    data: data || {},
  }
  state.journal.entries.push(entry)
  // enforce maxSize & maxAge
  const max = state.journal.maxSize || 10000
  const age = state.journal.maxAgeMs || 7 * 24 * 60 * 60 * 1000 // 7 days
  while (state.journal.entries.length > max) {
    state.journal.entries.shift()
  }
  const cutoff = Date.now() - age
  state.journal.entries = state.journal.entries.filter((e) => e.at > cutoff)
  saveStateSync(state, home)
  return true
}

/**
 * Get recent journal entries.
 */
export async function journalTail(home = defaultHome(), n = 100) {
  return (loadState(home).journal.entries || []).slice(-n)
}

/**
 * Get journal by kind.
 */
export async function journalByKind(home, kind) {
  return (await journalTail(home, Number.MAX_SAFE_INTEGER))
    .filter((e) => e.kind === kind)
    .slice(-100)
}

/**
 * Get journal by session.
 */
export async function journalBySession(home, session) {
  const entries = loadState(home).journal.entries || []
  return entries.filter((e) => e.data && e.data.session === session)
}

/**
 * Set degradation mode.
 */
export async function setDegraded(home, mode, reason) {
  const state = loadState(home)
  state.degraded = mode
  state.degradedReason = reason || null
  state.degradedSince = String(Date.now())
  saveStateSync(state, home)
  return true
}

/**
 * Check if degraded and return the mode.
 */
export function getDegraded(home = defaultHome()) {
  return loadState(home).degraded || 'none'
}

/**
 * Get degraded reason.
 */
export function getDegradedReason(home = defaultHome()) {
  return loadState(home).degradedReason || null
}

/**
 * Clear degraded mode.
 */
export async function clearDegraded(home = defaultHome()) {
  const state = loadState(home)
  state.degraded = 'none'
  state.degradedReason = null
  state.degradedSince = null
  saveStateSync(state, home)
  return true
}

/**
 * Record a shutdown event.
 */
export async function recordShutdown(home, reason) {
  const state = loadState(home)
  state.shutdownReason = reason || null
  state.shutdownAt = String(Date.now())
  saveStateSync(state, home)
  return true
}

/**
 * Get shutdown reason.
 */
export function getShutdownReason(home = defaultHome()) {
  return loadState(home).shutdownReason || null
}

/**
 * Load the state object (for direct access in tests).
 */
export function getState(home = defaultHome()) {
  return loadState(home)
}

/* ── user-approval system ───────────────────────────────────────────────────
 *
 * The whole point of the approval system is that the MODEL can never approve
 * its own destructive calls: a `force` flag it can set is not a confirmation.
 * Requests are created by the agent (via the `safety_ask` tool), granted ONLY
 * by the human (via the CLI `dsh-safety allow <id>`, the Safety Center panel,
 * or the CLI `delete --force` which the human runs themselves), and consumed
 * once (one-shot, time-limited) by the guard / safe_delete on the first
 * matching retry.
 *
 * ────────────────────────────────────────────────────────────────────────── */

/** Create a pending approval request. Returns the request record. */
export function createApproval(home, { kind, target, recursive = false, what, why, consequence, alternative, requestedBy = 'unknown' } = {}) {
  const state = loadState(home)
  const isWrite = kind === 'write'
  const req = {
    id: crypto.randomUUID().slice(0, 8),
    kind: isWrite ? 'write' : 'delete',
    target: target || null,
    // A write is never "recursive" — force the flag off so a write approval
    // with recursive:true can never become an unconsumable dead record (the
    // write waterfall always matches with recursive:false).
    recursive: isWrite ? false : !!recursive,
    what: what || null,
    why: why || null,
    consequence: consequence || null,
    alternative: alternative || null,
    requestedBy,
    createdAt: Date.now(),
    grantedAt: null,
    grantedBy: null,
    expiresAt: null,
    consumedAt: null,
    revokedAt: null,
  }
  state.approvals.list.push(req)
  compactApprovals(state)
  saveStateSync(state, home)
  return req
}

/**
 * Bound the approvals list without ever invalidating a LIVE user grant:
 *  - consumed/revoked/expired records are audit history — keep the newest 250;
 *  - pending (ungranted) requests are the spam surface (safety_ask) — keep the
 *    newest 200;
 *  - granted-but-unexpired approvals are NEVER dropped.
 */
function compactApprovals(state) {
  const now = Date.now()
  const list = state.approvals.list
  const isDead = (r) => r.consumedAt || r.revokedAt || (r.expiresAt && r.expiresAt <= now)
  const dead = list.filter(isDead)
  if (dead.length > 250) {
    const drop = new Set(dead.slice(0, dead.length - 250).map((r) => r.id))
    state.approvals.list = list.filter((r) => !drop.has(r.id))
  }
  const pending = state.approvals.list.filter((r) => !isDead(r) && !r.grantedAt)
  if (pending.length > 200) {
    const drop = new Set(pending.slice(0, pending.length - 200).map((r) => r.id))
    state.approvals.list = state.approvals.list.filter((r) => !drop.has(r.id))
  }
}

/**
 * Grant a pending request by id (the HUMAN action). Sets a TTL; after expiry
 * the request is unusable.
 */
export function grantApproval(home, id, { grantedBy = 'user', ttlMs = 5 * 60 * 1000 } = {}) {
  const state = loadState(home)
  const req = state.approvals.list.find((r) => r.id === String(id) && !r.consumedAt && !r.revokedAt)
  if (!req) return { ok: false, reason: 'not-found' }
  const now = Date.now()
  if (req.grantedAt && req.expiresAt && req.expiresAt <= now) {
    return { ok: false, reason: 'expired' }
  }
  req.grantedAt = now
  req.grantedBy = grantedBy
  req.expiresAt = now + (Number(ttlMs) || 5 * 60 * 1000)
  saveStateSync(state, home)
  return { ok: true, request: req }
}

/** Create and grant in one step (the human CLI path). */
export function grantApprovalFor(home, { kind, target, recursive = false, grantedBy = 'user', ttlMs = 5 * 60 * 1000 } = {}) {
  const req = createApproval(home, { kind, target, recursive, requestedBy: grantedBy })
  return grantApproval(home, req.id, { grantedBy, ttlMs })
}

/** Revoke a request (the human action). */
export function revokeApproval(home, id) {
  const state = loadState(home)
  const req = state.approvals.list.find((r) => r.id === String(id))
  if (!req) return { ok: false, reason: 'not-found' }
  req.revokedAt = Date.now()
  saveStateSync(state, home)
  return { ok: true, request: req }
}

/**
 * Consume one matching granted approval (one-shot). Returns true only when an
 * unexpired, granted, non-consumed request matches the call:
 *   - kind must match ('delete' | 'write');
 *   - the recursive flag must match exactly (a directory-delete approval never
 *     covers a file delete and vice versa);
 *   - for recursive calls the approval may be target-agnostic (`target: null`,
 *     e.g. a generic "allow a recursive shell delete" granted by the human via
 *     the CLI) or exact; for non-recursive calls it must be exact.
 * Matching is synchronous so it can run inside the tool guard.
 */
/**
 * Case-normalized target equality. Windows paths are compared case-insensitively
 * (matching `keyOf` used by path classification), so an approval granted for
 * `C:\Users\A\X` is consumed by a retry that spells it `c:\users\a\x` — and on
 * POSIX the comparison stays exact.
 *
 * 大小写归一的目标比较：Windows 下与路径分类（keyOf）保持一致地大小写不敏感，
 * 批准时写的 `C:\Users\A\X` 能被 `c:\users\a\x` 的重试消费；POSIX 保持精确比较。
 */
function sameTarget(a, b) {
  if (a === null || b === null) return a === b
  return keyOf(a) === keyOf(b)
}

/**
 * Whether a recursive approval `r` covers the call target `target`. A recursive
 * approval covers: a generic target (null), the exact target, or ANY path
 * UNDER the approved root — so `dsh-safety allow --path C:\Temp --recursive`
 * authorizes deleting C:\Temp itself and anything below it, which is the
 * intuitive meaning of "approve this recursive delete".
 */
function recursiveCovers(rTarget, target) {
  if (rTarget === null) return true
  if (target === null) return false
  return sameTarget(rTarget, target) || isUnder(target, rTarget)
}

export function consumeApproval(home, { kind, target = null, recursive = false } = {}) {
  const state = loadState(home)
  const now = Date.now()
  const idx = state.approvals.list.findIndex((r) => {
    if (r.kind !== kind || r.consumedAt || r.revokedAt) return false
    if (!r.grantedAt || !r.expiresAt || r.expiresAt <= now) return false
    if (!!r.recursive !== !!recursive) return false
    if (recursive) return recursiveCovers(r.target, target)
    return sameTarget(r.target, target)
  })
  if (idx === -1) return false
  state.approvals.list[idx].consumedAt = now
  saveStateSync(state, home)
  return true
}

/**
 * Non-consuming check: is there a granted, unexpired, unconsumed approval that
 * would match this call? Used by the guard for WRITES, where the fs waterfall
 * is the real consumption point — so an approved write is checked here without
 * being consumed twice.
 *
 * 非消费检查：是否存在一个已批准、未过期、未消费且匹配本次调用的审批？守卫对
 * 「写」用它做只读判断——写的真正消费点在下游 fs 瀑布层，这里消费会造成二次消费。
 */
export function hasActiveApproval(home, { kind, target = null, recursive = false } = {}) {
  const state = loadState(home)
  const now = Date.now()
  return state.approvals.list.some((r) => {
    if (r.kind !== kind || r.consumedAt || r.revokedAt) return false
    if (!r.grantedAt || !r.expiresAt || r.expiresAt <= now) return false
    if (!!r.recursive !== !!recursive) return false
    if (recursive) return recursiveCovers(r.target, target)
    return sameTarget(r.target, target)
  })
}

/** List all approval requests (pending, granted, used, revoked). */
export function listApprovals(home = defaultHome()) {
  return loadState(home).approvals.list || []
}

/** List requests that are still actionable (pending or granted-but-unexpired). */
export function activeApprovals(home = defaultHome()) {
  const now = Date.now()
  return listApprovals(home).filter((r) => !r.consumedAt && !r.revokedAt && (!r.expiresAt || r.expiresAt > now))
}
