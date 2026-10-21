import type { EngineInterface } from 'claude-code'

export type ReviewOptions = {
  bin: string
  // The task's worktree, and the branch its work is compared with (the batch's base).
  dir: string
  base: string
  prompt: string
  model: string
  level?: string
  retries: number
  stallMs: number
  fallback?: string
  signal?: AbortSignal
}

export type Review = { verdict: 'ok' | 'concerns' | 'error'; notes: string; cost: number; model: string }

// A second, read-only worker checks a finished task's diff against its prompt, so Claude
// reads only the flagged parts.
export async function reviewTask($: EngineInterface, o: ReviewOptions): Promise<Review> {
  void $
  return { verdict: 'error', notes: 'review is not implemented yet', cost: 0, model: o.model }
}
