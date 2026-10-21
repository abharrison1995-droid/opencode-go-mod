import type { ModelHealth } from '../types'

const MAX_MODELS = 60

// How one attempt ended: only four outcomes count against a model's health.
// "verify" is a resume after a passed run whose check failed, so the run itself was ok.
function counted(reason: string): keyof Pick<ModelHealth, 'ok' | 'failed' | 'rateLimited' | 'hung'> | undefined {
  if (reason === 'cancelled') return undefined
  if (reason === 'ok' || reason === 'verify' || reason === 'start') return 'ok'
  if (reason === 'rate-limited') return 'rateLimited'
  if (reason === 'hung') return 'hung'
  return 'failed'
}

export function recordRun(
  prev: Record<string, ModelHealth>,
  model: string,
  reason: string,
  ms: number,
  error?: string,
): Record<string, ModelHealth> {
  const kind = counted(reason)
  if (kind === undefined) return prev

  const old = prev[model] ?? { ok: 0, failed: 0, rateLimited: 0, hung: 0, totalMs: 0, lastAt: 0 }
  const next: ModelHealth = {
    ...old,
    [kind]: old[kind] + 1,
    totalMs: old.totalMs + Math.max(0, ms),
    lastAt: Date.now(),
  }
  if (error !== undefined && error.trim() !== '' && kind !== 'ok') next.lastError = error.slice(0, 500).trim()

  const all: Record<string, ModelHealth> = { ...prev, [model]: next }
  const keys = Object.keys(all)
  if (keys.length <= MAX_MODELS) return all

  const oldest = keys.reduce((a, b) => ((all[b]?.lastAt ?? 0) < (all[a]?.lastAt ?? 0) ? b : a))
  delete all[oldest]
  return all
}
