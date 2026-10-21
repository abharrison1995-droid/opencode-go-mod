import type { EngineInterface } from 'claude-code'

import type { WorkerModel } from '../types'

export type Run = {
  text: string
  sessionId?: string
  tools: string[]
  errors: string[]
  cost: number
}

export type RunEnd = { code: number | null; signal: string | null }

export type EndReason = 'ok' | 'failed' | 'rate-limited' | 'hung' | 'cancelled'

export type VerifyResult = { passed: boolean; output: string; rounds?: number }

// reason labels why this attempt runs; previous is how the last attempt actually ended.
export type AttemptInfo = { attempt: number; model: string; reason: string; previous: EndReason }

export type ResilientOptions = {
  bin: string
  model: string
  fallback?: string
  // When set, used instead of fallback: each rung in turn, with its own retries.
  fallbacks?: { model: string; level?: string; retries?: number }[]
  level?: string
  prompt: string
  cwd: string | undefined
  autoApprove?: boolean
  readOnly?: boolean
  files?: string[]
  sessionId?: string
  retries: number
  firstRetries?: number
  stallMs: number
  signal?: AbortSignal
  verify?: string
  verifyRounds: number
  onAttempt?: (info: AttemptInfo) => void | Promise<void>
}

export type ResilientResult = {
  run: Run
  end: RunEnd
  stderr: string
  sessionId?: string
  model: string
  attempts: number
  reason: EndReason
  verify?: VerifyResult
  ms: number
}

// How long a resume waits before it starts, times the retry number. Abortable through the run's signal.
export const RETRY_WAIT_MS = 15_000

const RATE_LIMIT = [/429/, /rate limit/i, /endpoint is unavailable/i, /overloaded/i]

// `--` stops a prompt that starts with `-` being read as a flag. The working folder is the
// spawn's cwd alone: passing --dir as well resolved a relative dir twice.
export function buildArgv(
  bin: string,
  o: { model: string; level?: string; sessionId?: string; autoApprove?: boolean; readOnly?: boolean; files?: string[]; prompt: string },
): string[] {
  return [
    bin,
    'run',
    '--format',
    'json',
    '-m',
    o.model,
    ...(o.level ? ['--variant', o.level] : []),
    ...(o.sessionId ? ['--session', o.sessionId] : []),
    ...(o.autoApprove ? ['--auto'] : []),
    ...(o.readOnly ? ['--agent', 'plan'] : []),
    ...(o.files ?? []).flatMap(file => ['-f', file]),
    '--',
    o.prompt,
  ]
}

// Pure string code: no Node path module is available to a mod.
export function resolveDir(base: string, dir?: string): string | undefined {
  if (dir === undefined) return undefined
  const joined = dir.startsWith('/') ? dir : base === '' ? dir : `${base}/${dir}`
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop()
      else if (!joined.startsWith('/')) parts.push('..')
    } else parts.push(part)
  }
  const out = parts.join('/')
  if (joined.startsWith('/')) return `/${out}`
  return out === '' ? '.' : out
}

// Folds one line of `opencode run --format json` into the run so far.
export function readEvent(run: Run, line: string) {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    if (line.trim() !== '') run.errors.push(line.trim())
    return
  }
  run.sessionId ??= ev.sessionID ?? ev.part?.sessionID
  const part = ev.part ?? {}
  if (ev.type === 'text' || part.type === 'text') {
    if (typeof part.text === 'string') run.text += (run.text === '' ? '' : '\n') + part.text
  } else if (ev.type === 'tool_use' || part.type === 'tool') {
    const title = part.state?.title ?? part.state?.input?.filePath ?? part.state?.input?.command ?? ''
    const shown = String(title).length > 100 ? `…${String(title).slice(-99)}` : String(title)
    run.tools.push(`${part.tool ?? 'tool'}${shown ? `: ${shown}` : ''}`)
  } else if (ev.type === 'step_finish' || part.type === 'step-finish') {
    if (typeof part.cost === 'number') run.cost += part.cost
  } else if (ev.type === 'error') {
    run.errors.push(ev.error?.data?.message ?? ev.error?.message ?? JSON.stringify(ev.error ?? ev))
  }
}

// A watchdog is a real host timer: the stall limit is wall time, and a test kit without a
// clock still has setTimeout.
type Timers = {
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

function timers(): Timers {
  return globalThis as unknown as Timers
}


function looksRateLimited(run: Run, stderr: string): boolean {
  const text = [...run.errors, stderr].join('\n')
  return RATE_LIMIT.some(re => re.test(text))
}

export async function runOpencode(
  $: EngineInterface,
  argv: readonly string[],
  cwd: string | undefined,
  onProgress: (run: Run) => void | Promise<void>,
  o: { stallMs?: number; signal?: AbortSignal } = {},
): Promise<{ run: Run; end: RunEnd; stderr: string; reason: EndReason }> {
  const run: Run = { text: '', tools: [], errors: [], cost: 0 }
  let pending = ''
  let stderr = ''
  let end: RunEnd = { code: null, signal: null }
  let hung = false
  let cancelled = o.signal?.aborted === true
  if (cancelled) {
    end = { code: null, signal: 'cancelled' }
    return { run, end, stderr, reason: 'cancelled' }
  }
  const host = timers()
  const stream = $.process.spawn({ argv, cwd })[Symbol.asyncIterator]()
  while (!cancelled) {
    if (o.signal?.aborted === true) {
      cancelled = true
      try {
        void stream.return?.(undefined)?.catch?.(() => undefined)
      } catch {
        // Leaving the loop is what kills the child.
      }
      break
    }
    const pulled = stream.next()
    let timer: unknown
    let stall = false
    let wake: (() => void) | undefined
    const woken = new Promise<void>(resolve => (wake = resolve))
    const onStall = () => {
      stall = true
      wake?.()
    }
    // No host timer: fall back to the engine clock, ended early once the piece arrives.
    let sleeper: AbortController | undefined
    if (o.stallMs !== undefined && o.stallMs > 0) {
      if (host.setTimeout !== undefined) timer = host.setTimeout(onStall, o.stallMs)
      else {
        sleeper = new AbortController()
        $.clock.sleep(o.stallMs, { signal: sleeper.signal }).then(onStall, () => undefined)
      }
    }
    const onAbort = () => {
      cancelled = true
      wake?.()
    }
    o.signal?.addEventListener('abort', onAbort)
    let first: { kind: 'next'; value: IteratorResult<{ stream: 'stdout' | 'stderr'; text: string }, RunEnd> } | { kind: 'wake' }
    try {
      first = await Promise.race([
        pulled.then(value => ({ kind: 'next' as const, value })),
        woken.then(() => ({ kind: 'wake' as const })),
      ])
    } finally {
      if (timer !== undefined) host.clearTimeout?.(timer)
      sleeper?.abort()
      o.signal?.removeEventListener('abort', onAbort)
    }
    if (first.kind === 'wake') {
      void pulled.catch(() => undefined)
      try {
        void stream.return?.(undefined)?.catch?.(() => undefined)
      } catch {
        // Leaving the loop is what kills the child; a stream that cannot close is left to it.
      }
      if (!cancelled) hung = true
      break
    }
    const step = first.value
    if (step.done) {
      end = step.value
      break
    }
    const { stream: pipe, text } = step.value
    if (pipe === 'stderr') {
      stderr = (stderr + text).slice(-4000)
      continue
    }
    const lines = (pending + text).split('\n')
    pending = lines.pop() ?? ''
    const before = run.tools.length
    for (const line of lines) readEvent(run, line)
    if (run.tools.length !== before) await onProgress(run)
  }
  if (pending !== '') readEvent(run, pending)
  if (hung) end = { code: null, signal: 'hung' }
  if (cancelled) end = { code: null, signal: 'cancelled' }

  // A finished run that merely mentions a rate limit along the way is still ok.
  const failed = end.code !== 0 || (run.text === '' && run.errors.length > 0)
  const reason: EndReason = cancelled
    ? 'cancelled'
    : hung
      ? 'hung'
      : !failed
        ? 'ok'
        : looksRateLimited(run, stderr)
          ? 'rate-limited'
          : 'failed'
  return { run, end, stderr, reason }
}

function merge(into: Run, from: Run) {
  into.text = from.text
  if (from.sessionId !== undefined) into.sessionId = from.sessionId
  into.tools.push(...from.tools)
  into.errors.push(...from.errors)
  into.cost += from.cost
}

export function retryPrompt(reason: string): string {
  return `Continue the task from where you stopped (the last request failed: ${reason}). Check what you already changed before going on, then finish it.`
}

export function verifyPrompt(command: string, output: string): string {
  return `Your work does not pass the check \`${command}\` yet. Its output (last 3000 chars):\n${output.slice(-3000)}\nFix it, re-run the check yourself, and finish.`
}

async function runVerify($: EngineInterface, command: string, cwd: string | undefined): Promise<{ passed: boolean; output: string }> {
  const result = await $.process.run(['sh', '-c', command], { cwd, timeoutMs: 600_000 }).catch(err => ({
    exitCode: 1,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
    isStdoutTruncated: false,
    isStderrTruncated: false,
  }))
  const output = [result.stdout, result.stderr].filter(part => part.trim() !== '').join('\n').trim()
  return { passed: result.exitCode === 0, output }
}

// Runs a worker, then resumes it over rate limits, hangs, failures and failed checks, and
// finally on the fallback model. Merges every attempt's text, tools, errors and cost.
export async function runResilient(
  $: EngineInterface,
  o: ResilientOptions,
  onProgress: (run: Run) => void | Promise<void>,
): Promise<ResilientResult> {
  const started = Date.now()
  const merged: Run = { text: '', tools: [], errors: [], cost: 0 }
  let sessionId = o.sessionId
  let model = o.model
  let level = o.level
  let attempts = 0
  let reason: EndReason = 'failed'
  let verify: VerifyResult | undefined
  let end: RunEnd = { code: null, signal: null }
  let stderr = ''

  const attempt = async (prompt: string, nextModel: string, nextSession: string | undefined, why: string, nextLevel: string | undefined) => {
    if (o.signal?.aborted === true) {
      reason = 'cancelled'
      return undefined
    }
    if (attempts > 0 && o.onAttempt !== undefined) await o.onAttempt({ attempt: attempts + 1, model: nextModel, reason: why, previous: reason })
    attempts++
    const argv = buildArgv(o.bin, {
      model: nextModel,
      level: nextLevel,
      sessionId: nextSession,
      autoApprove: o.autoApprove,
      readOnly: o.readOnly,
      files: o.files,
      prompt,
    })
    const result = await runOpencode($, argv, o.cwd, onProgress, { stallMs: o.stallMs, signal: o.signal })
    merge(merged, result.run)
    end = result.end
    stderr = result.stderr
    if (result.run.sessionId !== undefined) sessionId = result.run.sessionId
    model = nextModel
    level = nextLevel
    reason = result.reason
    return result
  }

  const wait = async (n: number): Promise<boolean> => {
    if (o.signal?.aborted === true) return false
    try {
      await $.clock.sleep(RETRY_WAIT_MS * n, o.signal === undefined ? undefined : { signal: o.signal })
      return true
    } catch {
      return false
    }
  }

  // Resumes the session when there is one, else starts the task fresh. A fresh start has
  // nothing to check, so it goes again at once instead of paying the resume wait.
  const retryRound = async (nextModel: string, tries: number, firstWhy: string, nextLevel: string | undefined) => {
    let why = firstWhy
    for (let i = 0; i < tries; i++) {
      if (reason === 'ok' || reason === 'cancelled') return
      if (sessionId !== undefined && !(await wait(i + 1))) {
        reason = 'cancelled'
        return
      }
      const prompt = sessionId === undefined ? o.prompt : retryPrompt(reason)
      await attempt(prompt, nextModel, sessionId, why, nextLevel)
      why = reason
    }
  }

  await attempt(o.prompt, o.model, o.sessionId, 'start', o.level)
  await retryRound(o.model, Math.max(0, o.firstRetries ?? o.retries), reason, o.level)

  if (reason !== 'ok' && reason !== 'cancelled' && o.fallbacks !== undefined && o.fallbacks.length > 0) {
    for (const rung of o.fallbacks) {
      if (reason === 'ok' || reason === 'cancelled') break
      const prompt = sessionId === undefined ? o.prompt : retryPrompt(reason)
      await attempt(prompt, rung.model, sessionId, 'fallback', rung.level)
      await retryRound(rung.model, Math.max(0, rung.retries ?? o.retries), reason, rung.level)
    }
  } else {
    const fallback = o.fallback ?? ''
    if (reason !== 'ok' && reason !== 'cancelled' && fallback !== '' && fallback !== model) {
      const prompt = sessionId === undefined ? o.prompt : retryPrompt(reason)
      await attempt(prompt, fallback, sessionId, 'fallback', o.level)
      await retryRound(fallback, Math.max(0, o.retries), reason, o.level)
    }
  }

  if (reason === 'ok' && o.verify !== undefined && o.verify.trim() !== '') {
    let check = await runVerify($, o.verify, o.cwd)
    let rounds = 0
    const max = Math.max(0, o.verifyRounds)
    while (!check.passed && rounds < max && sessionId !== undefined && o.signal?.aborted !== true) {
      rounds++
      await attempt(verifyPrompt(o.verify, check.output), model, sessionId, 'verify', level)
      if (reason !== 'ok') break
      check = await runVerify($, o.verify, o.cwd)
    }
    verify = { passed: check.passed, output: check.output, rounds }
    if (o.signal?.aborted === true) reason = 'cancelled'
    else if (!check.passed) reason = 'failed'
  }

  return { run: merged, end, stderr, sessionId, model, attempts, reason, verify, ms: Date.now() - started }
}

export function formatReport(o: {
  model: string
  level?: string
  wanted?: string
  short: string
  run: Run
  end: RunEnd
  stderr: string
  free?: boolean
  attempts?: number
  verify?: VerifyResult
  warning?: string
}): string {
  const { model, level, wanted, short, run, end, stderr } = o
  const failed = end.code !== 0 || (run.text === '' && run.errors.length > 0)
  const verify = o.verify === undefined ? undefined : o.verify.passed ? 'verify: passed' : `verify: FAILED after ${o.verify.rounds ?? 0} rounds\n${o.verify.output.slice(-1500)}`
  return [
    `model: ${model}${level ? ` · reasoning ${level}` : wanted ? ` · reasoning default (${short} has no ${wanted} level)` : ''}`,
    o.attempts !== undefined && o.attempts > 1 ? `attempts: ${o.attempts}` : undefined,
    o.warning ? `warning: ${o.warning}` : undefined,
    run.sessionId ? `sessionId: ${run.sessionId}` : undefined,
    `exit: ${end.signal ?? end.code}`,
    `cost: $${run.cost.toFixed(4)}${o.free ? ' (free model)' : ''}`,
    run.tools.length ? `actions (${run.tools.length}):\n${run.tools.map(t => `- ${t}`).join('\n')}` : undefined,
    run.errors.length ? `errors:\n${run.errors.join('\n')}` : undefined,
    failed && stderr.trim() ? `stderr:\n${stderr.trim()}` : undefined,
    verify,
    `answer:\n${run.text || '(no text answer)'}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// Today's date where the person is, not UTC.
export function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function dailySpent($: EngineInterface, day: string): Promise<number> {
  const held = await Promise.resolve($.store.get('spendDaily')).catch(() => undefined)
  if (held === null || typeof held !== 'object') return 0
  const value = held as { date?: unknown; usd?: unknown }
  return value.date === day && typeof value.usd === 'number' ? value.usd : 0
}

export function budgetMessage(budget: number, spent: number): string {
  return `Daily OpenCode budget $${budget.toFixed(2)} reached ($${spent.toFixed(2)} spent today). Raise it in the plugin settings or use a free model.`
}

export async function attachedChars($: EngineInterface, files: readonly string[]): Promise<number> {
  let chars = 0
  for (const file of files) {
    const stat = await Promise.resolve($.fs.stat(file)).catch(() => undefined)
    if (stat !== undefined && typeof stat.size === 'number') chars += stat.size
  }
  return chars
}

export type ContextVerdict = { level: 'ok' | 'warn' | 'over'; estimate: number; limit: number }

// Roughly four characters a token. Unknown models have no window to compare against.
export function contextVerdict(chars: number, model: WorkerModel | undefined): ContextVerdict | undefined {
  if (model === undefined || !(model.context > 0)) return undefined
  const estimate = Math.ceil(chars / 4)
  const ratio = estimate / model.context
  return { level: ratio > 0.8 ? 'over' : ratio >= 0.5 ? 'warn' : 'ok', estimate, limit: model.context }
}

export function overContext(verdict: ContextVerdict): string {
  return `This task is about ${verdict.estimate} tokens, over 80% of the model's ${verdict.limit}-token context window. Trim the prompt or files, or pick a larger-context model.`
}

export function contextWarning(verdict: ContextVerdict): string {
  return `this task is about ${verdict.estimate} tokens, ${Math.round((verdict.estimate / verdict.limit) * 100)}% of the model's ${verdict.limit}-token context window.`
}

// A notification channel is optional, and the test kit may leave it out: never let it fail a batch.
export function notify($: EngineInterface, text: string, title: string) {
  try {
    void $.ui.notify(text, { title }).catch(() => undefined)
  } catch {
    // No ui.notify beneath this environment.
  }
}
