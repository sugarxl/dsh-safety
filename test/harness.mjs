/**
 * Integration harness for the dsh-safety HOST half, without a running DSH.
 * Runs `apply()` against a stub `ctx`, then exercises the guard, the fs
 * waterfall, and the registered tools. Zero external imports — no
 * `@deepseek-ai/*` needed, so it runs from a clean checkout:
 *
 *   node test/harness.mjs
 */

import { promises as fsp, mkdtempSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, name, inject } from '../lib/index.js'
import { grantApprovalFor, grantApproval, activeApprovals } from '../lib/state.mjs'

const base = mkdtempSync(path.join(os.tmpdir(), 'dsh-safety-harness-'))
const home = path.join(base, 'home')
const web = path.join(home, 'profiles', 'web')
mkdirSync(path.join(web, 'plugins', 'p1', 'lib'), { recursive: true })
mkdirSync(path.join(web, 'node_modules'), { recursive: true })
writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } } }))
writeFileSync(path.join(web, 'cordis.patch.yml'), '- insert:\n    - id: alpha\n')
writeFileSync(path.join(web, 'plugins', 'p1', 'lib', 'index.js'), 'export const x = 1\n')
writeFileSync(path.join(home, 'cordis.patch.yml'), '- insert:\n    - id: beta\n')
writeFileSync(path.join(home, 'settings.yaml'), 'theme: dark\n')

const registeredTools = []
const guards = []
const sections = []
const listeners = new Map()
const effects = []

const ctx = {
  effect(fn, label) {
    const r = fn()
    effects.push({ label, r })
    return () => {}
  },
  tools: {
    register(tool) { registeredTools.push(tool); return () => {} },
    guard(g) { guards.push(g); return () => {} },
  },
  systemPrompt: {
    section(s) { sections.push(s); return () => {} },
  },
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, [])
    listeners.get(evt).push(fn)
    return () => {}
  },
  get() { return undefined },
  logger: { warn: () => {} },
}

// Explicit policy so the temp home keeps a clean protected/confirm/free split
// regardless of where os.tmpdir() lives (the real default adds $HOME as a
// confirm-delete zone, which is covered by the unit tests).
apply(ctx, { home, homeIsConfirm: false, confirmDeleteRoots: [path.join(home, 'profiles')] })

let failures = 0
const check = (cond, msg) => {
  if (!cond) {
    failures++
    console.error('FAIL: ' + msg)
  } else {
    console.log('ok: ' + msg)
  }
}

check(name === 'dsh-safety', 'plugin name')
check(Array.isArray(inject) && inject.includes('tools') && !inject.includes('webServer'), 'inject declares tools only (no web panel)')
check(sections.some((s) => s.name === 'safety:policy'), 'policy section registered')
check(listeners.has('fs/write-intent') && listeners.has('fs/edit-intent'), 'fs waterfall listeners registered')

const toolNames = registeredTools.map((t) => t.name)
for (const expected of ['safe_delete', 'safety_trash', 'safety_undo', 'safety_snapshot', 'safety_restore', 'safety_check', 'safety_journal', 'safety_status', 'safety_ask']) {
  check(toolNames.includes(expected), `tool registered: ${expected}`)
}

check(guards.length === 1, 'one monotonic guard registered')
const guard = guards[0]

// Guard: deny destructive shell on protected path
const shellDeny = guard({
  name: 'pwsh',
  arguments: { command: 'Remove-Item -Recurse -Force "C:\\Users\\a\\.dsh\\profiles\\web\\node_modules"' },
  agent: undefined,
})
check(typeof shellDeny === 'string' && shellDeny.includes('[dsh-safety]'), 'guard denies recursive shell delete on protected path')

// Guard: deny recursive delete ANYWHERE (free path too) — the incident pattern
const recFreeDeny = guard({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force "C:\\Temp\\scratch"' }, agent: undefined })
check(typeof recFreeDeny === 'string' && recFreeDeny.includes('recursive'), 'guard denies recursive delete on free path')

// Guard: deny non-recursive delete in the confirm zone (plugin sources)
const confirmDeny = guard({
  name: 'pwsh',
  arguments: { command: 'Remove-Item -Force "' + path.join(web, 'plugins', 'p1', 'x.js') + '"' },
  agent: undefined,
})
check(typeof confirmDeny === 'string' && confirmDeny.includes('confirm'), 'guard denies non-recursive delete on confirm path')

// Guard: allow non-recursive file delete on a truly free path
const freeDelOk = guard({ name: 'pwsh', arguments: { command: 'Remove-Item -Force "C:\\Temp\\junk.txt"' }, agent: undefined })
check(freeDelOk === undefined, 'guard allows non-recursive file delete on free path')

// Guard: deny write to protected profile manifest
const writeDeny = guard({ name: 'write', arguments: { file_path: path.join(web, 'package.json') }, agent: undefined })
check(typeof writeDeny === 'string' && writeDeny.includes('blocked'), 'guard denies write to profile package.json')

// Educational denial: must explain what/why and the sanctioned path
check(
  typeof writeDeny === 'string' && writeDeny.includes('safe_delete') && writeDeny.includes('Why it matters') && writeDeny.includes('Target:'),
  'denial message is educational (target + consequence + sanctioned path)'
)

// Anti-loop escalation: the same target blocked twice warns the agent to STOP
const writeDeny2 = guard({ name: 'write', arguments: { file_path: path.join(web, 'package.json') }, agent: undefined })
check(typeof writeDeny2 === 'string' && /attempt #2|STOP/i.test(writeDeny2), 'guard escalates after repeated denials for the same target')

// safety_ask: creates a structured request; the guard denies while pending,
// then allows the matching call once the user grants it (one-shot).
const askTool = registeredTools.find((t) => t.name === 'safety_ask')
check(typeof askTool === 'object' && askTool !== undefined, 'tool registered: safety_ask')
const askTarget = path.join(web, 'plugins', 'p1', 'old.js')
writeFileSync(askTarget, 'x\n')
const ask = await askTool.execute({ path: askTarget, kind: 'delete', what: 'stale plugin file', why: 'cleanup', consequence: 'removed from plugin dir', alternative: 'keep a backup' })
const askId = /request ([a-z0-9]+) created/.exec(ask.text)
check(askId !== null, 'safety_ask creates a request with an id')
// the request must carry a SYSTEM-computed consequence (from the real path
// classification), not just the model's self-reported narrative
const askReq = activeApprovals(home).find((r) => r.id === askId[1])
check(!!askReq && typeof askReq.systemNote === 'string' && askReq.systemNote.includes('confirm-delete zone'), 'approval request carries a system-computed consequence (trust anchor)')
const pendingDeny = guard({ name: 'pwsh', arguments: { command: 'Remove-Item -Force "' + askTarget + '"' }, agent: undefined })
check(typeof pendingDeny === 'string' && pendingDeny.includes(askId[1]), 'guard reports the pending approval id')
grantApproval(home, askId[1], { grantedBy: 'cli-user' })
const userApproved = guard({ name: 'pwsh', arguments: { command: 'Remove-Item -Force "' + askTarget + '"' }, agent: undefined })
check(userApproved === undefined, 'guard allows the user-approved delete (one-shot)')
const deniedAgain = guard({ name: 'pwsh', arguments: { command: 'Remove-Item -Force "' + askTarget + '"' }, agent: undefined })
check(typeof deniedAgain === 'string', 'approval is one-shot; the next call is blocked again')

// cooperative mode: a human-granted generic recursive approval lets a free-path
// recursive shell delete through (one-shot); strict mode stays non-approvable.
const coopGuards = []
const coopCtx = {
  effect(fn) { const r = fn(); return () => {} },
  tools: { register() { return () => {} }, guard(g) { coopGuards.push(g); return () => {} } },
  systemPrompt: { section() {} },
  on() { return () => {} },
  get() {},
  logger: { warn: () => {} },
}
apply(coopCtx, { home, homeIsConfirm: false, mode: 'cooperative' })
const coopGuard = coopGuards[0]
check(coopGuards.length === 1, 'cooperative mode registers a guard')
const strictRec = guard({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force "C:\\Temp\\scratch"' }, agent: undefined })
check(typeof strictRec === 'string' && strictRec.includes('not approvable'), 'strict mode: recursive free-path delete is not approvable')
const coopDeny = coopGuard({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force "C:\\Temp\\scratch"' }, agent: undefined })
check(typeof coopDeny === 'string', 'cooperative mode still denies without approval')
grantApprovalFor(home, { kind: 'delete', target: null, recursive: true, grantedBy: 'cli-user' })
const coopAllow = coopGuard({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force "C:\\Temp\\scratch"' }, agent: undefined })
check(coopAllow === undefined, 'cooperative mode allows a user-approved recursive delete (one-shot)')

// A recursive approval for a SPECIFIC free directory (the documented CLI
// `allow --path <dir> --recursive` flow) also works, and covers the subtree.
grantApprovalFor(home, { kind: 'delete', target: 'C:\\Temp\\coop-project', recursive: true, grantedBy: 'cli-user' })
const coopDirAllow = coopGuard({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force "C:\\Temp\\coop-project\\sub\\build"' }, agent: undefined })
check(coopDirAllow === undefined, 'cooperative: a specific-directory recursive approval covers its subtree (one-shot)')

// A raw RECURSIVE shell delete on a PROTECTED path is never approvable — even
// with an exact, user-granted approval it must go through safe_delete.
grantApprovalFor(home, { kind: 'delete', target: path.join(web, 'node_modules'), recursive: true, grantedBy: 'cli-user' })
const protRecDeny = guard({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force "' + path.join(web, 'node_modules') + '"' }, agent: undefined })
check(typeof protRecDeny === 'string' && protRecDeny.includes('safe_delete'), 'protected recursive shell delete is never approvable via raw shell')

// User-approved WRITE passes the fs waterfall (the approval is consumed there,
// one-shot): the guard checks without consuming, the waterfall is the real gate.
const fsGuard2 = listeners.get('fs/write-intent')[0]
grantApprovalFor(home, { kind: 'write', target: path.join(web, 'package.json'), grantedBy: 'cli-user' })
let approvedWritePassed = false
try {
  const r = await fsGuard2({ displayPath: path.join(web, 'package.json') }, {}, async () => 'next')
  approvedWritePassed = r === 'next'
} catch { approvedWritePassed = false }
check(approvedWritePassed, 'fs/write-intent allows a user-approved write (consumes approval)')
let approvedWriteBlocked2 = false
try {
  await fsGuard2({ displayPath: path.join(web, 'package.json') }, {}, async () => 'next')
} catch (e) { approvedWriteBlocked2 = e && e.code === 'FS_DENIED' }
check(approvedWriteBlocked2, 'fs/write-intent blocks the second write (approval is one-shot)')

// Guard: allow edit of plugin source
const pluginEdit = guard({ name: 'edit', arguments: { file_path: path.join(web, 'plugins', 'p1', 'lib', 'index.js') }, agent: undefined })
check(pluginEdit === undefined, 'guard allows edit of plugin source')

// Guard: allow non-destructive reads
const readOk = guard({ name: 'pwsh', arguments: { command: 'Get-Content "C:\\Users\\a\\.dsh\\profiles\\web\\package.json"' }, agent: undefined })
check(readOk === undefined, 'guard allows non-destructive read')

// fs waterfall: blocks protected write
const fsGuard = listeners.get('fs/write-intent')[0]
let blocked = false
try {
  await fsGuard({ displayPath: path.join(web, 'package.json') }, {}, async () => 'next')
} catch (e) {
  blocked = e && e.code === 'FS_DENIED'
}
check(blocked, 'fs/write-intent throws FS_DENIED on protected path')

// fs waterfall: passes plugin-source writes through
let passed = false
try {
  const r = await fsGuard({ displayPath: path.join(web, 'plugins', 'p1', 'lib', 'index.js') }, {}, async () => 'next')
  passed = r === 'next'
} catch { passed = false }
check(passed, 'fs/write-intent allows plugin-source write')

// fs/delete-intent: any unknown-name fs delete tool is blocked on
// protected/confirm paths, and a granted delete approval lets it through.
const fsDelGuard = listeners.get('fs/delete-intent')[0]
let fsDelBlocked = false
try {
  await fsDelGuard({ displayPath: path.join(web, 'plugins', 'p1', 'old.js') }, {}, async () => 'next')
} catch (e) { fsDelBlocked = e && e.code === 'FS_DENIED' }
check(fsDelBlocked, 'fs/delete-intent blocks a confirm-zone delete without approval')
grantApprovalFor(home, { kind: 'delete', target: path.join(web, 'plugins', 'p1', 'old.js'), recursive: false, grantedBy: 'cli-user' })
let fsDelApproved = false
try {
  const r = await fsDelGuard({ displayPath: path.join(web, 'plugins', 'p1', 'old.js') }, {}, async () => 'next')
  fsDelApproved = r === 'next'
} catch { fsDelApproved = false }
check(fsDelApproved, 'fs/delete-intent allows a user-approved delete (consumes approval)')

// fs waterfall shares the symlink-aware classification: a write through a
// symlinked PARENT into a protected zone is blocked even for a file that does
// not exist yet (the deepest-existing-ancestor realpath is classified).
let protoLink = null
try {
  symlinkSync(path.join(web, 'node_modules'), path.join(home, 'proto-link'))
  protoLink = path.join(home, 'proto-link')
} catch { protoLink = null }
if (protoLink) {
  const fsGuardSym = listeners.get('fs/write-intent')[0]
  let symBlocked = false
  try {
    await fsGuardSym({ displayPath: path.join(protoLink, 'new.txt') }, {}, async () => 'next')
  } catch (e) { symBlocked = e && e.code === 'FS_DENIED' }
  check(symBlocked, 'fs/write-intent blocks a write through a symlinked parent into protected')
}

// safe_delete: refuses confirm-zone paths without force
const safeDelete = registeredTools.find((t) => t.name === 'safe_delete')
const pluginFile = path.join(web, 'plugins', 'p1', 'lib', 'index.js')
const refused = await safeDelete.execute({ path: pluginFile })
check(refused.ok === false && refused.error.includes('confirm'), 'safe_delete refuses confirm path without force')

// safe_delete: refuses the plugin's own state dir
const stateRefusal = await safeDelete.execute({ path: path.join(home, '.dsh-safety') })
check(stateRefusal.ok === false && stateRefusal.error.includes('state'), 'safe_delete refuses its own state dir')

// force:true alone is NOT a user approval
const noApproval = await safeDelete.execute({ path: pluginFile, force: true })
check(noApproval.ok === false && noApproval.error.includes("USER's approval"), 'safe_delete refuses force:true without a real user approval')

// after the human grants an approval, force:true succeeds (still trash-only)
grantApprovalFor(home, { kind: 'delete', target: pluginFile, grantedBy: 'cli-user' })
const forced = await safeDelete.execute({ path: pluginFile, force: true })
check(forced.ok === true && forced.text.includes('moved to trash'), 'safe_delete moves confirm path to trash after user approval')

// safe_delete: preview describes a directory without moving it
const dirVictim = path.join(home, 'tmp-dir')
mkdirSync(dirVictim)
writeFileSync(path.join(dirVictim, 'a.txt'), 'a')
writeFileSync(path.join(dirVictim, 'b.txt'), 'b')
const preview = await safeDelete.execute({ path: dirVictim, preview: true })
check(preview.ok === true && preview.text.includes('PREVIEW') && preview.text.includes('2 top-level entries'), 'safe_delete preview lists directory contents without moving')
check(existsSync(dirVictim) === true, 'preview did not move anything')

// safe_delete on a free path + undo roundtrip
const victim = path.join(home, 'tmp-junk.txt')
writeFileSync(victim, 'junk\n')
const del = await safeDelete.execute({ path: victim })
check(del.ok === true && del.text.includes('moved to trash'), 'safe_delete moved free-path file to trash')
check(existsSync(victim) === false, 'victim gone after safe_delete')
const undo = registeredTools.find((t) => t.name === 'safety_undo')
const idMatch = /trash id: ([^\s]+)/.exec(del.text)
check(idMatch !== null, 'safe_delete reports trash id')
const undone = await undo.execute({ id: idMatch[1] })
check(undone.ok === true, 'safety_undo restored file')
check(existsSync(victim) === true, 'victim restored')

// safety_check runs on the (now clean) home
const safetyCheck = registeredTools.find((t) => t.name === 'safety_check')
const chk = await safetyCheck.execute({})
check(chk.ok === true && typeof chk.text === 'string' && chk.text.startsWith('safety_check'), 'safety_check produced report')

// safety_snapshot + safety_restore
const snapTool = registeredTools.find((t) => t.name === 'safety_snapshot')
const snap = await snapTool.execute({ label: 'harness' })
check(snap.ok === true && /snapshot [\d-]+-harness-[a-z0-9]+: \d+ file/.test(snap.text), 'safety_snapshot created snapshot')
const restTool = registeredTools.find((t) => t.name === 'safety_restore')
const snapId = snap.text.split(' ')[1].replace(/:$/, '')
const restNoConfirm = await restTool.execute({ id: snapId, confirm: false })
check(restNoConfirm.ok === false, 'safety_restore requires confirm:true')
const restYes = await restTool.execute({ id: snapId, confirm: true })
check(restYes.ok === true, 'safety_restore restored from snapshot')

// safety_status
const statusTool = registeredTools.find((t) => t.name === 'safety_status')
const st = await statusTool.execute({})
check(st.ok === true && st.text.includes('home=' + home), 'safety_status reports home')

await fsp.rm(base, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} harness check(s) FAILED`)
  process.exit(1)
}
console.log('\nall harness checks passed')
