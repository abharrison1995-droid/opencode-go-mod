import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { sanitizeDiagnostic } from '../shared/usage.mjs'

const MAX_RECORDS = 500
const MAX_FILE_BYTES = 1_000_000

function historyFile(env = process.env) {
  const root = env.BRIDGE_HISTORY_DIR || env.LOCALAPPDATA || env.XDG_CACHE_HOME || join(env.USERPROFILE || env.HOME || tmpdir(), '.cache')
  return join(root, 'agent-subscription-bridge', 'job-history.json')
}

async function readRecords(path) {
  try {
    const text = await readFile(path, 'utf8')
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) return []
    const value = JSON.parse(text)
    return Array.isArray(value?.records) ? value.records.filter(record => record && typeof record.id === 'string').slice(-MAX_RECORDS) : []
  } catch { return [] }
}

let pendingWrite = Promise.resolve()

export function recordJob(record, env = process.env) {
  pendingWrite = pendingWrite.catch(() => {}).then(async () => {
    const path = historyFile(env)
    const directory = join(path, '..')
    await mkdir(directory, { recursive: true })
    const records = await readRecords(path)
    const safe = {
      id: String(record.id),
      provider: String(record.provider),
      accountId: String(record.accountId ?? 'default'),
      status: String(record.status),
      createdAt: Number(record.createdAt),
      updatedAt: Number(record.updatedAt),
      ...(Number.isFinite(record.durationMs) ? { durationMs: record.durationMs } : {}),
      ...(typeof record.ok === 'boolean' ? { ok: record.ok } : {}),
      ...(Number.isInteger(record.exitCode) ? { exitCode: record.exitCode } : {}),
      ...(record.error ? { error: sanitizeDiagnostic(record.error) } : {}),
    }
    const index = records.findIndex(item => item.id === safe.id)
    if (index >= 0) records[index] = safe
    else records.push(safe)
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify({ version: 1, records: records.slice(-MAX_RECORDS) }), { mode: 0o600 })
    try { await rename(temp, path) }
    catch {
      await writeFile(path, JSON.stringify({ version: 1, records: records.slice(-MAX_RECORDS) }), { mode: 0o600 })
      const { unlink } = await import('node:fs/promises')
      await unlink(temp).catch(() => {})
    }
  })
  return pendingWrite
}

export async function getJobHistory({ provider, accountId, limit = 50, env = process.env } = {}) {
  const path = historyFile(env)
  let records = await readRecords(path)
  if (provider) records = records.filter(record => record.provider === provider)
  if (accountId) records = records.filter(record => record.accountId === accountId)
  const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 50
  return records.slice(-boundedLimit).reverse()
}
