import type { Effort, ModelHealth, Preset, WorkerModel } from '../types'
import { geminiChecker } from './gemini'

export const PRESETS: Preset[] = [
  { name: 'cheap', model: 'opencode/deepseek-v4.1-flash-free', effort: 'low', note: 'free, best effort: free endpoints rate-limit and stall' },
  { name: 'reliable', model: 'opencode-go/deepseek-v4.1-flash', effort: 'high', note: 'paid, about $0.10 a task' },
  { name: 'strong', model: 'opencode-go/kimi-k3', effort: 'high', note: 'paid, pricier, for harder tasks' },
]

export const presetNamed = (name: string) => PRESETS.find(p => p.name === name.toLowerCase())

// The `plan` preset: the user's Z.AI Coding Plan, when opencode lists it. GLM-5.3 is the plan's
// full model; a flash model is the fallback when it is missing.
export function planPreset(models: WorkerModel[]): Preset | undefined {
  const plan = models.filter(m => m.source === 'zai')
  const pick = plan.find(m => /\/glm-5\.3$/.test(m.id)) ?? plan.find(m => !m.id.includes('flash')) ?? plan[0]
  return pick && { name: 'plan', model: pick.id, effort: 'high', note: 'your Z.AI Coding Plan: no per-token cost, uses its 5-hour quota' }
}

// The `gemini` preset: Gemini 4 Argon on the user's Google AI Pro plan, through Antigravity.
export function geminiPreset(models: WorkerModel[]): Preset | undefined {
  const pick = geminiChecker(models)
  return pick && { name: 'gemini', model: pick.model, effort: pick.effort, note: 'your Google AI Pro plan via Antigravity: no per-token cost, uses its quota' }
}

/** The presets on offer: the fixed ones, plus plan and gemini when those subscriptions are connected. */
export function presetsFor(models: WorkerModel[]): Preset[] {
  return [...PRESETS, ...[planPreset(models), geminiPreset(models)].filter((p): p is Preset => p !== undefined)]
}

export const presetIn = (models: WorkerModel[], name: string) => presetsFor(models).find(p => p.name === name.toLowerCase())

export const NO_PLAN = 'The plan profile needs the Z.AI Coding Plan, and opencode lists none of its models. Ask the user to run `opencode auth login` and pick Z.AI Coding Plan, or use another profile.'

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

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
