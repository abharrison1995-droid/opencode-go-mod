import type { EngineInterface, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { LocalName, LocalServer } from '../types'

// Decision models served on this machine over TypeSafe's POST /v1/systemone.
export type LocalSpec = {
  name: LocalName
  label: string
  port: number
  /** path under the models dir the server runs in */
  folder: string
  argv: (dir: string, opts: LocalOptions) => string[]
  env: (opts: LocalOptions) => Record<string, string>
  /** GET path that answers 200 once weights are loaded */
  ready: string
  note: string
}

export type LocalOptions = { dir: string; kevRun: string; device: string; layaDevice: string; /** GiB of GPU Kev may take, the rest in RAM; 0: all on one device */ kevGpuGb: number; /** this mod's folder, for scripts/kev_split.py */ root: string }

export const LOCAL: LocalSpec[] = [
  {
    name: 'kev',
    label: 'Kev',
    port: 8009,
    folder: 'kev',
    argv: (dir, o) => [
      `${dir}/kev/.venv/bin/python`,
      ...(o.kevGpuGb > 0 ? [`${o.root}/scripts/kev_split.py`] : ['-m', 'kev.serve']),
      ...['--run', o.kevRun, '--port', '8009', '--host', '127.0.0.1', '--device', o.kevGpuGb > 0 ? 'cuda' : o.device],
    ],
    env: (o): Record<string, string> => (o.kevGpuGb > 0 ? { KEV_GPU_GB: String(o.kevGpuGb) } : {}),
    ready: '/v1/models',
    note: 'Qwen3.5 + LoRA decision model (Jared Palmer)',
  },
  {
    name: 'laya',
    label: 'Laya',
    port: 8010,
    folder: '.',
    argv: dir => [`${dir}/laya-env/bin/laya-serve`],
    env: o => ({ LAYA_HOST: '127.0.0.1', LAYA_PORT: '8010', LAYA_MODELS: 'english', LAYA_DEVICE: o.layaDevice === 'auto' ? '' : o.layaDevice }),
    ready: '/health',
    note: 'ModernBERT decision model, 100+ languages (Convai)',
  },
]

export const notInstalled = (s: LocalSpec, bin: string) => `${s.label} is not installed (${bin} is missing). Run /opencode local setup for the install command.`

export const localNamed = (name: string) => LOCAL.find(s => s.name === name.toLowerCase())

const url = (s: LocalSpec, path: string) => `http://127.0.0.1:${s.port}${path}`

// Module-level, so a reload (which kills the children with the module) starts clean.
const children = new Map<LocalName, AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>>()

export async function ping($: EngineInterface, s: LocalSpec): Promise<boolean> {
  try {
    return (await $.http.fetch(url(s, s.ready))).ok
  } catch {
    return false
  }
}

/** Starts the server unless one already answers, and waits up to `waitMs` for it. */
export async function startLocal(
  $: EngineInterface,
  s: LocalSpec,
  opts: LocalOptions,
  set: (state: Partial<LocalServer>) => Promise<void>,
  waitMs = 600_000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await ping($, s)) {
    await set({ status: 'ready', error: undefined })
    return { ok: true }
  }
  // One server loads at a time: two loading together spike RAM and GPU memory at once.
  const turn = starting
  let done = () => {}
  starting = new Promise<void>(r => (done = r))
  try {
    await turn
    return await launch($, s, opts, set, waitMs)
  } finally {
    done()
  }
}

let starting: Promise<void> = Promise.resolve()

async function launch(
  $: EngineInterface,
  s: LocalSpec,
  opts: LocalOptions,
  set: (state: Partial<LocalServer>) => Promise<void>,
  waitMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await ping($, s)) {
    await set({ status: 'ready', error: undefined })
    return { ok: true }
  }
  if (!children.has(s.name)) {
    const bin = s.argv(opts.dir, opts)[0] ?? ''
    if ((await $.fs.stat(bin).catch(() => undefined)) === undefined) {
      const error = notInstalled(s, bin)
      await set({ status: 'error', error })
      return { ok: false, error }
    }
    const stream = $.process.spawn({ argv: s.argv(opts.dir, opts), cwd: `${opts.dir}/${s.folder}`, env: s.env(opts) })
    children.set(s.name, stream)
    await set({ status: 'starting', error: undefined, startedAt: Date.now() })
    void pump(stream, s.name, set)
  }
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    if (!children.has(s.name)) return { ok: false, error: lastError.get(s.name) ?? `${s.label} exited while starting.` }
    if (await ping($, s)) {
      await set({ status: 'ready' })
      return { ok: true }
    }
    await $.clock.sleep(1500)
  }
  return { ok: false, error: `${s.label} did not answer on port ${s.port} within ${Math.round(waitMs / 1000)}s; it may still be downloading weights.` }
}

const lastError = new Map<LocalName, string>()

async function pump(stream: AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>, name: LocalName, set: (state: Partial<LocalServer>) => Promise<void>) {
  let tail = ''
  try {
    for (;;) {
      const r = await stream.next()
      if (r.done) {
        const how = r.value.signal ?? `exit ${r.value.code}`
        const error = r.value.signal === null && r.value.code !== 0 ? `${how}: ${lastLines(tail)}` : undefined
        if (error) lastError.set(name, error)
        await set({ status: error ? 'error' : 'off', error })
        break
      }
      tail = (tail + r.value.text).slice(-4000)
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    lastError.set(name, error)
    await set({ status: 'error', error })
  } finally {
    children.delete(name)
  }
}

const lastLines = (text: string) => text.trim().split('\n').slice(-3).join(' | ').slice(0, 400)

/** Stops a server this module started; one started elsewhere is left alone. */
export async function stopLocal(name: LocalName): Promise<boolean> {
  const stream = children.get(name)
  if (!stream) return false
  children.delete(name)
  await stream.return(undefined as never).catch(() => undefined)
  return true
}

export const ownsLocal = (name: LocalName) => children.has(name)

export type Question =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> | string[] }
  | { type: 'score'; instructions: string; criteria: string[] }

/** A reason the questions can't be sent, or undefined. */
export function checkQuestions(q: unknown): string | undefined {
  if (q === null || typeof q !== 'object' || Array.isArray(q)) return 'questions must be an object of name → question.'
  const entries = Object.entries(q as Record<string, any>)
  if (entries.length === 0) return 'questions is empty.'
  for (const [key, v] of entries) {
    if (v === null || typeof v !== 'object') return `${key}: must be an object.`
    if (typeof v.instructions !== 'string' || v.instructions.trim() === '') return `${key}: needs instructions.`
    if (!['noul', 'choice', 'score'].includes(v.type)) return `${key}: type must be noul, choice or score.`
    if (v.type === 'choice' && (v.criteria === null || typeof v.criteria !== 'object' || Object.keys(v.criteria).length < 2)) return `${key}: a choice needs at least two criteria.`
    if (v.type === 'score' && (!Array.isArray(v.criteria) || v.criteria.length < 2)) return `${key}: a score needs a criteria list of at least two levels.`
  }
  return undefined
}

export async function askLocal($: EngineInterface, s: LocalSpec, state: unknown, questions: unknown, model?: string): Promise<{ answers: unknown; latencyMs?: number } | { error: string }> {
  let res: Awaited<ReturnType<EngineInterface['http']['fetch']>>
  try {
    res = await $.http.fetch(url(s, '/v1/systemone'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, questions, ...(model ? { model } : {}) }),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  let json: any
  try {
    json = JSON.parse(res.text)
  } catch {
    json = undefined
  }
  if (!res.ok || json?.answers === undefined) return { error: `HTTP ${res.status}: ${String(json?.detail ? JSON.stringify(json.detail) : res.text).slice(0, 400)}` }
  return { answers: json.answers, latencyMs: typeof json.latency_ms === 'number' ? json.latency_ms : undefined }
}

/** One line per question: the top answer and how sure. */
export function formatAnswers(answers: unknown): string {
  if (answers === null || typeof answers !== 'object') return String(answers)
  return Object.entries(answers as Record<string, any>)
    .map(([key, a]) => {
      if (a?.type === 'noul') return `${key}: yes ${pct(a.noul)}`
      if (a?.type === 'choice') return `${key}: ${a.choice} (${dist(a.probabilities)})`
      if (a?.type === 'score') {
        const top = a.legend?.[String(Math.round(a.score))]
        return `${key}: ${Number(a.score).toFixed(2)}${top ? ` ≈ ${top}` : ''} (${dist(a.probabilities, a.legend)})`
      }
      return `${key}: ${JSON.stringify(a)}`
    })
    .join('\n')
}

const pct = (p: unknown) => (typeof p === 'number' ? `${Math.round(p * 100)}%` : '?')
const dist = (probs: unknown, legend?: Record<string, string>) =>
  probs && typeof probs === 'object'
    ? Object.entries(probs as Record<string, number>)
        .sort((a, b) => b[1] - a[1])
        .map(([k, p]) => `${legend?.[k] ?? k} ${pct(p)}`)
        .join(', ')
    : ''
