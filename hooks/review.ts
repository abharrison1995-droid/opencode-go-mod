import type { EngineInterface } from 'claude-code'

import { runResilient } from './delegate'

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
  // What to compare, when not the task's branch against base (the final check of a merged batch).
  rev?: string
  // The reviewer's instructions for the diff, in place of the task review's.
  ask?: (diff: string) => string
}

export type Review = { verdict: 'ok' | 'concerns' | 'error'; notes: string; cost: number; model: string }

const DIFF_CAP = 40_000
const PROMPT_CAP = 6_000
const NOTES_CAP = 2_000
const ERROR_CAP = 300

function cutDiff(text: string): string {
  return text.length <= DIFF_CAP ? text : `${text.slice(0, DIFF_CAP)}\n… (diff cut at ${DIFF_CAP} characters)`
}

async function gitAt($: EngineInterface, argv: string[]) {
  const out = await $.process
    .run(argv)
    .catch(err => ({ exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }))
  return { code: out.exitCode, stdout: out.stdout, stderr: out.stderr }
}

function reviewPrompt(prompt: string, diff: string): string {
  return [
    `You are reviewing another agent's work on this task: ${prompt.slice(0, PROMPT_CAP)}`,
    `Here is its diff:\n${diff}`,
    'Check that it does what the task asked, for bugs, for missing pieces, and for changes outside the task\'s scope; you may read files in the folder.',
    'Reply with a first line of exactly `VERDICT: OK` or `VERDICT: CONCERNS`, then at most 8 short bullets `- <file>:<line> <problem>` (none needed for OK).',
    'Be strict about real problems and silent about style.',
  ].join('\n\n')
}

// A second, read-only worker checks a finished task's diff against its prompt, so Claude
// reads only the flagged parts.
export async function reviewTask($: EngineInterface, o: ReviewOptions): Promise<Review> {
  const rev = o.rev ?? `${o.base}...HEAD`
  const stat = await gitAt($, ['git', '-C', o.dir, 'diff', '--stat', rev])
  const diff = await gitAt($, ['git', '-C', o.dir, 'diff', rev])
  const changes = [stat.stdout.trim(), diff.stdout.trim()].filter(text => text !== '').join('\n\n')
  if (changes === '') return { verdict: 'concerns', notes: 'The task changed nothing.', cost: 0, model: o.model }

  const outcome = await runResilient(
    $,
    {
      bin: o.bin,
      model: o.model,
      level: o.level,
      fallback: o.fallback,
      prompt: (o.ask ?? (diff => reviewPrompt(o.prompt, diff)))(cutDiff(changes)),
      cwd: o.dir,
      readOnly: true,
      retries: o.retries,
      stallMs: o.stallMs,
      signal: o.signal,
      verifyRounds: 0,
    },
    () => undefined,
  )

  const answer = outcome.run.text.trim()
  const match = /VERDICT:\s*(OK|CONCERNS)/i.exec(answer)
  if (outcome.reason !== 'ok' || match === null) {
    const detail =
      answer !== ''
        ? answer
        : outcome.stderr.trim() !== ''
          ? outcome.stderr.trim()
          : outcome.run.errors.join('\n').trim() || 'The review worker failed.'
    return { verdict: 'error', notes: detail.slice(0, ERROR_CAP), cost: outcome.run.cost, model: outcome.model }
  }

  const lineEnd = answer.indexOf('\n', match.index)
  const notes = (lineEnd === -1 ? '' : answer.slice(lineEnd + 1)).trim().slice(0, NOTES_CAP)
  return {
    verdict: match[1]?.toLowerCase() === 'ok' ? 'ok' : 'concerns',
    notes,
    cost: outcome.run.cost,
    model: outcome.model,
  }
}
