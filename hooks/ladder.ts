import type { Effort, ModelHealth, WorkerModel } from '../types'
import { isFree } from './catalog'
import { geminiPreset, planPreset, presetNamed, rate } from './presets'

export type Rung = { model: string; effort?: Effort; retries?: number }

const runs = (h: ModelHealth) => h.ok + h.failed + h.rateLimited + h.hung

// The `ladder` profile: the models a run climbs, cheapest first. The first rung is the
// starting model; runResilient moves to the next after the current one's retries fail.
// The subscriptions' rungs sit between the free and paid ones: Gemini (Google AI Pro), then the
// Z.AI Coding Plan when planOk, its quota having room.
export function ladder(models: WorkerModel[], health: Record<string, ModelHealth>, planOk = true): Rung[] {
  const free = models
    .map((m, i) => ({ m, i }))
    .filter(({ m, i }) => isFree(m) && models.findIndex(x => x.id === m.id) === i)
    .map(({ m, i }) => {
      const h = health[m.id]
      return { model: m.id, rating: rate(h), share: h === undefined ? 0 : h.ok / Math.max(1, runs(h)), i }
    })
    .filter(x => x.rating === 'good' || x.rating === 'unknown')
    .sort((a, b) => {
      if (a.rating !== b.rating) return a.rating === 'good' ? -1 : 1
      if (a.rating === 'good') return b.share - a.share || a.i - b.i
      return a.i - b.i
    })
    .slice(0, 2)

  const rungs: Rung[] = free.map(x => ({ model: x.model, effort: 'high', retries: 1 }))
  const add = (model: string, effort?: Effort) => {
    if (!rungs.some(r => r.model === model)) rungs.push({ model, effort })
  }
  const gemini = geminiPreset(models)
  if (gemini !== undefined && rate(health[gemini.model]) !== 'bad') rungs.push({ model: gemini.model, effort: gemini.effort, retries: 1 })
  const plan = planPreset(models)
  if (plan !== undefined && planOk && rate(health[plan.model]) !== 'bad') rungs.push({ model: plan.model, effort: plan.effort, retries: 1 })
  const reliable = presetNamed('reliable')
  const strong = presetNamed('strong')
  if (reliable !== undefined) add(reliable.model, reliable.effort)
  if (strong !== undefined) add(strong.model, strong.effort)
  return rungs
}
