/**
 * dsh-safety core: pure, dependency-free logic (node builtins only).
 *
 * Everything here is unit-testable without a running DSH. The cordis glue in
 * `index.js` only wires these functions to `ctx.tools`, `ctx.on`, and
 * `ctx.webServer`.
 *
 * Policies (v1):
 *   - blockWriteRoots: no write/edit/delete by tools or fs service.
 *     (profile manifests, patch layers, lockfiles, node_modules, install dir)
 *   - blockDeleteRoots: no delete, but edits are allowed.
 *     (plugin sources under profiles/<name>/plugins, agent presets)
 *   - everything else is free; deletion there is still best done via
 *     `safe_delete` (trash + journal + undo).
 */

import {
  promises as fsp,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import path from 'node:path'

export const PLUGIN_ID = 'dsh-safety'
export const STATE_DIR = '.dsh-safety'

/** Windows drive-letter case-insensitive compare; POSIX exact compare. */
export function keyOf(p) {
  const abs = path.resolve(String(p))
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** Whether `child` is `root` itself or lives under it. */
export function isUnder(child, root) {
  const c = keyOf(child)
  const r = keyOf(root)
  if (c === r) return true
  const prefix = r.endsWith(path.sep) ? r : r + path.sep
  return c.startsWith(prefix)
}

/**
 * Effective policy label for one absolute path.
 *   'protected' — no write/edit/delete (config/deps/install dirs)
 *   'confirm'   — no delete without force/confirmation; edits allowed
 *   'free'      — normal working files (directory deletes still via safe_delete)
 */
export function classify(abs, policy) {
  const roots = policy || {}
  const writeRoots = roots.blockWriteRoots || []
  const confirmRoots = roots.confirmDeleteRoots || roots.blockDeleteRoots || []
  if (writeRoots.some((r) => isUnder(abs, r))) return 'protected'
  if (confirmRoots.some((r) => isUnder(abs, r))) return 'confirm'
  return 'free'
}

/** Whether an absolute path is a filesystem root (e.g. `C:\` or `/`). */
export function isDriveRoot(abs) {
  const p = path.parse(abs)
  return p.root === abs && abs.length > 1
}

/* ── destructive shell-command detection ──────────────────────────────────── */

const DESTRUCTIVE_VERBS = [
  // PowerShell
  /Remove-Item\b/i,
  /(?:^|[;\s|&])del\b/i,
  /(?:^|[;\s|&])erase\b/i,
  /(?:^|[;\s|&])rd\b/i,
  /(?:^|[;\s|&])rmdir\b/i,
  /\[System\.IO\.File\]::Delete\s*\(/i,
  /\[System\.IO\.Directory\]::Delete\s*\(/i,
  // POSIX
  /\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*r/i, // rm -r / -rf / -fr
  /\brm\s+[^\s|;&]+/i,
  /(?:^|[;\s|&])rm\b/i,
  /\bunlink\b/i,
  // node / python one-liners
  /\bfs\.(?:rm|unlink)(?:Sync)?\s*\(/i,
  /\b(?:os|pathlib)\.(?:remove|unlink)\s*\(/i,
  /\bshutil\.rmtree\s*\(/i,
  // git
  /\bgit\s+clean\s+-(?:[a-zA-Z]*f[a-zA-Z]*)/i,
  // npm/pnpm destructive prune
  /\b(?:npm|pnpm)\s+prune\b/i,
  /\b(?:npm|pnpm)\s+rm\b/i,
  /\b(?:pnpm|npm)\s+remove\b/i,
]

/** Strong signal that the command deletes/removes something. */
export function hasDestructiveVerb(command) {
  return DESTRUCTIVE_VERBS.some((re) => re.test(String(command || '')))
}

/**
 * Extract candidate file paths from a shell command. Conservative: absolute
 * paths, `-Path`/`-LiteralPath`/`--path` targets, and `~`-prefixed paths.
 */
export function extractShellPaths(command, home) {
  const text = String(command || '')
  const withTilde = text.replace(/(^|[\s"'`=(])~(?=[\\/])/g, `$1${home || ''}`)
  const out = []
  const abs = /(?:^|[\s"'`=(])([A-Za-z]:\\[^\s"'`|;&<>()]+|(?:\/|\.{1,2}\/)[^\s"'`|;&<>()]+)/g
  let m
  while ((m = abs.exec(withTilde)) !== null) {
    let p = m[1]
    p = p.replace(/^["'`=(]+/, '').replace(/["'`,;)]+$/, '')
    if (p.length > 1) out.push(p)
  }
  // `-Path 'C:\x'` / `--path` / `Remove-Item C:\x -Recurse`
  const flag = /(?:-Path|-LiteralPath|--path)\s+["']?([^\s"'|;&<>()]+)/gi
  while ((m = flag.exec(withTilde)) !== null) {
    const p = m[1].replace(/["']+$/g, '')
    if (p.length > 1) out.push(p)
  }
  return out
}

const DISTINCTIVE_BASENAMES = new Set([
  'node_modules',
  '.agent-presets',
  '.dsh',
  'cordis.patch.yml',
  'cordis.yml',
  'settings.yaml',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package.json',
])

/**
 * Distinctive, case-folded markers for a policy's protected roots, used to
 * catch shell deletes that reference protected paths in relative or `~` form.
 */
export function markersFor(policy) {
  const out = new Set()
  const roots = [
    ...(policy?.blockWriteRoots || []),
    ...(policy?.confirmDeleteRoots || policy?.blockDeleteRoots || []),
  ]
  for (const root of roots) {
    const k = keyOf(root)
    out.add(k)
    const base = path.basename(root)
    if (DISTINCTIVE_BASENAMES.has(base)) out.add(base.toLowerCase())
    // path fragments like `\.dsh\profiles` (without drive) are distinctive
    const frag = k.replace(/^[a-z]:/, '')
    if (frag.length > 2 && (frag.includes('node_modules') || frag.includes('.agent-presets') || frag.includes('.dsh'))) {
      out.add(frag)
    }
  }
  out.add('.dsh')
  out.add('node_modules')
  out.add('cordis.patch.yml')
  return [...out]
}

/**
 * Whether a shell delete command is RECURSIVE (targets a whole directory tree).
 * Recursive deletes are the highest-risk operation (the incident that started
 * this plugin deleted an entire directory with `Remove-Item -Recurse -Force`),
 * so the guard denies them everywhere and routes them to `safe_delete`.
 */
export function isRecursiveDelete(name, args) {
  const a = args || {}
  if (name === 'pwsh') {
    const c = String(a.command || '')
    if (/-Recurse\b/i.test(c)) return true
    if (/(?:^|[\s;|&])(-r)(?=\s|$)/i.test(c)) return true
    if (/\b(?:rd|rmdir)\b[^\r\n]*?\s+\/\w*[sS]\w*/i.test(c)) return true // rd /s
    return false
  }
  if (name === 'bash') {
    const c = String(a.command || '')
    if (/\brm\b[^\r\n]*?\s+-\w*[rR]\w*/i.test(c)) return true // rm -r/-rf/-fr
    if (/\brmdir\b[^\r\n]*?\s+-\w*[rR]\w*/i.test(c)) return true
    if (/shutil\.rmtree\s*\(/i.test(c)) return true // always recursive
    if (/\bfs\.(?:rm|rmdir)(?:Sync)?\s*\([^)]*recursive\s*:\s*true/i.test(c)) return true
    return false
  }
  return false
}

/**
 * Decide whether a tool call is destructive against a protected root.
 * Used by the tools.guard. Returns a decision:
 *   { action: 'deny', reason, kind, abs?, cls?, recursive? } — block the call
 *   { action: 'allow' } — let it through
 */
export function destructiveTargetForCall(name, args, policy) {
  const a = args || {}
  const writeNames = new Set(['write', 'edit', 'str_replace_editor'])
  if (writeNames.has(name)) {
    const p = a.file_path
    if (typeof p === 'string' && p.length > 0) {
      const abs = path.resolve(p)
      const cls = classify(abs, policy)
      if (cls === 'protected') {
        return { action: 'deny', kind: 'write', abs, cls, reason: `write/edit on protected path "${abs}"` }
      }
    }
    return { action: 'allow' }
  }
  if (name === 'pwsh' || name === 'bash') {
    const command = a.command
    if (typeof command !== 'string' || !hasDestructiveVerb(command)) return { action: 'allow' }
    const recursive = isRecursiveDelete(name, a)
    // 1) explicit absolute paths in the command
    for (const p of extractShellPaths(command, policy?.home)) {
      const abs = path.resolve(p)
      const cls = classify(abs, policy)
      if (cls === 'protected') {
        return { action: 'deny', kind: 'delete', abs, cls, recursive, reason: `delete on protected path "${abs}"` }
      }
      if (cls === 'confirm') {
        return { action: 'deny', kind: 'delete', abs, cls, recursive, reason: `delete on confirm path "${abs}" — use safe_delete (trash, undoable)` }
      }
    }
    // 2) marker hits (relative / `~` forms)
    const lower = command.toLowerCase()
    for (const marker of markersFor(policy)) {
      if (lower.includes(marker)) {
        return { action: 'deny', kind: 'delete', abs: null, cls: 'marker', recursive, reason: `delete matching protected marker "${marker}"` }
      }
    }
    // 3) recursive delete ANYWHERE (even free paths): too dangerous to guess
    if (recursive) {
      return { action: 'deny', kind: 'delete', abs: null, cls: 'recursive', recursive: true, reason: 'recursive directory delete — use safe_delete (moves to trash, undoable)' }
    }
    return { action: 'allow' }
  }
  return { action: 'allow' }
}

/* ── encoding / syntax validation (the "why it won't boot" checks) ───────── */

/** Strict UTF-8 validity (fatal decoder). */
export function utf8Valid(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

const MOJIBAKE_MARKERS = [
  '\uFFFD',
  '鈥', '锟', '锘', '鎬', '鍒', '鐨', '涓', '閲', '璇', '杩', '鏄', '绉', '彁',
  'â€', 'Ã©', 'Ã¨', 'Ã¥', 'Ã§', 'Ã¼', 'Â\xa0', 'Â·',
  '鈹€', '鈹?', '鈥?', '锛', '锟?',
]
const MOJIBAKE_ASCII_NOISE = /[\u0080-\u009f]{4,}/ // C1 control run (mojibake hallmark)

/** Heuristic: text shows strong signs of a wrong-encoding round-trip. */
export function looksLikeMojibake(text) {
  const s = String(text || '')
  let hits = 0
  for (const marker of MOJIBAKE_MARKERS) {
    let idx = 0
    while ((idx = s.indexOf(marker, idx)) !== -1) {
      hits++
      idx += marker.length
      if (hits >= 4) return true
    }
  }
  if (MOJIBAKE_ASCII_NOISE.test(s)) return true
  // GBK bytes decoded as UTF-8 often collapse into long sequences of '锟'/'鈥'
  return /(?:锟|鈥|鈹|鈹){3,}/.test(s)
}

/** Parse JSON text, returning a normalized result. */
export function checkJson(text, label) {
  try {
    JSON.parse(text)
    return { ok: true, label }
  } catch (e) {
    return { ok: false, label, reason: `JSON parse error: ${e && e.message ? e.message : String(e)}` }
  }
}

/** Collect `- id:` / `id:` rows from a cordis patch YAML (subset scanner). */
export function scanPatchIds(text) {
  const ids = []
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^\s*(?:-\s+)?id\s*:\s*["']?([^"'\s#]+)["']?\s*$/.exec(line)
    if (m) ids.push({ id: m[1], line: i + 1 })
  }
  return ids
}

/** Duplicate row ids across all patch layers — the "one row, one layer" bug. */
export function findDuplicateIds(patchTexts) {
  const seen = new Map() // id -> [{file, line}]
  for (const { file, text } of patchTexts) {
    for (const { id, line } of scanPatchIds(text)) {
      if (!seen.has(id)) seen.set(id, [])
      seen.get(id).push({ file, line })
    }
  }
  const duplicates = []
  for (const [id, locs] of seen) {
    if (locs.length > 1) duplicates.push({ id, locs })
  }
  return duplicates
}

/* ── state helpers (journal / trash / snapshots) ─────────────────────────── */

function stateDirs(home) {
  const base = path.join(home, STATE_DIR)
  return {
    base,
    journal: path.join(base, 'journal.jsonl'),
    trash: path.join(base, 'trash'),
    snapshots: path.join(base, 'snapshots'),
    restored: path.join(base, 'restored-from'),
  }
}

export async function ensureStateDirs(home) {
  const d = stateDirs(home)
  await fsp.mkdir(d.trash, { recursive: true })
  await fsp.mkdir(d.snapshots, { recursive: true })
  await fsp.mkdir(d.restored, { recursive: true })
  return d
}

export function journalPath(home) {
  return stateDirs(home).journal
}

export async function journalAppend(home, entry) {
  const file = journalPath(home)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
  await fsp.appendFile(file, line, 'utf8')
}

export async function journalTail(home, n = 20) {
  const file = journalPath(home)
  if (!existsSync(file)) return []
  const text = await fsp.readFile(file, 'utf8')
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  return lines
    .slice(-Math.max(1, Number(n) || 20))
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { raw: l }
      }
    })
}

export function nowStamp() {
  const d = new Date()
  const pad = (x) => String(x).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/** Move a file/dir into trash; returns the trash id. Never throws on missing. */
export async function trashMove(home, abs, policy, meta) {
  const dirs = await ensureStateDirs(home)
  const id = `${nowStamp()}-${Math.random().toString(36).slice(2, 8)}`
  const dest = path.join(dirs.trash, id)
  await fsp.rename(abs, dest).catch(async () => {
    // cross-volume or open handles: copy then remove
    await fsp.cp(abs, dest, { recursive: true, force: true })
    await fsp.rm(abs, { recursive: true, force: true })
  })
  await journalAppend(home, {
    kind: 'trash',
    id,
    op: meta?.op || 'safe_delete',
    original: abs,
    trash: dest,
    by: meta?.by || 'unknown',
    reason: meta?.reason,
  })
  return { id, original: abs, trash: dest }
}

export async function trashList(home) {
  const dirs = await ensureStateDirs(home)
  const entries = []
  if (!existsSync(dirs.trash)) return entries
  for (const name of readdirSync(dirs.trash)) {
    const full = path.join(dirs.trash, name)
    try {
      const st = statSync(full)
      entries.push({ id: name, path: full, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs })
    } catch {
      /* ignore */
    }
  }
  return entries.sort((a, b) => b.mtime - a.mtime)
}

export async function trashRestore(home, id) {
  const dirs = await ensureStateDirs(home)
  const src = path.join(dirs.trash, String(id))
  if (!existsSync(src)) return { ok: false, error: 'not-found' }
  // find original from journal
  const tail = await journalTail(home, 5000)
  const entry = [...tail].reverse().find((e) => e.kind === 'trash' && e.id === id)
  let dest = entry?.original
  if (!dest || existsSync(dest)) {
    const base = entry?.original || `restored-${id}`
    dest = path.join(path.dirname(base), `${path.basename(base)}.restored-${nowStamp()}`)
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.rename(src, dest).catch(async () => {
    await fsp.cp(src, dest, { recursive: true, force: true })
    await fsp.rm(src, { recursive: true, force: true })
  })
  await journalAppend(home, { kind: 'restore', id, dest, at: new Date().toISOString() })
  return { ok: true, dest }
}

/* ── snapshots of the composition (last-known-good) ───────────────────────── */

/**
 * Enumerate the critical composition files to snapshot:
 * profile manifests/patches/lockfiles, home patch/settings, every plugin
 * package.json + cordis.patch.yml, and agent-preset compositions.
 */
export function snapshotManifest(home) {
  const files = []
  const profilesDir = path.join(home, 'profiles')
  if (existsSync(profilesDir)) {
    for (const profile of readdirSync(profilesDir)) {
      const dir = path.join(profilesDir, profile)
      let st
      try {
        st = statSync(dir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
        const f = path.join(dir, name)
        if (existsSync(f)) files.push(f)
      }
      // plugins tree
      const pluginsDir = path.join(dir, 'plugins')
      if (existsSync(pluginsDir)) {
        const walk = (cur) => {
          for (const entry of readdirSync(cur, { withFileTypes: true })) {
            const full = path.join(cur, entry.name)
            if (entry.isDirectory()) {
              if (entry.name === 'node_modules' || entry.name === '.git') continue
              walk(full)
            } else if (entry.name === 'package.json' || entry.name === 'cordis.patch.yml') {
              files.push(full)
            }
          }
        }
        walk(pluginsDir)
      }
    }
  }
  for (const name of ['cordis.patch.yml', 'settings.yaml']) {
    const f = path.join(home, name)
    if (existsSync(f)) files.push(f)
  }
  const presets = path.join(home, '.agent-presets')
  if (existsSync(presets)) {
    for (const preset of readdirSync(presets)) {
      const dir = path.join(presets, preset)
      let st
      try {
        st = statSync(dir)
      } catch {
        continue
      }
      if (!st.isDirectory()) continue
      for (const name of ['agent.cordis.yml', 'preset.yml']) {
        const f = path.join(dir, name)
        if (existsSync(f)) files.push(f)
      }
    }
  }
  return [...new Set(files)]
}

export async function createSnapshot(home, label) {
  const dirs = await ensureStateDirs(home)
  const id = `${nowStamp()}-${(label || 'manual').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40)}`
  const dest = path.join(dirs.snapshots, id)
  const files = snapshotManifest(home)
  const entries = []
  for (const f of files) {
    const rel = path.relative(home, f)
    const target = path.join(dest, rel)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.copyFile(f, target)
    entries.push({ rel, sha256: await sha256File(f) })
  }
  const manifest = { id, at: new Date().toISOString(), label: label || 'manual', files: entries }
  await fsp.writeFile(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await journalAppend(home, { kind: 'snapshot', id, files: entries.length })
  return manifest
}

export async function snapshotList(home) {
  const dirs = await ensureStateDirs(home)
  const out = []
  if (!existsSync(dirs.snapshots)) return out
  for (const name of readdirSync(dirs.snapshots)) {
    const dir = path.join(dirs.snapshots, name)
    let st
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const mf = path.join(dir, 'manifest.json')
    if (!existsSync(mf)) continue
    try {
      const manifest = JSON.parse(readFileSync(mf, 'utf8'))
      out.push({ id: manifest.id, at: manifest.at, label: manifest.label, files: (manifest.files || []).length })
    } catch {
      out.push({ id: name, at: null, label: '(unreadable manifest)', files: 0 })
    }
  }
  return out.sort((a, b) => String(b.id).localeCompare(String(a.id)))
}

export async function restoreSnapshot(home, id) {
  const dirs = await ensureStateDirs(home)
  const dir = path.join(dirs.snapshots, String(id))
  const mf = path.join(dir, 'manifest.json')
  if (!existsSync(mf)) return { ok: false, error: 'not-found' }
  const manifest = JSON.parse(readFileSync(mf, 'utf8'))
  const moved = []
  for (const entry of manifest.files || []) {
    const dest = path.join(home, entry.rel)
    const src = path.join(dir, entry.rel)
    if (!existsSync(src)) continue
    if (existsSync(dest)) {
      const backup = path.join(dirs.restored, `${nowStamp()}-${path.basename(dest)}`)
      await fsp.mkdir(path.dirname(backup), { recursive: true })
      await fsp.rename(dest, backup).catch(() => {})
      moved.push({ rel: entry.rel, backup })
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(src, dest)
  }
  await journalAppend(home, { kind: 'restore-snapshot', id, moved: moved.length })
  return { ok: true, restored: manifest.files.length, moved: moved.length }
}

/** Prune old snapshots / trash beyond configured keep counts. */
export async function prune(home, keepTrash = 200, keepSnapshots = 10) {
  const dirs = await ensureStateDirs(home)
  let removedTrash = 0
  if (existsSync(dirs.trash)) {
    const entries = (await trashList(home)).slice(Number(keepTrash) || 200)
    for (const e of entries) {
      await fsp.rm(e.path, { recursive: true, force: true }).catch(() => {})
      removedTrash++
    }
  }
  let removedSnapshots = 0
  if (existsSync(dirs.snapshots)) {
    const snaps = (await snapshotList(home)).slice(Number(keepSnapshots) || 10)
    for (const s of snaps) {
      await fsp.rm(path.join(dirs.snapshots, s.id), { recursive: true, force: true }).catch(() => {})
      removedSnapshots++
    }
  }
  if (removedTrash + removedSnapshots > 0) {
    await journalAppend(home, { kind: 'prune', removedTrash, removedSnapshots })
  }
  return { removedTrash, removedSnapshots }
}

async function sha256File(file) {
  const { createHash } = await import('node:crypto')
  const buf = await fsp.readFile(file)
  return createHash('sha256').update(buf).digest('hex')
}

/* ── composition validation (pre-restart boot gate) ───────────────────────── */

/**
 * Validate the current composition files. Returns a report:
 * { files: [...], duplicates: [...], pass: boolean }
 */
export function validateComposition(home) {
  const report = { files: [], duplicates: [], pass: true }
  const patchTexts = []
  for (const f of snapshotManifest(home)) {
    if (!existsSync(f)) continue
    const rel = path.relative(home, f)
    const checks = []
    let buf
    try {
      buf = readFileSync(f)
    } catch (e) {
      checks.push({ check: 'read', ok: false, reason: String(e && e.message ? e.message : e) })
      report.pass = false
      report.files.push({ rel, checks, ok: false })
      continue
    }
    if (!utf8Valid(buf)) {
      checks.push({ check: 'utf8', ok: false, reason: 'not valid UTF-8' })
      report.pass = false
    } else {
      checks.push({ check: 'utf8', ok: true })
      const text = buf.toString('utf8')
      if (looksLikeMojibake(text)) {
        checks.push({ check: 'encoding', ok: false, reason: 'mojibake detected (wrong-encoding round-trip)' })
        report.pass = false
      } else {
        checks.push({ check: 'encoding', ok: true })
      }
      const base = path.basename(f)
      if (base === 'package.json') {
        const r = checkJson(text, rel)
        if (!r.ok) {
          checks.push({ check: 'json', ok: false, reason: r.reason })
          report.pass = false
        } else checks.push({ check: 'json', ok: true })
      } else if (base === 'cordis.patch.yml' || base === 'agent.cordis.yml' || base === 'preset.yml') {
        const ids = scanPatchIds(text)
        checks.push({ check: 'yaml-ids', ok: true, detail: `${ids.length} row id(s) scanned` })
        if (base === 'cordis.patch.yml') patchTexts.push({ file: rel, text })
      }
    }
    const ok = checks.every((c) => c.ok)
    if (!ok) report.pass = false
    report.files.push({ rel, checks, ok })
  }
  report.duplicates = findDuplicateIds(patchTexts)
  if (report.duplicates.length > 0) report.pass = false
  return report
}

export default {
  PLUGIN_ID,
  keyOf,
  isUnder,
  classify,
  isDriveRoot,
  hasDestructiveVerb,
  extractShellPaths,
  isRecursiveDelete,
  destructiveTargetForCall,
  utf8Valid,
  looksLikeMojibake,
  checkJson,
  scanPatchIds,
  findDuplicateIds,
  ensureStateDirs,
  journalPath,
  journalAppend,
  journalTail,
  nowStamp,
  trashMove,
  trashList,
  trashRestore,
  snapshotManifest,
  createSnapshot,
  snapshotList,
  restoreSnapshot,
  prune,
  validateComposition,
}
