import { expect, test } from 'claude-code/testing'

import { MODELS, RUN } from './testkit'

type SpawnCall = { argv: string[]; cwd?: string; env?: Record<string, string> }
type RunCall = { argv: string[]; init?: unknown }

type Options = {
  store?: Map<string, unknown>
  spawned?: SpawnCall[]
  runs?: RunCall[]
  status?: (string | undefined)[]
  submitted?: string[]
  spawn?: (e: any) => AsyncGenerator<any, any>
  run?: (e: any) => any
}

const plain = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function engine(on: any, o: Options = {}) {
  const store = o.store ?? new Map<string, unknown>()
  const spawned = o.spawned ?? []
  const runs = o.runs ?? []
  const status = o.status ?? []
  const submitted = o.submitted ?? []

  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__opencode-go__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_: any, e: any) => (status.push(e.text), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.read', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('prompt.submit', (_: any, e: any) => (submitted.push(e.text), { text: e.text }))
  on('process.run', (_: any, e: any) => {
    runs.push({ argv: [...e.argv], init: e.init })
    if (o.run !== undefined) return o.run(e)
    if (e.argv.includes('models')) return plain(MODELS)
    if (e.argv[0] === 'sh') return plain('/usr/bin/opencode\n')
    return plain()
  })
  on('process.spawn', async function* (_: any, e: any) {
    spawned.push({ argv: [...e.argv], cwd: e.cwd, env: e.env })
    if (o.spawn !== undefined) return yield* o.spawn(e)
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

async function start($: any, cwd = '/proj') {
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
  // The catalog loads in the background after session.start; let it settle before the test ends.
  await new Promise(r => setTimeout(r, 5))
}

const delegate = (input: Record<string, unknown>) => ({ tool: 'mcp__opencode-go__delegate', ...input })
const batch = (input: Record<string, unknown>) => ({ tool: 'mcp__opencode-go__delegate_batch', ...input })

test('delegate puts the working folder in cwd and a -- before the prompt', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned })
  await start($, '/proj')

  const ran = await $.tool.call(delegate({ prompt: '-do it', dir: 'sub' }) as any)
  expect((ran as any).deny).toBeUndefined()
  expect(spawned[0].cwd).toBe('/proj/sub')
  expect(spawned[0].argv.slice(-2)).toEqual(['--', '-do it'])
  expect(spawned[0].argv).not.toContain('--dir')

  await $.tool.call(delegate({ prompt: 'again', dir: '/abs/x/../y' }) as any)
  expect(spawned[1].cwd).toBe('/abs/y')
})

test('workers get PWD set to their folder, so opencode does not use the host folder', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned })
  await start($, '/proj')

  await $.tool.call(delegate({ prompt: 'here' }) as any)
  expect(spawned[0].cwd).toBe('/proj')
  expect(spawned[0].env).toEqual({ PWD: '/proj' })

  await $.tool.call(delegate({ prompt: 'there', dir: 'sub' }) as any)
  expect(spawned[1].env).toEqual({ PWD: '/proj/sub' })

  const ran = await $.tool.call(batch({ title: 'b', isolation: 'none', tasks: [{ id: 'a', prompt: 'x' }] }) as any)
  expect((ran as any).deny).toBeUndefined()
  expect(spawned[2].env).toEqual({ PWD: '/proj' })
})

test('readOnly runs opencode plan agent', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned })
  await start($, '/proj')

  await $.tool.call(delegate({ prompt: 'review it', readOnly: true }) as any)
  const argv = spawned[0].argv
  expect(argv[argv.indexOf('--agent') + 1]).toBe('plan')
  expect(argv.at(-2)).toBe('--')
})

test('a failed run is denied with its stderr, and a thrown spawn is caught', async ($, on) => {
  const spawned: SpawnCall[] = []
  let mode: 'stderr' | 'throw' = 'stderr'
  const spawn = async function* () {
    if (mode === 'throw') throw new Error('kaput')
    yield { stream: 'stderr', text: 'fatal: nope\n' }
    return { value: { code: 1, signal: null } }
  }
  engine(on, { spawned, spawn })
  await start($, '/proj')

  const failed = await $.tool.call(delegate({ prompt: 'work' }) as any)
  expect(String((failed as any).deny)).toContain('opencode run failed')
  expect(String((failed as any).deny)).toContain('fatal: nope')

  mode = 'throw'
  const thrown = await $.tool.call(delegate({ prompt: 'work' }) as any)
  expect(String((thrown as any).deny)).toContain('delegate failed')
})

test('parallel delegate calls share one status line until both finish', async ($, on) => {
  const status: (string | undefined)[] = []
  let count = 0
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  let both!: () => void
  const bothStarted = new Promise<void>(r => (both = r))
  const spawn = async function* () {
    count++
    if (count === 2) both()
    await gate
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  }
  engine(on, { status, spawn })
  await start($, '/proj')

  const first = $.tool.call(delegate({ prompt: 'a' }) as any)
  const second = $.tool.call(delegate({ prompt: 'b' }) as any)
  await bothStarted

  expect(status.some(s => typeof s === 'string' && s.includes('2 running'))).toBe(true)
  expect(status.includes(undefined)).toBe(false)

  release()
  await Promise.all([first, second])
  expect(status.at(-1)).toBeUndefined()
  expect(status.filter(s => s === undefined).length).toBe(1)
})

test('a run adds its cost to spendTotal', async ($, on) => {
  const store = new Map<string, unknown>()
  const spawn = async function* () {
    yield { stream: 'stdout', text: RUN.replace('"cost":0', '"cost":0.25') + '\n' }
    return { value: { code: 0, signal: null } }
  }
  engine(on, { store, spawn })
  await start($, '/proj')

  await $.tool.call(delegate({ prompt: 'work' }) as any)
  expect(store.get('spendTotal')).toBe(0.25)
})

test('a batch starts in dependency order and reports 3/3 done', async ($, on) => {
  const spawned: SpawnCall[] = []
  const started: string[] = []
  const spawn = async function* (e: any) {
    started.push(e.argv.at(-1))
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  }
  engine(on, { spawned, spawn })
  await start($, '/proj')

  const ran = await $.tool.call(
    batch({
      title: 'three',
      tasks: [
        { id: 'a', prompt: 'A' },
        { id: 'b', prompt: 'B', dependsOn: ['a'] },
        { id: 'c', prompt: 'C' },
      ],
      isolation: 'none',
      maxParallel: 2,
    }) as any,
  )
  expect(spawned.length).toBe(3)
  expect(started.indexOf('A')).toBeLessThan(started.indexOf('B'))
  expect(started.indexOf('C')).toBeLessThan(started.indexOf('B'))
  expect(String((ran as any).result)).toContain('3/3 done')
})

test('a failed dependency makes its dependants skipped', async ($, on) => {
  const spawn = async function* (e: any) {
    if (e.argv.at(-1) === 'A') {
      yield { stream: 'stdout', text: '{"type":"error","error":{"message":"boom"}}\n' }
      return { value: { code: 1, signal: null } }
    }
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  }
  engine(on, { spawn })
  await start($, '/proj')

  const ran = await $.tool.call(
    batch({
      title: 'fail',
      tasks: [
        { id: 'a', prompt: 'A' },
        { id: 'b', prompt: 'B', dependsOn: ['a'] },
      ],
      isolation: 'none',
    }) as any,
  )
  const report = String((ran as any).result)
  expect(report).toContain('b · skipped')
  expect(report).toContain('dependency a failed')
})

test('a dependency cycle is denied before anything runs', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned })
  await start($, '/proj')

  const ran = await $.tool.call(
    batch({
      title: 'cycle',
      tasks: [
        { id: 'a', prompt: 'A', dependsOn: ['b'] },
        { id: 'b', prompt: 'B', dependsOn: ['a'] },
      ],
      isolation: 'none',
    }) as any,
  )
  expect(String((ran as any).deny)).toContain('cycle')
  expect(spawned.length).toBe(0)
})

test('maxParallel 1 never runs two workers at once', async ($, on) => {
  let active = 0
  let peak = 0
  const spawn = async function* () {
    active++
    peak = Math.max(peak, active)
    await new Promise(r => setTimeout(r, 10))
    yield { stream: 'stdout', text: RUN + '\n' }
    active--
    return { value: { code: 0, signal: null } }
  }
  engine(on, { spawn })
  await start($, '/proj')

  await $.tool.call(
    batch({
      title: 'serial',
      tasks: [
        { id: 'a', prompt: 'A' },
        { id: 'b', prompt: 'B' },
        { id: 'c', prompt: 'C' },
      ],
      isolation: 'none',
      maxParallel: 1,
    }) as any,
  )
  expect(peak).toBe(1)
})

test('worktree isolation creates a sibling worktree and runs there', async ($, on) => {
  const spawned: SpawnCall[] = []
  const runs: RunCall[] = []
  const run = (e: any) => {
    if (e.argv.includes('models')) return plain(MODELS)
    if (e.argv[0] === 'sh') return plain('/usr/bin/opencode\n')
    if (e.argv.includes('rev-parse') && e.argv.includes('--show-toplevel')) return plain('/repo\n')
    if (e.argv.includes('rev-parse') && e.argv.includes('--abbrev-ref')) return plain('main\n')
    return plain()
  }
  engine(on, { spawned, runs, run })
  await start($, '/repo')

  await $.tool.call(batch({ title: 'wt', tasks: [{ id: 'a', prompt: 'A' }], isolation: 'worktree' }) as any)
  const add = runs.find(r => r.argv.includes('worktree') && r.argv.includes('add'))
  expect(add).toBeDefined()
  const branch = add!.argv[add!.argv.indexOf('-b') + 1]
  const id = /^oc\/(.+)-a$/.exec(branch)![1]
  expect(add!.argv).toEqual(['git', '-C', '/repo', 'worktree', 'add', '-b', `oc/${id}-a`, `/repo-opencode/${id}-a`, 'HEAD'])
  expect(spawned[0].cwd).toBe(`/repo-opencode/${id}-a`)
})

test('a background batch returns at once and submits its report later', async ($, on) => {
  const submitted: string[] = []
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const spawn = async function* () {
    await gate
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  }
  engine(on, { submitted, spawn })
  await start($, '/proj')

  const ran = await $.tool.call(batch({ title: 'bg', tasks: [{ id: 'a', prompt: 'A' }], isolation: 'none', background: true }) as any)
  expect(String((ran as any).result)).toContain('started')
  expect(submitted.length).toBe(0)

  release()
  for (let i = 0; i < 100 && submitted.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  expect(submitted[0]).toContain('finished')
  expect(submitted[0]).toContain('1/1 done')
  await new Promise(r => setTimeout(r, 20))
})
