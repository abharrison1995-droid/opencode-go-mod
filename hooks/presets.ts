import type { Effort, ModelHealth, Preset } from '../types'

export const PRESETS: Preset[] = [
  { name: 'cheap', model: 'opencode/deepseek-v4.1-flash-free', effort: 'low', note: 'free, best effort: free endpoints rate-limit and stall' },
  { name: 'reliable', model: 'opencode-go/deepseek-v4.1-flash', effort: 'high', note: 'paid, about $0.10 a task' },
  { name: 'strong', model: 'opencode-go/kimi-k3', effort: 'high', note: 'paid, pricier, for harder tasks' },
]

export const presetNamed = (name: string) => PRESETS.find(p => p.name === name.toLowerCase())

export const isEffort = (s: unknown): s is Effort => s === 'low' || s === 'medium' || s === 'high' || s === 'xhigh' || s === 'max'

// The panel's health dot. Recent rate limits and hangs count against a model more than old ones.
export function rate(h: ModelHealth | undefined, now = Date.now()): 'good' | 'shaky' | 'bad' | 'unknown' {
  if (h === undefined) return 'unknown'
  const runs = h.ok + h.failed + h.rateLimited + h.hung
  if (runs === 0) return 'unknown'
  const bad = (h.failed + h.rateLimited + h.hung) / runs
  const stale = now - h.lastAt > 6 * 3_600_000
  if (bad < 0.2 || (stale && bad < 0.5)) return 'good'
  return bad < 0.5 || stale ? 'shaky' : 'bad'
}
