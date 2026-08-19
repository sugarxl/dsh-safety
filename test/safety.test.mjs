import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildPolicy,
  classify,
  classifyWithReal,
  destructiveTargetForCall,
  extractVariableRefFragments,
  isDriveRoot,
  isRecursiveDelete,
  isUnder,
  hasDestructiveVerb,
  extractShellPaths,
  resolveVariableRefs,
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

test('trashRestore rejects path-traversal ids (safety_undo cannot touch files outside trash)', async () => {
  const { base, home } = await makeFakeHome()
  await ensureStateDirs(home)
  // An id like `../../escape-file.txt` would resolve OUTSIDE the trash dir if
  // it were blindly path.join'ed — it must be rejected outright.
  const marker = path.join(path.dirname(home), 'escape-file.txt')
  writeFileSync(marker, 'DO NOT TOUCH')
  const r = await trashRestore(home, '../../escape-file.txt')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'invalid-id')
  assert.equal(existsSync(marker), true, 'file outside the trash dir is untouched')
  await fsp.rm(base, { recursive: true, force: true })
})

test('restoreSnapshot rejects path-traversal ids', async () => {
  const { base, home } = await makeFakeHome()
  await ensureStateDirs(home)
  const r = await restoreSnapshot(home, '../../escape')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'invalid-id')
  await fsp.rm(base, { recursive: true, force: true })
})

test('run_code bodies with explicit protected/confirm absolute paths are denied (parity with shell)', () => {
  const protectedAbs = path.join(HOME, '.dsh', 'profiles', 'web', 'package.json')
  const confirmAbs = path.join(HOME, '.dsh', 'profiles', 'web', 'plugins', 'p1', 'lib', 'index.js')
  const p = { home: HOME, blockWriteRoots: [path.join(HOME, '.dsh', 'profiles', 'web', 'package.json')], confirmDeleteRoots: [path.join(HOME, '.dsh', 'profiles', 'web', 'plugins')] }
  // non-recursive unlink on a protected path, NO marker substring, NO recursion
  const d1 = destructiveTargetForCall('run_code', { code: `require('fs').unlinkSync(${JSON.stringify(protectedAbs)})` }, p)
  assert.equal(d1.action, 'deny')
  assert.equal(d1.cls, 'protected')
  // non-recursive unlink on a confirm-zone path (plugin source)
  const d2 = destructiveTargetForCall('run_code', { code: `import { unlinkSync } from 'node:fs'\nunlinkSync(${JSON.stringify(confirmAbs)})` }, p)
  assert.equal(d2.action, 'deny')
  assert.equal(d2.cls, 'confirm')
})

test('resolveVariableRefs normalizes Windows-style tails to platform separators', () => {
  const customHome = path.join(HOME, 'custom-dsh-home')
  const p = { home: customHome, blockWriteRoots: [path.join(customHome, 'profiles')], confirmDeleteRoots: [] }
  const resolved = resolveVariableRefs('Remove-Item -Force "%DSH_HOME%\\profiles\\web\\plugins\\p1\\lib\\x.js"', p)
  assert.ok(resolved.length > 0, 'the %DSH_HOME% reference resolves')
  // Regression for the Linux CI failure: a literal backslash in the tail used
  // to survive path.join on POSIX as one weird filename component, so the
  // resolved path never matched the protected root (cls came back 'var-ref'
  // instead of 'protected').
  for (const r of resolved) {
    assert.equal(r.includes('\\'), process.platform === 'win32', 'backslashes are normalized on POSIX')
  }
  const d = destructiveTargetForCall('pwsh', { command: 'Remove-Item -Force "%DSH_HOME%\\profiles\\web\\plugins\\p1\\lib\\x.js"' }, p)
  assert.equal(d.action, 'deny')
  assert.equal(d.cls, 'protected', 'resolved path classifies as protected on every platform')
})

test('variable refs that resolve into the DSH home are denied even without a protected marker', () => {
  // A custom DSH_HOME whose name contains no protected marker substring
  // (no ".dsh", no "node_modules", no "package.json" in the path text).
  const customHome = path.join(HOME, 'custom-dsh-home')
  const p = { home: customHome, blockWriteRoots: [path.join(customHome, 'profiles')], confirmDeleteRoots: [] }
  // `$env:DSH_HOME\scratch.txt` — no marker in the fragment, only resolvable
  const d = destructiveTargetForCall('pwsh', { command: `Remove-Item -Force "$env:DSH_HOME\\scratch.txt"` }, p)
  assert.equal(d.action, 'deny')
  assert.equal(d.cls, 'var-ref')
  // and a percent-style reference into a protected profile path
  const d2 = destructiveTargetForCall('pwsh', { command: `Remove-Item -Force "%DSH_HOME%\\profiles\\web\\plugins\\p1\\lib\\x.js"` }, p)
  assert.equal(d2.action, 'deny')
  assert.equal(d2.cls, 'protected')
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
  // BARE fs call after `import { rmSync } from 'node:fs'` — no `.` prefix
  const d4 = destructiveTargetForCall('run_code', { code: `import { rmSync } from 'node:fs'\nrmSync(${JSON.stringify(path.join(HOME, '.dsh', 'profiles'))}, { recursive: true })` }, p)
  assert.equal(d4.action, 'deny', 'bare rmSync (after import) must be caught')
  // bare unlinkSync on a protected path
  const d5 = destructiveTargetForCall('run_code', { code: `import { unlinkSync } from 'node:fs'\nunlinkSync(${JSON.stringify(path.join(HOME, '.dsh', 'profiles', 'settings.yaml'))})` }, p)
  assert.equal(d5.action, 'deny', 'bare unlinkSync (after import) must be caught')
  // harmless code without destructive verbs passes
  const d3 = destructiveTargetForCall('run_code', { code: `const x = 1; return x + 1` }, p)
  assert.equal(d3.action, 'allow')
})

test('rm --recursive is recognized as a recursive delete', () => {
  assert.equal(isRecursiveDelete('bash', { command: 'rm --recursive /tmp/project' }), true)
})

test('new destructive verbs: [IO.File]::Delete, git rm, and the ri alias', () => {
  for (const c of [
    '[IO.File]::Delete("C:\\x")', // System. prefix omitted
    '[System.IO.File]::Delete("C:\\x")', // full prefix still works
    '[IO.Directory]::Delete("C:\\x", $true)',
    'git rm C:\\x\\y.txt',
    'git rm -r C:\\x',
    'ri "C:\\x"', // PowerShell Remove-Item alias
  ]) {
    assert.equal(hasDestructiveVerb(c), true, `should detect: ${c}`)
  }
  assert.equal(hasDestructiveVerb('git status'), false)
  assert.equal(hasDestructiveVerb('git add .'), false)
})

test('extractShellPaths also captures forward-slash Windows paths', () => {
  const p = extractShellPaths('Remove-Item -Force "C:/Users/a/.dsh/profiles/web/package.json"', HOME)
  assert.ok(p.some((x) => x.toLowerCase().includes('.dsh')), JSON.stringify(p))
  const c = extractShellPaths('Remove-Item -Force "C:/Users/a/Documents/x.txt"', HOME)
  assert.ok(c.some((x) => x.toLowerCase().includes('documents')), JSON.stringify(c))
})

test('str_replace_editor delete command is classified as a delete, not ignored', () => {
  const protectedAbs = path.join(HOME, '.dsh', 'profiles', 'web', 'package.json')
  const p = { blockWriteRoots: [path.join(HOME, '.dsh')], confirmDeleteRoots: [] }
  const d = destructiveTargetForCall('str_replace_editor', { path: protectedAbs, command: 'delete' }, p)
  assert.equal(d.action, 'deny')
  assert.equal(d.kind, 'delete')
  assert.equal(d.cls, 'protected')
})

test('run_code WRITES to protected paths are denied (write guard bypass closed)', () => {
  const protectedAbs = path.join(HOME, '.dsh', 'profiles', 'web', 'package.json')
  const p = { home: HOME, blockWriteRoots: [path.join(HOME, '.dsh')], confirmDeleteRoots: [] }
  // fs.writeFileSync on a protected path — no delete verb anywhere
  const d1 = destructiveTargetForCall('run_code', { code: `require('fs').writeFileSync(${JSON.stringify(protectedAbs)}, '{}')` }, p)
  assert.equal(d1.action, 'deny')
  assert.equal(d1.kind, 'write')
  assert.equal(d1.cls, 'protected')
  // a relative write whose path is not extractable is a documented limitation
  // (no marker fallback for writes — see safety-core), but the absolute
  // spelling under a different protected file is still caught
  const d2 = destructiveTargetForCall('run_code', { code: `fs.writeFileSync(${JSON.stringify(path.join(HOME, '.dsh', 'cordis.patch.yml'))}, 'x')` }, p)
  assert.equal(d2.action, 'deny')
  assert.equal(d2.kind, 'write')
  // writes to a confirm-zone path stay allowed (edits are permitted)
  const confirmAbs = path.join(HOME, '.dsh', 'profiles', 'web', 'plugins', 'p1', 'lib', 'index.js')
  const p2 = { home: HOME, blockWriteRoots: [path.join(HOME, '.dsh', 'profiles', 'web', 'package.json')], confirmDeleteRoots: [path.join(HOME, '.dsh', 'profiles', 'web', 'plugins')] }
  const d3 = destructiveTargetForCall('run_code', { code: `fs.writeFileSync(${JSON.stringify(confirmAbs)}, 'x')` }, p2)
  assert.equal(d3.action, 'allow')
})

test('recursive free-path deny carries the explicit target (so cooperative approvals can match)', () => {
  const p = { home: HOME, blockWriteRoots: [], confirmDeleteRoots: [] }
  // with an explicit path: abs is carried
  const withPath = destructiveTargetForCall('pwsh', { command: 'Remove-Item -Recurse -Force "C:\\Temp\\scratch"' }, p)
  assert.equal(withPath.action, 'deny')
  assert.equal(withPath.cls, 'recursive')
  assert.ok(withPath.abs !== null, 'explicit recursive target is carried in abs')
  // without any path: abs stays null (only a generic approval could match)
  const noPath = destructiveTargetForCall('pwsh', { command: 'Remove-Item -Recurse -Force' }, p)
  assert.equal(noPath.action, 'deny')
  assert.equal(noPath.abs, null)
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

test('isDriveRoot recognizes the OS filesystem root (including POSIX /)', () => {
  const root = process.platform === 'win32' ? 'C:\\' : '/'
  assert.equal(isDriveRoot(root), true)
  assert.equal(isDriveRoot(path.join(HOME, 'x')), false)
})

test('str_replace_editor writes are blocked on protected paths via the `path` argument', () => {
  const protectedAbs = path.join(HOME, '.dsh', 'profiles', 'web', 'package.json')
  const p = { blockWriteRoots: [path.join(HOME, '.dsh')], confirmDeleteRoots: [] }
  // the real editor tool passes { path, command }, not { file_path }
  const hit = destructiveTargetForCall('str_replace_editor', { path: protectedAbs, command: 'str_replace', old_string: 'a', new_string: 'b' }, p)
  assert.equal(hit.action, 'deny')
  assert.equal(hit.kind, 'write')
  // view is a read — must stay allowed
  const view = destructiveTargetForCall('str_replace_editor', { path: protectedAbs, command: 'view' }, p)
  assert.equal(view.action, 'allow')
  // create on a free path stays allowed
  const createFree = destructiveTargetForCall('str_replace_editor', { path: path.join(HOME, 'tmp-free.js'), command: 'create', file_text: 'x' }, p)
  assert.equal(createFree.action, 'allow')
})

test('classifyWithReal blocks symlinks that resolve into a protected zone', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-sym-'))
  const protectedDir = path.join(base, 'protected')
  await fsp.mkdir(protectedDir, { recursive: true })
  const p = { blockWriteRoots: [protectedDir], confirmDeleteRoots: [] }
  // literal path is outside the protected zone, but the symlink points into it
  const link = path.join(base, 'escape-link')
  try {
    symlinkSync(protectedDir, link)
  } catch (e) {
    await fsp.rm(base, { recursive: true, force: true })
    return // symlinks unavailable on this host (e.g. no privilege) — skip
  }
  const target = path.join(link, 'package.json')
  assert.equal(classify(target, p), 'free', 'literal path alone looks free')
  assert.equal(classifyWithReal(target, p), 'protected', 'realpath resolves into the protected zone')
  const d = destructiveTargetForCall('write', { file_path: target }, p)
  assert.equal(d.action, 'deny', 'write through the symlink must be blocked')
  await fsp.rm(base, { recursive: true, force: true })
})

test('classifyWithReal closes the symlinked-PARENT escape for not-yet-existing files', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-symparent-'))
  const protectedDir = path.join(base, 'protected')
  await fsp.mkdir(protectedDir, { recursive: true })
  const p = { blockWriteRoots: [protectedDir], confirmDeleteRoots: [] }
  const link = path.join(base, 'escape-link')
  try {
    symlinkSync(protectedDir, link)
  } catch (e) {
    await fsp.rm(base, { recursive: true, force: true })
    return // symlinks unavailable — skip
  }
  // The target does NOT exist yet (a file about to be created). The literal
  // path is free, but its deepest existing ancestor (the link) resolves into
  // the protected zone, so a write here must be classified protected.
  const target = path.join(link, 'new-file.txt')
  assert.equal(existsSync(target), false, 'target does not exist yet')
  assert.equal(classify(target, p), 'free', 'literal path alone looks free')
  assert.equal(classifyWithReal(target, p), 'protected', 'symlinked parent resolves into protected')
  const d = destructiveTargetForCall('write', { file_path: target }, p)
  assert.equal(d.action, 'deny', 'write through a symlinked parent must be blocked')
  await fsp.rm(base, { recursive: true, force: true })
})

test('del /s and erase /s are recursive; rmSync accepts {recursive:1} and {recursive:!0}', () => {
  assert.equal(isRecursiveDelete('pwsh', { command: 'del /s /q "C:\\Temp\\x"' }), true)
  assert.equal(isRecursiveDelete('pwsh', { command: 'erase /s /q "C:\\Temp\\x"' }), true)
  assert.equal(isRecursiveDelete('bash', { command: "require('fs').rmSync('C:/x', { recursive: 1 })" }), true)
  assert.equal(isRecursiveDelete('bash', { command: "rmSync('C:/x', { recursive: !0 })" }), true)
  assert.equal(isRecursiveDelete('pwsh', { command: 'del /q "C:\\Temp\\x\\file.txt"' }), false, 'plain del stays non-recursive')
})

test('extractShellPaths captures quoted -Path values that contain spaces', () => {
  const p = extractShellPaths('Remove-Item -LiteralPath "C:\\Users\\a\\my file.txt" -Force', HOME)
  assert.ok(p.some((x) => x.toLowerCase().includes('my file.txt')), JSON.stringify(p))
  const q = extractShellPaths("Remove-Item -Path 'C:/Users/a/my other file.txt'", HOME)
  assert.ok(q.some((x) => x.toLowerCase().includes('my other file.txt')), JSON.stringify(q))
})

test('scanPatchIds handles quoted ids and trailing inline comments', () => {
  const text = '- insert:\n    - id: "quoted-id"\n    - id: plain-id # trailing comment\n    - id: 2nd-quoted # with comment\n'
  const ids = scanPatchIds(text)
  assert.deepEqual(ids.map((x) => x.id), ['quoted-id', 'plain-id', '2nd-quoted'])
  // duplicates across layers are still found when comments are present
  const dups = findDuplicateIds([
    { file: 'a.yml', text: '- insert:\n    - id: dup # comment\n' },
    { file: 'b.yml', text: '- insert:\n    - id: dup\n' },
  ])
  assert.equal(dups.length, 1)
  assert.equal(dups[0].id, 'dup')
})

test('restoreSnapshot refuses to restore a corrupt snapshot (checksum gate)', async () => {
  const { base, home } = await makeFakeHome()
  const file = path.join(home, 'profiles', 'web', 'cordis.patch.yml')
  const snap = await createSnapshot(home, 'integrity')
  // tamper with the snapshot's copy — the manifest hash no longer matches
  const snapCopy = path.join(home, '.dsh-safety', 'snapshots', snap.id, 'profiles', 'web', 'cordis.patch.yml')
  await fsp.writeFile(snapCopy, '- insert:\n    - id: TAMPERED\n')
  // diverge the live file too, so a restore would otherwise be performed
  await fsp.writeFile(file, '- insert:\n    - id: BROKEN\n')
  const res = await restoreSnapshot(home, snap.id)
  assert.equal(res.ok, false)
  assert.match(res.error, /checksum mismatch/)
  // rollback: live file untouched (still the BROKEN version), never half-restored
  assert.equal(await fsp.readFile(file, 'utf8'), '- insert:\n    - id: BROKEN\n')
  await fsp.rm(base, { recursive: true, force: true })
})

test('createSnapshot ids are unique even for same-second same-label snapshots', async () => {
  const { base, home } = await makeFakeHome()
  const a = await createSnapshot(home, 'same-label')
  const b = await createSnapshot(home, 'same-label')
  assert.notEqual(a.id, b.id, 'two snapshots in the same second must not collide')
  assert.equal((await snapshotList(home)).length, 2)
  await fsp.rm(base, { recursive: true, force: true })
})

test('createSnapshot works on an empty home (no composition files yet)', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-empty-'))
  const home = path.join(base, 'home')
  await fsp.mkdir(home, { recursive: true })
  const snap = await createSnapshot(home, 'empty')
  assert.equal(snap.files.length, 0)
  assert.ok(existsSync(path.join(home, '.dsh-safety', 'snapshots', snap.id, 'manifest.json')))
  assert.equal((await snapshotList(home)).length, 1)
  await fsp.rm(base, { recursive: true, force: true })
})

test('restoreSnapshot refuses a manifest that escapes the home dir', async () => {
  const { base, home } = await makeFakeHome()
  await ensureStateDirs(home)
  const evilId = '00000000-000000-evil'
  const evilDir = path.join(home, '.dsh-safety', 'snapshots', evilId)
  await fsp.mkdir(evilDir, { recursive: true })
  await fsp.writeFile(
    path.join(evilDir, 'manifest.json'),
    JSON.stringify({ id: evilId, at: new Date().toISOString(), label: 'evil', files: [{ rel: '../escape-target.txt' }] }),
    'utf8'
  )
  const marker = path.join(home, '..', 'escape-target.txt')
  writeFileSync(marker, 'DO NOT TOUCH')
  const res = await restoreSnapshot(home, evilId)
  assert.equal(res.ok, false)
  assert.match(res.error, /unsafe manifest entry/)
  assert.equal(await fsp.readFile(marker, 'utf8'), 'DO NOT TOUCH', 'nothing outside home was touched')
  await fsp.rm(base, { recursive: true, force: true })
})
