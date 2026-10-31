import type { EngineInterface } from 'claude-code'

import type { Effort, WorkerModel } from '../types'
import { isExe, isWindows, whereAll } from './platform'

// Gemini (and the other models a Google AI Pro plan offers) run through the Antigravity CLI,
// `agy`, signed in with the user's Google account: no API key and no per-token cost, drawn
// from the plan's quota. The mod names them `agy/<model>`, with the level split off the id.
export const AGY_PREFIX = 'agy/'
export const isAgyId = (id: string) => id.startsWith(AGY_PREFIX)

// agy prints nothing until it answers, so the usual no-output watchdog would kill a working
// run. agy's own --print-timeout ends it instead, and the watchdog waits a little longer.
export const AGY_TIMEOUT = '30m'
export const AGY_STALL_MS = 31 * 60_000

const LEVELS = ['low', 'medium', 'high'] as const

// catalog.ts imports this module, so the makers agy offers are named here.
const makerOf = (bare: string) =>
  bare.startsWith('gemini') ? 'Google' : bare.startsWith('claude') ? 'Anthropic' : bare.startsWith('gpt') ? 'OpenAI' : 'Other'

// agy's Windows installer puts agy.exe in %LOCALAPPDATA%\agy\bin.
async function findAgyExe($: EngineInterface): Promise<string | undefined> {
  const local = await $.env.get('LOCALAPPDATA')
  const paths = [...(await whereAll($, 'agy')).filter(isExe), ...(local === undefined ? [] : [`${local}/agy/bin/agy.exe`])]
  for (const path of paths) {
    if ((await $.fs.stat(path).catch(() => undefined)) !== undefined) return path
  }
  return undefined
}

export async function findAgy($: EngineInterface): Promise<string | undefined> {
  if (await isWindows($)) return findAgyExe($)
  const which = await $.process.run(['sh', '-c', 'command -v agy']).catch(() => undefined)
  if (which !== undefined && which.exitCode === 0 && which.stdout.trim() !== '') return which.stdout.trim()
  const home = await $.env.get('HOME')
  if (home === undefined) return undefined
  const path = `${home}/.local/bin/agy`
  return (await $.fs.stat(path).catch(() => undefined)) === undefined ? undefined : path
}

// `agy models` prints `<id>\t<name>` per model and level, e.g. `gemini-4-argon-high\tGemini 4 Argon (High)`.
export function parseAgyModels(out: string): WorkerModel[] {
  const byId = new Map<string, WorkerModel>()
  for (const line of out.split('\n')) {
    // agy versions print either tabs or columns padded with spaces.
    const columns = /^\s*(\S+)(?:\t+| {2,})(.+?)\s*$/.exec(line)
    if (columns === null) continue
    const rawId = columns[1] ?? ''
    const rawName = columns[2] ?? ''
    if (rawId === '' || rawName === '') continue
    const level = LEVELS.find(l => rawId.endsWith(`-${l}`))
    const bare = level === undefined ? rawId : rawId.slice(0, -level.length - 1)
    const id = `${AGY_PREFIX}${bare}`
    const name = rawName.replace(/\s*\((Low|Medium|High)\)$/i, '')
    const known = byId.get(id)
    if (known !== undefined) {
      if (level !== undefined && !known.efforts.includes(level)) known.efforts.push(level)
      continue
    }
    byId.set(id, {
      id,
      name,
      source: 'gemini',
      maker: makerOf(bare),
      input: 0,
      output: 0,
      efforts: level === undefined ? [] : [level],
      maxOutput: 64_000,
      context: bare.startsWith('gemini') ? 1_000_000 : 200_000,
    })
  }
  for (const m of byId.values()) m.efforts.sort((a, b) => LEVELS.indexOf(a as never) - LEVELS.indexOf(b as never))
  return [...byId.values()]
}

export async function loadAgyModels($: EngineInterface): Promise<WorkerModel[]> {
  const bin = await findAgy($)
  if (bin === undefined) return []
  const out = await $.process.run([bin, 'models'], { timeoutMs: 60_000 }).catch(() => undefined)
  return out === undefined || out.exitCode !== 0 ? [] : parseAgyModels(out.stdout)
}

/** The `--model` value: the bare id with a level agy offers (xhigh and max ask for high). */
export function agyModelArg(model: string, level?: string): string {
  const bare = model.slice(AGY_PREFIX.length)
  const wanted = level === 'xhigh' || level === 'max' ? 'high' : level
  return `${bare}-${LEVELS.includes(wanted as never) ? wanted : 'medium'}`
}

// Headless agy denies every tool that would ask for permission, so runs skip the prompts.
// --sandbox keeps credential folders out of the agent's commands; it does not stop writes to
// the rest of the home folder. readOnly is agy's plan mode, which edits nothing.
export function agyArgv(
  bin: string,
  o: { model: string; level?: string; sessionId?: string; readOnly?: boolean; files?: string[]; prompt: string; logFile: string },
): string[] {
  const files = (o.files ?? []).filter(file => file.trim() !== '')
  const prompt = files.length === 0 ? o.prompt : `${o.prompt}\n\nRead these files first: ${files.join(', ')}`
  return [
    bin,
    `--print=${prompt}`,
    '--model',
    agyModelArg(o.model, o.level),
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--sandbox',
    '--print-timeout',
    AGY_TIMEOUT,
    '--log-file',
    o.logFile,
    ...(o.readOnly ? ['--mode', 'plan'] : []),
    ...(o.sessionId ? ['--conversation', o.sessionId] : []),
  ]
}

/** Decode agy's headless result envelope, rather than interpreting partial text as a completed run. */
export function parseAgyResponse(out: string): { status: string; response: string; error?: string; conversationId?: string } {
  let value: unknown
  try {
    value = JSON.parse(out)
  } catch {
    return { status: 'INVALID', response: '', error: 'Antigravity returned no valid JSON result. Check agy --version and its stderr.' }
  }
  if (value === null || typeof value !== 'object') {
    return { status: 'INVALID', response: '', error: 'Antigravity returned an invalid result envelope.' }
  }
  const result = value as Record<string, unknown>
  const status = typeof result.status === 'string' ? result.status : 'INVALID'
  const response = typeof result.response === 'string' ? result.response : ''
  const error = typeof result.error === 'string' && result.error.trim() !== ''
    ? result.error
    : status !== 'SUCCESS' ? `Antigravity ended with status ${status}.` : undefined
  const conversationId = typeof result.conversation_id === 'string' && /^[0-9a-f-]{36}$/i.test(result.conversation_id)
    ? result.conversation_id
    : undefined
  return { status, response, ...(error ? { error } : {}), ...(conversationId ? { conversationId } : {}) }
}

/** The conversation a run started, from its log: what `--conversation` resumes. */
export function conversationIn(log: string): string | undefined {
  return /Created conversation ([0-9a-f-]{36})/.exec(log)?.[1]
}

/** The model that plans, reviews and checks: Gemini 4 Argon when the plan lists it. */
export function geminiChecker(models: WorkerModel[]): { model: string; effort: Effort } | undefined {
  const gemini = models.filter(m => m.source === 'gemini' && m.maker === 'Google')
  const pick = gemini.find(m => /argon/.test(m.id)) ?? gemini.find(m => !/flash/.test(m.id)) ?? gemini[0]
  return pick && { model: pick.id, effort: pick.efforts.includes('high') ? 'high' : 'medium' }
}

/** The checker a call names (a bare id is taken as agy's), else geminiChecker's pick. */
export function pickChecker(models: WorkerModel[], model?: string, effort?: Effort): { model: string; effort: Effort } | undefined {
  if (typeof model !== 'string' || model.trim() === '') {
    const pick = geminiChecker(models)
    return pick && effort !== undefined ? { ...pick, effort } : pick
  }
  const id = model.includes('/') ? model.trim() : `${AGY_PREFIX}${model.trim()}`
  const known = models.find(m => m.id === id)
  const fallback: Effort = known === undefined || known.efforts.includes('high') ? 'high' : 'medium'
  return { model: id, effort: effort ?? fallback }
}

export const NO_GEMINI =
  'Gemini runs through the Antigravity CLI signed in to the Google AI Pro plan, and it lists no Gemini models. Ask the user to install it (curl -fsSL https://antigravity.google/cli/install.sh | bash), run `agy` once to sign in, then press ↻ Refresh models in the OpenCode panel.'

export type PlannedTask = { id: string; title: string; prompt: string; dependsOn: string[]; verify?: string }
export type Plan = { summary: string; tasks: PlannedTask[] }

export const MAX_PLANNED = 6

export function planPrompt(goal: string, o: { shared?: string; verify?: string; maxTasks: number }): string {
  return [
    'You are the planner for a team of coding agents that each work alone, in their own copy of this folder, and see nothing but the prompt you write for them.',
    `Goal:\n${goal}`,
    ...(o.shared ? [`Context every agent also gets:\n${o.shared}`] : []),
    'Read the folder first, enough to plan well. Then split the goal into independent tasks that can run in parallel; use dependsOn only where a task truly needs another one\'s result.',
    `At most ${o.maxTasks} tasks; fewer is better when the goal is small (one task is fine).`,
    "Each prompt must stand alone: name the files, the change, the constraints and how to know it is done. Keep tasks from editing the same files where you can.",
    o.verify
      ? `Every task's verify is \`${o.verify}\` unless a narrower command checks that task better.`
      : 'Give each coding task a verify shell command that exits 0 only when the task is done (a test, a build, a script).',
    'Do not create or edit any file. Reply with ONLY a JSON object, no prose and no code fence:',
    '{"summary": string, "tasks": [{"id": string, "title": string, "prompt": string, "dependsOn": string[], "verify": string}]}',
    'ids are short kebab-case words.',
  ].join('\n\n')
}

// The first {...} in the answer that parses, so a stray fence or sentence around it is harmless.
export function parsePlan(text: string, maxTasks = MAX_PLANNED): Plan | string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return 'The planner gave no JSON plan.'
  let raw: any
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return 'The planner\'s JSON plan does not parse.'
  }
  const list: unknown[] = Array.isArray(raw?.tasks) ? raw.tasks : []
  const tasks: PlannedTask[] = []
  for (const t of list) {
    const x = t as Record<string, unknown>
    if (typeof x?.id !== 'string' || typeof x.prompt !== 'string' || x.prompt.trim() === '') continue
    const id = x.id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || `t${tasks.length + 1}`
    if (tasks.some(p => p.id === id)) continue
    tasks.push({
      id,
      title: typeof x.title === 'string' && x.title.trim() !== '' ? x.title.trim() : id,
      prompt: x.prompt,
      dependsOn: Array.isArray(x.dependsOn) ? x.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      ...(typeof x.verify === 'string' && x.verify.trim() !== '' ? { verify: x.verify.trim() } : {}),
    })
  }
  if (tasks.length === 0) return 'The planner\'s plan has no tasks.'
  if (tasks.length > maxTasks) return `The planner made ${tasks.length} tasks; at most ${maxTasks} are allowed.`
  const ids = new Set(tasks.map(t => t.id))
  for (const t of tasks) t.dependsOn = t.dependsOn.filter(d => ids.has(d) && d !== t.id)
  return { summary: typeof raw.summary === 'string' ? raw.summary.trim() : '', tasks }
}

export function checkPrompt(goal: string, diff: string): string {
  return [
    `Coding agents worked on this goal: ${goal.slice(0, 6_000)}`,
    `Their merged changes:\n${diff}`,
    'Check the merged result as a whole: does it meet the goal, do the parts fit together, is anything missing or broken? The folder holds the code before these changes; the diff is what changed.',
    'Reply with a first line of exactly `VERDICT: OK` or `VERDICT: CONCERNS`, then at most 8 short bullets `- <file>:<line> <problem>` (none needed for OK).',
    'Be strict about real problems and silent about style.',
  ].join('\n\n')
}
