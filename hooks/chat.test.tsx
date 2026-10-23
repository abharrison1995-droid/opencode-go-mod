import { expect, mock, test } from 'claude-code/testing'

import type { WorkerModel } from '../types'
import { abortable, explainError } from './chat'
import { MODELS, PANE, REPLY, step } from './testkit'

// command.run's input now carries where the run came from and where it shows; the engine stamps both for an Enter.
const opencode = (args: string) => ({ command: 'opencode', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

type Options = {
  store?: Map<string, unknown>
  fetched?: any[]
  models?: () => any
  modelsDelay?: Promise<void>
  auth?: string | undefined
  reply?: () => any
}

const listed = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const response = (status: number, ok: boolean, body: unknown) => ({ status, ok, headers: {}, text: JSON.stringify(body) })

// Same shape as testkit's engine, with the catalog and auth answers each test needs to vary.
function setup(on: any, opts: Options = {}) {
  const store = opts.store ?? new Map<string, unknown>()
  const fetched = opts.fetched ?? []
  const reply = opts.reply ?? (() => response(200, true, REPLY))
  const auth = 'auth' in opts ? opts.auth : '{"opencode":{"type":"api","key":"test-key"}}'
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__opencode-go__${e.name}` } }))
  on('tool.list', () => ({ value: [{ name: 'Read', description: '', mcp: false }, { name: 'Bash', description: '', mcp: false }, { name: 'Agent', description: '', mcp: false }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.read', () => ({ value: auth }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Fix /x.ts', toolUses: [] },
      { role: 'assistant', text: 'Looking.', toolUses: [{ tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'ls' }, text: 'x.ts' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: 'x.ts', isError: false }] },
    ],
  }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('http.fetch', (_: any, e: any) => {
    // The local decision models' health pings; none is running here.
    if (e.url.startsWith('http://127.0.0.1:')) return { value: response(503, false, {}) }
    return (fetched.push(e), { value: reply() })
  })
  on('process.run', async (_: any, e: any) => {
    if (!e.argv.includes('models')) return { value: listed('/usr/bin/opencode\n') }
    if (opts.modelsDelay) await opts.modelsDelay
    return { value: opts.models ? opts.models() : listed(MODELS) }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '' }
    return { value: { code: 0, signal: null } }
  })
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'text', index: 0, text: 'from claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return { store, fetched }
}

async function until(fn: () => Promise<unknown>, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const found = await fn()
    if (found !== undefined) return found
    await new Promise(r => setTimeout(r, 10))
  }
  return undefined
}

// session.start loads the catalog in the background; let it finish before a test ends.
const settled = (store: Map<string, unknown>) =>
  until(() => Promise.resolve(((store.get('catalog') as any)?.models?.length ?? 0) > 1 ? true : undefined))

const CACHED: WorkerModel[] = [
  { id: 'opencode-go/cached-free', name: 'Cached Free', source: 'go', maker: 'Other', input: 0, output: 0, efforts: [], maxOutput: 32_000 },
]

const storeWithCache = (model: string) =>
  new Map<string, unknown>([
    ['catalog', { at: 1, models: CACHED }],
    ['model', model],
  ])

test('the panel draws cached models while the catalog loads', async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(r => {
    release = r
  })
  const store = storeWithCache('opencode-go/cached-free')
  setup(on, { store, modelsDelay: gate })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await until(() => ui.find({ key: 'model:opencode-go/cached-free' }))).toBeDefined()
  await ui.unmount()

  release()
  await settled(store)
  await new Promise(r => setTimeout(r, 20))
})

test('a failed load keeps the cached models and shows the error', async ($, on) => {
  const store = storeWithCache('opencode-go/cached-free')
  setup(on, { store, models: () => ({ exitCode: 1, stdout: '', stderr: 'boom\n', isStdoutTruncated: false, isStderrTruncated: false }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await until(() => ui.find({ key: 'model:opencode-go/cached-free' }))).toBeDefined()
  expect(await until(() => ui.find({ type: 'Text', text: /Could not list models: boom/ }))).toBeDefined()
  await ui.unmount()
  await new Promise(r => setTimeout(r, 50))
})

test('chat mode explains a rejected key', async ($, on) => {
  const fetched: any[] = []
  const { store } = setup(on, { fetched, reply: () => response(401, false, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settled(store)
  await $.command.run(opencode('chat on'))

  const { result } = await step($)
  expect(fetched.length).toBe(1)
  expect(result.answer).toContain('opencode auth login')
})

test('a 503 is retried once and then answered', async ($, on) => {
  const clock = mock.clock(on)
  const fetched: any[] = []
  let calls = 0
  const { store } = setup(on, {
    fetched,
    reply: () =>
      ++calls === 1
        ? response(503, false, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } })
        : response(200, true, REPLY),
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settled(store)
  await $.command.run(opencode('chat on'))

  const running = step($)
  for (let i = 0; i < 20 && fetched.length < 2; i++) {
    await clock.settle()
    await clock.advance(2_000)
  }
  const { result } = await running
  expect(fetched.length).toBe(2)
  expect(result.answer).toBe('Reading it.')
})

test('chat mode tells the user when there is no key', async ($, on) => {
  const { store } = setup(on, { auth: undefined })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settled(store)
  await $.command.run(opencode('chat on'))

  const { result } = await step($)
  expect(result.answer).toContain('no OpenCode key')
})

test('chat mode refuses a Zen model at the turn', async ($, on) => {
  const fetched: any[] = []
  const { store } = setup(on, { fetched })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settled(store)
  await $.command.run(opencode('model deepseek'))
  const refused = await $.command.run(opencode('chat on'))
  expect(refused.text).toContain('Zen model')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await until(() => ui.find({ type: 'Text', text: /▾ FREE$/ }))
  await ui.press({ key: 'chat:opencode' })
  await ui.unmount()

  const { result } = await step($)
  expect(fetched.length).toBe(0)
  expect(result.answer).toContain('Zen model')
})

test('subcommands pick models, efforts and groups', async ($, on) => {
  const { store } = setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settled(store)

  const glm = await $.command.run(opencode('model glm'))
  expect(glm.text).toContain('Worker: GLM 5.3 Flash')
  expect(store.get('model')).toBe('opencode-go/glm-5.3-flash')

  const several = await $.command.run(opencode('model kimi'))
  expect(several.text).toContain('Several match')

  const max = await $.command.run(opencode('effort max'))
  expect(max.text).toContain('Reasoning: max')
  expect(store.get('effort')).toBe('max')

  const huge = await $.command.run(opencode('effort huge'))
  expect(huge.text).toContain('low, medium, high, xhigh, max')

  const paid = await $.command.run(opencode('models paid'))
  expect(paid.text).toContain('opencode-go/kimi-k3')

  const status = await $.command.run(opencode('status'))
  expect(status.text).toContain('this chat')
})

test('an unknown subcommand lists the commands', async ($, on) => {
  const { store } = setup(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await settled(store)
  const out = await $.command.run(opencode('wat'))
  expect(out.text).toContain('Unknown subcommand.')
  expect(out.text).toContain('/opencode effort <level>')
})

test('abortable stops waiting on the signal', async () => {
  const controller = new AbortController()
  const running = abortable(new Promise<string>(() => {}), controller.signal)
  controller.abort()
  expect(await running).toEqual({ aborted: true })

  const already = new AbortController()
  already.abort()
  expect(await abortable(Promise.resolve('late'), already.signal)).toEqual({ aborted: true })
})

test('explainError words the common failures', () => {
  expect(explainError(401, 'nope')).toContain('opencode auth login')
  expect(explainError(429, 'slow down')).toContain('rate limiting')
  expect(explainError(400, 'model does not support tools')).toContain('try another model')
  expect(explainError(500, 'boom')).toBe('boom')
})
