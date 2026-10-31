import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { buildOpenCodeUsageArgs, createProviderQueries, getUsage, locateCli, parseAntigravityUsage, parseCodexRateLimits, parseOpenCodeUsage, sanitizeDiagnostic, supportsOpenCodeApi } from './usage.mjs'

test('Gemini host routes through Antigravity CLI and its configured executable override', async () => {
  assert.equal(await locateCli('gemini', { BRIDGE_AGY_BIN:'C:\\tools\\agy.exe', PATH:'' }, 'win32'), 'C:\\tools\\agy.exe')
})

test('Gemini Windows discovery checks the default Antigravity install directory', async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'bridge-agy-path-'))
  const expected = join(localAppData, 'agy', 'bin', 'agy.exe')
  try {
    await mkdir(join(localAppData, 'agy', 'bin'), { recursive:true })
    await writeFile(expected, '', { mode:0o755 })
    assert.equal(await locateCli('gemini', { LOCALAPPDATA:localAppData, PATH:'' }, 'win32'), expected)
  } finally {
    await rm(localAppData, { recursive:true, force:true })
  }
})

test('Codex windows are labelled by returned duration, not primary/secondary position', () => {
  const value = parseCodexRateLimits({ rateLimits: { planType: 'pro', primary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: 1_800_000_000 } } }, 'pro-2')
  assert.equal(value.accountId, 'pro-2')
  assert.equal(value.windows[0].label, 'Weekly')
  assert.equal(value.windows[0].percentRemaining, 73)
  assert.equal(value.windows[0].resetsAt, 1_800_000_000_000)
})

test('Codex model buckets preserve model-specific quota metadata', () => {
  const value = parseCodexRateLimits({
    rateLimitsByLimitId: {
      codex: { planType: 'pro', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 } },
      base_model_inference: { normalModelSlug: 'gpt-6-luna', primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: null } },
    },
  })
  assert.deepEqual(value.windows.map(window => [window.bucket, window.model, window.label]), [
    ['codex', undefined, '5-hour'],
    ['base_model_inference', 'gpt-6-luna', 'Weekly'],
  ])
})

test('OpenCode uses the server returned meters and does not invent missing percentages', () => {
  const value = parseOpenCodeUsage({ data: {
    workspace: { id: 'wrk_123', name: 'Personal' },
    go: { rolling: { percent: 21.5, limited: false, resetsAt: 1_800_000_000_000 }, weekly: { limited: false, resetsAt: 1_800_000_100_000 } },
    budgets: [],
  } })
  assert.equal(value.accountId, 'Personal')
  assert.equal(value.windows[0].percentRemaining, 78.5)
  assert.equal(value.windows[1].percentUsed, undefined)
  assert.equal(value.windows[1].percentRemaining, undefined)
  assert.equal(value.windows[1].resetsAt, 1_800_000_100_000)
})

test('OpenCode usage calls the documented local API with an explicit GET method', () => {
  const workspace = process.platform === 'win32' ? 'C:\\projects\\bridge with spaces' : join(tmpdir(), 'bridge with spaces')
  const args = buildOpenCodeUsageArgs(workspace)
  assert.equal(args[0], 'api')
  assert.equal(args[1], 'GET')
  const route = new URL(`http://127.0.0.1${args[2]}`)
  assert.equal(route.pathname, '/api/experimental/usage/limits')
  assert.equal(route.searchParams.get('directory'), resolve(workspace))
  assert.equal(supportsOpenCodeApi('Commands:\n  api  make a request to a running server\n  run  submit prompt'), true)
  assert.equal(supportsOpenCodeApi('Commands:\n  run  submit prompt\n  serve start server'), false)
})

test('OpenCode usage requires an explicit workspace when the host has no active project path', async () => {
  await assert.rejects(Promise.resolve().then(() => createProviderQueries(undefined, {})['opencode-go']()), /requires an active workspace directory/)
})

test('Antigravity accepts only structured quota fields and reports text-only output as details', () => {
  const parsed = parseAntigravityUsage({
    status: 'SUCCESS',
    response: JSON.stringify({ modelQuotas: [{ model: 'gemini-4-argon', usedPercent: 36, windowDurationMins: 300, resetsAt: 1_800_000_000 }] }),
  })
  assert.equal(parsed.measurement, 'server-reported')
  assert.equal(parsed.windows[0].model, 'gemini-4-argon')
  assert.equal(parsed.windows[0].percentRemaining, 64)
  const textOnly = parseAntigravityUsage({ status: 'SUCCESS', response: 'Model quota: 12 requests remain.' })
  assert.equal(textOnly.measurement, 'provider-details')
  assert.equal(textOnly.windows.length, 0)
  assert.match(textOnly.diagnostic, /no machine-readable quota fields/)
})

test('failed Antigravity authentication is not reported as a zero quota', () => {
  const value = parseAntigravityUsage({ status: 'ERROR', error: 'Authentication required; sign in with agy first.' })
  assert.equal(value.status, 'unauthenticated')
})

test('provider diagnostics scrub token shaped values', () => {
  assert.equal(sanitizeDiagnostic('Bearer abc.def sk-abcdefghijklmnop'), 'Bearer [REDACTED] [REDACTED]')
})

test('usage cache keeps last server reading stale on refresh failure and backs off', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'bridge-usage-'))
  const env = { ...process.env, LOCALAPPDATA: cacheRoot }
  let fail = false
  let calls = 0
  const queries = Object.fromEntries(['opencode-go', 'codex-pro-1', 'codex-pro-2', 'google-ai-pro'].map(provider => [provider, async () => {
    calls++
    if (fail) throw new Error('provider offline')
    return { provider, accountId: provider, status: 'available', connection: 'connected', authentication: 'authenticated', measurement: 'server-reported', source: 'mock server', checkedAt: 0, lastSuccessAt: 0, windows: [{ label: 'weekly', percentUsed: 20, percentRemaining: 80 }] }
  }]))
  try {
    const first = await getUsage({ directory: cacheRoot, env, now: 1_000_000, queryProviders: queries })
    assert.equal(first.length, 4)
    assert.equal(calls, 4)
    const fresh = await getUsage({ directory: cacheRoot, env, now: 1_001_000, queryProviders: queries })
    assert.equal(calls, 4)
    assert.equal(fresh[0].status, 'available')
    const forcedWhileFresh = await getUsage({ directory: cacheRoot, env, now: 1_002_000, force: true, queryProviders: queries })
    assert.equal(calls, 4)
    assert.equal(forcedWhileFresh[0].status, 'available')
    assert.equal(forcedWhileFresh[0].diagnostic, undefined)
    fail = true
    const stale = await getUsage({ directory: cacheRoot, env, now: 1_400_000, force: true, queryProviders: queries })
    assert.equal(stale[0].status, 'stale')
    assert.equal(stale[0].windows[0].percentRemaining, 80)
    const callsAfterFailure = calls
    const backedOff = await getUsage({ directory: cacheRoot, env, now: 1_450_000, force: true, queryProviders: queries })
    assert.equal(calls, callsAfterFailure)
    assert.equal(backedOff[0].status, 'stale')
  } finally {
    await rm(cacheRoot, { recursive: true, force: true })
  }
})

test('OpenCode cached readings do not cross workspace directories', async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'bridge-usage-workspaces-'))
  const env = { ...process.env, BRIDGE_USAGE_CACHE_DIR: cacheRoot }
  let calls = 0
  const queries = Object.fromEntries(['opencode-go', 'codex-pro-1', 'codex-pro-2', 'google-ai-pro'].map(provider => [provider, async () => {
    calls++
    return { provider, accountId:provider === 'opencode-go' ? `workspace-${calls}` : provider, status:'available', connection:'connected', authentication:'authenticated', measurement:'server-reported', source:'mock', checkedAt:0, lastSuccessAt:0, windows:[] }
  }]))
  try {
    const first = await getUsage({ directory:join(cacheRoot, 'project-a'), env, now:2_000_000, queryProviders:queries })
    const second = await getUsage({ directory:join(cacheRoot, 'project-b'), env, now:2_001_000, queryProviders:queries })
    assert.equal(calls, 5)
    assert.notEqual(first[0].accountId, second[0].accountId)
  } finally {
    await rm(cacheRoot, { recursive:true, force:true })
  }
})
