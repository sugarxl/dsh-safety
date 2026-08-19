import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSymlink, isHardlink, realpath, refinePolicy, classifyRefined, detectSpecialMounts } from '../lib/policy.mjs'

test('isSymlink uses lstat and detects a real symlink', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-policy-'))
  const real = path.join(base, 'real')
  await fsp.writeFile(real, 'x')
  const link = path.join(base, 'link')
  try {
    symlinkSync(real, link)
  } catch {
    await fsp.rm(base, { recursive: true, force: true })
    return // symlinks unavailable on this host
  }
  assert.equal(await isSymlink(link), true)
  assert.equal(await isSymlink(real), false)
  await fsp.rm(base, { recursive: true, force: true })
})

test('refinePolicy keeps every root and adds realpaths (never drops protection)', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-policy-'))
  const protectedDir = path.join(base, 'protected')
  await fsp.mkdir(protectedDir, { recursive: true })
  const link = path.join(base, 'protected-link')
  let symlinkOk = true
  try {
    symlinkSync(protectedDir, link)
  } catch {
    symlinkOk = false
  }
  const basePolicy = {
    blockWriteRoots: [protectedDir, ...(symlinkOk ? [link] : [])],
    confirmDeleteRoots: [path.join(base, 'confirm')],
  }
  const refined = await refinePolicy(basePolicy, { excludeMounts: false })
  assert.ok(refined.blockWriteRoots.includes(protectedDir), 'literal root is kept')
  if (symlinkOk) {
    const real = await realpath(link)
    assert.ok(refined.blockWriteRoots.includes(real), 'realpath of a symlinked root is added')
  }
  assert.ok(Array.isArray(refined.specialMounts))
  // classifyRefined maps zones
  assert.equal(classifyRefined(path.join(protectedDir, 'package.json'), refined), 'protected')
  assert.equal(classifyRefined(path.join(base, 'confirm', 'x'), refined), 'confirm')
  assert.equal(classifyRefined(path.join(base, 'free', 'x'), refined), 'free')
  await fsp.rm(base, { recursive: true, force: true })
})

test('detectSpecialMounts always returns a Set', async () => {
  const mounts = await detectSpecialMounts()
  assert.ok(mounts instanceof Set)
})

test('isHardlink does not throw on a plain file', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-policy-'))
  const f = path.join(base, 'f.txt')
  await fsp.writeFile(f, 'hi')
  assert.equal(await isHardlink(f), false)
  await fsp.rm(base, { recursive: true, force: true })
})
