#!/usr/bin/env node
/**
 * dsh-safety CLI — the human side of the safety net.
 *
 * Works STANDALONE (no DSH needed): it talks to the same `$DSH_HOME/.dsh-safety`
 * state that the plugin uses, so you can undo/restore/check even when DSH is
 * down or the plugin isn't installed. Zero third-party dependencies.
 *
 * Usage:
 *   dsh-safety status                 show state: zones, trash, snapshots, journal
 *   dsh-safety delete <path> [--force] [--preview]
 *   dsh-safety trash [--limit N]
 *   dsh-safety undo <id>
 *   dsh-safety snapshot [label] [--exclude a,b]
 *   dsh-safety restore <id> --confirm
 *   dsh-safety check                  pre-restart composition validation
 *   dsh-safety journal [n]
 *   dsh-safety policy                 print the effective policy zones
 *   dsh-safety help
 *
 * Home resolution: $DSH_HOME, else ~/.dsh. Override with --home <path>.
 */

import os from 'node:os'
import path from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import {
  buildPolicy,
  classify,
  createSnapshot,
  ensureStateDirs,
  journalTail,
  prune,
  restoreSnapshot,
  snapshotList,
  trashList,
  trashMove,
  trashRestore,
  validateComposition,
} from '../lib/safety-core.mjs'

const HOME = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))

const args = process.argv.slice(2)
const flags = { force: false, preview: false, confirm: false, home: HOME }
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--force') flags.force = true
  else if (a === '--preview') flags.preview = true
  else if (a === '--confirm') flags.confirm = true
  else if (a === '--home') { flags.home = path.resolve(args[++i] ?? HOME); continue }
  else if (a.startsWith('--exclude=')) flags.exclude = a.slice('--exclude='.length)
  else if (a.startsWith('--limit=')) flags.limit = Number(a.slice('--limit='.length))
  else positional.push(a)
}
const home = flags.home
const [cmd, ...rest] = positional

const out = (s) => { process.stdout.write(s + '\n') }
const err = (s) => { process.stderr.write('dsh-safety: ' + s + '\n'); process.exit(1) }

// Shared with the plugin: policy zones can never drift between CLI and guard.
const policyForCli = () => buildPolicy(home, {})

async function main() {
  await ensureStateDirs(home).catch(() => {})

  if (cmd === 'status' || cmd === undefined) {
    const trash = await trashList(home)
    const snaps = await snapshotList(home)
    const tail = await journalTail(home, 5)
    out([
      `home=${home}`,
      `trash=${trash.length} item(s)`,
      `snapshots=${snaps.length}: ${snaps.map((s) => s.id).join(', ') || '(none)'}`,
      `journal: ${tail.map((e) => e.kind).join(', ') || '(empty)'}`,
    ].join('\n'))
    return
  }

  if (cmd === 'delete') {
    const target = rest[0]
    if (!target) err('delete needs a path')
    const abs = path.resolve(target)
    const policy = policyForCli()
    const cls = classify(abs, policy)
    if (abs === home || abs === path.dirname(home)) err(`refusing to delete a root: ${abs}`)
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
    const r = await trashMove(home, abs, policy, { op: 'cli-delete', by: 'user' })
    prune(home, 200, 10).catch(() => {})
    out(`moved to trash: ${abs}\ntrash id: ${r.id}\nundo with: dsh-safety undo ${r.id}`)
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

  err(`unknown command "${cmd}" — try: status | delete | trash | undo | snapshot | restore | check | journal | policy | help`)
}

main().catch((e) => err(e && e.message ? e.message : String(e)))
