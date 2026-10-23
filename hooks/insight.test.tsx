import { expect, mock, test } from 'claude-code/testing'

import { MODELS, PANE, ready, RUN } from './testkit'

// command.run's input now carries where the run came from and where it shows; the engine stamps both for an Enter.
const opencode = (args: string) => ({ command: 'opencode', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
type SpawnCall = { argv: string[]; cwd?: string }

const result = (exitCode = 0, stdout = '', stderr = ''): RunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const plain = (stdout = '') => ({ value: result(0, stdout) })

const reply = (text: string, code = 0) =>
  async function* () {
    yield { stream: 'stdout', text }
    return { value: { code, signal: null } }
  }

const hang = async function* () {
  await new Promise(() => undefined)
}

const started = (session: string) => `{"type":"step_start","sessionID":"${session}","part":{"type":"step-start"}}`
const limited = () => [started('ses_1'), '{"type":"error","sessionID":"ses_1","error":{"message":"429 rate limit reached"}}'].join('\n') + '\n'
const finished = (cost: number) =>
  [
    started('ses_1'),
    '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"edit","state":{"status":"completed","title":"src/a.ts"}}}',
    '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"done"}}',
    `{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","cost":${cost}}}`,
  ].join('\n') + '\n'

type Options = {
  store?: Map<string, unknown>
  writes?: { path: string; text: string }[]
  tools?: { name: string; description: string }[]
  runs?: string[][]
  spawned?: SpawnCall[]
  run?: (argv: string[]) => RunResult | undefined
  spawn?: (argv: string[], n: number) => AsyncGenerator<any, any> | (() => AsyncGenerator<any, any>)
}

function setup(on: any, o: Options = {}) {
  const store = o.store ?? new Map<string, unknown>()
  let calls = 0
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => {
    o.tools?.push({ name: e.name, description: e.description })
    return { value: { tool: `mcp__opencode-go__${e.name}` } }
  })
  on('tool.list', () => ({ value: [{ name: 'Read', description: '', mcp: false }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.read', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: undefined }))
  on('fs.write', (_: any, e: any) => (o.writes?.push({ path: e.path, text: e.text }), { value: undefined }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('process.run', (_: any, e: any) => {
    o.runs?.push([...e.argv])
    if (o.run !== undefined) {
      const custom = o.run(e.argv)
      if (custom !== undefined) return { value: custom }
    }
    if (e.argv.includes('models')) return plain(MODELS)
    if (e.argv[0] === 'sh') return plain('/usr/bin/opencode\n')
    return plain()
  })
  on('process.spawn', async function* (_: any, e: any) {
    calls++
    o.spawned?.push({ argv: [...e.argv], cwd: e.cwd })
    const n = calls
    if (o.spawn !== undefined) {
      const behaviour = o.spawn(e.argv, n)
      return yield* (typeof behaviour === 'function' ? behaviour() : behaviour)
    }
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
  await new Promise(r => setTimeout(r, 15))
}

const delegate = (input: Record<string, unknown>) => ({ tool: 'mcp__opencode-go__delegate', ...input })
const batch = (input: Record<string, unknown>) => ({ tool: 'mcp__opencode-go__delegate_batch', ...input })

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 10))
  }
}

async function drive(clock: any, call: Promise<any>, steps = 12) {
  let settled = false
  const tracked = call.then(
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
  return tracked
}

test('a delegate run reports short and writes the full report to a file', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  setup(on, { writes })
  await start($)

  const ran = await $.tool.call(delegate({ prompt: 'work' }) as any)
  const report = String((ran as any).result)
  expect((ran as any).deny).toBeUndefined()
  expect(report).not.toContain('actions (')
  expect(report).toContain('answer:\ndone')
  expect(report).toContain('Full report: ')

  const path = /Full report: (\S+)/.exec(report)?.[1] ?? ''
  expect(path).toMatch(/^\/proj\/\.opencode\/reports\/d-.+\.md$/)
  const written = writes.find(w => w.path === path)
  expect(written).toBeDefined()
  expect(written?.text).toContain('actions (')
  expect(written?.text).toContain('answer:\ndone')
})

test('report full returns the long form', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  setup(on, { writes })
  await start($)

  const ran = await $.tool.call(delegate({ prompt: 'work', report: 'full' }) as any)
  const report = String((ran as any).result)
  expect(report).toContain('actions (')
  expect(report).toContain('answer:\ndone')
  expect(writes.length).toBe(2)
  expect(writes[0].text).toContain('actions (')
  expect(writes[1]).toEqual({ path: expect.stringMatching(/\.opencode\/reports\/\.gitignore$/), text: '*\n' })
})

test('health records rate limits and successes, and a cancelled run changes nothing', async ($, on) => {
  const clock = mock.clock(on)
  const spawned: SpawnCall[] = []
  const { store } = setup(on, {
    spawned,
    spawn: (_argv, n) => (n === 1 ? reply(limited(), 1) : n === 2 ? reply(RUN + '\n') : hang()),
  })
  await start($)

  const ran = await drive(clock, $.tool.call(delegate({ prompt: 'work' }) as any))
  expect((ran as any).deny).toBeUndefined()
  const health = (store.get('health') ?? {}) as Record<string, any>
  expect(health['opencode-go/kimi-k3']?.rateLimited).toBe(1)
  expect(health['opencode-go/kimi-k3']?.ok).toBe(1)

  const before = JSON.stringify(store.get('health'))
  const running = $.tool.call(delegate({ prompt: 'slow' }) as any)
  await until(() => spawned.length >= 3)
  await $.command.run(opencode('cancel all'))
  const stopped = await running
  expect(String((stopped as any).deny)).toContain('cancelled')
  expect(JSON.stringify(store.get('health'))).toBe(before)
})

test('describe warns about models rated bad', async ($, on) => {
  const tools: { name: string; description: string }[] = []
  const store = new Map<string, unknown>([
    ['health', { 'opencode-go/kimi-k3': { ok: 0, failed: 0, rateLimited: 5, hung: 0, totalMs: 1000, lastAt: Date.now() } }],
  ])
  setup(on, { store, tools })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  await ui.press({ key: 'refresh' })
  await until(() => tools.some(t => t.name === 'delegate' && t.description.includes('Unreliable right now')))
  await ui.unmount()

  const description = [...tools].reverse().find(t => t.name === 'delegate')?.description ?? ''
  expect(description).toContain('Unreliable right now: opencode-go/kimi-k3')
})

test('a finished batch lands in history and spend by model', async ($, on) => {
  const { store } = setup(on, { spawn: (_argv, n) => reply(finished(n === 1 ? 0.2 : 0.3)) })
  await start($)

  await $.tool.call(batch({ title: 'costs', tasks: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B' }], isolation: 'none' }) as any)

  const history = (store.get('history') ?? []) as any[]
  expect(history.length).toBe(1)
  expect(history[0].status).toBe('done')
  expect(history[0].tasks).toBe(2)
  expect(history[0].done).toBe(2)
  expect(Math.round(history[0].cost * 100) / 100).toBe(0.5)

  const byModel = (store.get('spendByModel') ?? {}) as Record<string, number>
  expect(Math.round((byModel['opencode-go/kimi-k3'] ?? 0) * 100) / 100).toBe(0.5)
})

test('profile picks a preset model and level, and an explicit model wins', async ($, on) => {
  const spawned: SpawnCall[] = []
  setup(on, { spawned })
  await start($)

  await $.tool.call(delegate({ prompt: 'work', profile: 'reliable' }) as any)
  const preset = spawned[0].argv
  expect(preset[preset.indexOf('-m') + 1]).toBe('opencode-go/deepseek-v4.1-flash')
  expect(preset[preset.indexOf('--variant') + 1]).toBe('high')

  await $.tool.call(delegate({ prompt: 'work', profile: 'reliable', model: 'kimi-k3' }) as any)
  const explicit = spawned[1].argv
  expect(explicit[explicit.indexOf('-m') + 1]).toBe('opencode-go/kimi-k3')
})

test('autoMerge merges passing tasks through a temporary worktree and records conflicts', async ($, on) => {
  const runs: string[][] = []
  const run = (argv: string[]): RunResult | undefined => {
    if (argv[0] === 'sh') return result(0, '/usr/bin/opencode\n')
    if (argv.includes('models')) return result(0, MODELS)
    if (argv[0] !== 'git') return result(0, '/usr/bin/opencode\n')
    const at = argv.indexOf('-C')
    const top = at < 0 ? '' : argv[at + 1] ?? ''
    const args = at < 0 ? argv : argv.slice(at + 2)
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return result(0, '/repo\n')
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return result(0, 'main\n')
    if (args[0] === 'worktree' && args[1] === 'add') return result(0, '')
    if (args[0] === 'worktree' && args[1] === 'remove') return result(0, '')
    if (args[0] === 'branch') return result(0, '')
    if (args[0] === 'status') return result(0, top.endsWith('-merged') ? '' : ' M src/a.ts\n')
    if (args[0] === 'add') return result(0, '')
    if (args[0] === 'commit') return result(0, '')
    if (args[0] === 'show') return result(0, ' src/a.ts | 2 +-\n 1 file changed, 1 insertion(+)\n')
    if (args[0] === 'merge' && args[1] === '--abort') return result(0, '')
    if (args[0] === 'merge') {
      const branch = args[args.length - 1] ?? ''
      if (branch.endsWith('-c')) return result(1, '', 'CONFLICT (content): Merge conflict in src/c.ts\n')
      return result(0, "Merge made by the 'ort' strategy.\n")
    }
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) return result(0, 'src/c.ts\n')
    if (args[0] === 'diff') return result(0, '')
    return result(0, '')
  }
  setup(on, { runs, run })
  await start($, '/repo')

  const ran = await $.tool.call(
    batch({
      title: 'merge me',
      isolation: 'worktree',
      autoMerge: true,
      tasks: [
        { id: 'a', prompt: 'A' },
        { id: 'b', prompt: 'B' },
        { id: 'c', prompt: 'C' },
      ],
    }) as any,
  )
  const report = String((ran as any).result)
  expect((ran as any).deny).toBeUndefined()

  const made = runs.find(argv => argv.includes('branch') && argv.some(a => /^oc\/.+-merged$/.test(a)))
  expect(made).toBeDefined()
  const branch = made?.find(a => /^oc\/.+-merged$/.test(a)) ?? ''
  const id = /^oc\/(.+)-merged$/.exec(branch)?.[1] ?? ''
  expect(id).not.toBe('')
  expect(made?.join(' ')).toBe(`git -C /repo branch ${branch} main`)

  const folder = `/repo-opencode/${id}-merged`
  expect(runs.some(argv => argv.join(' ') === `git -C ${folder} merge --no-ff --no-edit oc/${id}-a`)).toBe(true)
  expect(runs.some(argv => argv.join(' ') === `git -C ${folder} merge --no-ff --no-edit oc/${id}-b`)).toBe(true)
  expect(runs.some(argv => argv.join(' ') === `git -C ${folder} merge --abort`)).toBe(true)
  expect(runs.some(argv => argv.join(' ') === `git -C /repo worktree remove --force ${folder}`)).toBe(true)
  expect(runs.every(argv => !argv.includes('checkout') && !argv.includes('switch'))).toBe(true)

  expect(report).toContain(`Merged into ${branch}: a, b`)
  expect(report).toContain('Conflicts (not merged): c (files: src/c.ts)')
  expect(report).toContain(`To take it: git -C /repo merge ${branch}`)
})
