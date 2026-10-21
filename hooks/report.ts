import type { EngineInterface } from 'claude-code'

import type { Batch, BatchTask } from '../types'
import type { BatchExtras } from './batch'
import type { EndReason, Run, RunEnd, VerifyResult } from './delegate'

// Auto-merge's outcome the panel's Batch does not carry: merged ids and each
// conflicting task's files. Kept beside the run so both reports can show them.
export type ReportExtras = BatchExtras & { merged?: string[]; conflicts?: Record<string, string[]> }

const ANSWER = 1200
const ERROR = 600
const SHORT_ERROR = 300
const SHORT_ANSWER = 400

const ICONS: Record<BatchTask['status'], string> = {
  pending: '○',
  running: '◐',
  done: '●',
  failed: '✕',
  skipped: '–',
  cancelled: '⊘',
}

function cut(text: string, n: number): string {
  const trimmed = text.trim()
  return trimmed.length <= n ? trimmed : `${trimmed.slice(0, n)}…`
}

function shortModel(id: string): string {
  return id.split('/')[1] ?? id
}

// The last line of `git show --stat` (or diff --stat) is the summary the model reads.
function statSummary(stat: string | undefined): string | undefined {
  if (stat === undefined) return undefined
  const lines = stat.split('\n').map(line => line.trim())
  return [...lines].reverse().find(line => /changed/.test(line))
}

export async function writeReport($: EngineInterface, base: string, name: string, text: string): Promise<string> {
  const folder = base.replace(/\/+$/, '')
  const path = `${folder}/.opencode/reports/${name}.md`
  try {
    await $.fs.write(path, text)
    // Keeps reports out of the user's git status and commits.
    await $.fs.write(`${folder}/.opencode/reports/.gitignore`, '*\n')
  } catch {
    // A read-only project still gets the report inline; the path is best effort.
  }
  return path
}

export async function changedFiles($: EngineInterface, dir: string | undefined): Promise<string[]> {
  if (dir === undefined || dir === '') return []
  const out = await $.process
    .run(['git', '-C', dir, 'status', '--porcelain'])
    .catch(() => undefined)
  if (out === undefined || out.exitCode !== 0) return []
  return out.stdout
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line !== '')
    .slice(0, 20)
}

export function delegateShort(o: {
  model: string
  level?: string
  wanted?: string
  short: string
  run: Run
  end: RunEnd
  reason: EndReason
  stderr: string
  free?: boolean
  attempts?: number
  verify?: VerifyResult
  warning?: string
  files?: string[]
  path: string
}): string {
  const { model, level, wanted, run, end, reason, stderr, path } = o
  const failed = end.code !== 0 || (run.text === '' && run.errors.length > 0)
  const errors = [...run.errors]
  if (failed && stderr.trim() !== '') errors.push(stderr.trim())
  const answer = run.text || '(no text answer)'
  const levelText = level !== undefined ? `reasoning ${level}` : wanted !== undefined ? 'reasoning default' : 'reasoning default'

  return [
    `model: ${model} · ${levelText} · attempts: ${o.attempts ?? 1} · exit: ${end.signal ?? end.code} · reason: ${reason} · cost: $${run.cost.toFixed(4)}${o.free ? ' (free)' : ''}`,
    o.warning !== undefined ? `warning: ${o.warning}` : undefined,
    run.sessionId !== undefined ? `sessionId: ${run.sessionId}` : undefined,
    o.verify === undefined ? undefined : o.verify.passed ? 'verify: passed' : `verify: FAILED after ${o.verify.rounds ?? 0} rounds\n${cut(o.verify.output, 400)}`,
    o.files !== undefined && o.files.length > 0 ? `files changed:\n${o.files.join('\n')}` : undefined,
    `answer:\n${answer.length <= ANSWER ? answer : `${answer.slice(0, ANSWER)}\n… (full answer in ${path})`}`,
    errors.length > 0 ? `errors:\n${cut(errors.join('\n'), ERROR)}` : undefined,
    `Full report: ${path}`,
  ]
    .filter(line => line !== undefined)
    .join('\n\n')
}

function mergeLines(batch: Batch, extras: ReportExtras): string[] {
  const integration = batch.integration
  const merged = batch.tasks.filter(t => t.merged === true).map(t => t.id)
  const conflicts = extras.conflicts ?? {}
  const conflicted = Object.entries(conflicts)
  if (integration === undefined && merged.length === 0 && conflicted.length === 0) return []

  const lines: string[] = []
  if (merged.length > 0) lines.push(`Merged into ${integration ?? 'the integration branch'}: ${merged.join(', ')}`)
  for (const [id, files] of conflicted) {
    lines.push(`Conflicts (not merged): ${id}${files.length > 0 ? ` (files: ${files.join(', ')})` : ''}`)
  }
  if (integration !== undefined && batch.top !== undefined) lines.push(`To take it: git -C ${batch.top} merge ${integration}`)
  return lines
}

export function batchShortReport(o: { batch: Batch; extras: ReportExtras; path: string }): string {
  const { batch, extras, path } = o
  const done = batch.tasks.filter(t => t.status === 'done').length
  const total = batch.tasks.reduce((sum, t) => sum + t.cost, 0)
  const counts = (['failed', 'skipped', 'cancelled'] as const)
    .map(status => ({ status, n: batch.tasks.filter(t => t.status === status).length }))
    .filter(row => row.n > 0)
    .map(row => `${row.n} ${row.status}`)
  const lines = [`${done}/${batch.tasks.length} done · $${total.toFixed(4)} · ${counts.length > 0 ? counts.join(' · ') : 'all done'}`]

  for (const task of batch.tasks) {
    const parts = [`${ICONS[task.status]} ${task.id}`, task.status, shortModel(task.model), `$${task.cost.toFixed(4)}`, `try ${task.attempts ?? 1}`]
    if (task.verify !== undefined) parts.push(task.verify === 'passed' ? 'verify ✓' : 'verify ✗')
    const stat = statSummary(extras.diffs?.[task.id])
    if (stat !== undefined) parts.push(stat)
    if (task.branch !== undefined) parts.push(task.branch)
    lines.push(parts.join(' · '))
  }

  for (const task of batch.tasks) {
    if (task.status === 'pending' || task.status === 'running' || task.status === 'done') continue
    if (task.error !== undefined && task.error.trim() !== '') lines.push(`${task.id} error: ${cut(task.error, SHORT_ERROR)}`)
    const answer = extras.answers?.[task.id]
    if (answer !== undefined && answer.trim() !== '') lines.push(`${task.id} answer: ${cut(answer, SHORT_ANSWER)}`)
  }

  const merge = mergeLines(batch, extras)
  if (merge.length > 0) lines.push(`Merge:\n${merge.join('\n')}`)
  lines.push(`Full report: ${path}`)
  return lines.join('\n')
}

export function batchReport(batch: Batch, extras: ReportExtras = {}): string {
  const finished = batch.tasks.filter(t => t.status === 'done').length
  const total = batch.tasks.reduce((sum, t) => sum + t.cost, 0)
  const lines = [`# ${batch.title}`, `${finished}/${batch.tasks.length} done · $${total.toFixed(4)}`]
  if (batch.tasks.some(t => t.dependsOn.length > 0)) {
    lines.push('Dependent tasks started from HEAD, not from their dependency’s changes.')
  }

  for (const task of batch.tasks) {
    lines.push(
      [
        `## ${task.id} · ${task.title} · ${task.status}`,
        `model: ${task.model}${task.effort ? ` · reasoning ${task.effort}` : ''}`,
        task.attempts !== undefined && task.attempts > 1 ? `attempts: ${task.attempts}` : undefined,
        extras.warnings?.[task.id] ? `warning: ${extras.warnings[task.id]}` : undefined,
        `cost: $${task.cost.toFixed(4)}`,
        task.verify ? `verify: ${task.verify}` : undefined,
        task.sessionId ? `sessionId: ${task.sessionId}` : undefined,
        task.dir ? `dir: ${task.dir}` : undefined,
        task.branch ? `branch: ${task.branch}` : undefined,
        extras.diffs?.[task.id]?.trim() ? `diff:\n${extras.diffs[task.id].trim()}` : undefined,
        task.steps ? `actions (${task.steps}): ${task.last ?? ''}`.trimEnd() : undefined,
        task.error ? `error: ${task.error}` : undefined,
        extras.answers?.[task.id] !== undefined ? `answer:\n${extras.answers[task.id].slice(0, 3000)}` : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  const merge = mergeLines(batch, extras)
  if (merge.length > 0) lines.push(['## Merge', ...merge].join('\n'))

  if (extras.isolation === 'worktree' && extras.top) {
    const main = extras.branch ?? 'main'
    const branches = batch.tasks.filter(t => t.branch !== undefined)
    if (branches.length > 0) {
      lines.push(
        [
          '## Review and merge',
          `Review each branch with \`git -C ${extras.top} diff ${main}...<branch>\`, merge what is good, then remove its worktree and branch.`,
          ...branches.map(t => `- ${t.id}: \`git -C ${extras.top} diff ${main}...${t.branch}\`; \`git -C ${extras.top} worktree remove ${extras.top}-opencode/${batch.id}-${t.id}\`; \`git -C ${extras.top} branch -D ${t.branch}\``),
        ].join('\n'),
      )
    }
  }

  return lines.join('\n\n')
}
