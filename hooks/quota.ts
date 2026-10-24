import type { PlanUse } from '../types'
import { isPlanId } from './catalog'

// The Z.AI Coding Plan limits use per rolling 5-hour window, not in dollars. The mod counts model
// calls (opencode steps) on plan models and can stop starting plan runs at a limit the user sets.
export const WINDOW_MS = 5 * 60 * 60 * 1000

export const prune = (uses: PlanUse[], now: number) => uses.filter(u => now - u.at < WINDOW_MS)

export const usedIn = (uses: PlanUse[], now: number) => prune(uses, now).reduce((sum, u) => sum + u.calls, 0)

/** When the oldest call in the window leaves it, or undefined with none. */
export function resetAt(uses: PlanUse[], now: number): number | undefined {
  const live = prune(uses, now)
  return live.length === 0 ? undefined : Math.min(...live.map(u => u.at)) + WINDOW_MS
}

/** Model calls a run made on plan models, from its per-model call counts. */
export const planCalls = (calls: Record<string, number> | undefined) =>
  Object.entries(calls ?? {}).reduce((sum, [model, n]) => sum + (isPlanId(model) ? n : 0), 0)

const clock = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function quotaMessage(used: number, quota: number, reset: number | undefined): string {
  return `The Z.AI Coding Plan limit set in the zaiQuota option is reached: ${used}/${quota} model calls in the last 5 hours${reset !== undefined ? `, easing from ${clock(reset)}` : ''}. Pick a Go or free model for this task, or wait.`
}

export function quotaText(uses: PlanUse[], quota: number, now: number): string {
  const used = usedIn(uses, now)
  return `${used}${quota > 0 ? `/${quota}` : ''} model calls in the last 5 h`
}
