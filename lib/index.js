/**
 * dsh-safety host half.
 *
 * dsh-safety host 半区。
 *
 * A personal "safety harness" for DSH: stops the agent from deleting or
 * rewriting the files that make DSH unbootable (profile manifests, patch
 * layers, lockfiles, node_modules, the deployment install dir), provides a
 * trash-based `safe_delete` with undo, last-known-good snapshots of the whole
 * composition, a pre-restart `safety_check` (UTF-8 / mojibake / JSON / YAML
 * row-id / cross-layer duplicate detection), and an audit journal.
 *
 * DSH 的安全护栏：阻止代理删除/改写会导致 DSH 无法启动的文件（profile
 * manifest、补丁层、lockfile、node_modules、部署安装目录等）；提供基于
 * 回收站的 safe_delete 与撤销、整套组合的 last-known-good 快照、重启前
 * safety_check（UTF-8 / 乱码 / JSON / YAML 行 id / 跨层重复检测）与审计日志。
 *
 * ZERO external imports (node builtins + `./safety-core.mjs`, `./state.mjs`,
 * `./audit.mjs` — all node-builtins-only) on purpose: a bundle installed with
 * a bare `link:` has no own `node_modules`, so importing `@deepseek-ai/*`
 * would fail module resolution at boot. Tool definitions are hand-built
 * (JSON Schema subset) instead of `defineTool`.
 *
 * 刻意保持零外部 import（仅 Node 内置 + ./safety-core.mjs）：以裸 link: 方式
 * 安装的 bundle 没有自带 node_modules，import @deepseek-ai/* 会在启动时解析
 * 失败。工具定义用手写 JSON Schema 子集替代 defineTool。
 *
 * Enforcement points (dsh runtime APIs, not imports):
 *   强制点（dsh 运行时 API，非 import）：
 *   - `ctx.tools.guard()` — monotonic pre-dispatch denial (covers write/edit/
 *     str_replace_editor/pwsh/bash/run_code with destructive commands).
 *     单调的派发前拒绝（覆盖带破坏性命令的 write/edit/str_replace_editor/
 *     pwsh/bash/run_code）。
 *   - `fs/write-intent` + `fs/edit-intent` waterfalls — defense in depth,
 *     throws `{ code: 'FS_DENIED' }` for protected paths regardless of which
 *     tool writes.
 *     纵深防御：任何途径写 protected 路径都会在瀑布中抛 { code: 'FS_DENIED' }。
 *   - `safe_delete` — the sanctioned deletion path (moves to trash, undoable).
 *     唯一受认可的删除通道（移入回收站，可撤销）。
 */

import path from 'node:path'
import os from 'node:os'
import { existsSync, readdirSync, statSync } from 'node:fs'
import {
  PLUGIN_ID,
  buildPolicy,
  classify,
  destructiveTargetForCall,
  ensureStateDirs,
  isDriveRoot,
  isUnder,
  journalAppend,
  journalTail,
  trashMove,
  trashList,
  trashRestore,
  createSnapshot,
  snapshotList,
  restoreSnapshot,
  prune,
  validateComposition,
  keyOf,
} from './safety-core.mjs'
import { recordBlock, getTotalBlocks, createApproval, consumeApproval, hasActiveApproval, activeApprovals } from './state.mjs'
import { appendAudit } from './audit.mjs'

export const name = PLUGIN_ID
export const inject = ['systemPrompt', 'tools']

/* ── tool scaffolding (ZERO external imports) ─────────────────────────────── */

/**
 * Compile a per-property parameter spec into the JSON Schema subset the tools
 * registry accepts. This mirrors the `defineTool` shape without importing
 * `@deepseek-ai/dsh-tools`, so the plugin resolves even when installed with a
 * bare `link:` and no own `node_modules`.
 */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

const textTool = ({ name, description, parameters, execute }) => ({
  name,
  description,
  parameters: toJsonSchema(parameters || {}),
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        text: { type: 'string' },
        error: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: (value && (value.text || value.error)) || '(empty)' }],
  },
  async execute(args) {
    try {
      return await execute(args)
    } catch (e) {
      return { ok: false, text: '', error: `[dsh-safety] ${e && e.message ? e.message : String(e)}` }
    }
  },
})

/* ── plugin apply ─────────────────────────────────────────────────────────── */

/**
 * Fail-soft entry: the safety plugin must NEVER be the thing that breaks a
 * DSH boot. Any error during registration degrades (logs) and the rest of
 * DSH boots normally.
 */
export function apply(ctx, config = {}) {
  try {
    applyInner(ctx, config)
  } catch (e) {
    try {
      ctx?.logger?.('dsh-safety')?.warn?.('apply failed — fail-soft, continuing boot', e)
    } catch {
      /* logging must not throw either */
    }
  }
}

function applyInner(ctx, config = {}) {
  const home = path.resolve(config.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
  const policy = buildPolicy(home, config)
  // `mode`: 'strict' (default) keeps raw recursive shell deletes non-approvable;
  // 'cooperative' lets the human authorize them via the approval flow.
  const cooperative = config.mode === 'cooperative' || config.allowRecursiveDeletes === true
  const flags = {
    blockWrites: config.blockWrites !== false,
    blockShell: config.blockShellDestructive !== false,
    audit: config.audit !== false,
    keepTrash: Number(config.keepTrash) || 200,
    keepSnapshots: Number(config.keepSnapshots) || 10,
    allowRecursiveDeletes: cooperative,
    approvalTtlMs: Number(config.approvalTtlMs) || 5 * 60 * 1000,
  }
  let guardBlocks = 0
  let guardApprovals = 0
  let lastCheck = null

  // Describe what a delete would remove: size for files, entry preview for dirs.
  const describeTarget = (abs) => {
    let st
    try {
      st = statSync(abs)
    } catch {
      return '(cannot stat)'
    }
    if (!st.isDirectory()) return `[file] ${st.size} bytes`
    let names = []
    try {
      names = readdirSync(abs)
    } catch {
      names = []
    }
    const top = names.slice(0, 20)
    return `[directory] ${names.length} top-level entr${names.length === 1 ? 'y' : 'ies'}${names.length ? ':\n  ' + top.join('\n  ') + (names.length > 20 ? `\n  … ${names.length - 20} more` : '') : ''}`
  }

  // Educate the agent about WHY a target is sensitive: the causality card
  // (what it is → what breaking it does → what the sanctioned path is).
  const explainConsequence = (cls, kind) => {
    if (cls === 'protected') {
      return kind === 'write'
        ? 'This is a boot-critical file (profile manifest / patch / lockfile / node_modules / install dir): rewriting it can make DSH fail to start. Take a safety_snapshot BEFORE any change you are authorized to make.'
        : 'This is a boot-critical file: deleting it can make DSH unbootable.'
    }
    if (cls === 'confirm') {
      return 'This is inside a confirm-delete zone (OS home / plugin sources / agent presets): edits are fine, deletes need the USER\'s explicit approval and still only go to the trash (undoable).'
    }
    if (cls === 'var-ref' || cls === 'marker') {
      return 'The command\'s real target cannot be verified from text (variable expansion / marker match): it may resolve into a protected zone, so it is treated as dangerous.'
    }
    if (cls === 'recursive') {
      return 'Recursive directory deletes are the highest-risk operation (a past incident wiped an entire install root this way).'
    }
    return ''
  }

  // Anti-loop escalation: track how many times the same target was blocked so
  // the guard can tell the agent to STOP retrying and ask the user instead.
  const denialCounts = new Map() // key -> attempt count
  const denialKey = (d) => `${d.kind}|${d.cls}|${d.abs || d.reason}`

  const register = (tool) => ctx.effect(() => ctx.tools.register(tool), `dsh-safety: ${tool.name}`)

  /* ── policy section: the agent's safety MINDSET (not just rules) ───────── */
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'safety:policy',
    order: 200,
    text: `Filesystem safety — ENFORCED by dsh-safety. Think before you touch; when in doubt, ASK THE USER with the causality:
- Before deleting or overwriting anything important: run safe_delete with preview:true first, then explain to the user WHAT it is, WHY you want to change it, WHAT the consequence is, and WHAT the alternative is — proceed only after the user EXPLICITLY approves.
- Never delete directories with raw shell (rm -r/-rf, Remove-Item -Recurse, rd /s, rmdir, shutil.rmtree, fs.rm recursive): the guard blocks these everywhere. Use safe_delete (moves to trash, undoable).
- Protected (no write/edit/delete without explicit user authorization): profile package.json / cordis.patch.yml / cordis.yml / pnpm-workspace.yaml / pnpm-lock.yaml / node_modules, the deployment install dir, home cordis.patch.yml & settings.yaml. Rewriting these can make DSH fail to boot.
- Confirm-delete (delete requires user approval; still trash-only, never permanent): everything under the OS home dir, plugin sources under profiles/*/plugins, and .agent-presets.
- IF A CALL IS BLOCKED: stop. Do NOT try to work around the block (other tools, renamed paths, encoding tricks) — that is exactly what the guard exists to stop. Instead call safety_ask with the causality (what / why / consequence / alternative), tell the user the request id, and WAIT: the user approves via "dsh-safety allow <id>". You can never approve your own requests.
- Workflow: (1) safety_snapshot before editing composition files; (2) safety_check before restarting dsh after any plugin/config change; (3) recovery via safety_status / safety_undo / safety_restore / safety_trash.`,
  }), 'dsh-safety: policy section')

  /* ── tools ──────────────────────────────────────────────────────────────── */

  register(textTool({
    name: 'safe_delete',
    description: 'Delete a file or directory the safe way: it is moved to the dsh-safety trash (recoverable via safety_undo) and journaled. Directory deletes describe their contents first. Confirm/protected paths are refused unless the USER has approved the deletion (a `force:true` flag alone is NOT a user approval — the model cannot self-authorize). This is the ONLY sanctioned delete channel — recursive shell deletes are blocked by the guard. Run preview:true first to see what would be removed.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the file or directory to delete.' },
      force: { type: 'boolean', description: 'Marker that the user has approved this deletion (still requires a granted approval; still trash-only, never permanent).' },
      preview: { type: 'boolean', description: 'Set true to only describe what would be trashed, without moving anything.' },
    },
    async execute(args) {
      const abs = path.resolve(String(args.path || ''))
      const stateRoot = path.join(home, '.dsh-safety')
      if (abs === home || abs === path.dirname(home) || isDriveRoot(abs)) {
        return { ok: false, error: `refusing to trash a filesystem root "${abs}"` }
      }
      if (isUnder(abs, stateRoot)) {
        return { ok: false, error: `refusing to delete dsh-safety state "${abs}" (trash/snapshots/journal live here)` }
      }
      if (!existsSync(abs)) return { ok: false, error: `not found: ${abs}` }
      const cls = classify(abs, policy)
      const desc = describeTarget(abs)
      if (args.preview === true) {
        return { ok: true, text: `PREVIEW (nothing moved): ${abs}\n${desc}\n\nRun safe_delete again WITHOUT preview to move it to trash.` }
      }
      if (cls !== 'free') {
        // Real user authorization: consume a granted approval (one-shot) for
        // this exact delete. `force:true` alone is never enough.
        let isDir = false
        try { isDir = statSync(abs).isDirectory() } catch { /* not a dir */ }
        const approved = (() => {
          try {
            return consumeApproval(home, { kind: 'delete', target: abs, recursive: isDir })
          } catch {
            return false
          }
        })()
        if (!approved) {
          const pending = activeApprovals(home).find((r) => !r.grantedAt && r.kind === 'delete' && !!r.recursive === isDir && r.target !== null && keyOf(r.target) === keyOf(abs))
          return {
            ok: false,
            error: `"${abs}" is ${cls}: deleting it needs the USER's approval, not just force:true. ` +
              (pending
                ? `Approval request ${pending.id} is pending — ask the user to approve: dsh-safety allow ${pending.id}.`
                : 'Run safety_ask with the causality (what / why / consequence / alternative), then the user approves via "dsh-safety allow <id>".'),
          }
        }
      }
      const r = await trashMove(home, abs, policy, { op: 'safe_delete', by: 'agent' })
      if (flags.keepTrash > 0) prune(home, flags.keepTrash, flags.keepSnapshots).catch(() => {})
      appendAudit(home, 'delete', { tool: 'safe_delete', target: abs, reason: `trash id ${r.id} (cls=${cls})` }).catch(() => {})
      return { ok: true, text: `moved to trash: ${abs}\ntrash id: ${r.id}\n${desc}\nrestore with: safety_undo id=${r.id}` }
    },
  }))

  register(textTool({
    name: 'safety_ask',
    description: 'Request the USER\'s approval to delete or modify a sensitive file/directory. When the guard blocks a call, use this to create a structured approval request: explain WHAT the target is, WHY you need to change it, WHAT the consequence would be, and WHAT the alternative is. The user approves via "dsh-safety allow <id>"; once approved, retry the original call. The model can NEVER approve its own requests.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the file/directory you want to delete or write.' },
      kind: { type: 'string', enum: ['delete', 'write'], description: 'What you want to do: delete or write.' },
      recursive: { type: 'boolean', description: 'Set true when deleting a whole directory tree.' },
      what: { type: 'string', description: 'What this target is (e.g. "profile manifest for the web profile").' },
      why: { type: 'string', description: 'Why you need to delete/modify it.' },
      consequence: { type: 'string', description: 'What happens if it is deleted/modified (e.g. "DSH will fail to boot").' },
      alternative: { type: 'string', description: 'Safer alternative (e.g. "snapshot first, keep a backup").' },
    },
    async execute(args) {
      const kind = args.kind === 'write' ? 'write' : 'delete'
      const abs = path.resolve(String(args.path || ''))
      const req = createApproval(home, {
        kind,
        target: abs,
        recursive: args.recursive === true,
        what: String(args.what || ''),
        why: String(args.why || ''),
        consequence: String(args.consequence || ''),
        alternative: String(args.alternative || ''),
        requestedBy: 'agent',
      })
      journalAppend(home, { kind: 'safety-ask', id: req.id, target: abs, what: req.what, why: req.why, consequence: req.consequence }).catch(() => {})
      appendAudit(home, 'ask', { tool: 'safety_ask', target: abs, reason: req.id }).catch(() => {})
      return {
        ok: true,
        text: `approval request ${req.id} created for ${kind} on ${abs}${req.recursive ? ' (recursive)' : ''}.\n` +
          `Ask the user to approve it: dsh-safety allow ${req.id}.\n` +
          `Once approved, retry the original call — it will be allowed once.`,
      }
    },
  }))

  register(textTool({
    name: 'safety_trash',
    description: 'List the dsh-safety trash (deleted items waiting for undo or purge).',
    parameters: { limit: { type: 'integer', description: 'Max entries (default 50).' } },
    async execute(args) {
      const list = await trashList(home)
      const n = Math.max(1, Number(args.limit) || 50)
      const head = list.slice(0, n)
      const text = head.length === 0
        ? 'trash is empty'
        : head.map((e) => `${e.id}\t${e.isDir ? '[dir]' : '[file]'}\t${e.size} bytes`).join('\n') +
          (list.length > head.length ? `\n… ${list.length - head.length} more (use limit to show more)` : '')
      return { ok: true, text }
    },
  }))

  register(textTool({
    name: 'safety_undo',
    description: 'Restore an item from the dsh-safety trash back to its original location (or a .restored-* sibling if the original is occupied).',
    parameters: { id: { type: 'string', required: true, description: 'Trash id from safety_trash.' } },
    async execute(args) {
      const r = await trashRestore(home, String(args.id || ''))
      if (!r.ok) return { ok: false, error: r.error || 'restore failed' }
      return { ok: true, text: `restored to: ${r.dest}` }
    },
  }))

  register(textTool({
    name: 'safety_snapshot',
    description: 'Take a last-known-good snapshot of the whole DSH composition: every profile package.json / cordis.patch.yml / cordis.yml / lockfile, home patch, all plugin package.json + cordis.patch.yml, and agent-preset compositions. Credential-bearing files (settings.yaml, .credentials.yaml) are excluded by default (config snapshotExclude). Run this before editing any composition/plugin file.',
    parameters: { label: { type: 'string', description: 'Optional short label, e.g. before-install.' } },
    async execute(args) {
      const exclude = config.snapshotExclude ?? ['settings.yaml', '.credentials.yaml']
      const manifest = await createSnapshot(home, String(args.label || ''), exclude)
      appendAudit(home, 'snapshot', { tool: 'safety_snapshot', target: manifest.id, reason: String(args.label || '') }).catch(() => {})
      return { ok: true, text: `snapshot ${manifest.id}: ${manifest.files.length} file(s) (excluded: ${exclude.join(', ')})` }
    },
  }))

  register(textTool({
    name: 'safety_restore',
    description: 'Restore the composition from a snapshot (e.g. after a failed boot). Current versions are first moved to the .dsh-safety/restored-from backup. Requires confirm:true.',
    parameters: {
      id: { type: 'string', required: true, description: 'Snapshot id from safety_status / safety_snapshot.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true; this overwrites live composition files.' },
    },
    async execute(args) {
      if (args.confirm !== true) return { ok: false, error: 'confirm:true is required' }
      const r = await restoreSnapshot(home, String(args.id || ''))
      if (!r.ok) return { ok: false, error: r.error || 'restore failed' }
      appendAudit(home, 'restore', { tool: 'safety_restore', target: String(args.id || ''), reason: `restored ${r.restored}, backed up ${r.moved}` }).catch(() => {})
      return { ok: true, text: `restored ${r.restored} file(s) from snapshot ${args.id}; ${r.moved} current file(s) backed up` }
    },
  }))

  register(textTool({
    name: 'safety_check',
    description: 'Pre-restart boot gate: validate the current composition before you restart dsh after plugin/config changes. Checks UTF-8 validity, mojibake (wrong-encoding round-trip), JSON parse of package.json files, patch row-id scanning, and duplicate plugin row ids across layers (the "one row, one layer" rule).',
    parameters: {},
    async execute() {
      const report = validateComposition(home)
      lastCheck = report
      const lines = [`safety_check: ${report.pass ? 'PASS' : 'FAIL'}`]
      for (const f of report.files) {
        const bad = f.checks.filter((c) => !c.ok)
        lines.push(`${f.ok ? '[ok]' : '[FAIL]'} ${f.rel}${bad.length ? ' — ' + bad.map((b) => `${b.check}: ${b.reason}`).join('; ') : ''}`)
      }
      if (report.duplicates.length > 0) {
        lines.push(`DUPLICATE ROW IDS (will fail next boot):`)
        for (const d of report.duplicates) {
          lines.push(`  ${d.id}: ${d.locs.map((l) => `${l.file}:${l.line}`).join(' , ')}`)
        }
      }
      lines.push(report.pass
        ? 'Composition is safe to restart.'
        : 'Fix the FAIL items BEFORE restarting; or safety_restore a known-good snapshot.')
      return { ok: true, text: lines.join('\n') }
    },
  }))

  register(textTool({
    name: 'safety_journal',
    description: 'Tail the dsh-safety audit journal (trash moves, restores, snapshots, blocked operations).',
    parameters: { n: { type: 'integer', description: 'Number of entries (default 20).' } },
    async execute(args) {
      const tail = await journalTail(home, Number(args.n) || 20)
      const text = tail.length === 0
        ? 'journal is empty'
        : tail.map((e) => {
          const t = e.at ? e.at.slice(0, 19) : '?'
          return `[${t}] ${e.kind}${e.original ? ' ' + e.original : ''}${e.id ? ' id=' + e.id : ''}${e.reason ? ' (' + e.reason + ')' : ''}`
        }).join('\n')
      return { ok: true, text }
    },
  }))

  register(textTool({
    name: 'safety_status',
    description: 'Show the dsh-safety state: protected roots, guard block count, trash count, snapshots, last check result, journal tail.',
    parameters: {},
    async execute() {
      const trash = await trashList(home)
      const snaps = await snapshotList(home)
      const tail = await journalTail(home, 5)
      const totalBlocks = getTotalBlocks(home)
      const approvals = activeApprovals(home)
      const pending = approvals.filter((r) => !r.grantedAt)
      const granted = approvals.filter((r) => r.grantedAt)
      const lines = [
        `home=${home}`,
        `guard-armed=${flags.blockWrites || flags.blockShell}`,
        `guard-blocks=${totalBlocks} (this session: ${guardBlocks})`,
        `guard-approvals-this-session=${guardApprovals}`,
        `approvals: ${pending.length} pending, ${granted.length} granted — ${pending.map((r) => `${r.id}(${r.kind}${r.recursive ? ',recursive' : ''})`).join(', ') || '(none pending)'}`,
        `mode=${cooperative ? 'cooperative' : 'strict'}`,
        `trash=${trash.length} item(s)`,
        `snapshots=${snaps.length}: ${snaps.slice(0, 5).map((s) => s.id).join(', ') || '(none)'}`,
        `last-check=${lastCheck ? (lastCheck.pass ? 'PASS' : 'FAIL') : 'not run'}`,
        `journal: ${tail.map((e) => e.kind).join(', ') || '(empty)'}`,
        `protected write-roots: ${policy.blockWriteRoots.join(' ; ') || '(none)'}`,
        `confirm-delete roots: ${policy.confirmDeleteRoots.join(' ; ') || '(none)'}`,
      ]
      return { ok: true, text: lines.join('\n') }
    },
  }))

  /* ── monotonic guard (primary enforcement) ──────────────────────────────── */
  if (flags.blockWrites || flags.blockShell) {
    ctx.effect(() => ctx.tools.guard((exec) => {
      try {
        const d = destructiveTargetForCall(exec.name, exec.arguments, policy)
        if (!d || d.action !== 'deny') return undefined
        const isWrite = d.kind === 'write'
        if (isWrite && !flags.blockWrites) return undefined
        if (!isWrite && !flags.blockShell) return undefined

        // Human-gated override: a granted, one-shot approval lets the call
        // through. The model can never grant itself one — only the user (CLI)
        // can. A raw RECURSIVE shell delete is approvable ONLY on a free path
        // and ONLY in cooperative mode; protected/confirm recursive deletes are
        // never approvable via raw shell — they must go through safe_delete
        // (trash, undoable). For WRITES the guard only checks (non-consuming):
        // the fs/write-intent waterfall is the real consumption point, so an
        // approved write is not consumed twice (and actually succeeds).
        const approvable = !d.recursive || (d.cls === 'recursive' && flags.allowRecursiveDeletes)
        if (approvable) {
          try {
            if (d.kind === 'write') {
              if (hasActiveApproval(home, { kind: 'write', target: d.abs || null, recursive: false })) {
                journalAppend(home, {
                  kind: 'approval-gate',
                  tool: exec.name,
                  target: d.abs || null,
                  cls: d.cls || null,
                }).catch(() => {})
                return undefined
              }
            } else if (consumeApproval(home, { kind: 'delete', target: d.abs || null, recursive: d.recursive === true })) {
              guardApprovals++
              journalAppend(home, {
                kind: 'approval-consume',
                tool: exec.name,
                target: d.abs || null,
                cls: d.cls || null,
                recursive: d.recursive === true,
              }).catch(() => {})
              appendAudit(home, 'approval', { tool: exec.name, target: d.abs || null, reason: 'user-approved call allowed' }).catch(() => {})
              return undefined
            }
          } catch {
            /* fail closed: treat as no approval */
          }
        }

        guardBlocks++
        const key = denialKey(d)
        const attempts = (denialCounts.get(key) || 0) + 1
        denialCounts.set(key, attempts)
        journalAppend(home, {
          kind: 'guard-block',
          tool: exec.name,
          target: d.abs || null,
          cls: d.cls || null,
          recursive: d.recursive === true,
          attempts,
          reason: d.reason,
        }).catch(() => {})
        // Persist the counter across restarts and record the audit alert.
        recordBlock(home, exec.name, exec.sessionId || exec.agent?.sessionId, d.reason, d.abs || null).catch(() => {})
        appendAudit(home, 'guard', { tool: exec.name, target: d.abs || null, reason: d.reason, attempts }).catch(() => {})

        // A pending request for this exact operation? Tell the model to have
        // the user approve it, instead of retrying blindly. Target matching is
        // case-normalized (Windows), consistent with approval consumption.
        const dAbs = d.abs || null
        const pending = activeApprovals(home).find(
          (r) =>
            !r.grantedAt &&
            r.kind === d.kind &&
            !!r.recursive === !!d.recursive &&
            (dAbs === null ? r.target === null : r.target !== null && keyOf(r.target) === keyOf(dAbs))
        )

        // Educational denial: why it was blocked, what the target is, what the
        // consequence is, and the sanctioned path — plus an anti-loop warning
        // once the same target has been blocked repeatedly.
        const desc = d.abs ? describeTarget(d.abs) : null
        const consequence = explainConsequence(d.cls, d.kind)
        const escalation = attempts >= 2
          ? `\nSTOP: this target has been blocked ${attempts} times. Do NOT try other tools, renamed paths or encodings to get around the guard — explain the situation to the user and ask.`
          : ''
        const approvalHint = pending
          ? `\nAn approval request ${pending.id} is already pending for this operation: ask the user to approve it (dsh-safety allow ${pending.id}). Do not retry until it is approved.`
          : d.recursive && !approvable
            ? d.cls === 'recursive'
              ? '\nRecursive deletes are not approvable in strict mode. Use safe_delete on the directory (preview first; moves to trash, undoable).'
              : '\nRecursive deletes on protected/confirm paths are never approvable via raw shell. Use safe_delete on the directory (preview first; moves to trash, undoable).'
            : '\nTo get authorized, call safety_ask with the causality (what / why / consequence / alternative), then the user approves via "dsh-safety allow <id>".'
        return [
          `[dsh-safety] blocked ${d.kind}${d.recursive ? ' (recursive)' : ''} on a ${d.cls} target: ${d.reason}.`,
          ...(desc ? [`Target: ${desc}`] : []),
          ...(consequence ? [`Why it matters: ${consequence}`] : []),
          'Sanctioned path: use safe_delete (preview first; moves to trash, undoable).',
          approvalHint.trim(),
          ...(escalation ? [escalation.trim()] : []),
        ].join('\n')
      } catch (e) {
        // Fail open so the guard can never take DSH down — but journal the
        // error so a silently-disabled guard is observable in the audit trail.
        journalAppend(home, { kind: 'guard-error', error: e && e.message ? e.message : String(e) }).catch(() => {})
        return undefined
      }
    }), 'dsh-safety: tools.guard')
  }

  /* ── fs write/edit waterfall (defense in depth) ─────────────────────────── */
  if (flags.blockWrites) {
    const fsGuard = async (target, _actor, next) => {
      const p = target && (target.displayPath || target.path)
      if (!p) return next()
      const abs = path.resolve(String(p))
      if (classify(abs, policy) === 'protected') {
        // A granted user approval is consumed HERE — the waterfall is the real
        // enforcement for writes (the guard above only checks without
        // consuming), so an approved write actually succeeds and is one-shot.
        if (consumeApproval(home, { kind: 'write', target: abs, recursive: false })) {
          guardApprovals++
          journalAppend(home, { kind: 'approval-consume', tool: 'fs/write-intent', target: abs, cls: 'protected', recursive: false }).catch(() => {})
          appendAudit(home, 'approval', { tool: 'fs/write-intent', target: abs, reason: 'user-approved write allowed' }).catch(() => {})
          return next()
        }
        await journalAppend(home, { kind: 'fs-block', target: abs }).catch(() => {})
        // Fail the waterfall with a stable code; no import of @deepseek-ai/dsh-fs.
        throw Object.assign(new Error(`[dsh-safety] write/edit blocked on protected path "${abs}"`), { code: 'FS_DENIED' })
      }
      return next()
    }
    ctx.on('fs/write-intent', fsGuard)
    ctx.on('fs/edit-intent', fsGuard)
  }

  /* ── audit: journal destructive tool calls that actually ran ────────────── */
  if (flags.audit) {
    ctx.on('session/event', (session, event) => {
      if (!event || event.type !== 'tool/call') return
      const data = event.data || {}
      const d = destructiveTargetForCall(data.name, data.arguments, policy)
      if (!d || d.kind !== 'delete') return
      journalAppend(home, {
        kind: 'audit',
        session: session && session.id,
        tool: data.name,
        target: d.abs || null,
        cls: d.cls || null,
        recursive: d.recursive === true,
      }).catch(() => {})
    })
  }

  // Make state dirs eagerly (best-effort).
  ensureStateDirs(home).catch(() => {})
}
