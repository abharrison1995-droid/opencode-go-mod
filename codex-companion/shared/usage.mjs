import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { delimiter, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { codexProfileHome } from './codex.mjs'

export const PROVIDERS = Object.freeze([
  { id: 'opencode-go', label: 'OpenCode Go', accountId: 'default' },
  { id: 'codex-pro-1', label: 'Codex Pro 1', accountId: 'pro-1' },
  { id: 'codex-pro-2', label: 'Codex Pro 2', accountId: 'pro-2' },
  { id: 'google-ai-pro', label: 'Google AI Pro', accountId: 'default' },
])

export const REFRESH_INTERVAL_MS = 5 * 60_000
export const MIN_RETRY_MS = 60_000
export const MAX_RETRY_MS = 30 * 60_000
const MAX_OUTPUT = 1_000_000
const TIMEOUT_MS = 20_000
const CACHE_VERSION = 1

const asFinite = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const asText = value => typeof value === 'string' && value.trim() ? value.trim() : undefined

export function sanitizeDiagnostic(value) {
  return String(value ?? 'Provider returned an unspecified error.')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/((?:access|refresh)[_-]?token\s*[=:]\s*)[^\s,"']+/gi, '$1[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(-600)
}

function epochMillis(value, unit = 'auto') {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (unit === 'seconds') return value * 1000
  if (unit === 'milliseconds') return value
  return value < 100_000_000_000 ? value * 1000 : value
}

function normalizePercent(used, remaining) {
  if (asFinite(used) !== undefined && used >= 0 && used <= 100) {
    return { percentUsed: used, percentRemaining: 100 - used }
  }
  if (asFinite(remaining) !== undefined && remaining >= 0 && remaining <= 100) {
    return { percentRemaining: remaining, percentUsed: 100 - remaining }
  }
  return {}
}

function normalizeWindow({ label, durationMins, used, remaining, resetAt, resetUnit, model, bucket, remainingAmount, limitAmount }) {
  const percent = normalizePercent(used, remaining)
  const duration = asFinite(durationMins)
  const reset = epochMillis(resetAt, resetUnit)
  const name = asText(label)
  const modelName = asText(model)
  const bucketName = asText(bucket)
  const left = typeof remainingAmount === 'string' || asFinite(remainingAmount) !== undefined ? remainingAmount : undefined
  const limit = typeof limitAmount === 'string' || asFinite(limitAmount) !== undefined ? limitAmount : undefined
  if (Object.keys(percent).length === 0 && duration === undefined && reset === undefined && name === undefined && modelName === undefined && left === undefined && limit === undefined) return undefined
  return {
    ...(name ? { label: name } : {}),
    ...(duration !== undefined && duration > 0 ? { durationMins: duration } : {}),
    ...percent,
    ...(reset !== undefined ? { resetsAt: reset } : {}),
    ...(modelName ? { model: modelName } : {}),
    ...(bucketName ? { bucket: bucketName } : {}),
    ...(left !== undefined ? { remaining: left } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }
}

function quotaLabel(duration, fallback) {
  if (duration === 300) return '5-hour'
  if (duration === 10_080) return 'Weekly'
  if (duration === 43_200) return 'Monthly'
  if (duration > 0) return `${duration} min`
  return fallback
}

export function parseCodexRateLimits(response, accountId = 'pro-1') {
  const root = response?.result ?? response
  const buckets = root?.rateLimitsByLimitId
  const entries = buckets && typeof buckets === 'object' && Object.keys(buckets).length > 0
    ? Object.entries(buckets)
    : [['codex', root?.rateLimits]]
  const windows = []
  for (const [bucketId, snapshot] of entries) {
    if (!snapshot || typeof snapshot !== 'object') continue
    for (const slot of ['primary', 'secondary']) {
      const win = snapshot[slot]
      if (!win || typeof win !== 'object') continue
      const duration = asFinite(win.windowDurationMins)
      const model = asText(snapshot.normalModelSlug)
      const normalized = normalizeWindow({
        label: quotaLabel(duration, slot),
        durationMins: duration,
        used: win.usedPercent,
        resetAt: win.resetsAt,
        resetUnit: 'seconds',
        model,
        bucket: asText(snapshot.limitName) ?? asText(bucketId),
      })
      if (normalized) windows.push(normalized)
    }
  }
  const firstSnapshot = root?.rateLimits && typeof root.rateLimits === 'object' ? root.rateLimits : entries[0]?.[1]
  const plan = asText(firstSnapshot?.planType)
  const ordinaryAllowed = typeof root?.ordinaryUsageAllowed === 'boolean' ? root.ordinaryUsageAllowed : undefined
  return {
    provider: 'codex',
    accountId,
    status: 'available',
    connection: 'connected',
    authentication: 'authenticated',
    measurement: windows.length ? 'server-reported' : 'provider-details',
    source: 'Codex app-server JSON-RPC account/rateLimits/read',
    checkedAt: Date.now(),
    lastSuccessAt: Date.now(),
    windows,
    ...(plan ? { planType: plan } : {}),
    ...(ordinaryAllowed !== undefined ? { ordinaryUsageAllowed: ordinaryAllowed } : {}),
    ...(windows.length === 0 ? { diagnostic: 'The authenticated endpoint returned no quota windows.' } : {}),
  }
}

function findAntigravityBuckets(value, result = [], path = []) {
  if (Array.isArray(value)) {
    for (const item of value) findAntigravityBuckets(item, result, path)
    return result
  }
  if (!value || typeof value !== 'object') return result

  const used = value.usedPercent ?? value.used_percent ?? value.percentUsed ?? value.percent_used ?? value.usagePercent ?? value.usage_percent
  const remaining = value.remainingPercent ?? value.remaining_percent ?? value.percentRemaining ?? value.percent_remaining
  const hasQuotaContext = path.some(part => /quota|limit|model|bucket/i.test(part)) || Object.keys(value).some(key => /quota|limit|remaining|usedPercent|used_percent/i.test(key))
  if (hasQuotaContext && (asFinite(used) !== undefined || asFinite(remaining) !== undefined || value.remainingRequests !== undefined || value.remaining_requests !== undefined || value.remaining !== undefined)) {
    const label = value.windowLabel ?? value.window_label ?? value.windowName ?? value.window_name ?? value.name ?? value.label ?? value.modelName ?? value.model_name
    const model = value.model ?? value.modelId ?? value.model_id ?? value.slug
    const duration = value.windowDurationMins ?? value.window_duration_mins ?? value.durationMins ?? value.duration_minutes ?? value.window_minutes
    const resetAt = value.resetsAt ?? value.resets_at ?? value.resetAt ?? value.reset_at ?? value.resetTimestamp ?? value.reset_timestamp
    const remainingAmount = value.remainingRequests ?? value.remaining_requests ?? (asFinite(value.remaining) !== undefined && asFinite(value.remaining) > 100 ? value.remaining : undefined)
    const limitAmount = value.limit ?? value.limitRequests ?? value.limit_requests
    const window = normalizeWindow({
      label: asText(label) ?? quotaLabel(duration, path.at(-1) ?? 'Quota'),
      durationMins: duration,
      used,
      remaining,
      resetAt,
      model,
      bucket: path.at(-1),
      remainingAmount,
      limitAmount,
    })
    if (window) result.push(window)
  }
  for (const [key, nested] of Object.entries(value)) {
    if (nested && typeof nested === 'object') findAntigravityBuckets(nested, result, [...path, key])
  }
  return result
}

export function parseAntigravityUsage(output) {
  let envelope
  try { envelope = typeof output === 'string' ? JSON.parse(output.trim()) : output }
  catch { return { status: 'unavailable', error: 'Antigravity /usage did not return valid JSON.' } }
  if (!envelope || typeof envelope !== 'object') return { status: 'unavailable', error: 'Antigravity /usage returned an unsupported response.' }
  const status = asText(envelope.status)?.toUpperCase()
  if (status && status !== 'SUCCESS') {
    const message = asText(envelope.error) ?? asText(envelope.response) ?? status
    const unauthenticated = /auth|sign[ -]?in|log[ -]?in|credential/i.test(message)
    return { status: unauthenticated ? 'unauthenticated' : 'unavailable', error: sanitizeDiagnostic(message) }
  }
  let payload = envelope.quotas ?? envelope.quota ?? envelope.modelQuotas ?? envelope.model_quotas ?? envelope.usage ?? envelope.response ?? envelope
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch { payload = undefined }
  }
  const windows = findAntigravityBuckets(payload)
  const now = Date.now()
  return {
    provider: 'google-ai',
    accountId: 'default',
    status: 'available',
    connection: 'connected',
    authentication: 'authenticated',
    measurement: windows.length ? 'server-reported' : 'provider-details',
    source: 'Antigravity CLI agy --print /usage --output-format json',
    checkedAt: now,
    lastSuccessAt: now,
    windows,
    ...(windows.length === 0 ? { diagnostic: 'The authenticated /usage command returned no machine-readable quota fields.' } : {}),
  }
}

export function parseOpenCodeUsage(response) {
  const data = response?.data ?? response
  if (data === null) return { status: 'unauthenticated', error: 'OpenCode Console is not signed in for this location.' }
  if (!data || typeof data !== 'object') return { status: 'unavailable', error: 'OpenCode usage endpoint returned an unsupported response.' }
  const go = data.go
  const windows = []
  if (go && typeof go === 'object') {
    for (const key of ['rolling', 'weekly', 'monthly']) {
      const meter = go[key]
      if (!meter || typeof meter !== 'object') continue
      const window = normalizeWindow({
        label: key === 'rolling' ? 'Rolling' : key === 'weekly' ? 'Weekly' : 'Monthly',
        used: meter.percent,
        resetAt: meter.resetsAt,
        resetUnit: 'milliseconds',
        bucket: 'OpenCode Go',
      })
      if (window) windows.push({ ...window, ...(typeof meter.limited === 'boolean' ? { limited: meter.limited } : {}) })
    }
  }
  const workspace = data.workspace && typeof data.workspace === 'object' ? data.workspace : undefined
  const accountId = asText(workspace?.name) ?? asText(workspace?.id) ?? 'default'
  const now = Date.now()
  return {
    provider: 'opencode-go',
    accountId,
    status: 'available',
    connection: 'connected',
    authentication: 'authenticated',
    measurement: windows.length ? 'server-reported' : 'provider-details',
    source: 'OpenCode local API GET /api/experimental/usage/limits',
    checkedAt: now,
    lastSuccessAt: now,
    windows,
    ...(workspace?.name ? { workspaceName: sanitizeDiagnostic(workspace.name) } : {}),
    ...(windows.length === 0 ? { diagnostic: 'OpenCode returned no Go allowance for this workspace.' } : {}),
  }
}

function cachePath(env = process.env) {
  const root = env.BRIDGE_USAGE_CACHE_DIR || env.LOCALAPPDATA || env.XDG_CACHE_HOME || (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : join(env.HOME || tmpdir(), '.cache'))
  return join(root, 'agent-subscription-bridge', 'usage-cache.json')
}

async function readCache(env) {
  try {
    const value = JSON.parse(await readFile(cachePath(env), 'utf8'))
    if (value?.version === CACHE_VERSION && value.entries && typeof value.entries === 'object') return value
  } catch {}
  return { version: CACHE_VERSION, entries: {} }
}

async function writeCache(cache, env) {
  const target = cachePath(env)
  const directory = resolve(target, '..')
  await mkdir(directory, { recursive: true })
  const temp = `${target}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(cache), { mode: 0o600 })
  try { await rename(temp, target) }
  catch (error) {
    await writeFile(target, JSON.stringify(cache), { mode: 0o600 })
    const fs = await import('node:fs/promises')
    await fs.unlink(temp).catch(() => {})
  }
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true } catch { return false }
}

async function executable(path) {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    if (process.platform === 'win32') return true
    await access(path, constants.X_OK)
    return true
  } catch { return false }
}

const ENV_BIN = Object.freeze({ opencode: 'BRIDGE_OPENCODE_BIN', codex: 'BRIDGE_CODEX_BIN', agy: 'BRIDGE_AGY_BIN' })

export async function locateCli(provider, env = process.env, platform = process.platform, arch = process.arch) {
  const canonical = provider === 'gemini' || provider === 'agy' ? 'agy' : provider
  const name = canonical
  const override = asText(env[ENV_BIN[canonical]])
  if (override) return override
  const pathValue = env.PATH ?? ''
  const extensions = platform === 'win32' ? ['.exe'] : ['']
  const candidates = []
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) candidates.push(join(dir, name + extension))
  }
  if (platform === 'win32' && env.APPDATA && canonical === 'opencode') candidates.push(join(env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
  if (platform === 'win32' && env.LOCALAPPDATA && canonical === 'agy') candidates.push(join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'))
  if (platform === 'win32' && env.APPDATA && canonical === 'codex') {
    const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    candidates.push(join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'vendor', target, 'codex', 'codex.exe'))
  }
  for (const candidate of candidates) if (await executable(candidate)) return candidate
  if (platform !== 'win32') return name
  throw new Error(`Native ${name}.exe not found. Set ${ENV_BIN[provider]} to its path; Windows .cmd shims are not launched through a shell.`)
}

function capture(bin, args, { cwd, env = process.env, input, timeoutMs = TIMEOUT_MS, maxOutput = MAX_OUTPUT, signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    const child = spawn(bin, args, { cwd, env: { ...env, ...(cwd ? { PWD: cwd } : {}) }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = fn => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn() }
    const terminate = () => { try { child.kill() } catch {} }
    const abort = () => { terminate(); finish(() => reject(new Error('Cancelled'))) }
    const timer = setTimeout(() => { terminate(); finish(() => reject(new Error(`Provider timed out after ${timeoutMs}ms`))) }, timeoutMs)
    const add = (kind, chunk) => {
      const next = (kind === 'stdout' ? stdout : stderr) + chunk.toString('utf8')
      if (next.length + (kind === 'stdout' ? stderr.length : stdout.length) > maxOutput) {
        terminate()
        finish(() => reject(new Error('Provider output exceeded the safety limit.')))
        return
      }
      if (kind === 'stdout') stdout = next
      else stderr = next
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => add('stdout', chunk))
    child.stderr.on('data', chunk => add('stderr', chunk))
    child.on('error', error => finish(() => reject(error)))
    child.on('close', code => finish(() => resolvePromise({ stdout, stderr, code })))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function jsonOutput(stdout, label) {
  try { return JSON.parse(stdout.trim()) }
  catch { throw new Error(`${label} did not return valid JSON.`) }
}

async function queryOpenCode(directory, env) {
  const bin = await locateCli('opencode', env)
  const versionResult = await capture(bin, ['--version'], { cwd:directory, env, timeoutMs:5_000, maxOutput:10_000 })
  const version = versionResult.code === 0 ? sanitizeDiagnostic(versionResult.stdout.trim()) : undefined
  const help = await capture(bin, ['--help'], { cwd:directory, env, timeoutMs:5_000, maxOutput:50_000 })
  if (help.code !== 0 || !supportsOpenCodeApi(help.stdout)) {
    throw new Error(`OpenCode ${version ?? 'CLI'} does not expose the documented API command required for server-reported usage.`)
  }
  const result = await capture(bin, buildOpenCodeUsageArgs(directory), { cwd: directory, env, timeoutMs: 25_000 })
  if (result.code !== 0) throw new Error(sanitizeDiagnostic(result.stderr || 'OpenCode usage request failed.'))
  const usage = parseOpenCodeUsage(jsonOutput(result.stdout, 'OpenCode usage endpoint'))
  return { ...usage, ...(version ? { cliVersion:version } : {}) }
}

export function buildOpenCodeUsageArgs(directory) {
  const query = new URLSearchParams({ directory:resolve(directory) })
  return ['api', 'GET', `/api/experimental/usage/limits?${query.toString()}`]
}

export function supportsOpenCodeApi(helpText) {
  return typeof helpText === 'string' && /^\s*api\s/m.test(helpText)
}

function profileHome(accountId, env) {
  const home = env.USERPROFILE || env.HOME
  if (!home) throw new Error('User home directory is unavailable.')
  return codexProfileHome(home, accountId)
}

async function requestJsonRpc(child, lines, id, method, params, timeoutMs = 8_000) {
  const serialized = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
  child.stdin.write(serialized)
  return await new Promise((resolvePromise, reject) => {
    let settled = false
    let pollTimer
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Codex app-server ${method} timed out.`)) }, timeoutMs)
    const cleanup = () => { settled = true; clearTimeout(timer); clearTimeout(pollTimer) }
    const poll = () => {
      if (settled) return
      const i = lines.findIndex(message => message?.id === id)
      if (i >= 0) {
        cleanup()
        const [message] = lines.splice(i, 1)
        if (message.error) reject(new Error(sanitizeDiagnostic(message.error.message ?? JSON.stringify(message.error))))
        else resolvePromise(message.result)
      } else pollTimer = setTimeout(poll, 10)
    }
    poll()
  })
}

async function queryCodex(accountId, env) {
  const home = profileHome(accountId, env)
  if (!(await exists(home))) throw Object.assign(new Error(`Dedicated Codex profile ${accountId} is missing; sign in to that profile with CODEX_HOME set.`), { unauthenticated: true })
  const bin = await locateCli('codex', env)
  const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
    cwd: env.USERPROFILE || env.HOME || process.cwd(),
    env: { ...env, CODEX_HOME: home },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  const replies = []
  let buffer = ''
  const kill = () => { try { child.kill() } catch {} }
  const timeout = setTimeout(kill, 30_000)
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8')
    if (stdout.length > MAX_OUTPUT) kill()
    buffer += chunk.toString('utf8')
    const parts = buffer.split(/\r?\n/)
    buffer = parts.pop() ?? ''
    for (const line of parts) {
      try { replies.push(JSON.parse(line)) } catch {}
    }
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000) })
  child.on('error', () => {})
  try {
    const init = await requestJsonRpc(child, replies, 1, 'initialize', { clientInfo: { name: 'agent-subscription-bridge', version: '0.1.0' } })
    if (!init) throw new Error('Codex app-server initialization returned no result.')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n')
    await requestJsonRpc(child, replies, 2, 'account/read', { refreshToken: false })
    const usage = await requestJsonRpc(child, replies, 3, 'account/rateLimits/read', { excludeResetCreditDetails: true })
    return parseCodexRateLimits(usage, accountId)
  } catch (error) {
    const message = sanitizeDiagnostic(error instanceof Error ? error.message : error)
    const unauthenticated = /auth|sign[ -]?in|log[ -]?in|credential|required to read rate limits/i.test(message)
    throw Object.assign(new Error(message || sanitizeDiagnostic(stderr)), { unauthenticated })
  } finally {
    clearTimeout(timeout)
    child.stdin.end()
    setTimeout(kill, 500).unref?.()
  }
}

async function queryAntigravity(env) {
  const bin = await locateCli('agy', env)
  const version = await capture(bin, ['--version'], { env, timeoutMs: 5_000, maxOutput: 10_000 }).catch(() => undefined)
  const result = await capture(bin, ['--print', '/usage', '--output-format', 'json', '--print-timeout', '30s'], { env, timeoutMs: 35_000 })
  if (result.code !== 0) {
    const details = sanitizeDiagnostic(result.stderr || result.stdout || 'Antigravity /usage failed.')
    throw Object.assign(new Error(details), { unauthenticated: /auth|sign[ -]?in|log[ -]?in|credential/i.test(details) })
  }
  const parsed = parseAntigravityUsage(result.stdout)
  if (parsed.status !== 'available') throw Object.assign(new Error(parsed.error), { unauthenticated: parsed.status === 'unauthenticated' })
  const cliVersion = version?.code === 0 ? sanitizeDiagnostic(version.stdout.trim()) : undefined
  return { ...parsed, ...(cliVersion ? { cliVersion } : {}) }
}

export const createProviderQueries = (directory, env = process.env) => ({
  'opencode-go': () => {
    if (!directory) throw new Error('OpenCode Go usage requires an active workspace directory; pass directory to bridge_usage or start the dashboard from that workspace.')
    return queryOpenCode(directory, env)
  },
  'codex-pro-1': () => queryCodex('pro-1', env),
  'codex-pro-2': () => queryCodex('pro-2', env),
  'google-ai-pro': () => queryAntigravity(env),
})

function withStatus(entry, status, now, extras = {}) {
  const snapshot = entry?.snapshot
  if (snapshot) return {
    ...snapshot,
    status,
    checkedAt: now,
    lastSuccessAt: entry.lastSuccessAt ?? snapshot.lastSuccessAt,
    ...(extras.error ? { diagnostic: sanitizeDiagnostic(extras.error) } : { diagnostic: undefined }),
  }
  return {
    provider: extras.provider,
    accountId: extras.accountId,
    status,
    connection: extras.connection ?? 'unknown',
    authentication: extras.authentication ?? 'unknown',
    measurement: 'unavailable',
    source: extras.source,
    checkedAt: now,
    ...(extras.error ? { diagnostic: sanitizeDiagnostic(extras.error) } : {}),
    windows: [],
  }
}

export async function getUsage({ directory, force = false, now = Date.now(), env = process.env, queryProviders } = {}) {
  const cwd = directory ? resolve(directory) : undefined
  const cache = await readCache(env)
  const queries = queryProviders ?? createProviderQueries(cwd, env)
  const cacheKey = info => info.id === 'opencode-go'
    ? `${info.id}:${cwd ? createHash('sha256').update(cwd).digest('hex').slice(0, 24) : 'no-workspace'}`
    : info.id
  const results = await Promise.all(PROVIDERS.map(async info => {
    const key = cacheKey(info)
    const entry = cache.entries[key]
    const age = entry?.lastSuccessAt === undefined ? Infinity : now - entry.lastSuccessAt
    const nextAllowedAt = entry?.nextAllowedAt ?? 0
    if (!force && entry?.snapshot && age < REFRESH_INTERVAL_MS) return withStatus(entry, 'available', now)
    if (now < nextAllowedAt) {
      const status = entry?.snapshot ? (entry.diagnostic ? 'stale' : 'available') : entry?.status ?? 'unavailable'
      return withStatus(entry, status, now, { provider: info.id, accountId: info.accountId, ...(entry?.diagnostic ? { error:entry.diagnostic } : {}) })
    }
    try {
      const snapshot = await queries[info.id]()
      if (snapshot.status !== 'available') throw Object.assign(new Error(snapshot.error ?? snapshot.diagnostic), { unauthenticated: snapshot.status === 'unauthenticated' })
      snapshot.provider = info.id
      snapshot.checkedAt = now
      snapshot.lastSuccessAt = now
      cache.entries[key] = { snapshot, lastSuccessAt: now, lastAttemptAt: now, failures: 0, nextAllowedAt: now + REFRESH_INTERVAL_MS }
      return snapshot
    } catch (error) {
      const message = sanitizeDiagnostic(error instanceof Error ? error.message : error)
      const failures = (entry?.failures ?? 0) + 1
      const backoff = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(failures - 1, 5))
      const failedStatus = error?.unauthenticated ? 'unauthenticated' : 'unavailable'
      const snapshot = entry?.snapshot
        ? withStatus(entry, 'stale', now, { error: message })
        : withStatus(undefined, failedStatus, now, {
          provider: info.id,
          accountId: info.accountId,
          connection: 'disconnected',
          authentication: error?.unauthenticated ? 'unauthenticated' : 'unknown',
          source: info.id === 'codex-pro-1' || info.id === 'codex-pro-2' ? 'Codex app-server JSON-RPC account/rateLimits/read' : info.id === 'opencode-go' ? 'OpenCode local API GET /api/experimental/usage/limits' : 'Antigravity CLI agy --print /usage --output-format json',
          error: message,
        })
      cache.entries[key] = { ...(entry ?? {}), snapshot: entry?.snapshot, status: snapshot.status, diagnostic: message, failures, lastAttemptAt: now, nextAllowedAt: now + backoff }
      if (!entry?.snapshot) Object.assign(cache.entries[key], { unavailableSnapshot: snapshot })
      return snapshot
    }
  }))
  cache.checkedAt = now
  await writeCache(cache, env).catch(() => {})
  return results.map((snapshot, index) => {
    const entry = cache.entries[cacheKey(PROVIDERS[index])]
    if (!snapshot.windows && entry?.unavailableSnapshot) return entry.unavailableSnapshot
    return snapshot
  })
}

export function usageIsFresh(snapshot, now = Date.now()) {
  return snapshot?.status === 'available' && typeof snapshot.lastSuccessAt === 'number' && now - snapshot.lastSuccessAt < REFRESH_INTERVAL_MS
}
