import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendAudit,
  readAudit,
  readAlerts,
  getThresholds,
  setThresholds,
  auditFile,
  alertsFile,
  tail,
  tailAlerts,
} from '../lib/audit.mjs'

async function makeHome() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-audit-'))
  const home = path.join(base, 'home')
  await fsp.mkdir(home, { recursive: true })
  return { base, home }
}

test('appendAudit writes one JSON object per line (JSONL)', async () => {
  const { base, home } = await makeHome()
  await appendAudit(home, 'delete', { tool: 'safe_delete', target: '/tmp/x', reason: 'test' })
  await appendAudit(home, 'guard', { tool: 'pwsh', target: '/y', reason: 'deny' })
  const entries = await readAudit(home)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].kind, 'delete')
  assert.equal(entries[0].tool, 'safe_delete')
  assert.equal(entries[1].kind, 'guard')
  const text = await fsp.readFile(auditFile(home), 'utf8')
  // each line is a standalone JSON document
  for (const line of text.split('\n').filter((l) => l.trim())) {
    assert.doesNotThrow(() => JSON.parse(line), 'every audit line parses on its own')
  }
  await fsp.rm(base, { recursive: true, force: true })
})

test('thresholds roundtrip and default fallback', async () => {
  const { base, home } = await makeHome()
  assert.equal(getThresholds(home).blocksPerMin, 10)
  await setThresholds(home, { blocksPerMin: 2, deletesPerHour: 3 })
  assert.equal(getThresholds(home).blocksPerMin, 2)
  assert.equal(getThresholds(home).deletesPerHour, 3)
  await fsp.rm(base, { recursive: true, force: true })
})

test('high block rate fires an alert into alerts.json (JSONL-safe counting)', async () => {
  const { base, home } = await makeHome()
  await setThresholds(home, { blocksPerMin: 2 })
  for (let i = 0; i < 3; i++) {
    await appendAudit(home, 'guard', { tool: 'write', target: '/x', reason: 'deny' })
  }
  const alerts = await readAlerts(home)
  assert.ok(alerts.length >= 1, 'threshold breach must emit an alert')
  assert.ok(alerts[0].kind.includes('high-block-rate'), JSON.stringify(alerts[0]))
  // also verify the alerts file is JSONL too
  const text = await fsp.readFile(alertsFile(home), 'utf8')
  for (const line of text.split('\n').filter((l) => l.trim())) {
    assert.doesNotThrow(() => JSON.parse(line))
  }
  await fsp.rm(base, { recursive: true, force: true })
})

test('tail filters by kind', async () => {
  const { base, home } = await makeHome()
  await appendAudit(home, 'guard', { tool: 'a' })
  await appendAudit(home, 'delete', { tool: 'b' })
  const g = await tail(home, 'guard', 10)
  assert.equal(g.length, 1)
  assert.equal(g[0].tool, 'a')
  await fsp.rm(base, { recursive: true, force: true })
})
