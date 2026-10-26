import { expect, test } from 'claude-code/testing'

import { resolveConflict, type ResolveOptions } from './resolve'

type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
type SpawnCall = { argv: string[]; cwd?: string }

const result = (exitCode = 0, stdout = '', stderr = ''): RunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const run = (cost = 0) =>
  async function* () {
    yield {
      stream: 'stdout',
      text: [
        '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}',
        '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"resolved"}}',
        `{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","cost":${cost}}}`,
      ].join('\n') + '\n',
    }
    return { code: 0, signal: null }
  }

type Options = {
  runs?: string[][]
  spawned?: SpawnCall[]
  run?: (argv: string[]) => RunResult | undefined
  spawn?: () => AsyncGenerator<any, any>
}

// A plain engine: a hook's $ has process, but the test's own $ only holds the namespaces on
// it, so direct calls get this instead.
function fakeEngine(o: Options = {}) {
  return {
    env: { get: async () => undefined },
    process: {
      run: async (argv: string[]) => {
        o.runs?.push([...argv])
        return o.run?.(argv) ?? result(0)
      },
      spawn: (request: { argv: readonly string[]; cwd?: string }) => {
        o.spawned?.push({ argv: [...request.argv], cwd: request.cwd })
        return (o.spawn ?? run())()
      },
    },
  }
}

const options = (over: Partial<ResolveOptions> = {}): ResolveOptions => ({
  bin: '/bin/opencode',
  dir: '/task',
  integration: 'oc/b-merged',
  files: ['src/a.ts', 'src/b.ts'],
  prompt: 'the original task prompt',
  model: 'opencode-go/kimi-k3',
  verify: 'npm test',
  verifyRounds: 0,
  retries: 0,
  stallMs: 0,
  ...over,
})

const resolved = (over: Partial<Options> = {}): Options => ({
  run: (argv: string[]) => {
    if (argv[3] === 'rev-parse') return result(0, 'abc123\n')
    if (argv.includes('merge') && !argv.includes('--abort')) return result(1, '', 'CONFLICT\n')
    if (argv.includes('--diff-filter=U')) return result(0, 'src/a.ts\nsrc/b.ts\n')
    if (argv.includes('grep')) return result(1)
    if (argv.includes('add')) return result(0)
    if (argv.includes('commit')) return result(0)
    return result(0)
  },
  ...over,
})

test('a clean merge returns at once without a worker', async () => {
  const spawned: SpawnCall[] = []
  const $ = fakeEngine({
    spawned,
    run: (argv: string[]) => (argv[3] === 'rev-parse' ? result(0, 'abc123\n') : result(0)),
  })

  const outcome = await resolveConflict($ as any, options())
  expect(outcome.ok).toBe(true)
  expect(outcome.cost).toBe(0)
  expect(outcome.note).toBe('merged cleanly')
  expect(spawned).toHaveLength(0)
})

test('a conflict is resolved by the worker, then added and committed', async () => {
  const runs: string[][] = []
  const spawned: SpawnCall[] = []
  const $ = fakeEngine(resolved({ runs, spawned, spawn: run(0.25) }))

  const outcome = await resolveConflict($ as any, options())
  expect(outcome.ok).toBe(true)
  expect(outcome.cost).toBe(0.25)
  expect(outcome.model).toBe('opencode-go/kimi-k3')
  expect(outcome.note).toBe('resolved by worker')
  expect(spawned).toHaveLength(1)
  expect(spawned[0]!.cwd).toBe('/task')
  expect(spawned[0]!.argv.at(-1)).toContain('src/a.ts')
  expect(spawned[0]!.argv.at(-1)).toContain('src/b.ts')
  expect(runs.some(argv => argv.includes('add') && argv.includes('-A'))).toBe(true)
  expect(
    runs.some(argv => argv.join(' ') === 'git -C /task -c user.name=OpenCode worker -c user.email=opencode-worker@localhost commit --no-edit'),
  ).toBe(true)
})

test('markers left behind abort the merge and fail', async () => {
  const runs: string[][] = []
  const base = resolved()
  const $ = fakeEngine({
    runs,
    run: argv => {
      if (argv.includes('grep')) return result(0, 'src/a.ts:1:<<<<<<< HEAD\n')
      return base.run?.(argv)
    },
  })

  const outcome = await resolveConflict($ as any, options())
  expect(outcome.ok).toBe(false)
  expect(outcome.note).toContain('marker')
  expect(runs.some(argv => argv.join(' ') === 'git -C /task merge --abort')).toBe(true)
  expect(runs.some(argv => argv.includes('add'))).toBe(false)
})

test('a failed worker aborts the merge and fails', async () => {
  const runs: string[][] = []
  const $ = fakeEngine({
    runs,
    spawn: async function* () {
      yield { stream: 'stderr', text: 'worker gave up\n' }
      return { code: 1, signal: null }
    },
    run: argv => {
      if (argv.includes('merge') && !argv.includes('--abort')) return result(1, '', 'CONFLICT\n')
      if (argv.includes('--diff-filter=U')) return result(0, 'src/a.ts\n')
      return result(0)
    },
  })

  const outcome = await resolveConflict($ as any, options())
  expect(outcome.ok).toBe(false)
  expect(outcome.note).toContain('worker')
  expect(runs.some(argv => argv.join(' ') === 'git -C /task merge --abort')).toBe(true)
})

test('a fresh start includes the original prompt and no --session', async () => {
  const spawned: SpawnCall[] = []
  const $ = fakeEngine(resolved({ spawned, spawn: run() }))

  const outcome = await resolveConflict($ as any, options())
  expect(outcome.ok).toBe(true)
  const argv = spawned[0]!.argv
  expect(argv).not.toContain('--session')
  const prompt = argv.at(-1) ?? ''
  expect(prompt).toContain('Your original task:')
  expect(prompt).toContain('the original task prompt')
})
