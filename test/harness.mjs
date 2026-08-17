/**
 * Integration harness for the dsh-safety HOST half, without a running DSH.
 * Imports the real `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-fs`, runs
 * `apply()` against a stub `ctx`, then exercises the guard, the fs waterfall,
 * and the registered tools. Run from the repo root:
 *
 *   node test/harness.mjs
 */

import { promises as fsp, mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, name, inject } from '../lib/index.js'

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
const webRoutes = []
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
  webServer: {
    register(r) { webRoutes.push(r); return () => {} },
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
check(Array.isArray(inject) && inject.includes('tools'), 'inject declares tools')
check(sections.some((s) => s.name === 'safety:policy'), 'policy section registered')
check(webRoutes.some((r) => r.path === '/safety/api'), '/safety/api route registered')
check(listeners.has('fs/write-intent') && listeners.has('fs/edit-intent'), 'fs waterfall listeners registered')

const toolNames = registeredTools.map((t) => t.name)
for (const expected of ['safe_delete', 'safety_trash', 'safety_undo', 'safety_snapshot', 'safety_restore', 'safety_check', 'safety_journal', 'safety_status']) {
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

// safe_delete: refuses confirm-zone paths without force
const safeDelete = registeredTools.find((t) => t.name === 'safe_delete')
const pluginFile = path.join(web, 'plugins', 'p1', 'lib', 'index.js')
const refused = await safeDelete.execute({ path: pluginFile })
check(refused.ok === false && refused.error.includes('confirm'), 'safe_delete refuses confirm path without force')

// safe_delete: refuses the plugin's own state dir
const stateRefusal = await safeDelete.execute({ path: path.join(home, '.dsh-safety') })
check(stateRefusal.ok === false && stateRefusal.error.includes('state'), 'safe_delete refuses its own state dir')

const forced = await safeDelete.execute({ path: pluginFile, force: true })
check(forced.ok === true && forced.text.includes('moved to trash'), 'safe_delete moves confirm path to trash with force:true')

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
check(snap.ok === true && /snapshot [\d-]+-harness: \d+ file/.test(snap.text), 'safety_snapshot created snapshot')
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
