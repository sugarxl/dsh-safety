import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildPolicy,
  classify,
  destructiveTargetForCall,
  extractVariableRefFragments,
  isDriveRoot,
  isRecursiveDelete,
  isUnder,
  hasDestructiveVerb,
  extractShellPaths,
  utf8Valid,
  looksLikeMojibake,
  scanPatchIds,
  findDuplicateIds,
  ensureStateDirs,
  trashMove,
  trashRestore,
  trashList,
  createSnapshot,
  snapshotList,
  restoreSnapshot,
  validateComposition,
} from '../lib/safety-core.mjs'

const HOME = os.homedir()

function policyFor(protectedAbs, confirmAbs) {
  return {
    blockWriteRoots: [protectedAbs],
    confirmDeleteRoots: [confirmAbs],
  }
}

test('isUnder handles same-root, child, and sibling', () => {
  const root = path.join(HOME, 'x')
  assert.equal(isUnder(path.join(root, 'a'), root), true)
  assert.equal(isUnder(root, root), true)
  assert.equal(isUnder(path.join(HOME, 'y'), root), false)
  assert.equal(isUnder(path.join(root, 'a', 'b', 'c'), root), true)
})

test('classify maps protected/confirm/free', () => {
  const p = policyFor(path.join(HOME, 'cfg'), path.join(HOME, 'src'))
  assert.equal(classify(path.join(HOME, 'cfg', 'package.json'), p), 'protected')
  assert.equal(classify(path.join(HOME, 'src', 'lib', 'x.js'), p), 'confirm')
  assert.equal(classify(path.join(HOME, 'other', 'x.js'), p), 'free')
  assert.equal(isDriveRoot(path.join(HOME, 'x')), false)
  assert.equal(isDriveRoot('C:\\'), process.platform === 'win32')
})

test('hasDestructiveVerb recognizes shell deletes', () => {
  for (const c of [
    'Remove-Item -Recurse -Force C:\\x',
    'rm -rf /tmp/x',
    'rm C:\\x\\y',
    'del /q C:\\x',
    'rd /s /q C:\\x',
    'rmdir C:\\x',
    'git clean -fdx',
    '[System.IO.File]::Delete("C:\\x")',
    'node -e "fs.rmSync(\'C:/x\', {recursive:true})"',
    'python -c "shutil.rmtree(\'C:/x\')"',
    'npm prune',
  ]) {
    assert.equal(hasDestructiveVerb(c), true, `should detect: ${c}`)
  }
  for (const c of [
    'Get-ChildItem C:\\x',
    'pnpm install',
    'npm run build',
    'git status',
    'Copy-Item a b',
    'Get-Content package.json',
  ]) {
    assert.equal(hasDestructiveVerb(c), false, `should NOT detect: ${c}`)
  }
})

test('extractShellPaths pulls absolute and tilde paths', () => {
  const p = extractShellPaths('Remove-Item -Path "C:\\Users\\a\\.dsh\\x" -Recurse', HOME)
  assert.ok(p.some((x) => x.includes('.dsh')))
  const t = extractShellPaths('rm -rf ~/.dsh/profiles/web/node_modules', HOME)
  assert.ok(t.some((x) => x.includes('node_modules')), JSON.stringify(t))
})

test('isRecursiveDelete detects recursive shell deletes only', () => {
  const rec = [
    'Remove-Item -Recurse -Force C:\\x',
    'Remove-Item -r -Force C:\\x',
    'rd /s /q C:\\x',
    'rmdir /s C:\\x',
    'rm -rf /tmp/x',
    'rm -r /tmp/x',
    'rm -fr /tmp/x',
    'python -c "shutil.rmtree(\'C:/x\')"',
    'node -e "fs.rmSync(\'C:/x\', {recursive:true})"',
  ]
  for (const c of rec) assert.equal(isRecursiveDelete('pwsh', { command: c }) || isRecursiveDelete('bash', { command: c }), true, `should be recursive: ${c}`)
  const nonRec = [
    'Remove-Item -Force C:\\x\\file.txt',
    'del /q C:\\x\\file.txt',
    'rm C:\\x\\file.txt',
    'rm -f /tmp/file.txt',
    'node -e "fs.unlinkSync(\'C:/x/file\')"',
  ]
  for (const c of nonRec) assert.equal(isRecursiveDelete('pwsh', { command: c }) || isRecursiveDelete('bash', { command: c }), false, `should NOT be recursive: ${c}`)
})

test('destructiveTargetForCall blocks protected writes but not plugin-source edits', () => {
  const protectedAbs = path.join(HOME, '.dsh', 'profiles', 'web', 'package.json')
  const pluginsAbs = path.join(HOME, '.dsh', 'profiles', 'web', 'plugins')
  const p = policyFor(protectedAbs, pluginsAbs)

  const hit = destructiveTargetForCall('write', { file_path: protectedAbs }, p)
  assert.ok(hit && hit.action === 'deny' && hit.kind === 'write' && hit.cls === 'protected')

  const editPlugin = destructiveTargetForCall('edit', { file_path: path.join(pluginsAbs, 'dsh-x', 'lib', 'index.js') }, p)
  assert.equal(editPlugin.action, 'allow', 'plugin source edits are allowed')

  const freeWrite = destructiveTargetForCall('write', { file_path: path.join(HOME, 'tmp-free.js') }, p)
  assert.equal(freeWrite.action, 'allow')
})

test('destructiveTargetForCall blocks recursive + confirm-zone shell deletes', () => {
  const protectedAbs = path.join(HOME, '.dsh', 'profiles', 'web', 'node_modules')
  const pluginsAbs = path.join(HOME, '.dsh', 'profiles', 'web', 'plugins')
  const p = policyFor(protectedAbs, pluginsAbs)

  // recursive delete on a protected path → deny
  const a = destructiveTargetForCall('pwsh', { command: 'Remove-Item -Recurse -Force "C:\\Users\\a\\.dsh\\profiles\\web\\node_modules"' }, p)
  assert.equal(a.action, 'deny')
  assert.equal(a.recursive, true)

  // tilde + marker recursive → deny
  const b = destructiveTargetForCall('bash', { command: 'rm -rf ~/.dsh/profiles/web/node_modules' }, p)
  assert.equal(b.action, 'deny')

  // non-recursive file delete on a free path → allow
  const c = destructiveTargetForCall('pwsh', { command: 'Remove-Item -Force "C:\\Temp\\junk.txt"' }, p)
  assert.equal(c.action, 'allow')

  // non-recursive delete on a confirm-zone path → deny (route to safe_delete)
  const c2 = destructiveTargetForCall('pwsh', { command: `Remove-Item -Force "${path.join(pluginsAbs, 'x.js')}"` }, p)
  assert.equal(c2.action, 'deny')
  assert.equal(c2.cls, 'confirm')

  // recursive delete ANYWHERE (free path) → deny
  const c3 = destructiveTargetForCall('pwsh', { command: 'Remove-Item -Recurse -Force "C:\\Temp\\scratch"' }, p)
  assert.equal(c3.action, 'deny')
  assert.equal(c3.cls, 'recursive')

  // non-destructive read → allow
  const d = destructiveTargetForCall('pwsh', { command: 'Get-Content "C:\\Users\\a\\.dsh\\profiles\\web\\node_modules\\x"' }, p)
  assert.equal(d.action, 'allow')
})

test('destructiveTargetForCall denies non-recursive delete under a $HOME confirm zone', () => {
  const p = { blockWriteRoots: [], confirmDeleteRoots: [HOME] }
  const d = destructiveTargetForCall('pwsh', { command: `Remove-Item -Force "${path.join(HOME, 'something.txt')}"` }, p)
  assert.equal(d.action, 'deny')
  assert.equal(d.cls, 'confirm')
})

test('utf8 and mojibake detection', () => {
  assert.equal(utf8Valid(Buffer.from('hello 你好', 'utf8')), true)
  assert.equal(utf8Valid(Buffer.from([0xff, 0xfe, 0x00, 0xd8])), false)
  assert.equal(looksLikeMojibake('普通文本 ok'), false)
  assert.equal(looksLikeMojibake('鈥? 鈹€鈹?绉诲姩绔? 锟斤拷'), true)
})

test('patch id scanning and cross-layer duplicate detection', () => {
  const a = '- insert:\n    - id: foo\n    - id: bar\n'
  const b = '- insert:\n    - id: foo\n'
  assert.deepEqual(scanPatchIds(a).map((x) => x.id), ['foo', 'bar'])
  const dups = findDuplicateIds([{ file: 'a.yml', text: a }, { file: 'b.yml', text: b }])
  assert.equal(dups.length, 1)
  assert.equal(dups[0].id, 'foo')
  assert.equal(dups[0].locs.length, 2)
})

async function makeFakeHome() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-test-'))
  const home = path.join(base, 'home')
  const web = path.join(home, 'profiles', 'web')
  await fsp.mkdir(path.join(web, 'node_modules'), { recursive: true })
  await fsp.mkdir(path.join(web, 'plugins', 'p1', 'lib'), { recursive: true })
  await fsp.mkdir(path.join(home, '.agent-presets', 'pr1'), { recursive: true })
  writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } } }))
  writeFileSync(path.join(web, 'cordis.patch.yml'), '- insert:\n    - id: alpha\n')
  writeFileSync(path.join(web, 'plugins', 'p1', 'package.json'), JSON.stringify({ name: 'p1', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(path.join(web, 'plugins', 'p1', 'cordis.patch.yml'), '- insert:\n    - id: p1\n')
  writeFileSync(path.join(home, 'cordis.patch.yml'), '- insert:\n    - id: beta\n')
  writeFileSync(path.join(home, 'settings.yaml'), 'theme: dark\n')
  writeFileSync(path.join(home, '.agent-presets', 'pr1', 'agent.cordis.yml'), '- id: persona\n')
  return { base, home }
}

test('validateComposition flags mojibake, bad json and duplicate ids', async () => {
  const { home } = await makeFakeHome()
  // realistic GBK→UTF-8 mojibake (dense marker hits)
  writeFileSync(path.join(home, 'settings.yaml'), 'theme: 鈹€鈹?绉诲姩绔? 锟斤拷 stuff\n')
  writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), '{ not json')
  writeFileSync(path.join(home, 'cordis.patch.yml'), '- insert:\n    - id: alpha\n')
  const report = validateComposition(home)
  assert.equal(report.pass, false)
  assert.equal(report.duplicates.length, 1)
  assert.equal(report.duplicates[0].id, 'alpha')
  const bad = report.files.filter((f) => !f.ok)
  assert.ok(bad.some((f) => f.rel.endsWith('settings.yaml')), JSON.stringify(bad.map((f) => f.rel)))
  assert.ok(bad.some((f) => f.rel.endsWith('package.json')))
  await fsp.rm(path.dirname(home), { recursive: true, force: true })
})

test('validateComposition passes on a clean tree', async () => {
  const { base, home } = await makeFakeHome()
  writeFileSync(path.join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
  const report = validateComposition(home)
  assert.equal(report.pass, true)
  assert.equal(report.duplicates.length, 0)
  await fsp.rm(base, { recursive: true, force: true })
})

test('trash move/restore roundtrip', async () => {
  const { base, home } = await makeFakeHome()
  const victim = path.join(home, 'profiles', 'web', 'plugins', 'p1', 'lib', 'index.js')
  writeFileSync(victim, 'export const x = 1\n')
  await ensureStateDirs(home)
  const r = await trashMove(home, victim, { blockWriteRoots: [], confirmDeleteRoots: [] }, { op: 'test' })
  assert.equal(existsSync(victim), false)
  assert.ok(existsSync(r.trash))
  const restored = await trashRestore(home, r.id)
  assert.equal(restored.ok, true)
  assert.equal(existsSync(victim), true)
  assert.equal(await fsp.readFile(victim, 'utf8'), 'export const x = 1\n')
  assert.ok((await trashList(home)).length === 0)
  await fsp.rm(base, { recursive: true, force: true })
})

test('snapshot create/list/restore roundtrip', async () => {
  const { base, home } = await makeFakeHome()
  const file = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
  const before = await fsp.readFile(file, 'utf8')
  const snap = await createSnapshot(home, 'test')
  assert.ok((await snapshotList(home)).length >= 1)
  writeFileSync(file, '- insert:\n    - id: BROKEN\n')
  const restored = await restoreSnapshot(home, snap.id)
  assert.equal(restored.ok, true)
  assert.equal(await fsp.readFile(file, 'utf8'), before)
  await fsp.rm(base, { recursive: true, force: true })
})

test('buildPolicy produces the shared three-tier zones', () => {
  const home = path.join(HOME, '.dsh')
  const p = buildPolicy(home, { homeIsConfirm: false })
  assert.ok(Array.isArray(p.blockWriteRoots) && p.blockWriteRoots.length > 0)
  assert.ok(Array.isArray(p.confirmDeleteRoots) && p.confirmDeleteRoots.length > 0)
  // profiles root is always a confirm zone
  assert.ok(p.confirmDeleteRoots.some((r) => isUnder(path.join(home, 'profiles', 'web'), r)))
  // user extras merge in
  const p2 = buildPolicy(home, { homeIsConfirm: false, confirmDeleteRoots: [path.join(HOME, 'extra')], blockWriteRoots: [path.join(HOME, 'sacred')] })
  assert.equal(classify(path.join(HOME, 'extra', 'x'), p2), 'confirm')
  assert.equal(classify(path.join(HOME, 'sacred', 'y'), p2), 'protected')
})

test('extractVariableRefFragments catches env/percent refs with tail', () => {
  const frags = extractVariableRefFragments('Remove-Item -Recurse "$env:USERPROFILE\\.dsh\\profiles" -Force')
  assert.ok(frags.some((f) => f.toLowerCase().includes('.dsh')), JSON.stringify(frags))
  const pct = extractVariableRefFragments('rd /s "%APPDATA%\\npm\\node_modules\\@deepseek-ai"')
  assert.ok(pct.some((f) => f.toLowerCase().includes('appdata')), JSON.stringify(pct))
  const braces = extractVariableRefFragments('rm -rf ${HOME}/.dsh/profiles/web/node_modules')
  assert.ok(braces.some((f) => f.toLowerCase().includes('.dsh')), JSON.stringify(braces))
})

test('guard denies variable-ref deletes that expand into a protected zone', () => {
  const p = { home: HOME, blockWriteRoots: [path.join(HOME, '.dsh')], confirmDeleteRoots: [] }
  const d = destructiveTargetForCall('pwsh', { command: 'Remove-Item -Recurse -Force "$env:USERPROFILE\\.dsh\\profiles\\web"' }, p)
  assert.equal(d.action, 'deny')
  assert.equal(d.cls, 'var-ref')
})

test('guard scans run_code bodies for destructive protected calls', () => {
  const p = { home: HOME, blockWriteRoots: [path.join(HOME, '.dsh')], confirmDeleteRoots: [] }
  // direct recursive fs delete on a protected path inside the code body
  const d1 = destructiveTargetForCall('run_code', { code: `await tools.pwsh({command:'echo hi'});\nrequire('fs').rmSync(${JSON.stringify(path.join(HOME, '.dsh', 'profiles'))}, {recursive:true})` }, p)
  assert.equal(d1.action, 'deny')
  // shutil.rmtree on a protected marker
  const d2 = destructiveTargetForCall('run_code', { code: `import shutil\nshutil.rmtree('${path.join(HOME, '.dsh', 'profiles')}')` }, p)
  assert.equal(d2.action, 'deny')
  // harmless code without destructive verbs passes
  const d3 = destructiveTargetForCall('run_code', { code: `const x = 1; return x + 1` }, p)
  assert.equal(d3.action, 'allow')
})

test('restoreSnapshot is transactional: phase-B failure rolls back cleanly', async () => {
  const { base, home } = await makeFakeHome()
  const web = path.join(home, 'profiles', 'web')
  const file = path.join(web, 'cordis.patch.yml')
  const pkg = path.join(web, 'package.json')
  const pkgBefore = await fsp.readFile(pkg, 'utf8')
  const snap = await createSnapshot(home, 'tx')
  // live file diverges from the snapshot
  writeFileSync(file, '- insert:\n    - id: CORRUPTED\n')
  // break a LATER restore target so phase B fails AFTER earlier files restored:
  // replace the p1 package dir with a plain file (mkdir for p1/... will ENOTDIR)
  const p1 = path.join(web, 'plugins', 'p1')
  await fsp.rm(p1, { recursive: true, force: true })
  writeFileSync(p1, 'i am a file blocking the p1 dir\n')
  const res = await restoreSnapshot(home, snap.id)
  assert.equal(res.ok, false)
  // rollback: the earlier restored files are back to their pre-restore live state
  assert.equal(await fsp.readFile(file, 'utf8'), '- insert:\n    - id: CORRUPTED\n')
  assert.equal(await fsp.readFile(pkg, 'utf8'), pkgBefore)
  await fsp.rm(base, { recursive: true, force: true })
})
