import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  scanDir,
  diffManifests,
  buildBaselineSnapshot,
  buildIncrementalSnapshot,
  saveSnapshotRecord,
  loadSnapshotRecord,
  listSnapshotDirs,
  getLatestBaseline,
  getLatestIncremental,
  getCombinedManifest,
  dirTreeChecksum,
  snapshotsDir,
} from '../lib/snapshot-store.mjs'

async function makeHome() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-snap-'))
  const home = path.join(base, 'home')
  await fsp.mkdir(home, { recursive: true })
  return { base, home }
}

test('scanDir honors maxDepth and returns checksums', async () => {
  const { base, home } = await makeHome()
  const root = path.join(home, 'tree')
  await fsp.mkdir(path.join(root, 'a', 'b'), { recursive: true })
  await fsp.writeFile(path.join(root, 'a', 'top.txt'), 'top')
  await fsp.writeFile(path.join(root, 'a', 'b', 'deep.txt'), 'deep')

  const shallow = await scanDir(root, 0)
  assert.equal(shallow.length, 0, 'maxDepth 0 means current dir only (files are in subdirs)')

  const depth1 = await scanDir(root, 1)
  assert.ok(depth1.some((e) => e.rel === 'a' + path.sep + 'top.txt'))
  assert.ok(!depth1.some((e) => e.rel.includes('deep.txt')), 'depth 1 must not reach depth 2')

  const full = await scanDir(root, 10)
  assert.equal(full.length, 2)
  for (const e of full) {
    assert.ok(/^[0-9a-f]{64}$/.test(e.checksum), 'entries carry a real sha256 checksum')
  }
  await fsp.rm(base, { recursive: true, force: true })
})

test('diffManifests detects added, removed and modified', () => {
  const baseline = [
    { rel: 'a.txt', checksum: 'AAA' },
    { rel: 'b.txt', checksum: 'BBB' },
    { rel: 'gone.txt', checksum: 'GGG' },
  ]
  const current = [
    { rel: 'a.txt', checksum: 'ZZZ', size: 9 }, // modified
    { rel: 'b.txt', checksum: 'BBB' }, // unchanged
    { rel: 'new.txt', checksum: 'NNN', size: 1 }, // added
  ]
  const delta = diffManifests(baseline, current)
  const byRel = Object.fromEntries(delta.map((d) => [d.rel, d.op]))
  assert.equal(byRel['a.txt'], 'modified')
  assert.equal(byRel['gone.txt'], 'removed')
  assert.equal(byRel['new.txt'], 'added')
  assert.ok(!('b.txt' in byRel), 'unchanged files are absent from the delta')
})

test('baseline + incremental snapshot roundtrip (meta/baseline/delta files)', async () => {
  const { base, home } = await makeHome()
  const root = path.join(home, 'data')
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(path.join(root, 'x.txt'), 'v1')

  const baseline = await buildBaselineSnapshot(root)
  assert.equal(baseline.type, 'baseline')
  assert.equal(baseline.fileCount, 1)
  await saveSnapshotRecord(home, 'base-1', baseline)
  assert.ok(existsSync(path.join(snapshotsDir(home), 'base-1', 'meta.json')))
  assert.ok(existsSync(path.join(snapshotsDir(home), 'base-1', 'baseline.json')))
  assert.equal(await getLatestBaseline(home), 'base-1')

  // modify the file and build an incremental
  await fsp.writeFile(path.join(root, 'x.txt'), 'v2')
  await fsp.writeFile(path.join(root, 'y.txt'), 'new')
  const inc = await buildIncrementalSnapshot(root, path.join(snapshotsDir(home), 'base-1', 'baseline.json'))
  assert.equal(inc.type, 'incremental')
  assert.equal(inc.baselineId, 'base-1')
  await saveSnapshotRecord(home, 'inc-1', inc)
  assert.ok(existsSync(path.join(snapshotsDir(home), 'inc-1', 'delta.json')))
  assert.equal(await getLatestIncremental(home, 'base-1'), 'inc-1')

  // combined manifest reflects baseline + delta
  const combined = await getCombinedManifest(home, 'base-1', 'inc-1')
  assert.equal(combined.type, 'combined')
  const byRel = Object.fromEntries(combined.files.map((f) => [f.rel, f]))
  assert.equal(byRel['x.txt'].op, 'modified', 'delta marked x.txt modified')
  assert.ok('y.txt' in byRel, 'added file is present in the combined manifest')
  assert.ok(Array.isArray(await listSnapshotDirs(home)))

  // missing records return null
  assert.equal(await loadSnapshotRecord(home, 'nope'), null)
  await fsp.rm(base, { recursive: true, force: true })
})

test('dirTreeChecksum changes when content changes', async () => {
  const { base, home } = await makeHome()
  const root = path.join(home, 'data2')
  await fsp.mkdir(root, { recursive: true })
  await fsp.writeFile(path.join(root, 'f.txt'), 'one')
  const before = await dirTreeChecksum(root)
  await fsp.writeFile(path.join(root, 'f.txt'), 'two')
  const after = await dirTreeChecksum(root)
  assert.notEqual(before, after)
  await fsp.rm(base, { recursive: true, force: true })
})
