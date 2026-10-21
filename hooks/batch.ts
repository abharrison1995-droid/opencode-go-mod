import type { EngineInterface } from 'claude-code'

import type { Batch, BatchTask, Effort } from '../types'

export type BatchTaskSpec = {
  id: string
  prompt: string
  title?: string
  model?: string
  effort?: Effort
  readOnly?: boolean
  dependsOn?: string[]
  verify?: string
  verifyRounds?: number
  files?: string[]
}

export type Isolation = 'worktree' | 'copy' | 'none'

export type BatchRunSpec = { batch: Batch; maxParallel: number; signal?: AbortSignal }

export type TaskVerify = { passed: boolean; output: string; rounds?: number }

export type TaskResult = {
  status: 'done' | 'failed' | 'skipped' | 'cancelled'
  cost: number
  steps: number
  last?: string
  sessionId?: string
  dir?: string
  branch?: string
  error?: string
  attempts?: number
  verify?: TaskVerify
}

export type BatchExtras = {
  isolation?: Isolation
  top?: string
  branch?: string
  diffs?: Record<string, string>
  answers?: Record<string, string>
  warnings?: Record<string, string>
}

export type RunnerDefaults = { fallback?: string; retries: number; stallMs: number }

const remembered = new Map<string, { specs: BatchTaskSpec[]; defaults: RunnerDefaults }>()

// Task prompts are not on the panel's Batch, so the panel's Resume reads them from here.
export function rememberBatch(id: string, specs: readonly BatchTaskSpec[], defaults: RunnerDefaults) {
  remembered.set(id, {
    specs: specs.map(t => ({
      ...t,
      dependsOn: t.dependsOn === undefined ? undefined : [...t.dependsOn],
      files: t.files === undefined ? undefined : [...t.files],
    })),
    defaults,
  })
  while (remembered.size > 20) {
    const oldest = remembered.keys().next().value
    if (oldest === undefined) break
    remembered.delete(oldest)
  }
}

export function batchSpecs(id: string): { specs: BatchTaskSpec[]; defaults: RunnerDefaults } | undefined {
  return remembered.get(id)
}

const MAX_TASKS = 12

export function checkTasks(tasks: readonly BatchTaskSpec[]): string | undefined {
  if (tasks.length === 0) return 'delegate_batch needs at least one task.'
  if (tasks.length > MAX_TASKS) return `delegate_batch takes at most ${MAX_TASKS} tasks.`
  const ids = new Set<string>()
  for (const task of tasks) {
    if (typeof task.id !== 'string' || task.id.trim() === '') return 'Every task needs an id.'
    if (ids.has(task.id)) return `Duplicate task id: ${task.id}.`
    ids.add(task.id)
    if (typeof task.prompt !== 'string' || task.prompt.trim() === '') return `Task ${task.id} needs a prompt.`
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!ids.has(dep)) return `Task ${task.id} depends on unknown task ${dep}.`
    }
  }
  const byId = new Map(tasks.map(t => [t.id, t]))
  const visiting = new Set<string>()
  const seen = new Set<string>()
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (seen.has(id)) return false
    visiting.add(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) if (cyclic(dep)) return true
    visiting.delete(id)
    seen.add(id)
    return false
  }
  for (const task of tasks) if (cyclic(task.id)) return 'The tasks have a dependency cycle.'
  return undefined
}

async function git($: EngineInterface, argv: string[]) {
  return $.process.run(argv).catch(err => ({ exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }))
}

// Parallel `git worktree add` calls race for the repo's lock, so folders are made one at a time.
let preparing: Promise<unknown> = Promise.resolve()

export function prepareDir(
  $: EngineInterface,
  mode: Isolation,
  base: string,
  batchId: string,
  taskId: string,
  from: readonly string[] = [],
): Promise<{ dir: string; branch?: string }> {
  const made = preparing.then(() => makeDir($, mode, base, batchId, taskId, from))
  preparing = made.catch(() => undefined)
  return made
}

async function makeDir(
  $: EngineInterface,
  mode: Isolation,
  base: string,
  batchId: string,
  taskId: string,
  from: readonly string[],
): Promise<{ dir: string; branch?: string }> {
  if (mode === 'none') return { dir: base }

  if (mode === 'copy') {
    const dir = `${base}-opencode/${batchId}-${taskId}`
    const made = await git($, ['mkdir', '-p', dir])
    if (made.exitCode !== 0) throw new Error(made.stderr.trim() || `mkdir -p ${dir} failed`)
    const copied = await git($, ['cp', '-a', `${base}/.`, dir])
    if (copied.exitCode !== 0) throw new Error(copied.stderr.trim() || `cp -a ${base} failed`)
    return { dir }
  }

  const found = await git($, ['git', '-C', base, 'rev-parse', '--show-toplevel'])
  if (found.exitCode !== 0) throw new Error(found.stderr.trim() || `git -C ${base} rev-parse --show-toplevel failed`)
  const top = found.stdout.trim()
  const folder = `${top}-opencode/${batchId}-${taskId}`
  const branch = `oc/${batchId}-${taskId}`
  const added = await git($, ['git', '-C', top, 'worktree', 'add', '-b', branch, folder, from[0] ?? 'HEAD'])
  if (added.exitCode !== 0) throw new Error(added.stderr.trim() || `git worktree add failed for ${folder}`)
  for (const b of from.slice(1)) {
    const merged = await git($, [
      'git', '-C', folder, '-c', 'user.name=OpenCode worker', '-c', 'user.email=opencode-worker@localhost',
      'merge', '--no-ff', '--no-edit', b,
    ])
    if (merged.exitCode === 0) continue
    // Read the conflict list before the abort clears it.
    const conflicts = await git($, ['git', '-C', folder, 'diff', '--name-only', '--diff-filter=U'])
    await git($, ['git', '-C', folder, 'merge', '--abort'])
    await git($, ['git', '-C', top, 'worktree', 'remove', '--force', folder])
    await git($, ['git', '-C', top, 'branch', '-D', branch])
    const files = conflicts.stdout.trim()
    throw new Error(`dependencies ${from[0]} and ${b} conflict${files === '' ? '' : `: ${files.split('\n').filter(l => l.trim() !== '').join(', ')}`}`)
  }
  const rel = base === top ? '' : base.startsWith(`${top}/`) ? base.slice(top.length + 1) : ''
  return { dir: rel ? `${folder}/${rel}` : folder, branch }
}

// Commits what a worker left in its worktree, so its branch holds the work and
// `git diff main...<branch>` shows it, new files included. Returns the commit's --stat.
export async function commitTask($: EngineInterface, dir: string, message: string): Promise<string | undefined> {
  const status = await git($, ['git', '-C', dir, 'status', '--porcelain'])
  if (status.exitCode !== 0 || status.stdout.trim() === '') return undefined
  const added = await git($, ['git', '-C', dir, 'add', '-A'])
  if (added.exitCode !== 0) return undefined
  let done = await git($, ['git', '-C', dir, 'commit', '-q', '-m', message])
  // A repo without a git identity still gets the commit, under a stand-in name.
  if (done.exitCode !== 0) {
    done = await git($, ['git', '-C', dir, '-c', 'user.name=OpenCode worker', '-c', 'user.email=opencode-worker@localhost', 'commit', '-q', '-m', message])
  }
  if (done.exitCode !== 0) return undefined
  const stat = await git($, ['git', '-C', dir, 'show', '--stat', '--format=', 'HEAD'])
  return stat.exitCode === 0 ? stat.stdout.trim() : undefined
}

export async function runBatch(
  $: EngineInterface,
  spec: BatchRunSpec,
  runTask: (task: BatchTask) => Promise<TaskResult>,
  onChange: (batch: Batch) => void | Promise<void>,
): Promise<void> {
  const batch = spec.batch
  const max = Math.max(1, Math.min(6, spec.maxParallel))
  const signal = spec.signal
  const active = new Set<Promise<void>>()
  const done = new Set<string>()
  const failed = new Set<string>()
  const skipped = new Set<string>()

  const cancelled = (): boolean => signal?.aborted === true
  const spent = (): number => batch.tasks.reduce((sum, t) => sum + t.cost, 0)
  const overBudget = (): boolean => batch.maxCost !== undefined && spent() >= batch.maxCost

  while (true) {
    let changed = false
    if (cancelled()) {
      for (const task of batch.tasks) {
        if (task.status !== 'pending') continue
        task.status = 'cancelled'
        task.error = 'batch cancelled'
        changed = true
      }
      if (changed) await onChange(batch)
    } else {
      let again = true
      while (again) {
        again = false
        for (const task of batch.tasks) {
          if (task.status !== 'pending') continue
          const bad = task.dependsOn.find(id => failed.has(id) || skipped.has(id))
          if (bad !== undefined) {
            task.status = 'skipped'
            task.error = `dependency ${bad} failed`
            skipped.add(task.id)
            again = true
          }
        }
        if (again) await onChange(batch)
      }
    }

    if (!cancelled() && overBudget()) {
      const budget = batch.maxCost ?? 0
      let stopped = false
      for (const task of batch.tasks) {
        if (task.status !== 'pending') continue
        task.status = 'skipped'
        task.error = `batch budget $${budget.toFixed(2)} reached`
        skipped.add(task.id)
        stopped = true
      }
      if (stopped) await onChange(batch)
    }

    while (!cancelled() && !overBudget() && active.size < max) {
      const next = batch.tasks.find(t => t.status === 'pending' && t.dependsOn.every(id => done.has(id)))
      if (next === undefined) break
      next.status = 'running'
      await onChange(batch)
      const running: Promise<void> = (async () => {
        let result: TaskResult
        try {
          result = await runTask(next)
        } catch (err) {
          result = { status: 'failed', cost: 0, steps: next.steps, error: err instanceof Error ? err.message : String(err) }
        }
        next.cost = result.cost
        next.steps = result.steps
        next.status = result.status
        if (result.last !== undefined) next.last = result.last
        if (result.sessionId !== undefined) next.sessionId = result.sessionId
        if (result.dir !== undefined) next.dir = result.dir
        if (result.branch !== undefined) next.branch = result.branch
        if (result.error !== undefined) next.error = result.error
        if (result.attempts !== undefined) next.attempts = result.attempts
        if (result.verify !== undefined) next.verify = result.verify.passed ? 'passed' : 'failed'
        if (result.status === 'done') done.add(next.id)
        else failed.add(next.id)
        await onChange(batch)
      })()
      active.add(running)
      void running.then(
        () => active.delete(running),
        () => active.delete(running),
      )
    }

    if (active.size === 0) {
      const pending = batch.tasks.filter(t => t.status === 'pending')
      if (pending.length > 0) {
        for (const task of pending) {
          task.status = cancelled() ? 'cancelled' : 'skipped'
          task.error = cancelled() ? 'batch cancelled' : 'dependency cycle'
          skipped.add(task.id)
        }
        await onChange(batch)
      }
      break
    }
    await Promise.race(active)
  }
}
