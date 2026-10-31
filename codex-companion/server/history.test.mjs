import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getJobHistory, recordJob } from './history.mjs'

test('job history is filtered by provider/account, redacts diagnostics, and never persists prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-history-'))
  const env = { ...process.env, BRIDGE_HISTORY_DIR:root }
  try {
    await recordJob({ id:'job-1', provider:'codex', accountId:'pro-2', status:'failed', createdAt:1, updatedAt:2, error:'Bearer secret-token-value' }, env)
    await recordJob({ id:'job-2', provider:'opencode', accountId:'default', status:'completed', createdAt:3, updatedAt:4, ok:true }, env)
    const codex = await getJobHistory({ provider:'codex', accountId:'pro-2', env })
    assert.equal(codex.length, 1)
    assert.equal(codex[0].id, 'job-1')
    assert.equal(codex[0].error, 'Bearer [REDACTED]')
    const file = await readFile(join(root, 'agent-subscription-bridge', 'job-history.json'), 'utf8')
    assert.doesNotMatch(file, /secret-token-value|prompt|response/)
  } finally {
    await rm(root, { recursive:true, force:true })
  }
})
