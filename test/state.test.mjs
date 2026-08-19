import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadState,
  saveState,
  recordBlock,
  getBlockCounts,
  getTotalBlocks,
  stateFile,
  createApproval,
  grantApproval,
  grantApprovalFor,
  revokeApproval,
  consumeApproval,
  hasActiveApproval,
  listApprovals,
  activeApprovals,
} from '../lib/state.mjs'

async function makeHome() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-state-'))
  const home = path.join(base, 'home')
  await fsp.mkdir(home, { recursive: true })
  return { base, home }
}

test('loadState returns a usable default when no state file exists', async () => {
  const { base, home } = await makeHome()
  const s = loadState(home)
  assert.equal(s.bootCount, 0)
  assert.deepEqual(s.guard.blocks, {})
  assert.deepEqual(s.guard.sessions, [])
  assert.deepEqual(s.approvals.list, [])
  assert.equal(existsSync(stateFile(home)), false, 'reading must not create the file')
  await fsp.rm(base, { recursive: true, force: true })
})

test('recordBlock coalesces and persists per-tool counts and session ids', async () => {
  const { base, home } = await makeHome()
  await recordBlock(home, 'write', 'sess-1', 'denied', '/x')
  await recordBlock(home, 'write', 'sess-1', 'denied', '/x')
  await recordBlock(home, 'pwsh', 'sess-2', 'denied', '/y')
  // merged read sees the counters immediately (before the coalesced flush)
  assert.equal(getBlockCounts(home).write, 2)
  assert.equal(getBlockCounts(home).pwsh, 1)
  assert.equal(getTotalBlocks(home), 3)
  // after the setImmediate flush, the disk reflects them too
  await new Promise((r) => setImmediate(r))
  const s = loadState(home)
  assert.equal(s.guard.blocks.write, 2)
  assert.equal(s.guard.blocks.pwsh, 1)
  assert.deepEqual(s.guard.sessions, ['sess-1', 'sess-2'])
  await fsp.rm(base, { recursive: true, force: true })
})

test('recordBlock flush never clobbers concurrently-created approvals (race regression)', async () => {
  const { base, home } = await makeHome()
  const req = createApproval(home, { kind: 'delete', target: '/x', requestedBy: 'agent' })
  grantApproval(home, req.id, { grantedBy: 'user' })
  await recordBlock(home, 'write', 'sess-1', 'denied', '/x')
  await new Promise((r) => setImmediate(r))
  assert.equal(consumeApproval(home, { kind: 'delete', target: '/x' }), true, 'approval survived the block-count flush')
  await fsp.rm(base, { recursive: true, force: true })
})

test('createApproval stores the system-computed consequence separately from the model narrative', async () => {
  const { base, home } = await makeHome()
  const req = createApproval(home, {
    kind: 'delete',
    target: '/x',
    requestedBy: 'agent',
    what: 'a harmless cache dir',
    why: 'cleanup',
    consequence: 'no impact', // model self-report — unverifiable
    systemNote: 'This is inside a confirm-delete zone: deletes need the USER\'s explicit approval.', // system verdict
  })
  const loaded = listApprovals(home).find((r) => r.id === req.id)
  assert.equal(loaded.systemNote.includes('confirm-delete zone'), true, 'system note is authoritative')
  assert.equal(loaded.what, 'a harmless cache dir', 'model narrative kept separately, not merged')
  assert.equal(loaded.consequence, 'no impact', 'model self-report preserved but clearly separable')
  await fsp.rm(base, { recursive: true, force: true })
})

test('a recursive approval with a Windows-style literal target covers its subtree on every platform', async () => {
  const { base, home } = await makeHome()
  // literal Windows-style target, exactly as the harness/CLI `allow --path`
  // flow can produce — must cover its subtree even on POSIX (keyOf normalizes
  // backslashes; previously `\sub` vs `/` made the prefix match fail on Linux)
  grantApprovalFor(home, { kind: 'delete', target: 'C:\\Temp\\coop-project', recursive: true, grantedBy: 'cli-user' })
  assert.equal(
    consumeApproval(home, { kind: 'delete', target: 'C:\\Temp\\coop-project\\sub\\build', recursive: true }),
    true,
    'subtree covered with Windows-style literal paths on every platform'
  )
  await fsp.rm(base, { recursive: true, force: true })
})

test('approval writes run under the cross-process lock (lock is cleaned up; stale holder is stolen)', async () => {
  const { base, home } = await makeHome()
  const lockDir = path.join(home, '.dsh-safety', '.approval-lock')
  const req = createApproval(home, { kind: 'delete', target: '/x', requestedBy: 'agent' })
  assert.equal(existsSync(lockDir), false, 'lock is released after a normal create')
  grantApproval(home, req.id, { grantedBy: 'user' })
  assert.equal(existsSync(lockDir), false, 'lock is released after a normal grant')
  // a held (crashed-holder) lock is force-stolen after the retry window
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(path.join(lockDir, 'stamp'), String(Date.now() - 60_000), 'utf8')
  assert.equal(consumeApproval(home, { kind: 'delete', target: '/x' }), true, 'held lock is stolen and the consume still works')
  assert.equal(existsSync(lockDir), false, 'lock is released after the stolen acquire')
  await fsp.rm(base, { recursive: true, force: true })
})

test('approval lifecycle: create -> grant -> consume (one-shot, exact match)', async () => {
  const { base, home } = await makeHome()
  const target = path.join(home, 'sensitive.txt')

  // not granted yet -> no consume
  const req = createApproval(home, { kind: 'delete', target, requestedBy: 'agent', what: 'a config file', why: 'cleanup' })
  assert.equal(consumeApproval(home, { kind: 'delete', target }), false, 'ungranted approval cannot be consumed')

  // grant, then consume exactly once
  const g = grantApproval(home, req.id, { grantedBy: 'user' })
  assert.equal(g.ok, true)
  assert.equal(consumeApproval(home, { kind: 'delete', target }), true, 'granted approval consumes')
  assert.equal(consumeApproval(home, { kind: 'delete', target }), false, 'approval is one-shot')

  // wrong kind / wrong target do not match
  const req2 = createApproval(home, { kind: 'delete', target })
  grantApproval(home, req2.id, { grantedBy: 'user' })
  assert.equal(consumeApproval(home, { kind: 'write', target }), false, 'kind must match')
  assert.equal(consumeApproval(home, { kind: 'delete', target: path.join(home, 'other.txt') }), false, 'target must match')
  assert.equal(consumeApproval(home, { kind: 'delete', target }), true, 'the right call still consumes')

  await fsp.rm(base, { recursive: true, force: true })
})

test('recursive approvals: flag must match, target may be null (generic)', async () => {
  const { base, home } = await makeHome()
  const dir = path.join(home, 'scratch')

  // generic recursive approval (target null) covers a recursive delete anywhere
  grantApprovalFor(home, { kind: 'delete', target: null, recursive: true, grantedBy: 'cli-user' })
  assert.equal(consumeApproval(home, { kind: 'delete', target: dir, recursive: true }), true)
  // it must NOT cover a non-recursive (file) delete
  grantApprovalFor(home, { kind: 'delete', target: null, recursive: true, grantedBy: 'cli-user' })
  assert.equal(consumeApproval(home, { kind: 'delete', target: dir, recursive: false }), false, 'recursive approval never covers a file delete')
  // and a non-recursive approval never covers a recursive delete (consume the
  // leftover generic approval first so it cannot interfere)
  assert.equal(consumeApproval(home, { kind: 'delete', target: dir, recursive: true }), true, 'leftover generic approval consumed')
  const req = createApproval(home, { kind: 'delete', target: dir, recursive: false })
  grantApproval(home, req.id, { grantedBy: 'user' })
  assert.equal(consumeApproval(home, { kind: 'delete', target: dir, recursive: true }), false, 'non-recursive approval never covers a recursive delete')
  await fsp.rm(base, { recursive: true, force: true })
})

test('approval target matching is case-insensitive on Windows (keyOf parity)', async () => {
  const { base, home } = await makeHome()
  const target = path.join(home, 'Sensitive.txt')
  const req = createApproval(home, { kind: 'delete', target })
  assert.equal(grantApproval(home, req.id, { grantedBy: 'user' }).ok, true)
  // On Windows, classification is case-insensitive, so approval matching must
  // be too; on POSIX the comparison stays exact.
  const altCase = process.platform === 'win32' ? target.toLowerCase() : target + '-different'
  assert.equal(consumeApproval(home, { kind: 'delete', target: altCase }), process.platform === 'win32')
  await fsp.rm(base, { recursive: true, force: true })
})

test('a recursive approval covers the approved root AND anything under it', async () => {
  const { base, home } = await makeHome()
  const root = path.join(home, 'scratch')
  const child = path.join(root, 'sub', 'dir')
  grantApprovalFor(home, { kind: 'delete', target: root, recursive: true, grantedBy: 'cli-user' })
  assert.equal(consumeApproval(home, { kind: 'delete', target: child, recursive: true }), true, 'parent approval covers a subtree delete')
  // a sibling is NOT covered
  grantApprovalFor(home, { kind: 'delete', target: root, recursive: true, grantedBy: 'cli-user' })
  assert.equal(consumeApproval(home, { kind: 'delete', target: path.join(home, 'other'), recursive: true }), false, 'sibling is not covered')
  // the generic (target null) approval still covers everything
  grantApprovalFor(home, { kind: 'delete', target: null, recursive: true, grantedBy: 'cli-user' })
  assert.equal(consumeApproval(home, { kind: 'delete', target: path.join(home, 'anywhere'), recursive: true }), true)
  await fsp.rm(base, { recursive: true, force: true })
})

test('approvals list is capped so safety_ask spam cannot grow state unbounded', async () => {
  const { base, home } = await makeHome()
  for (let i = 0; i < 600; i++) {
    createApproval(home, { kind: 'delete', target: path.join(home, 'x' + i), requestedBy: 'agent' })
  }
  assert.equal(listApprovals(home).length, 200, 'pending requests are capped at 200 (newest kept)')
  await fsp.rm(base, { recursive: true, force: true })
})

test('compaction never drops a granted-but-unexpired approval', async () => {
  const { base, home } = await makeHome()
  // grant one approval first, then flood with 600 pending requests
  const granted = createApproval(home, { kind: 'delete', target: path.join(home, 'precious'), requestedBy: 'agent' })
  grantApproval(home, granted.id, { grantedBy: 'user' })
  for (let i = 0; i < 600; i++) {
    createApproval(home, { kind: 'delete', target: path.join(home, 'x' + i), requestedBy: 'agent' })
  }
  const approvals = listApprovals(home)
  assert.equal(approvals.some((r) => r.id === granted.id), true, 'the live user grant survives compaction')
  assert.equal(consumeApproval(home, { kind: 'delete', target: path.join(home, 'precious') }), true, 'the preserved grant still consumes')
  await fsp.rm(base, { recursive: true, force: true })
})

test('a write approval is always non-recursive (no unconsumable dead records)', async () => {
  const { base, home } = await makeHome()
  const req = createApproval(home, { kind: 'write', target: '/x', recursive: true, requestedBy: 'agent' })
  assert.equal(req.recursive, false, 'write approvals normalize recursive to false')
  grantApproval(home, req.id, { grantedBy: 'user' })
  assert.equal(consumeApproval(home, { kind: 'write', target: '/x', recursive: false }), true, 'the write waterfall can consume it')
  await fsp.rm(base, { recursive: true, force: true })
})

test('hasActiveApproval is non-consuming and matches granted approvals', async () => {
  const { base, home } = await makeHome()
  const target = path.join(home, 'write.txt')
  const req = createApproval(home, { kind: 'write', target, requestedBy: 'agent' })
  // not granted yet -> no active approval
  assert.equal(hasActiveApproval(home, { kind: 'write', target }), false)
  grantApproval(home, req.id, { grantedBy: 'user' })
  assert.equal(hasActiveApproval(home, { kind: 'write', target }), true)
  assert.equal(hasActiveApproval(home, { kind: 'delete', target }), false, 'kind must match')
  // non-consuming: the approval is still consumable afterwards
  assert.equal(consumeApproval(home, { kind: 'write', target }), true)
  assert.equal(hasActiveApproval(home, { kind: 'write', target }), false, 'consumed approval is no longer active')
  await fsp.rm(base, { recursive: true, force: true })
})

test('grant + revoke + expiry bookkeeping', async () => {
  const { base, home } = await makeHome()
  const req = createApproval(home, { kind: 'write', target: '/x', requestedBy: 'agent' })
  assert.equal(activeApprovals(home).length, 1)
  const r = revokeApproval(home, req.id)
  assert.equal(r.ok, true)
  assert.equal(activeApprovals(home).length, 0, 'revoked requests are not active')
  assert.equal(consumeApproval(home, { kind: 'write', target: '/x' }), false)

  // granted with a tiny TTL -> expires and cannot be consumed
  const req2 = createApproval(home, { kind: 'delete', target: '/y' })
  grantApproval(home, req2.id, { grantedBy: 'user', ttlMs: 1 })
  await new Promise((r2) => setTimeout(r2, 10))
  assert.equal(consumeApproval(home, { kind: 'delete', target: '/y' }), false, 'expired approval cannot be consumed')
  await fsp.rm(base, { recursive: true, force: true })
})
