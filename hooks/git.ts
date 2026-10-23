import type { EngineInterface } from 'claude-code'

import type { Batch, BatchTask } from '../types'

export type GitResult = { ok: boolean; text: string }

export type TaskAction = 'diff' | 'merge' | 'discard'

const CAP = 60_000

// Batches made before top/base were recorded still know their worktree's folder; the
// folder is `<top>-opencode/<batch>-<task>`, so its head is the repo.
export function repoOf(batch: Batch, task: BatchTask) {
  if (batch.top !== undefined) return { top: batch.top, base: batch.base }
  const at = task.dir === undefined ? -1 : task.dir.indexOf('-opencode/')
  return at > 0 ? { top: task.dir?.slice(0, at), base: batch.base } : { top: batch.top, base: batch.base }
}

async function git($: EngineInterface, argv: string[]) {
  const out = await $.process
    .run(argv)
    .catch(err => ({ exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }))
  return { code: out.exitCode, stdout: out.stdout, stderr: out.stderr }
}

function cut(text: string) {
  return text.length <= CAP ? text : `${text.slice(0, CAP)}\n… (cut)`
}

export async function branchDiff($: EngineInterface, top: string, base: string, branch: string): Promise<GitResult> {
  const stat = await git($, ['git', '-C', top, 'diff', '--stat', `${base}...${branch}`])
  const diff = await git($, ['git', '-C', top, 'diff', `${base}...${branch}`])
  const ok = stat.code === 0 && diff.code === 0
  const text = [stat.stdout.trim(), diff.stdout.trim(), stat.stderr.trim(), diff.stderr.trim()].filter(t => t !== '').join('\n\n')
  return { ok, text: cut(text || (ok ? 'No changes.' : 'git diff failed.')) }
}

export async function mergeBranch($: EngineInterface, top: string, branch: string): Promise<GitResult> {
  const status = await git($, ['git', '-C', top, 'status', '--porcelain'])
  if (status.code !== 0) return { ok: false, text: status.stderr.trim() || `git -C ${top} status failed` }
  if (status.stdout.trim() !== '') {
    return { ok: false, text: `The main checkout has uncommitted changes; commit or stash them first.\n${status.stdout.trim()}` }
  }

  const merge = await git($, ['git', '-C', top, 'merge', '--no-ff', '--no-edit', branch])
  if (merge.code === 0) return { ok: true, text: (merge.stdout + merge.stderr).trim() || `Merged ${branch}.` }

  const conflicts = await git($, ['git', '-C', top, 'diff', '--name-only', '--diff-filter=U'])
  await git($, ['git', '-C', top, 'merge', '--abort'])
  const files = conflicts.stdout.trim()
  return {
    ok: false,
    text: [`Merge of ${branch} failed${files === '' ? '' : `; conflicting files:\n${files}`}.`, (merge.stdout + merge.stderr).trim()]
      .filter(t => t !== '')
      .join('\n'),
  }
}

export async function discardTask($: EngineInterface, top: string, folder: string, branch: string): Promise<GitResult> {
  const removed = await git($, ['git', '-C', top, 'worktree', 'remove', '--force', folder])
  const deleted = await git($, ['git', '-C', top, 'branch', '-D', branch])
  const ok = removed.code === 0 && deleted.code === 0
  const text = [removed.stdout, removed.stderr, deleted.stdout, deleted.stderr].map(t => t.trim()).filter(t => t !== '').join('\n')
  return { ok, text: text || (ok ? `Discarded ${branch}.` : `Could not discard ${branch}.`) }
}

export function worktreeFolder(top: string, batchId: string, taskId: string) {
  return `${top}-opencode/${batchId}-${taskId}`
}
