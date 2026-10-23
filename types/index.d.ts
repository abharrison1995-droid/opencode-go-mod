export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** One model opencode can run, as `opencode models --verbose` describes it. */
export type WorkerModel = {
  /** provider/model, as `opencode run -m` takes it */
  id: string
  name: string
  /** opencode-go/* is Go; opencode/* is Zen */
  source: 'go' | 'zen'
  /** who makes the model (Moonshot AI, Z.ai, ...) */
  maker: string
  /** USD per million tokens */
  input: number
  output: number
  /** the reasoning variants the model takes (`--variant`) */
  efforts: string[]
  /** largest reply it can write, in tokens */
  maxOutput: number
  /** context window, in tokens */
  context: number
}

export type Catalog = {
  status: 'loading' | 'ready' | 'error'
  models: WorkerModel[]
  error?: string
}

/** A phase a running worker is in beyond working on its prompt; cleared when the phase ends. */
export type Phase = 'verifying' | 'reviewing'

/** A delegate call in flight, for the panel. */
export type Job = { id: string; model: string; effort?: string; steps: number; last?: string; /** 1 on the first try, more after a resume or fallback */ attempt?: number; stage?: Phase }

/** One task of a delegate_batch run. */
export type BatchTask = {
  /** the caller's id for the task, unique in its batch */
  id: string
  title: string
  model: string
  effort?: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'
  /** ids of tasks in the same batch that must finish (done) first */
  dependsOn: string[]
  steps: number
  last?: string
  /** the folder it ran in (its worktree or copy, when isolated) */
  dir?: string
  /** the git branch of its worktree, when isolation is worktree */
  branch?: string
  cost: number
  sessionId?: string
  error?: string
  /** runs of opencode so far: resumes after errors or hangs, fallbacks, and verify fix-ups */
  attempts?: number
  /** the task's verify command's outcome, when it has one */
  verify?: 'passed' | 'failed'
  /** whether auto-merge merged its branch into the batch's integration branch */
  merged?: boolean
  /** the phase the task is in beyond working, while it runs */
  stage?: Phase
}

/** A delegate_batch run, for the panel's PLAN section. */
export type Batch = {
  id: string
  title: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  /** whether the chat is woken with the report when it ends */
  background: boolean
  startedAt: number
  endedAt?: number
  tasks: BatchTask[]
  /** the repo's top folder, when isolation is worktree (the panel's git actions run there) */
  top?: string
  /** the branch the main checkout was on when the batch started */
  base?: string
  /** the branch auto-merge merged passing tasks into */
  integration?: string
  /** the full report, written to a file */
  reportPath?: string
  /** USD; tasks stop being started once the batch has cost this much */
  maxCost?: number
}

/** How a model has behaved in this mod's runs, for the panel's health dot. */
export type ModelHealth = {
  ok: number
  failed: number
  /** 429s and "endpoint unavailable" */
  rateLimited: number
  /** runs killed after printing nothing for the stall limit */
  hung: number
  /** summed wall time of finished runs, ms */
  totalMs: number
  /** ms epoch of the last run */
  lastAt: number
  lastError?: string
}

/** A finished batch, kept across sessions for /opencode history. */
export type BatchSummary = {
  id: string
  title: string
  status: Batch['status']
  startedAt: number
  endedAt: number
  cost: number
  tasks: number
  done: number
  reportPath?: string
}

/** A named model + reasoning pair (cheap, reliable, strong). */
export type Preset = { name: string; model: string; effort: Effort; note: string }

/** Text the panel shows in place of the model lists (a branch's diff), until closed. */
export type Preview = { title: string; text: string }

/** What OpenCode runs cost, as opencode reports it (USD). */
export type Spend = { session: number; runs: number }

/** A local decision model the mod can serve. */
export type LocalName = 'kev' | 'laya'

/** A local model server, as the panel shows it. */
export type LocalServer = { status: 'off' | 'starting' | 'ready' | 'error'; error?: string; startedAt?: number; calls?: number; lastMs?: number }

/** delegate's arguments, as its inputSchema in register.tsx describes them. */
export type DelegateInput = {
  prompt: string
  model?: string
  profile?: 'cheap' | 'reliable' | 'strong' | 'ladder'
  effort?: Effort
  dir?: string
  sessionId?: string
  autoApprove?: boolean
  readOnly?: boolean
  files?: string[]
  verify?: string
  verifyRounds?: number
  report?: 'short' | 'full'
}

/** One task of delegate_batch. */
export type DelegateBatchTask = {
  id: string
  prompt: string
  title?: string
  model?: string
  profile?: 'cheap' | 'reliable' | 'strong' | 'ladder'
  effort?: Effort
  readOnly?: boolean
  dependsOn?: string[]
  files?: string[]
  verify?: string
  verifyRounds?: number
}

/** delegate_batch's arguments. */
export type DelegateBatchInput = {
  title: string
  tasks: DelegateBatchTask[]
  shared?: string
  files?: string[]
  verify?: string
  verifyRounds?: number
  maxCost?: number
  profile?: 'cheap' | 'reliable' | 'strong' | 'ladder'
  autoMerge?: boolean
  autoResolve?: boolean
  review?: boolean
  report?: 'short' | 'full'
  maxParallel?: number
  isolation?: 'worktree' | 'copy' | 'none'
  dir?: string
  autoApprove?: boolean
  background?: boolean
}

/** decide's arguments; register.tsx checks `questions` with checkQuestions. */
export type DecideInput = {
  model?: 'kev' | 'laya' | 'both'
  state: unknown
  questions: Record<string, unknown>
  raw?: boolean
}

declare module 'claude-code' {
  // Types each tool.call hook's `e`. The model can still send anything, so the hooks keep their checks.
  interface McpToolInputs {
    'mcp__opencode-go__delegate': DelegateInput
    'mcp__opencode-go__delegate_batch': DelegateBatchInput
    'mcp__opencode-go__decide': DecideInput
  }

  interface PluginState {
    'opencode-go': {
      catalog: Catalog
      model: string
      effort: Effort
      jobs: Job[]
      /** whether this chat's turns go to the OpenCode model instead of Claude */
      chat: boolean
      /** stable id sent to OpenCode as x-opencode-session for this chat */
      chatSession: string
      /** the panel's search text */
      query: string
      /** sections and maker groups the person folded or unfolded */
      open: Record<string, boolean>
      /** delegate_batch runs of this session, newest last */
      batches: Batch[]
      /** what this session's OpenCode runs cost */
      spend: Spend
      /** the most recently picked models, newest first (at most 5) */
      recent: string[]
      /** the mobile panel's "all models" list, shown or hidden */
      showAll: boolean
      /** per model id, how its runs went (also in $.store 'health') */
      health: Record<string, ModelHealth>
      /** finished batches, newest last, at most 30 (also in $.store 'history') */
      history: BatchSummary[]
      /** USD spent per model id, all sessions (also in $.store 'spendByModel') */
      spendByModel: Record<string, number>
      /** what the panel previews, or null */
      preview: Preview | null
      /** Kev and Laya servers on this machine */
      local: Record<string, LocalServer>
    }
  }
}
