import { expect, mock, test } from 'claude-code/testing'

import { MODELS, RUN } from './testkit'

type SpawnCall = { argv: string[]; cwd?: string }

const AGY = '/usr/bin/agy'
const CONVERSATION = '31d83eb7-eab3-4e55-b584-dca128317958'
const AGY_MODELS = [
  'Fetching available models...',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  '',
].join('\n')

const plain = (stdout = '', exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type Options = {
  store?: Map<string, unknown>
  spawned?: SpawnCall[]
  // Without agy, `command -v agy` finds nothing and no Gemini model is listed.
  agy?: boolean
  // What the nth agy spawn prints, and its exit code.
  agyRun?: (argv: string[], n: number) => { stdout?: string; stderr?: string; code?: number }
  status?: (string | undefined)[]
}

function engine(on: any, o: Options = {}) {
  const store = o.store ?? new Map<string, unknown>()
  const spawned = o.spawned ?? []
  let agyRuns = 0

  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__opencode-go__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_: any, e: any) => (o.status?.push(e.text), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  // The per-run agy log names the conversation it started.
  on('fs.read', (_: any, e: any) => ({ value: /[\\/]\.cache[\\/]opencode-go[\\/]agy-/.test(String(e.path)) ? `I1026 server.go:1225] Created conversation ${CONVERSATION} (backend=X)\n` : undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'sh' && argv.join(' ').includes('command -v agy')) return o.agy === false ? plain('', 1) : plain(`${AGY}\n`)
    if (argv[0] === 'sh') return plain('/usr/bin/opencode\n')
    if (argv[0] === AGY && argv[1] === 'models') return plain(AGY_MODELS)
    if (argv.includes('models')) return plain(MODELS)
    return plain()
  })
  on('process.spawn', async function* (_: any, e: any) {
    spawned.push({ argv: [...e.argv], cwd: e.cwd })
    if (e.argv[0] === AGY) {
      const out = o.agyRun?.(e.argv, ++agyRuns) ?? { stdout: JSON.stringify({ status: 'SUCCESS', response: 'gemini did it' }) }
      if (out.stdout) yield { stream: 'stdout', text: out.stdout }
      if (out.stderr) yield { stream: 'stderr', text: out.stderr }
      return { value: { code: out.code ?? 0, signal: null } }
    }
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return { store }
}

async function start($: any, cwd = '/proj') {
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 5))
}

// Moves the mocked clock on until the call settles, so a retry's wait passes at once.
async function drive(clock: any, call: Promise<any>, steps = 12) {
  let settled = false
  const tracked = call.finally(() => (settled = true))
  for (let i = 0; i < steps && !settled; i++) await clock.advance(120_000)
  return tracked
}

const delegate = (input: Record<string, unknown>) => ({ tool: 'mcp__opencode-go__delegate', ...input })
const batch = (input: Record<string, unknown>) => ({ tool: 'mcp__opencode-go__delegate_batch', ...input })
const agyCalls = (spawned: SpawnCall[]) => spawned.filter(s => s.argv[0] === AGY)
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1]

test('the gemini profile runs Gemini 4 Argon through agy and counts the run', async ($, on) => {
  const spawned: SpawnCall[] = []
  const { store } = engine(on, { spawned })
  await start($)

  const ran = await $.tool.call(delegate({ prompt: 'fix it', profile: 'gemini' }) as any)
  expect((ran as any).deny).toBeUndefined()
  const argv = spawned[0]!.argv
  expect(argv[0]).toBe(AGY)
  expect(argv[1]).toBe('--print=fix it')
  expect(flag(argv, '--model')).toBe('gemini-4-argon-high')
  expect(argv).toContain('--dangerously-skip-permissions')
  expect(argv).not.toContain('--mode')
  expect(spawned[0]!.cwd).toBe('/proj')
  expect(String((ran as any).result)).toContain('gemini did it')
  expect((store.get('geminiUse') as { calls: number }[]).map(u => u.calls)).toEqual([1])
})

test('a read-only Gemini run uses agy plan mode, and a level agy lacks asks for high', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned })
  await start($)

  await $.tool.call(delegate({ prompt: 'read the repo', model: 'agy/gemini-4-argon', effort: 'high', readOnly: true }) as any)
  expect(flag(spawned[0]!.argv, '--mode')).toBe('plan')
  expect(flag(spawned[0]!.argv, '--model')).toBe('gemini-4-argon-high')
})

test('the gemini profile is refused when agy lists no Gemini model', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned, agy: false })
  await start($)

  const refused = await $.tool.call(delegate({ prompt: 'work', profile: 'gemini' }) as any)
  expect(String((refused as any).deny)).toContain('Antigravity')
  expect(spawned.length).toBe(0)
})

test('a quota-limited agy run resumes its conversation', { options: { autoRetries: 1 } }, async ($, on) => {
  const clock = mock.clock(on)
  const spawned: SpawnCall[] = []
  engine(on, {
    spawned,
    agyRun: (_, n) => (n === 1 ? { stderr: 'RESOURCE_EXHAUSTED: quota exceeded', code: 1 } : { stdout: JSON.stringify({ status: 'SUCCESS', response: 'finished' }) }),
  })
  await start($)

  const ran = await drive(clock, $.tool.call(delegate({ prompt: 'long job', model: 'agy/gemini-4-argon' }) as any))
  expect((ran as any).deny).toBeUndefined()
  const calls = agyCalls(spawned)
  expect(calls.length).toBe(2)
  expect(calls[0]!.argv).not.toContain('--conversation')
  expect(flag(calls[1]!.argv, '--conversation')).toBe(CONVERSATION)
  expect(calls[1]!.argv[1]).toContain('Continue the task')
})

test('falling back from agy to an opencode model starts the task afresh', { options: { autoRetries: 0, fallbackModel: 'opencode-go/beam-free' } }, async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned, agyRun: () => ({ stdout: 'jetski: no output produced', code: 0 }) })
  await start($)

  const ran = await $.tool.call(delegate({ prompt: 'the task', model: 'agy/gemini-4-argon' }) as any)
  expect((ran as any).deny).toBeUndefined()
  const opencode = spawned.find(s => s.argv[0] === '/usr/bin/opencode')!
  expect(opencode.argv).toContain('opencode-go/beam-free')
  expect(opencode.argv).not.toContain('--session')
  expect(opencode.argv.at(-1)).toBe('the task')
})

const PLAN = JSON.stringify({
  summary: 'Two parts.',
  tasks: [
    { id: 'part-a', title: 'Part A', prompt: 'do part a', dependsOn: [], verify: 'true' },
    { id: 'part-b', title: 'Part B', prompt: 'do part b', dependsOn: ['part-a'], verify: '' },
  ],
})

test('goal mode has Gemini plan the tasks, then runs them in order', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned, agyRun: () => ({ stdout: JSON.stringify({ status: 'SUCCESS', response: PLAN }) }) })
  await start($)

  const ran = await $.tool.call(batch({ title: 'goal', goal: 'build both parts', isolation: 'none' }) as any)
  expect((ran as any).deny).toBeUndefined()
  const planner = spawned[0]!.argv
  expect(planner[0]).toBe(AGY)
  expect(flag(planner, '--mode')).toBe('plan')
  expect(planner[1]).toContain('build both parts')

  const workers = spawned.slice(1)
  expect(workers.map(w => w.argv.at(-1))).toEqual(['do part a', 'do part b'])
  const report = String((ran as any).result)
  expect(report).toContain('## Plan (agy/gemini-4-argon)')
  expect(report).toContain('part-b: Part B (after part-a)')
  expect(report).toContain('## Final check')
})

test('goal mode is refused with the planner\'s answer when it gives no plan', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned, agyRun: () => ({ stdout: JSON.stringify({ status: 'SUCCESS', response: 'I would rather chat.' }) }) })
  await start($)

  const refused = await $.tool.call(batch({ title: 'goal', goal: 'do things', isolation: 'none' }) as any)
  expect(String((refused as any).deny)).toContain('no JSON plan')
  expect(String((refused as any).deny)).toContain('I would rather chat.')
  expect(spawned.length).toBe(1)
})

test('goal mode needs Gemini, and a batch needs tasks or a goal', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned, agy: false })
  await start($)

  const noGemini = await $.tool.call(batch({ title: 'goal', goal: 'do things' }) as any)
  expect(String((noGemini as any).deny)).toContain('Antigravity')
  const empty = await $.tool.call(batch({ title: 'nothing' }) as any)
  expect(String((empty as any).deny)).toContain('needs tasks, or a goal')
  expect(spawned.length).toBe(0)
})

test('a checker named in the call plans with that model and level', async ($, on) => {
  const spawned: SpawnCall[] = []
  engine(on, { spawned, agyRun: () => ({ stdout: JSON.stringify({ status: 'SUCCESS', response: PLAN }) }) })
  await start($)

  const ran = await $.tool.call(batch({ title: 'goal', goal: 'build both parts', isolation: 'none', checker: 'gemini-3.8-flash', checkerEffort: 'high' }) as any)
  expect((ran as any).deny).toBeUndefined()
  expect(flag(spawned[0]!.argv, '--model')).toBe('gemini-3.8-flash-high')
  expect(String((ran as any).result)).toContain('## Plan (agy/gemini-3.8-flash)')
})

test('Gemini planning shows as a running agent, gone once the plan is in', async ($, on) => {
  const spawned: SpawnCall[] = []
  const status: (string | undefined)[] = []
  engine(on, { spawned, status, agyRun: () => ({ stdout: JSON.stringify({ status: 'SUCCESS', response: PLAN }) }) })
  await start($)

  await $.tool.call(batch({ title: 'goal', goal: 'build both parts', isolation: 'none' }) as any)
  expect(status).toContain('opencode gemini-4-argon: 0 steps · planning goal')
  expect(status.at(-1)).toBeUndefined()
})
