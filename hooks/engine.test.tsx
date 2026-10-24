import { expect, mock, test } from 'claude-code/testing'

import { rememberBatch, runBatch } from './batch'
import type { Batch, BatchTask } from '../types'
import { cancel, track, untrack } from './control'
import { localDate, runResilient } from './delegate'
import { resumeTask } from './register'
import { MODELS, RUN } from './testkit'

type SpawnCall = { argv: string[]; cwd?: string }
type RunCall = { argv: string[]; init?: unknown }

type Options = {
  store?: Map<string, unknown>
  spawned?: SpawnCall[]
  runs?: RunCall[]
  models?: string
  stat?: (path: string) => { kind: 'file'; size: number; mtimeMs: number; isLink: boolean } | undefined
  submitted?: string[]
  toasts?: string[]
  run?: (e: any) => any
  spawn?: (e: any, n: number) => AsyncGenerator<any, any> | (() => AsyncGenerator<any, any>) | undefined
}

const plain = (stdout = '', exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

function engine(on: any, o: Options = {}) {
  const store = o.store ?? new Map<string, unknown>()
  const spawned = o.spawned ?? []
  const runs = o.runs ?? []

  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__opencode-go__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_: any, e: any) => (o.toasts?.push(e.text), { value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.read', () => ({ value: undefined }))
  on('fs.stat', (_: any, e: any) => ({ value: o.stat?.(e.path) }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('prompt.submit', (_: any, e: any) => (o.submitted?.push(e.text), { text: e.text }))
  on('process.run', (_: any, e: any) => {
    runs.push({ argv: [...e.argv], init: e.init })
    if (o.run !== undefined) return o.run(e)
    if (e.argv.includes('models')) return plain(o.models ?? MODELS)
    if (e.argv[0] === 'sh') return plain('/usr/bin/opencode\n')
    return plain()
  })
  on('process.spawn', async function* (_: any, e: any) {
    spawned.push({ argv: [...e.argv], cwd: e.cwd })
    const behaviour = o.spawn?.(e, spawned.length)
    if (behaviour !== undefined) return yield* (typeof behaviour === 'function' ? behaviour() : behaviour)
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'text', index: 0, text: 'from claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return { store }
}

type FakeOptions = {
  batches?: any[]
  spawned?: SpawnCall[]
  toasts?: string[]
  store?: Map<string, unknown>
  spawn?: (n: number) => AsyncGenerator<any, any>
}

function fakeEngine(o: FakeOptions = {}) {
  const state = new Map<string, unknown>([
    ['batches', o.batches ?? []],
    ['jobs', []],
    ['spend', { session: 0, runs: 0 }],
  ])
  const store = o.store ?? new Map<string, unknown>()
  let calls = 0
  const $: any = {
    state: {
      get: (ref: any) => ({ value: state.get(ref.key), version: 0 }),
      set: (ref: any, value: any) => {
        state.set(ref.key, value)
        return { isSet: true, version: 1 }
      },
    },
    store: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => {
        store.set(key, value)
      },
    },
    env: { get: (name: string) => (name === 'HOME' ? '/home/test' : undefined) },
    fs: { stat: () => Promise.reject(new Error('ENOENT')) },
    process: {
      run: (argv: string[]) => ({
        exitCode: 0,
        stdout: argv[0] === 'sh' ? '/usr/bin/opencode\n' : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      }),
      spawn: (request: any) => {
        calls++
        o.spawned?.push({ argv: [...request.argv], cwd: request.cwd })
        const inner =
          o.spawn?.(calls) ??
          (async function* () {
            yield { stream: 'stdout', text: RUN + '\n' }
            return { value: { code: 0, signal: null } }
          })()
        return (async function* () {
          const finale = yield* inner
          return finale !== null && typeof finale === 'object' && 'value' in finale ? finale.value : finale
        })()
      },
    },
    ui: {
      toast: (text: string) => {
        o.toasts?.push(text)
      },
      status: () => undefined,
    },
  }
  return { $, state, store, calls: () => calls }
}

async function start($: any, cwd = '/proj') {
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 15))
}

const delegate = (input: Record<string, unknown>) => ({ tool: 'mcp__opencode-go__delegate', ...input })
const batch = (input: Record<string, unknown>) => ({ tool: 'mcp__opencode-go__delegate_batch', ...input })

const reply = (text: string, code = 0) =>
  async function* () {
    yield { stream: 'stdout', text }
    return { value: { code, signal: null } }
  }

const hang = async function* () {
  await new Promise(() => undefined)
}

const started = (session: string) =>
  `{"type":"step_start","sessionID":"${session}","part":{"type":"step-start"}}`

const limited = (session = 'ses_1') =>
  [
    started(session),
    `{"type":"error","sessionID":"${session}","error":{"message":"429 rate limit reached"}}`,
  ].join('\n') + '\n'

const failed = (session = 'ses_1') =>
  [
    started(session),
    `{"type":"error","sessionID":"${session}","error":{"message":"boom"}}`,
  ].join('\n') + '\n'

const finished = (cost: number) =>
  [
    started('ses_1'),
    `{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"edit","state":{"status":"completed","title":"src/a.ts"}}}`,
    `{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"done"}}`,
    `{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","cost":${cost}}}`,
  ].join('\n') + '\n'

async function drive(clock: any, call: Promise<any>, steps = 12) {
  let settled = false
  const trackedCall = call.then(
    value => {
      settled = true
      return value
    },
    err => {
      settled = true
      throw err
    },
  )
  for (let i = 0; i < steps && !settled; i++) await clock.advance(120_000)
  return trackedCall
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 10))
  }
}

test('a rate-limited run resumes the same session', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: SpawnCall[] = []
  engine(on, {
    spawned,
    spawn: (_e, n) => (n === 1 ? reply(limited(), 1) : reply(RUN + '\n')),
  })
  await start($)

  const ran = await drive(clock, $.tool.call(delegate({ prompt: 'work' }) as any))
  expect((ran as any).deny).toBeUndefined()
  expect(spawned.length).toBe(2)
  expect(spawned[1]!.argv).toContain('--session')
  expect(spawned[1]!.argv[spawned[1]!.argv.indexOf('--session') + 1]).toBe('ses_1')
  expect(String((ran as any).result)).toContain('attempts: 2')
  expect(String((ran as any).result)).toContain('answer:\ndone')
})

test('a run that keeps failing falls back to the fallback model', { options: { autoRetries: 1, fallbackModel: 'opencode-go/beam-free' } }, async ($, on) => {
  const clock = mock.clock(on)
  const spawned: SpawnCall[] = []
  engine(on, {
    spawned,
    spawn: (_e, n) => (n <= 2 ? reply(limited(), 1) : reply(RUN + '\n')),
  })
  await start($)

  const ran = await drive(clock, $.tool.call(delegate({ prompt: 'work' }) as any))
  expect((ran as any).deny).toBeUndefined()
  expect(spawned.length).toBe(3)
  const last = spawned.at(-1)!
  expect(last.argv[last.argv.indexOf('-m') + 1]).toBe('opencode-go/beam-free')
  expect(last.argv[last.argv.indexOf('--session') + 1]).toBe('ses_1')
})

test('a stalled run is killed and resumed', { options: { stallMinutes: 0.001, autoRetries: 1 } }, async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, {
    spawned,
    spawn: (_e, n) => (n === 1 ? hang : reply(RUN + '\n')),
  })
  await start($)

  const ran = await $.tool.call(delegate({ prompt: 'work' }) as any)
  expect((ran as any).deny).toBeUndefined()
  expect(spawned.length).toBe(2)
  expect(String((ran as any).result)).toContain('attempts: 2')
})

test('verify failures resume the worker with its output until the check passes', async ($, on) => {
  let checks = 0
  const run = (e: any) => {
    if (e.argv.includes('models')) return plain(MODELS)
    if (e.argv[0] === 'sh' && e.argv[2] === 'npm test') {
      checks++
      return checks === 1 ? plain('boom\n', 1) : plain('ok\n')
    }
    if (e.argv[0] === 'sh') return plain('/usr/bin/opencode\n')
    return plain()
  }
  const spawned: SpawnCall[] = []
  engine(on, { spawned, run })
  await start($)

  const ran = await $.tool.call(delegate({ prompt: 'work', verify: 'npm test' }) as any)
  expect((ran as any).deny).toBeUndefined()
  const report = String((ran as any).result)
  expect(report).toContain('verify: passed')
  expect(spawned.length).toBe(2)
  expect(spawned[1]!.argv.at(-1)).toContain('does not pass the check')
  expect(spawned[1]!.argv.at(-1)).toContain('boom')
})

test('a batch task that keeps failing verify ends failed', { options: { autoRetries: 0 } }, async ($, on) => {
  const run = (e: any) => {
    if (e.argv.includes('models')) return plain(MODELS)
    if (e.argv[0] === 'sh' && e.argv[2] === 'npm test') return plain('always broken\n', 1)
    if (e.argv[0] === 'sh') return plain('/usr/bin/opencode\n')
    return plain()
  }
  const spawned: SpawnCall[] = []
  engine(on, { spawned, run })
  await start($)

  const ran = await $.tool.call(
    batch({ title: 'checks', tasks: [{ id: 'a', prompt: 'A', verify: 'npm test', verifyRounds: 1 }], isolation: 'none' }) as any,
  )
  const report = String((ran as any).result)
  expect(report).toContain('a · failed')
  expect(report).toContain('verify: FAILED')
  expect(report).toContain('verify ✗')
})

test('shared context is prefixed and files become -f arguments', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned })
  await start($)

  await $.tool.call(
    batch({
      title: 'shared',
      shared: 'COMMON CONTEXT',
      tasks: [{ id: 'a', prompt: 'do A', files: ['src/a.ts'] }],
      isolation: 'none',
      maxParallel: 1,
    }) as any,
  )
  const argv = spawned[0]!.argv
  expect(argv.at(-1)).toBe('COMMON CONTEXT\n\n# Your task\ndo A')
  expect(argv[argv.indexOf('-f') + 1]).toBe('/proj/src/a.ts')
  expect(argv.indexOf('-f')).toBeLessThan(argv.indexOf('--'))
})

test('an oversized prompt for a small-context model is denied before any spawn', async ($, on) => {
  const models = [
    `opencode-go/tiny\n${JSON.stringify({ name: 'Tiny', status: 'active', cost: { input: 0, output: 0 }, limit: { output: 32000, context: 1000 }, variants: {} })}`,
  ].join('\n')
  const spawned: SpawnCall[] = []
  engine(on, { spawned, models })
  await start($)

  const ran = await $.tool.call(delegate({ prompt: 'x'.repeat(5000), model: 'tiny' }) as any)
  expect(String((ran as any).deny)).toContain('1250')
  expect(String((ran as any).deny)).toContain('1000')
  expect(spawned.length).toBe(0)
})

test('maxCost skips the tasks that would start after the budget is spent', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, {
    spawned,
    spawn: (_e, n) => (n === 1 ? reply(finished(0.25)) : reply(finished(0))),
  })
  await start($)

  const ran = await $.tool.call(
    batch({
      title: 'cost',
      tasks: [
        { id: 'a', prompt: 'A' },
        { id: 'b', prompt: 'B' },
      ],
      isolation: 'none',
      maxParallel: 1,
      maxCost: 0.1,
    }) as any,
  )
  const report = String((ran as any).result)
  expect(spawned.length).toBe(1)
  expect(report).toContain('b · skipped')
  expect(report).toContain('batch budget $0.10 reached')
})

test('the daily budget blocks paid runs but not free ones', { options: { dailyBudget: 1 } }, async ($, on) => {
  const store = new Map<string, unknown>([
    ['spendDaily', { date: localDate(Date.now()), usd: 5 }],
  ])
  const spawned: SpawnCall[] = []
  engine(on, { store, spawned })
  await start($)

  const paid = await $.tool.call(delegate({ prompt: 'work', model: 'kimi-k3' }) as any)
  expect(String((paid as any).deny)).toContain('Daily OpenCode budget $1.00 reached')
  expect(spawned.length).toBe(0)

  const free = await $.tool.call(delegate({ prompt: 'work', model: 'beam-free' }) as any)
  expect((free as any).deny).toBeUndefined()
  expect(spawned.length).toBe(1)
})

const ZAI_MODELS = `${MODELS}\nzai-coding-plan/glm-5.3\n${JSON.stringify({ name: 'GLM-5.3', status: 'active', cost: { input: 0, output: 0 }, limit: { output: 131072 } })}`

test('the Z.AI quota blocks plan runs once used up, and not Go runs', { options: { zaiQuota: 5, dailyBudget: 1 } }, async ($, on) => {
  const store = new Map<string, unknown>([
    ['planUse', [{ at: Date.now() - 60_000, calls: 5 }]],
    ['spendDaily', { date: localDate(Date.now()), usd: 0 }],
  ])
  const spawned: SpawnCall[] = []
  engine(on, { store, spawned, models: ZAI_MODELS })
  await start($)

  const plan = await $.tool.call(delegate({ prompt: 'work', model: 'zai-coding-plan/glm-5.3' }) as any)
  expect(String((plan as any).deny)).toContain('5/5 model calls')
  expect(spawned.length).toBe(0)

  const go = await $.tool.call(delegate({ prompt: 'work', model: 'kimi-k3' }) as any)
  expect((go as any).deny).toBeUndefined()
  expect(spawned.length).toBe(1)
})

test('a run on a plan model records its model calls, and the daily budget does not block it', { options: { dailyBudget: 1 } }, async ($, on) => {
  const store = new Map<string, unknown>([['spendDaily', { date: localDate(Date.now()), usd: 5 }]])
  const spawned: SpawnCall[] = []
  engine(on, { store, spawned, models: ZAI_MODELS })
  await start($)

  const plan = await $.tool.call(delegate({ prompt: 'work', model: 'zai-coding-plan/glm-5.3' }) as any)
  expect((plan as any).deny).toBeUndefined()
  expect(spawned.length).toBe(1)
  const uses = store.get('planUse') as { calls: number }[]
  expect(uses.map(u => u.calls)).toEqual([1])
})

test('the plan profile runs on the Z.AI Coding Plan, and is refused without it', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned, models: ZAI_MODELS })
  await start($)
  const ok = await $.tool.call(delegate({ prompt: 'work', profile: 'plan' }) as any)
  expect((ok as any).deny).toBeUndefined()
  expect(spawned[0]!.argv).toContain('zai-coding-plan/glm-5.3')
})

test('the plan profile is refused when no plan model is listed', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned })
  await start($)
  const refused = await $.tool.call(delegate({ prompt: 'work', profile: 'plan' }) as any)
  expect(String((refused as any).deny)).toContain('Z.AI Coding Plan')
  expect(spawned.length).toBe(0)
})

test('cancel(job id) stops a running resume as cancelled', { options: { autoRetries: 0 } }, async ($, on) => {
  let started!: () => void
  const running = new Promise<void>(resolve => (started = resolve))
  const fake = fakeEngine({
    spawn: () => {
      started()
      return hang()
    },
  })

  const signal = track('job-1')
  const call = runResilient(
    fake.$,
    {
      bin: '/usr/bin/opencode',
      model: 'opencode-go/kimi-k3',
      prompt: 'work',
      cwd: '/proj',
      retries: 0,
      stallMs: 0,
      verifyRounds: 0,
      signal,
    },
    () => undefined,
  )
  await running
  expect(cancel('job-1')).toBe(true)
  const outcome = await call
  expect(outcome.reason).toBe('cancelled')
  untrack('job-1')
})

test('cancelling a batch cancels pending tasks and the batch', async ($, on) => {
  engine(on, {})
  await start($)
  const task = (id: string): BatchTask => ({
    id,
    title: id,
    model: 'opencode-go/kimi-k3',
    status: 'pending',
    dependsOn: [],
    steps: 0,
    cost: 0,
  })
  const batch: Batch = { id: 'b1', title: 'cancel me', status: 'running', background: false, startedAt: 0, tasks: [task('a'), task('b')] }
  const signal = track('batch:b1')
  let taskSignal: AbortSignal | undefined
  signal.addEventListener('abort', () => cancel('task:b1:a'))

  const call = runBatch(
    $ as any,
    { batch, maxParallel: 1, signal },
    async next => {
      taskSignal = track('task:b1:a')
      await new Promise<void>(resolve => taskSignal!.addEventListener('abort', () => resolve()))
      untrack('task:b1:a')
      return { status: 'cancelled', cost: 0, steps: 0 }
    },
    () => undefined,
  )
  await until(() => taskSignal !== undefined)
  expect(cancel('batch:b1')).toBe(true)
  await call
  const status = (id: string) => batch.tasks.find(t => t.id === id)!.status
  expect(status('a')).toBe('cancelled')
  expect(status('b')).toBe('cancelled')
  untrack('batch:b1')
})

test('resumeTask resumes a failed task in its folder and marks it done', { options: { autoRetries: 0 } }, async ($, on) => {
  const spawned: SpawnCall[] = []
  const toasts: string[] = []
  const fake = fakeEngine({ spawned, toasts })
  const failedTask = {
    id: 'a',
    title: 'A',
    model: 'opencode-go/kimi-k3',
    status: 'failed',
    dependsOn: [],
    steps: 1,
    cost: 0.01,
    dir: '/proj',
    sessionId: 'ses_1',
  }
  fake.state.set('batches', [
    { id: 'b1', title: 'resume', status: 'failed', background: false, startedAt: 0, endedAt: 1, tasks: [failedTask] },
  ])
  rememberBatch('b1', [{ id: 'a', prompt: 'A' }], { retries: 0, stallMs: 0 })

  await resumeTask(fake.$ as any, 'b1', 'a')
  await until(() => toasts.some(text => text.includes('done on resume')))
  expect(spawned.length).toBe(1)
  expect(spawned[0]!.argv[spawned[0]!.argv.indexOf('--session') + 1]).toBe('ses_1')
  expect(spawned[0]!.cwd).toBe('/proj')
  const after = (fake.state.get('batches') as any[])[0]
  expect(after.tasks[0].status).toBe('done')
  expect(after.tasks[0].attempts).toBe(1)
})
