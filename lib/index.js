/**
 * dsh-safety host half.
 *
 * A personal "safety harness" for DSH: stops the agent from deleting or
 * rewriting the files that make DSH unbootable (profile manifests, patch
 * layers, lockfiles, node_modules, the deployment install dir), provides a
 * trash-based `safe_delete` with undo, last-known-good snapshots of the whole
 * composition, a pre-restart `safety_check` (UTF-8 / mojibake / JSON / YAML
 * row-id / cross-layer duplicate detection), and an audit journal.
 *
 * Enforcement points (verified against the installed @deepseek-ai packages):
 *   - `ctx.tools.guard()` — monotonic pre-dispatch denial (covers write/edit/
 *     str_replace_editor/pwsh/bash with destructive commands).
 *   - `fs/write-intent` + `fs/edit-intent` waterfalls — defense in depth,
 *     throws FsError for protected paths regardless of which tool writes.
 *   - `safe_delete` — the sanctioned deletion path (moves to trash, undoable).
 *
 * The browser half registers a "安全中心" settings section backed by the
 * `/safety/api` route.
 */

import path from 'node:path'
import os from 'node:os'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FsError } from '@deepseek-ai/dsh-fs'
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
} from './safety-core.mjs'

export const name = PLUGIN_ID
export const inject = ['systemPrompt', 'tools', 'webServer']

/* ── tool scaffolding ─────────────────────────────────────────────────────── */

const textTool = ({ name, description, parameters, execute }) => {
  return defineTool({
    name,
    description,
    parameters,
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
      render: (_args, value) => [{ type: 'text', text: value.text || value.error || '(empty)' }],
    },
    async execute(args) {
      try {
        return await execute(args)
      } catch (e) {
        return { ok: false, text: '', error: `[dsh-safety] ${e && e.message ? e.message : String(e)}` }
      }
    },
  })
}

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
  const flags = {
    blockWrites: config.blockWrites !== false,
    blockShell: config.blockShellDestructive !== false,
    audit: config.audit !== false,
    keepTrash: Number(config.keepTrash) || 200,
    keepSnapshots: Number(config.keepSnapshots) || 10,
  }
  let guardBlocks = 0
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

  const register = (tool) => ctx.effect(() => ctx.tools.register(tool), `dsh-safety: ${tool.name}`)

  /* ── policy section ─────────────────────────────────────────────────────── */
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'safety:policy',
    order: 200,
    text: `Filesystem safety policy — ENFORCED by the dsh-safety plugin, not a suggestion:
- NEVER use raw shell to delete directories (rm -r/-rf, Remove-Item -Recurse, rd /s, rmdir, shutil.rmtree, fs.rm recursive) — the guard BLOCKS recursive deletes everywhere. Use safe_delete, which moves to trash and is undoable.
- Before deleting anything, run safe_delete with preview:true to see what would be removed.
- Protected (no write/edit/delete): profile package.json / cordis.patch.yml / cordis.yml / pnpm-workspace.yaml / pnpm-lock.yaml / node_modules, the deployment install dir, home cordis.patch.yml & settings.yaml.
- Confirm-delete (delete requires safe_delete force:true, still trash-only, never permanent): everything under the OS home dir, plugin sources under profiles/*/plugins, and .agent-presets.
Rules: (1) never delete with raw shell; use safe_delete. (2) run safety_check before restarting dsh after any plugin/config change. (3) run safety_snapshot before editing composition files. (4) recovery via safety_status / safety_undo / safety_restore / safety_trash.`,
  }), 'dsh-safety: policy section')

  /* ── tools ──────────────────────────────────────────────────────────────── */

  register(textTool({
    name: 'safe_delete',
    description: 'Delete a file or directory the safe way: it is moved to the dsh-safety trash (recoverable via safety_undo) and journaled. Directory deletes describe their contents first. Confirm/protected paths are refused unless force:true (still trash-only, never permanent). This is the ONLY sanctioned delete channel — recursive shell deletes are blocked by the guard. Run preview:true first to see what would be removed.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the file or directory to delete.' },
      force: { type: 'boolean', description: 'Set true to delete a confirm/protected-path item (it still goes to trash, never permanent).' },
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
      if (cls !== 'free' && !args.force) {
        return { ok: false, error: `"${abs}" is ${cls} — pass force:true to move it to trash (still undoable), or ask the user.` }
      }
      const r = await trashMove(home, abs, policy, { op: 'safe_delete', by: 'agent' })
      if (flags.keepTrash > 0) prune(home, flags.keepTrash, flags.keepSnapshots).catch(() => {})
      return { ok: true, text: `moved to trash: ${abs}\ntrash id: ${r.id}\n${desc}\nrestore with: safety_undo id=${r.id}` }
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
      const lines = [
        `home=${home}`,
        `guard-armed=${flags.blockWrites || flags.blockShell}`,
        `guard-blocks=${guardBlocks}`,
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
        guardBlocks++
        journalAppend(home, {
          kind: 'guard-block',
          tool: exec.name,
          target: d.abs || null,
          cls: d.cls || null,
          recursive: d.recursive === true,
          reason: d.reason,
        }).catch(() => {})
        return `[dsh-safety] blocked ${d.kind}${d.recursive ? ' (recursive)' : ''}: ${d.reason}. Use safe_delete (moves to trash, undoable) or ask the user to authorize it.`
      } catch {
        return undefined // fail open for our own guard (defensive)
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
        await journalAppend(home, { kind: 'fs-block', target: abs }).catch(() => {})
        throw new FsError(`[dsh-safety] write/edit blocked on protected path "${abs}"`, 'FS_DENIED')
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

  /* ── web panel API ──────────────────────────────────────────────────────── */
  const readJson = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
  const respond = (res, value, status = 200) => {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  }
  const handler = async (req, res) => {
    try {
      if (req.method === 'GET') {
        const trash = await trashList(home)
        const snaps = await snapshotList(home)
        const tail = await journalTail(home, 20)
        respond(res, {
          ok: true,
          home,
          guardBlocks,
          lastCheck: lastCheck ? { pass: lastCheck.pass, files: lastCheck.files.length, duplicates: lastCheck.duplicates.length } : null,
          trash: trash.slice(0, 100).map((e) => ({ id: e.id, isDir: e.isDir, size: e.size, mtime: e.mtime })),
          snapshots: snaps.slice(0, 50).map((s) => ({ id: s.id, label: s.label, at: s.at, files: s.files })),
          journal: tail,
          blockWriteRoots: policy.blockWriteRoots,
          confirmDeleteRoots: policy.confirmDeleteRoots,
        })
        return
      }
      if (req.method !== 'POST') {
        respond(res, { ok: false, error: 'method' }, 405)
        return
      }
      // Lightweight same-origin guard: mutating calls (undo/restore/snapshot)
      // require the X-DSH-Safety header the bundled panel sends; a stray
      // same-origin script is unlikely to volunteer it.
      if (req.headers['x-dsh-safety'] !== '1') {
        respond(res, { ok: false, error: 'forbidden' }, 403)
        return
      }
      const payload = await readJson(req)
      const op = String(payload.op || '')
      if (op === 'undo') {
        const r = await trashRestore(home, String(payload.id || ''))
        respond(res, r.ok ? { ok: true, dest: r.dest } : { ok: false, error: r.error || 'failed' })
        return
      }
      if (op === 'restore') {
        if (payload.confirm !== true) { respond(res, { ok: false, error: 'confirm required' }); return }
        const r = await restoreSnapshot(home, String(payload.id || ''))
        respond(res, r.ok ? { ok: true, restored: r.restored, moved: r.moved } : { ok: false, error: r.error || 'failed' })
        return
      }
      if (op === 'snapshot') {
        const m = await createSnapshot(home, String(payload.label || ''))
        respond(res, { ok: true, id: m.id })
        return
      }
      if (op === 'check') {
        const r = validateComposition(home)
        lastCheck = r
        respond(res, { ok: true, pass: r.pass, files: r.files, duplicates: r.duplicates })
        return
      }
      respond(res, { ok: false, error: 'unknown-op' })
    } catch (e) {
      ctx.logger?.('dsh-safety')?.warn('request failed', e)
      respond(res, { ok: false, error: 'internal', detail: String(e && e.message ? e.message : e) })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/safety/api', handler }), 'dsh-safety: /safety/api route')

  // Make state dirs eagerly (best-effort).
  ensureStateDirs(home).catch(() => {})
}
