#!/usr/bin/env node
/**
 * dsh-safety CLI — the human side of the safety net.
 *
 * dsh-safety CLI —— 安全网的人侧入口。
 *
 * Works STANDALONE (no DSH needed): it talks to the same `$DSH_HOME/.dsh-safety`
 * state that the plugin uses, so you can undo/restore/check even when DSH is
 * down or the plugin isn't installed. Zero third-party dependencies.
 *
 * 独立运行（无需 DSH）：与插件读写同一个 `$DSH_HOME/.dsh-safety` 状态目录，
 * 因此即使 DSH 无法启动或插件未安装，也能执行 undo/restore/check。零第三方依赖。
 *
 * Usage:
 *   dsh-safety status                 show state: zones, trash, snapshots, approvals, journal
 *   dsh-safety delete <path> [--force] [--preview]
 *   dsh-safety trash [--limit N]
 *   dsh-safety undo <id>
 *   dsh-safety snapshot [label] [--exclude a,b]
 *   dsh-safety restore <id> --confirm
 *   dsh-safety check                  pre-restart composition validation
 *   dsh-safety journal [n]
 *   dsh-safety policy                 print the effective policy zones
 *   dsh-safety approvals              list pending/granted approval requests
 *   dsh-safety allow <id>             approve a request the agent created
 *   dsh-safety allow --path <p> [--kind delete|write] [--recursive]   approve a new one directly
 *   dsh-safety revoke <id>            revoke a request
 *   dsh-safety help
 *
 * Home resolution: $DSH_HOME, else ~/.dsh. Override with --home <path>.
 *
 * Policy overrides (align the CLI with the plugin's configured roots, which a
 * standalone CLI cannot read from the cordis patch layers):
 *   --write-root <path>      add a protected (no write/edit/delete) root
 *   --confirm-root <path>    add a confirm-delete (trash-only) root
 *   --no-home-confirm        do NOT make the whole OS home a confirm zone
 *   --keep-trash=N / --keep-snapshots=N   retention caps after delete/snapshot
 */

import os from 'node:os'
import path from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import {
  buildPolicy,
  classify,
  createSnapshot,
  ensureStateDirs,
  isDriveRoot,
  journalTail,
  prune,
  restoreSnapshot,
  snapshotList,
  trashList,
  trashMove,
  trashRestore,
  validateComposition,
} from '../lib/safety-core.mjs'
import { grantApproval, grantApprovalFor, revokeApproval, listApprovals, activeApprovals } from '../lib/state.mjs'

const HOME = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))

const args = process.argv.slice(2)
const flags = { force: false, preview: false, confirm: false, home: HOME }
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--force') flags.force = true
  else if (a === '--preview') flags.preview = true
  else if (a === '--confirm') flags.confirm = true
  else if (a === '--no-home-confirm') flags.noHomeConfirm = true
  else if (a === '--home') { flags.home = path.resolve(args[++i] ?? HOME); continue }
  else if (a.startsWith('--exclude=')) flags.exclude = a.slice('--exclude='.length)
  else if (a.startsWith('--limit=')) flags.limit = Number(a.slice('--limit='.length))
  else if (a.startsWith('--keep-trash=')) flags.keepTrash = Number(a.slice('--keep-trash='.length))
  else if (a.startsWith('--keep-snapshots=')) flags.keepSnapshots = Number(a.slice('--keep-snapshots='.length))
  else if (a === '--kind') { flags.kind = args[++i] ?? 'delete'; continue }
  else if (a.startsWith('--kind=')) flags.kind = a.slice('--kind='.length)
  else if (a === '--recursive') flags.recursive = true
  else if (a === '--path') { flags.path = path.resolve(args[++i] ?? ''); continue }
  else if (a.startsWith('--path=')) flags.path = path.resolve(a.slice('--path='.length))
  else if (a === '--write-root') { (flags.writeRoots ||= []).push(path.resolve(args[++i] ?? '')); continue }
  else if (a.startsWith('--write-root=')) { (flags.writeRoots ||= []).push(path.resolve(a.slice('--write-root='.length))) }
  else if (a === '--confirm-root') { (flags.confirmRoots ||= []).push(path.resolve(args[++i] ?? '')); continue }
  else if (a.startsWith('--confirm-root=')) { (flags.confirmRoots ||= []).push(path.resolve(a.slice('--confirm-root='.length))) }
  else positional.push(a)
}
const home = flags.home
const [cmd, ...rest] = positional

const out = (s) => { process.stdout.write(s + '\n') }
const err = (s) => { process.stderr.write('dsh-safety: ' + s + '\n'); process.exit(1) }

// Shared with the plugin: policy zones can never drift between CLI and guard.
// The plugin's configured roots live in the cordis patch layers, which this
// standalone CLI cannot read — so it accepts the same overrides via flags so a
// user can align the CLI's classification with the running guard's policy.
const policyForCli = () => buildPolicy(home, {
  homeIsConfirm: !flags.noHomeConfirm,
  blockWriteRoots: flags.writeRoots || [],
  confirmDeleteRoots: flags.confirmRoots || [],
})

async function main() {
  await ensureStateDirs(home).catch(() => {})

  if (cmd === 'status' || cmd === undefined) {
    const trash = await trashList(home)
    const snaps = await snapshotList(home)
    const tail = await journalTail(home, 5)
    const approvals = activeApprovals(home)
    const pending = approvals.filter((r) => !r.grantedAt)
    out([
      `home=${home}`,
      `trash=${trash.length} item(s)`,
      `snapshots=${snaps.length}: ${snaps.map((s) => s.id).join(', ') || '(none)'}`,
      `approvals: ${pending.length} pending — ${pending.map((r) => `${r.id}(${r.kind}${r.recursive ? ',recursive' : ''}${r.target ? ' ' + r.target : ''})`).join(', ') || '(none)'}`,
      `journal: ${tail.map((e) => e.kind).join(', ') || '(empty)'}`,
    ].join('\n'))
    return
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    out(`dsh-safety — filesystem safety harness for DeepSeek Harness (standalone CLI, zero deps)

Usage:
  dsh-safety status                 show state: zones, trash, snapshots, approvals, journal
  dsh-safety delete <path> [--force] [--preview]
  dsh-safety trash [--limit N]
  dsh-safety undo <id>
  dsh-safety snapshot [label] [--exclude a,b]
  dsh-safety restore <id> --confirm
  dsh-safety check                  pre-restart composition validation (exit 1 on failure)
  dsh-safety journal [n]
  dsh-safety policy                 print the effective policy zones
  dsh-safety approvals              list pending/granted approval requests
  dsh-safety allow <id>             approve a request the agent created
  dsh-safety allow --path <p> [--kind delete|write] [--recursive]   approve a new one directly
  dsh-safety revoke <id>            revoke a request
  dsh-safety help

Global:        --home <path>   (default $DSH_HOME or ~/.dsh)
Policy:        --write-root <path> --confirm-root <path> --no-home-confirm
Retention:     --keep-trash=N --keep-snapshots=N

The CLI is the human side of the approval flow: delete --force and allow are
REAL user authorizations; the model can never approve its own requests.`)
    return
  }

  if (cmd === 'delete') {
    const target = rest[0]
    if (!target) err('delete needs a path')
    const abs = path.resolve(target)
    const policy = policyForCli()
    const cls = classify(abs, policy)
    if (abs === home || abs === path.dirname(home) || isDriveRoot(abs)) err(`refusing to delete a filesystem root: ${abs}`)
    if (path.resolve(abs).toLowerCase().startsWith(path.join(home, '.dsh-safety').toLowerCase())) err(`refusing to delete dsh-safety state: ${abs}`)
    if (!existsSync(abs)) err(`not found: ${abs}`)
    if (flags.preview) {
      let st
      try { st = statSync(abs) } catch { err('cannot stat') }
      let desc = `[file] ${st.size} bytes`
      if (st.isDirectory()) {
        const names = readdirSync(abs)
        desc = `[directory] ${names.length} top-level entr${names.length === 1 ? 'y' : 'ies'}\n  ` + names.slice(0, 20).join('\n  ')
      }
      out(`PREVIEW (nothing moved): ${abs}\n${desc}`)
      return
    }
    if (cls !== 'free' && !flags.force) err(`"${abs}" is ${cls} — pass --force to move it to trash (still undoable)`)
    // The CLI user IS the human: --force authorizes the move. It always goes to
    // trash directly, so no approval record is granted here (a granted-but-
    // never-consumed approval would just linger in state until it expires).
    const r = await trashMove(home, abs, policy, { op: 'cli-delete', by: 'user' })
    prune(home, flags.keepTrash || 200, flags.keepSnapshots || 10).catch(() => {})
    out(`moved to trash: ${abs}\ntrash id: ${r.id}\nundo with: dsh-safety undo ${r.id}`)
    return
  }

  if (cmd === 'approvals') {
    const approvals = activeApprovals(home)
    if (approvals.length === 0) { out('no pending or granted approvals'); return }
    out(approvals.map((r) =>
      `${r.id}\t${r.grantedAt ? 'GRANTED' : 'PENDING'}\t${r.kind}${r.recursive ? '/recursive' : ''}\t${r.target || '(any)'}${r.what ? '\t' + r.what : ''}`
    ).join('\n'))
    return
  }

  if (cmd === 'allow') {
    // `allow <id>` approves a request the agent created; `allow --path <p>`
    // creates+grants one directly (the CLI user is the human).
    const id = rest[0]
    if (id) {
      const r = grantApproval(home, id, { grantedBy: 'cli-user' })
      if (!r.ok) err(r.reason || 'approval not found')
      out(`approved ${id} (${r.request.kind} on ${r.request.target || 'any'}, expires ${new Date(r.request.expiresAt).toISOString()})`)
      return
    }
    const target = rest[0] || (flags.path ? path.resolve(flags.path) : null)
    if (!target) err('allow needs a request id, or --path <path> [--kind delete|write] [--recursive]')
    const req = grantApprovalFor(home, { kind: flags.kind === 'write' ? 'write' : 'delete', target, recursive: flags.recursive === true, grantedBy: 'cli-user' })
    out(`created + approved ${req.request.id} (${req.request.kind}${req.request.recursive ? ',recursive' : ''} on ${target})`)
    return
  }

  if (cmd === 'revoke') {
    const id = rest[0]
    if (!id) err('revoke needs an approval id (see: dsh-safety approvals)')
    const r = revokeApproval(home, id)
    if (!r.ok) err(r.reason || 'approval not found')
    out(`revoked ${id}`)
    return
  }

  if (cmd === 'trash') {
    const list = await trashList(home)
    const n = Math.max(1, flags.limit || 50)
    out(list.slice(0, n).map((e) => `${e.id}\t${e.isDir ? '[dir]' : '[file]'}\t${e.size} bytes`).join('\n') || 'trash is empty')
    return
  }

  if (cmd === 'undo') {
    const id = rest[0]
    if (!id) err('undo needs a trash id (see: dsh-safety trash)')
    const r = await trashRestore(home, id)
    if (!r.ok) err(r.error || 'restore failed')
    out(`restored to: ${r.dest}`)
    return
  }

  if (cmd === 'snapshot') {
    const label = rest[0] || 'manual'
    const exclude = flags.exclude ? flags.exclude.split(',') : ['settings.yaml', '.credentials.yaml']
    const m = await createSnapshot(home, label, exclude)
    out(`snapshot ${m.id}: ${m.files.length} file(s)`)
    return
  }

  if (cmd === 'restore') {
    const id = rest[0]
    if (!id) err('restore needs a snapshot id (see: dsh-safety status)')
    if (!flags.confirm) err('restore overwrites live composition files — pass --confirm')
    const r = await restoreSnapshot(home, id)
    if (!r.ok) err(r.error || 'restore failed')
    out(`restored ${r.restored} file(s) from ${id}; ${r.moved} current file(s) backed up`)
    return
  }

  if (cmd === 'check') {
    const report = validateComposition(home)
    out(`safety_check: ${report.pass ? 'PASS' : 'FAIL'}`)
    for (const f of report.files) {
      const bad = f.checks.filter((c) => !c.ok)
      if (!f.ok) out(`[FAIL] ${f.rel} — ${bad.map((b) => `${b.check}: ${b.reason}`).join('; ')}`)
    }
    for (const d of report.duplicates) out(`DUPLICATE ROW ID: ${d.id} at ${d.locs.map((l) => `${l.file}:${l.line}`).join(' , ')}`)
    process.exitCode = report.pass ? 0 : 1
    return
  }

  if (cmd === 'journal') {
    const n = Number(rest[0] || flags.limit) || 20
    const tail = await journalTail(home, n)
    out(tail.map((e) => `[${(e.at || '?').slice(0, 19)}] ${e.kind}${e.original ? ' ' + e.original : ''}${e.id ? ' id=' + e.id : ''}`).join('\n') || 'journal is empty')
    return
  }

  if (cmd === 'policy') {
    const p = policyForCli()
    out([
      `home=${p.home}`,
      `protected write-roots:\n  ${p.blockWriteRoots.join('\n  ') || '(none)'}`,
      `confirm-delete roots:\n  ${p.confirmDeleteRoots.join('\n  ') || '(none)'}`,
    ].join('\n'))
    return
  }

  err(`unknown command "${cmd}" — try: status | delete | trash | undo | snapshot | restore | check | journal | policy | approvals | allow | revoke | help`)
}

main().catch((e) => err(e && e.message ? e.message : String(e)))
