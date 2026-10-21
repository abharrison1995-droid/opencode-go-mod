import type { EngineInterface } from 'claude-code'

export type ResolveOptions = {
  bin: string
  // The task's own worktree (still on its branch) and the branch it failed to merge into.
  dir: string
  integration: string
  files: string[]
  sessionId?: string
  prompt: string
  model: string
  level?: string
  verify?: string
  verifyRounds: number
  retries: number
  stallMs: number
  fallback?: string
  autoApprove?: boolean
  signal?: AbortSignal
}

export type ResolveResult = { ok: boolean; cost: number; model: string; note: string }

// Brings the integration branch into a conflicting task's worktree and has the worker
// resolve the conflict, so its branch then merges cleanly.
export async function resolveConflict($: EngineInterface, o: ResolveOptions): Promise<ResolveResult> {
  void $
  return { ok: false, cost: 0, model: o.model, note: 'conflict resolution is not implemented yet' }
}
