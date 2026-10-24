import { expect, test } from 'claude-code/testing'

import { askLocal, checkQuestions, formatAnswers, localNamed, ownsLocal, startLocal, stopLocal } from './local'
import type { LocalOptions } from './local'

test('checkQuestions accepts the three question types', async () => {
  expect(
    checkQuestions({
      billing: { type: 'noul', instructions: 'About billing?' },
      team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'charges', shipping: 'delivery' } },
      urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] },
    }),
  ).toBe(undefined)
})

test('checkQuestions names what is wrong', async () => {
  expect(checkQuestions([])).toBe('questions must be an object of name → question.')
  expect(checkQuestions({})).toBe('questions is empty.')
  expect(checkQuestions({ a: { type: 'noul' } })).toBe('a: needs instructions.')
  expect(checkQuestions({ a: { type: 'maybe', instructions: 'x' } })).toBe('a: type must be noul, choice or score.')
  expect(checkQuestions({ a: { type: 'choice', instructions: 'x', criteria: { one: null } } })).toBe('a: a choice needs at least two criteria.')
  expect(checkQuestions({ a: { type: 'score', instructions: 'x', criteria: ['one'] } })).toBe('a: a score needs a criteria list of at least two levels.')
})

test('formatAnswers gives one line per question, top answer first', async () => {
  const text = formatAnswers({
    escalate: { type: 'noul', noul: 0.93 },
    department: { type: 'choice', choice: 'returns', probabilities: { shipping: 0.28, returns: 0.47, billing: 0.25 } },
    frustration: { type: 'score', score: 1.44, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' }, probabilities: { 0: 0, 1: 0.56, 2: 0.44 } },
  })
  expect(text).toBe(
    'escalate: yes 93%\ndepartment: returns (returns 47%, shipping 28%, billing 25%)\nfrustration: 1.44 ≈ Frustrated (Frustrated 56%, Very angry 44%, Calm 0%)',
  )
})

test('localNamed ignores case', async () => {
  expect(localNamed('Kev')?.port).toBe(8009)
  expect(localNamed('LAYA')?.port).toBe(8010)
  expect(localNamed('other')).toBe(undefined)
})

const opts = (kevGpuGb: number): LocalOptions => ({ dir: '/m', kevRun: 'jaredpalmer/kev-4b', device: 'auto', layaDevice: 'cpu', kevGpuGb, root: '/mod' })

test('Kev runs plain kev.serve with no GPU budget', async () => {
  const kev = localNamed('kev')!
  expect(kev.argv('/m', opts(0))).toEqual(['/m/kev/.venv/bin/python', '-m', 'kev.serve', '--run', 'jaredpalmer/kev-4b', '--port', '8009', '--host', '127.0.0.1', '--device', 'auto'])
  expect(kev.env(opts(0))).toEqual({})
})

test('Kev splits across GPU and RAM through kev_split.py with a budget', async () => {
  const kev = localNamed('kev')!
  expect(kev.argv('/m', opts(4))).toEqual(['/m/kev/.venv/bin/python', '/mod/scripts/kev_split.py', '--run', 'jaredpalmer/kev-4b', '--port', '8009', '--host', '127.0.0.1', '--device', 'cuda'])
  expect(kev.env(opts(4))).toEqual({ KEV_GPU_GB: '4' })
})

// Hand-made $ for the server functions: pings answer from `up`, spawns are recorded.
type Child = AsyncGenerator<any, any> & { exit: (end: { code: number | null; signal: string | null }) => void; closed: () => boolean }

function child(lines: string[] = []): Child {
  let finish!: (end: { code: number | null; signal: string | null }) => void
  const ended = new Promise<{ code: number | null; signal: string | null }>(r => (finish = r))
  let closed = false
  const queue = [...lines]
  const it: any = {
    next: async () => (queue.length > 0 ? { done: false, value: { stream: 'stderr', text: queue.shift() } } : { done: true, value: await ended }),
    // Closing the stream is what kills the child.
    return: async () => {
      closed = true
      finish({ code: null, signal: 'SIGTERM' })
      return { done: true, value: { code: null, signal: 'SIGTERM' } }
    },
    [Symbol.asyncIterator]: () => it,
    exit: (end: { code: number | null; signal: string | null }) => finish(end),
    closed: () => closed,
  }
  return it
}

function fake(o: { up?: Set<number>; children?: Child[]; reply?: (url: string, init: any) => any; missing?: boolean } = {}) {
  const up = o.up ?? new Set<number>()
  const spawned: any[] = []
  const fetched: { url: string; init?: any }[] = []
  const states: any[] = []
  const $: any = {
    http: {
      fetch: async (url: string, init?: any) => {
        fetched.push({ url, init })
        if (o.reply && init?.method === 'POST') return o.reply(url, init)
        const port = Number(/:(\d+)\//.exec(url)?.[1])
        if (!up.has(port)) throw new Error('connection refused')
        return { status: 200, ok: true, headers: {}, text: '{}' }
      },
    },
    process: {
      spawn: (request: any) => {
        spawned.push(request)
        return o.children?.[spawned.length - 1] ?? child()
      },
    },
    clock: { sleep: () => new Promise(r => setTimeout(r, 1)) },
    fs: { stat: async () => (o.missing ? Promise.reject(new Error('ENOENT')) : { kind: 'file', size: 1, mtimeMs: 0, isLink: false }) },
  }
  const set = async (s: any) => void states.push(s)
  return { $, up, spawned, fetched, states, set }
}

const kev = () => localNamed('kev')!
const laya = () => localNamed('laya')!

test('a server that already answers is used as is', async () => {
  const f = fake({ up: new Set([8009]) })
  expect(await startLocal(f.$, kev(), opts(0), f.set)).toEqual({ ok: true })
  expect(f.spawned.length).toBe(0)
  expect(f.states).toEqual([{ status: 'ready', error: undefined }])
})

test('startLocal spawns the server in its folder and waits for it to answer', async () => {
  const c = child()
  const f = fake({ children: [c] })
  const started = startLocal(f.$, laya(), opts(0), f.set)
  for (let i = 0; i < 50 && f.spawned.length === 0; i++) await new Promise(r => setTimeout(r, 1))
  expect(f.spawned[0].argv).toEqual(['/m/laya-env/bin/laya-serve'])
  expect(f.spawned[0].cwd).toBe('/m/.')
  expect(f.spawned[0].env).toEqual({ LAYA_HOST: '127.0.0.1', LAYA_PORT: '8010', LAYA_MODELS: 'english', LAYA_DEVICE: 'cpu' })
  expect(ownsLocal('laya')).toBe(true)
  f.up.add(8010)
  expect(await started).toEqual({ ok: true })
  expect(f.states.map(s => s.status)).toEqual(['starting', 'ready'])

  expect(await stopLocal('laya')).toBe(true)
  expect(c.closed()).toBe(true)
  expect(ownsLocal('laya')).toBe(false)
})

test('a model that is not installed is reported without spawning', async () => {
  const f = fake({ missing: true })
  const result = await startLocal(f.$, laya(), opts(0), f.set)
  expect(result.ok).toBe(false)
  expect((result as { error: string }).error).toContain('/m/laya-env/bin/laya-serve is missing')
  expect(f.spawned.length).toBe(0)
  expect(f.states.map(s => s.status)).toEqual(['error'])
})

test('a server that exits while starting reports its last lines', async () => {
  const c = child(['loading\n', 'Traceback (most recent call last):\n', "ModuleNotFoundError: No module named 'kev'\n"])
  const f = fake({ children: [c] })
  const started = startLocal(f.$, kev(), opts(0), f.set)
  c.exit({ code: 1, signal: null })
  const got = await started
  expect(got.ok).toBe(false)
  expect((got as any).error).toBe("exit 1: loading | Traceback (most recent call last): | ModuleNotFoundError: No module named 'kev'")
  expect(f.states.at(-1)).toEqual({ status: 'error', error: (got as any).error })
  expect(ownsLocal('kev')).toBe(false)
})

test('a server that never answers times out and keeps running', async () => {
  const f = fake()
  const got = await startLocal(f.$, kev(), opts(0), f.set, 0)
  expect(got).toEqual({ ok: false, error: 'Kev did not answer on port 8009 within 0s; it may still be downloading weights.' })
  expect(ownsLocal('kev')).toBe(true)
  expect(await stopLocal('kev')).toBe(true)
})

test('servers start one at a time', async () => {
  const f = fake()
  const first = startLocal(f.$, kev(), opts(0), f.set)
  const second = startLocal(f.$, laya(), opts(0), f.set)
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 1))
  expect(f.spawned.map(s => s.argv[0])).toEqual(['/m/kev/.venv/bin/python'])

  f.up.add(8009)
  await first
  f.up.add(8010)
  await second
  expect(f.spawned.map(s => s.argv[0])).toEqual(['/m/kev/.venv/bin/python', '/m/laya-env/bin/laya-serve'])
  await stopLocal('kev')
  await stopLocal('laya')
})

test('stopLocal leaves a server it did not start alone', async () => {
  expect(await stopLocal('kev')).toBe(false)
})

test('askLocal posts the state and questions and reads the answers', async () => {
  const f = fake({ reply: () => ({ status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { a: { type: 'noul', noul: 0.9 } }, latency_ms: 42 }) }) })
  const got = await askLocal(f.$, kev(), 'refund please', { a: { type: 'noul', instructions: 'Billing?' } })
  expect(got).toEqual({ answers: { a: { type: 'noul', noul: 0.9 } }, latencyMs: 42 })
  expect(f.fetched[0]!.url).toBe('http://127.0.0.1:8009/v1/systemone')
  expect(JSON.parse(f.fetched[0]!.init.body)).toEqual({ state: 'refund please', questions: { a: { type: 'noul', instructions: 'Billing?' } } })
})

test('askLocal words a refused request and a dead server', async () => {
  const refused = fake({ reply: () => ({ status: 422, ok: false, headers: {}, text: JSON.stringify({ detail: 'criteria missing' }) }) })
  expect(await askLocal(refused.$, kev(), 's', {})).toEqual({ error: 'HTTP 422: "criteria missing"' })
  const dead = fake({
    reply: () => {
      throw new Error('connection refused')
    },
  })
  expect(await askLocal(dead.$, laya(), 's', {})).toEqual({ error: 'connection refused' })
})
