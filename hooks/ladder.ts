import type { Effort, ModelHealth, WorkerModel } from '../types'

export type Rung = { model: string; effort?: Effort }

// The `ladder` profile: the models a run climbs, cheapest first. The first rung is the
// starting model; runResilient moves to the next after the current one's retries fail.
export function ladder(models: WorkerModel[], health: Record<string, ModelHealth>): Rung[] {
  void models
  void health
  return []
}
