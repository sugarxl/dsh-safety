/**
 * dsh-safety core: pure, dependency-free logic (node builtins only).
 *
 * dsh-safety 核心：纯逻辑、零第三方依赖（仅 Node 内置）。
 *
 * Everything here is unit-testable without a running DSH. The cordis glue in
 * `index.js` only wires these functions to `ctx.tools` and `ctx.on`.
 *
 * 这里的所有函数都可在无 DSH 环境下单元测试；`index.js` 只负责把这些函数
 * 接到 `ctx.tools`、`ctx.on` 上。
 *
 * Policy (v2, three tiers):
 *   策略（v2，三级）：
 *   - blockWriteRoots: no write/edit/delete by tools or fs service.
 *     （禁写/改/删：profile manifest、补丁、lockfile、node_modules、安装目录）
 *   - confirmDeleteRoots: no delete without safe_delete force (trash-only);
 *     edits allowed. Defaults to the whole OS home dir.
 *     （禁删：未经 safe_delete force 不得删除，且删除只进回收站；允许编辑；
 *       默认覆盖整个 OS 用户主目录）
 *   - everything else is free; recursive deletes are still blocked everywhere.
 *     （其余为 free；递归删除在任何路径仍被无条件拦截）
 */

import {
  promises as fsp,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
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
  // `p.root === abs` alone covers both `C:\` and POSIX `/` (which has length 1
  // and previously slipped through the `abs.length > 1` guard).
  return p.root === abs
}

const CLASS_ORDER = { protected: 0, confirm: 1, free: 2 }

/**
 * Classify a path, also following symlinks: a link that resolves into a
 * protected zone must not be usable to bypass the guard (defense in depth).
 * The literal path is checked first, then its realpath, and the most
 * restrictive class wins.
 */
export function classifyWithReal(abs, policy) {
  let cls = classify(abs, policy)
  try {
    const real = realpathSync(abs)
    if (real !== abs) {
      const realCls = classify(real, policy)
      if (CLASS_ORDER[realCls] < CLASS_ORDER[cls]) cls = realCls
    }
  } catch {
    /* path may not exist yet — classify on the literal path */
  }
  return cls
}

/**
 * Build the three-tier policy for a DSH home.
 *
 * 为 DSH home 构建三级策略。
 *
 *   blockWriteRoots    — no write/edit/delete (config/deps/install dirs)
 *                        （禁写/改/删：配置、依赖、安装目录）
 *   confirmDeleteRoots — no delete without safe_delete force:true (trash-only,
 *                        never permanent); edits allowed. Defaults to the whole
 *                        OS home dir, so a stray `Remove-Item -Recurse` under
 *                        $HOME (the incident that started this plugin) is
 *                        blocked and routed to safe_delete.
 *                        （禁删：未经 safe_delete force 不得删除，删除只进回收站；
 *                          允许编辑；默认覆盖整个 OS 用户主目录——$HOME 下的一次
 *                          递归删除（本插件的起因事故）会被拦截并转走 safe_delete）
 *
 * Shared by the plugin (`index.js`) and the standalone CLI (`bin/…`) so the
 * two surfaces can never drift apart.
 * 插件（index.js）与独立 CLI（bin/…）共用同一份策略，两套表面永不漂移。
 */
export function buildPolicy(home, config = {}) {
  const blockWrite = new Set()
  const confirmDelete = new Set()
  const add = (set, p) => {
    if (p) set.add(path.resolve(String(p)))
  }

  // Deployment install dir (upgrades overwrite it; never touch).
  const candidates = [
    // Windows: npm global root under %APPDATA%
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    // POSIX: common npm/global install roots (added only when they exist).
    '/usr/lib/node_modules/@deepseek-ai/dsh',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh',
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
    path.join(os.homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  ]
  for (const c of candidates) if (c && existsSync(c)) add(blockWrite, c)

  // Home-level config.
  add(blockWrite, path.join(home, 'cordis.patch.yml'))
  add(blockWrite, path.join(home, 'settings.yaml'))

  // Per-profile crash-critical files + node_modules.
  const profilesDir = path.join(home, 'profiles')
  let profileNames = []
  try {
    profileNames = readdirSync(profilesDir).filter((n) => {
      try {
        return statSync(path.join(profilesDir, n)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    /* no profiles dir yet */
  }
  for (const profile of profileNames) {
    const dir = path.join(profilesDir, profile)
    for (const f of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
      add(blockWrite, path.join(dir, f))
    }
    add(blockWrite, path.join(dir, 'node_modules'))
  }
  add(blockWrite, path.join(profilesDir, 'node_modules'))

  // Confirm-delete zones: whole OS home (unless opted out — `homeIsConfirm:
  // false` is for harnesses whose temp home lives under $HOME), the DSH
  // profiles root (incl. plugin sources, which stay editable), and presets.
  if (config.homeIsConfirm !== false) add(confirmDelete, os.homedir())
  add(confirmDelete, profilesDir)
  add(confirmDelete, path.join(home, '.agent-presets'))

  // User extras (legacy `blockDeleteRoots` still accepted).
  for (const p of config.blockWriteRoots || []) add(blockWrite, p)
  for (const p of config.confirmDeleteRoots || config.blockDeleteRoots || []) add(confirmDelete, p)

  return { home, blockWriteRoots: [...blockWrite], confirmDeleteRoots: [...confirmDelete] }
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
  /\.(?:rm|rmdir|unlink)(?:Sync)?\s*\(/i, // require('fs').rmSync / ).rm( / fs.rm(
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
  // Function replacement (not a `$`-substitution string): a home path containing
  // `$` (e.g. a Windows username like `my$user`) must never be interpreted as a
  // replacement pattern like `$&`/`$1`.
  const withTilde = text.replace(/(^|[\s"'`=(])~(?=[\\/])/g, (m, pre) => pre + (home || ''))
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
    if (/\brm\b[^\r\n]*?\s+(?:-\w*\s+)*--recursive\b/i.test(c)) return true // rm --recursive
    if (/\brmdir\b[^\r\n]*?\s+-\w*[rR]\w*/i.test(c)) return true
    if (/shutil\.rmtree\s*\(/i.test(c)) return true // always recursive
    if (/\b(?:rm|rmdir)(?:Sync)?\s*\([^)]*recursive\s*:\s*true/i.test(c)) return true // rmSync(...,{recursive:true}) — bare import form too
    return false
  }
  return false
}

/**
 * Decide whether a tool call is destructive against a protected root.
 * Used by the tools.guard. Returns a decision:
 *   { action: 'deny', reason, kind, abs?, cls?, recursive? } — block the call
 *   { action: 'allow' } — let it through
 *
 * 判定一次工具调用是否对受保护路径构成破坏性操作（供 tools.guard 使用）。
 * 返回决策对象：deny=拦截（附原因/目标/级别/是否递归），allow=放行。
 */
export function destructiveTargetForCall(name, args, policy) {
  const a = args || {}
  // `write`/`edit` always write; `str_replace_editor` is a write only for its
  // mutating commands (view is a read and must stay allowed).
  const WRITE_COMMANDS = new Set(['create', 'str_replace', 'insert'])
  const writeNames = new Set(['write', 'edit'])
  if (writeNames.has(name) || (name === 'str_replace_editor' && WRITE_COMMANDS.has(String(a.command)))) {
    // DSH write tools pass `file_path`; the editor tool passes `path`. Accept
    // both so the guard cannot be dodged by picking the other argument name.
    const p = a.file_path || a.path
    if (typeof p === 'string' && p.length > 0) {
      const abs = path.resolve(p)
      const cls = classifyWithReal(abs, policy)
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
      const cls = classifyWithReal(abs, policy)
      if (cls === 'protected') {
        return { action: 'deny', kind: 'delete', abs, cls, recursive, reason: `delete on protected path "${abs}"` }
      }
      if (cls === 'confirm') {
        return { action: 'deny', kind: 'delete', abs, cls, recursive, reason: `delete on confirm path "${abs}" — use safe_delete (trash, undoable)` }
      }
    }
    // 1b) variable/parameter references that expand into a protected zone
    //     (`$env:USERPROFILE\.dsh`, `%APPDATA%\npm`, `${HOME}/…`): the literal
    //     path is invisible to text checks, so match the reference + the
    //     following fragment against protected markers.
    const refFrag = extractVariableRefFragments(command)
    if (refFrag.length > 0) {
      for (const frag of refFrag) {
        if (markersFor(policy).some((m) => frag.toLowerCase().includes(m))) {
          return { action: 'deny', kind: 'delete', abs: null, cls: 'var-ref', recursive, reason: `delete with variable reference expanding into a protected zone ("${frag}") — use safe_delete` }
        }
      }
    }
    // 1c) variable references that RESOLVE (known vars) into a protected zone
    //     or into the DSH home itself — literal classification, not just marker
    //     substrings (catches custom DSH_HOME paths and the install dir).
    const phome = policy?.home
    for (const p of resolveVariableRefs(command, policy)) {
      const abs = path.resolve(p)
      const cls = classifyWithReal(abs, policy)
      if (cls === 'protected') {
        return { action: 'deny', kind: 'delete', abs, cls, recursive, reason: `delete with variable reference expanding into protected path "${abs}"` }
      }
      if (phome && isUnder(abs, phome)) {
        return { action: 'deny', kind: 'delete', abs, cls: 'var-ref', recursive, reason: `delete with variable reference expanding into the DSH home ("${p}") — use safe_delete` }
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
  if (name === 'run_code') {
    // Arbitrary code execution: the guard cannot see inside the program, so
    // scan the code body text for destructive filesystem calls that reference
    // protected zones, exactly like shell commands. Dynamic/obfuscated calls
    // can still slip through — document that (SECURITY.md); the sandbox is
    // the real boundary for run_code.
    const code = String(a.code || '')
    // Bare fs calls after `import { rmSync } from 'node:fs'` have NO `.` prefix
    // (`rmSync(path, {recursive:true})`), which the method-call regexes miss.
    const BARE_FS_DELETE = /\b(?:rmdir|unlink|rmSync|rmdirSync|unlinkSync)\s*\(/i
    const isDestructiveCode = code.length > 0 && (hasDestructiveVerb(code) || BARE_FS_DELETE.test(code))
    if (!isDestructiveCode) return { action: 'allow' }
    const recursive = isRecursiveDelete('bash', { command: code }) || /\b(?:rm|rmdir)(?:Sync)?\s*\([^)]*recursive\s*:\s*true/i.test(code)
    // Explicit absolute paths in the code body get the SAME classification as
    // shell commands: a non-recursive delete on a protected/confirm path is
    // denied and routed to safe_delete, not silently allowed.
    for (const p of extractShellPaths(code, policy?.home)) {
      const abs = path.resolve(p)
      const cls = classifyWithReal(abs, policy)
      if (cls === 'protected') {
        return { action: 'deny', kind: 'delete', abs, cls, recursive, reason: `run_code delete on protected path "${abs}"` }
      }
      if (cls === 'confirm') {
        return { action: 'deny', kind: 'delete', abs, cls, recursive, reason: `run_code delete on confirm path "${abs}" — use safe_delete (trash, undoable)` }
      }
    }
    const lower = code.toLowerCase()
    for (const marker of markersFor(policy)) {
      if (lower.includes(marker)) {
        return { action: 'deny', kind: 'delete', abs: null, cls: 'marker', recursive, reason: `run_code contains a delete targeting protected marker "${marker}"` }
      }
    }
    if (recursive) {
      return { action: 'deny', kind: 'delete', abs: null, cls: 'recursive', recursive: true, reason: 'run_code contains a recursive delete — use safe_delete (moves to trash, undoable)' }
    }
    return { action: 'allow' }
  }
  return { action: 'allow' }
}

/**
 * Extract text fragments following environment-variable / parameter references
 * in a shell command, e.g. `$env:USERPROFILE\.dsh\x` → `\.dsh\x`,
 * `%APPDATA%\npm\...` → `\npm\...`, `${HOME}/.dsh/...` → `/.dsh/...`.
 * Used to catch deletes whose target path only exists after variable expansion.
 */
export function extractVariableRefFragments(command) {
  const text = String(command || '')
  const out = []
  // $env:NAME\rest / $NAME\rest / ${NAME}\rest — capture the tail fragment too
  const envRef = /\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*((?:\\|\/)[^\s"'`|;&<>()]*)?|\$\{[A-Za-z_][A-Za-z0-9_]*\}((?:\\|\/)[^\s"'`|;&<>()]*)?/gi
  let m
  while ((m = envRef.exec(text)) !== null) {
    if (m[0].length > 1) out.push(m[0])
  }
  // %NAME%\rest (cmd.exe style)
  const pctRef = /%[A-Za-z_][A-Za-z0-9_]*%((?:\\|\/)[^\s"'`|;&<>()]*)?/gi
  while ((m = pctRef.exec(text)) !== null) {
    if (m[0].length > 1) out.push(m[0])
  }
  return out
}

/**
 * Resolve fragments that start with a KNOWN environment variable to their
 * literal values (HOME / USERPROFILE / DSH_HOME / APPDATA / TEMP / TMP).
 *
 * The marker check alone misses deletes whose target only becomes a protected
 * or DSH-home path after expansion — e.g. `$env:DSH_HOME\profiles\...` when
 * DSH_HOME is a custom path that contains no protected marker substring, or
 * `$env:USERPROFILE\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` (the
 * install dir). Unknown variables are left unresolved (the marker check still
 * applies on top).
 *
 * 把以已知环境变量开头的片段解析为字面路径（HOME/USERPROFILE/DSH_HOME/
 * APPDATA/TEMP/TMP）。仅靠标记匹配会漏掉展开后才落入 protected 或 DSH home
 * 的目标——例如自定义 DSH_HOME（不含任何保护标记子串）下的
 * `$env:DSH_HOME\profiles\...`，或安装目录 `%APPDATA%\npm\node_modules\...`。
 * 未知变量保持未解析（标记检查仍然生效）。
 */
export function resolveVariableRefs(command, policy = {}) {
  const home = policy.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const known = {
    HOME: os.homedir(),
    USERPROFILE: os.homedir(),
    DSH_HOME: home,
    APPDATA: process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : ''),
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
  }
  const out = []
  const push = (name, tail) => {
    const base = known[name]
    if (!base) return
    out.push(tail ? path.join(base, String(tail).replace(/^[\\/]+/, '')) : base)
  }
  // $env:NAME\tail / $NAME\tail / ${NAME}\tail
  const envRef = /\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)((?:\\|\/)[^\s"'`|;&<>()]*)?|\$\{([A-Za-z_][A-Za-z0-9_]*)\}((?:\\|\/)[^\s"'`|;&<>()]*)?/g
  let m
  while ((m = envRef.exec(String(command || ''))) !== null) {
    if (m[1]) push(m[1].toUpperCase(), m[2])
    if (m[3]) push(m[3].toUpperCase(), m[4])
  }
  // %NAME%\tail (cmd.exe style)
  const pctRef = /%([A-Za-z_][A-Za-z0-9_]*)%((?:\\|\/)[^\s"'`|;&<>()]*)?/g
  while ((m = pctRef.exec(String(command || ''))) !== null) {
    if (m[1]) push(m[1].toUpperCase(), m[2])
  }
  return out
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

/**
 * Validate an externally-supplied id (trash / snapshot / approval) before it is
 * joined into a state-dir path. Trash and snapshot ids are generated internally
 * as `yyyyMMdd-HHmmss-<label>-<rand6>`, so anything containing a path separator
 * or `..` is rejected outright — this closes the `../../x` path-traversal hole
 * in `trashRestore` / `restoreSnapshot`.
 *
 * 校验外部传入的 id（回收站/快照/审批）后再拼进状态目录路径。内部生成的
 * id 形如 `yyyyMMdd-HHmmss-<label>-<rand6>`，含路径分隔符或 `..` 一律拒绝——
 * 封堵 trashRestore / restoreSnapshot 里的 `../../x` 路径穿越洞。
 */
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/
export function validId(id) {
  const s = String(id || '')
  return s.length > 0 && s.length <= 128 && !s.includes('..') && SAFE_ID_RE.test(s)
}

/** Move a file/dir into trash; returns the trash id. Never throws on missing. */
/** 把文件/目录移入回收站并返回回收站 id；目标缺失时不抛错。 */
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
  if (!validId(id)) return { ok: false, error: 'invalid-id' }
  const src = path.join(dirs.trash, String(id))
  if (!existsSync(src)) return { ok: false, error: 'not-found' }
  // find original from journal (scan the WHOLE log — the deletion may be old)
  const tail = await journalTail(home, Number.MAX_SAFE_INTEGER)
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
 *
 * `exclude` filters by relative path or basename (case-insensitive); used to
 * keep credential-bearing files (e.g. `settings.yaml`, `.credentials.yaml`)
 * out of snapshots by default. `validateComposition` deliberately does NOT
 * pass an exclude list — it still scans everything for boot-critical issues.
 */
export function snapshotManifest(home, exclude = []) {
  const files = []
  const excluded = exclude.map((e) => String(e).toLowerCase())
  const isExcluded = (f) => {
    if (excluded.length === 0) return false
    const rel = path.relative(home, f).toLowerCase()
    const base = path.basename(f).toLowerCase()
    return excluded.some((e) => rel === e || base === e || rel.endsWith(`/${e}`) || rel.endsWith(`\\${e}`))
  }
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
        if (existsSync(f) && !isExcluded(f)) files.push(f)
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
              if (!isExcluded(full)) files.push(full)
            }
          }
        }
        walk(pluginsDir)
      }
    }
  }
  for (const name of ['cordis.patch.yml', 'settings.yaml']) {
    const f = path.join(home, name)
    if (existsSync(f) && !isExcluded(f)) files.push(f)
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
        if (existsSync(f) && !isExcluded(f)) files.push(f)
      }
    }
  }
  return [...new Set(files)]
}

export async function createSnapshot(home, label, exclude = []) {
  const dirs = await ensureStateDirs(home)
  // Random suffix: two snapshots in the same second with the same label must
  // never produce the same directory id (which would silently overwrite the
  // earlier one).
  const id = `${nowStamp()}-${(label || 'manual').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`
  const dest = path.join(dirs.snapshots, id)
  try {
    const files = snapshotManifest(home, exclude)
    const entries = []
    // Create the snapshot dir up front: with zero composition files there are
    // no per-file mkdirs, and the manifest write would otherwise ENOENT.
    await fsp.mkdir(dest, { recursive: true })
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
  } catch (e) {
    // never leave a half-written snapshot behind
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {})
    throw e
  }
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
  return out.sort((a, b) => String(b.at || b.id).localeCompare(String(a.at || a.id)))
}

/**
 * Restore a snapshot with two-phase + rollback semantics.
 *
 * 两阶段 + 回滚语义的快照恢复。
 *
 * First move every live file to the restored-from backup (phase A), then copy
 * snapshot files back (phase B). If either phase fails mid-way, already-moved
 * or restored files are undone so a failed rollback never leaves the
 * composition half-restored.
 *
 * 第一阶段把现行文件全部移入 restored-from 备份，第二阶段把快照文件复制回
 * 原位；任一阶段中途失败都会撤销已执行的部分，保证失败的恢复永远不会把
 * 组合留成半恢复状态。
 */
export async function restoreSnapshot(home, id) {
  const dirs = await ensureStateDirs(home)
  if (!validId(id)) return { ok: false, error: 'invalid-id' }
  const dir = path.join(dirs.snapshots, String(id))
  const mf = path.join(dir, 'manifest.json')
  if (!existsSync(mf)) return { ok: false, error: 'not-found' }
  const manifest = JSON.parse(readFileSync(mf, 'utf8'))

  // Two-phase restore with rollback: first move every live file to the
  // restored-from backup (phase A), then copy snapshot files back (phase B).
  // If either phase fails mid-way, already-moved/restored files are undone so
  // a failed rollback never leaves the composition half-restored.
  const plan = []
  for (const entry of manifest.files || []) {
    const rel = String(entry?.rel ?? '')
    // Containment check: a tampered/corrupt manifest must never be able to
    // write or move files outside the DSH home (nor outside the snapshot dir).
    const dest = path.resolve(home, rel)
    const src = path.resolve(dir, rel)
    const relFromHome = path.relative(home, dest)
    const relFromSnap = path.relative(dir, src)
    if (
      path.isAbsolute(rel) ||
      relFromHome === '' ||
      relFromHome.startsWith('..') ||
      path.isAbsolute(relFromHome) ||
      relFromSnap.startsWith('..') ||
      path.isAbsolute(relFromSnap)
    ) {
      return { ok: false, error: `unsafe manifest entry "${rel}" — restore aborted, nothing was touched` }
    }
    if (!existsSync(src)) continue
    plan.push({ rel, dest, src })
  }

  const stamp = nowStamp()
  const moved = []
  // Phase A: back up current files. Backups keep the relative layout under a
  // timestamped subdir so files with the same basename never collide.
  for (const item of plan) {
    if (!existsSync(item.dest)) continue
    const backup = path.join(dirs.restored, stamp, item.rel)
    try {
      await fsp.mkdir(path.dirname(backup), { recursive: true })
      await fsp.rename(item.dest, backup)
      moved.push({ rel: item.rel, backup, dest: item.dest })
    } catch (e) {
      // roll back phase A
      for (const m of moved) {
        try { await fsp.rename(m.backup, m.dest) } catch { /* best effort */ }
      }
      return { ok: false, error: `backup failed for "${item.rel}": ${e && e.message ? e.message : String(e)} — nothing was restored` }
    }
  }
  // Phase B: copy snapshot files into place; on failure undo B and redo A.
  const applied = []
  try {
    for (const item of plan) {
      await fsp.mkdir(path.dirname(item.dest), { recursive: true })
      await fsp.copyFile(item.src, item.dest)
      applied.push(item)
    }
  } catch (e) {
    for (const item of applied) {
      try { await fsp.rm(item.dest, { force: true }) } catch { /* best effort */ }
    }
    for (const m of moved) {
      try { await fsp.rename(m.backup, m.dest) } catch { /* best effort */ }
    }
    return { ok: false, error: `restore failed for "${applied.at(-1)?.rel ?? '?'}": ${e && e.message ? e.message : String(e)} — rolled back` }
  }

  await journalAppend(home, { kind: 'restore-snapshot', id, moved: moved.length })
  return { ok: true, restored: plan.length, moved: moved.length }
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
  classifyWithReal,
  isDriveRoot,
  buildPolicy,
  hasDestructiveVerb,
  extractShellPaths,
  extractVariableRefFragments,
  resolveVariableRefs,
  validId,
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
