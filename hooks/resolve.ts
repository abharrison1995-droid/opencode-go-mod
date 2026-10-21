import type { EngineInterface } from 'claude-code'

import { runResilient } from './delegate'

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

type GitOut = { exitCode: number; stdout: string; stderr: string }

const IDENTITY = ['-c', 'user.name=OpenCode worker', '-c', 'user.email=opencode-worker@localhost']

async function git($: EngineInterface, argv: string[]): Promise<GitOut> {
  return $.process.run(argv).catch(err => ({ exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }))
}

function lines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '')
}

async function rollback($: EngineInterface, dir: string, start: string) {
  const aborted = await git($, ['git', '-C', dir, 'merge', '--abort'])
  if (aborted.exitCode !== 0 && start !== '') await git($, ['git', '-C', dir, 'reset', '--hard', start])
}

// Brings the integration branch into a conflicting task's worktree and has the worker
// resolve the conflict, so its branch then merges cleanly.
export async function resolveConflict($: EngineInterface, o: ResolveOptions): Promise<ResolveResult> {
  if (o.signal?.aborted === true) return { ok: false, cost: 0, model: o.model, note: 'cancelled' }

  const startOut = await git($, ['git', '-C', o.dir, 'rev-parse', 'HEAD'])
  const start = startOut.stdout.trim()

  const merged = await git($, ['git', '-C', o.dir, ...IDENTITY, 'merge', '--no-edit', o.integration])
  if (merged.exitCode === 0) return { ok: true, cost: 0, model: o.model, note: 'merged cleanly' }

  const conflicts = await git($, ['git', '-C', o.dir, 'diff', '--name-only', '--diff-filter=U'])
  const files = conflicts.exitCode === 0 ? lines(conflicts.stdout) : []
  if (files.length === 0) files.push(...o.files)

  const fresh = o.sessionId === undefined || o.sessionId === ''
  const prompt = [
    `The branch \`${o.integration}\` holds other tasks' finished work and was merged into this worktree.`,
    `These files have conflict markers: ${files.join(', ')}.`,
    "Resolve every conflict so both sides' changes are kept (the other tasks' work must stay), remove all markers, and do not commit.",
    o.verify !== undefined && o.verify.trim() !== ''
      ? `Re-run the check \`${o.verify}\` when you are done.`
      : 'Re-run the check if one was given.',
    ...(fresh ? ['', 'Your original task:', o.prompt.slice(0, 4000)] : []),
  ].join('\n')

  let cost = 0
  try {
    const outcome = await runResilient(
      $,
      {
        bin: o.bin,
        model: o.model,
        fallback: o.fallback,
        level: o.level,
        prompt,
        cwd: o.dir,
        autoApprove: o.autoApprove,
        sessionId: fresh ? undefined : o.sessionId,
        retries: o.retries,
        stallMs: o.stallMs,
        signal: o.signal,
        verify: o.verify,
        verifyRounds: o.verifyRounds,
      },
      () => undefined,
    )
    cost = outcome.run.cost
    const model = outcome.model

    if (o.signal?.aborted === true || outcome.reason === 'cancelled') {
      await rollback($, o.dir, start)
      return { ok: false, cost, model, note: 'cancelled' }
    }
    if (outcome.reason !== 'ok') {
      await rollback($, o.dir, start)
      return { ok: false, cost, model, note: `worker could not resolve the conflict (${outcome.reason})` }
    }

    const markers = await git($, ['git', '-C', o.dir, 'grep', '-nE', '^(<<<<<<<|>>>>>>>)', '--', ...files])
    if (markers.exitCode === 0) {
      await rollback($, o.dir, start)
      return { ok: false, cost, model, note: 'conflict markers remain' }
    }

    if (o.signal?.aborted === true) {
      await rollback($, o.dir, start)
      return { ok: false, cost, model, note: 'cancelled' }
    }

    const added = await git($, ['git', '-C', o.dir, 'add', '-A'])
    const committed = added.exitCode === 0 ? await git($, ['git', '-C', o.dir, ...IDENTITY, 'commit', '--no-edit']) : added
    if (committed.exitCode !== 0) {
      await rollback($, o.dir, start)
      const why = added.exitCode !== 0 ? 'git add failed' : 'commit failed'
      return { ok: false, cost, model, note: why }
    }

    return { ok: true, cost, model, note: 'resolved by worker' }
  } catch (err) {
    await rollback($, o.dir, start)
    return {
      ok: false,
      cost,
      model: o.model,
      note: err instanceof Error ? err.message : String(err),
    }
  }
}
