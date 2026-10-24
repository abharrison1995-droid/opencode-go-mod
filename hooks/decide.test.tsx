import { expect, test } from 'claude-code/testing'

import { MODELS, PANE, ready } from './testkit'

// command.run's input now carries where the run came from and where it shows; the engine stamps both for an Enter.
const opencode = (args: string) => ({ command: 'opencode', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

const decide = (input: Record<string, unknown>) => ({ tool: 'mcp__opencode-go__decide', ...input })

const QUESTIONS = { billing: { type: 'noul', instructions: 'Is this about billing?' } }
const answers = (p: number) => JSON.stringify({ answers: { billing: { type: 'noul', noul: p } }, latency_ms: 12 })

type Options = { up?: Set<number>; answer?: (port: number) => any }

// Same shape as testkit's engine, with local servers that answer on the ports in `up`.
function setup(on: any, o: Options = {}) {
  const up = o.up ?? new Set<number>()
  const store = new Map<string, unknown>()
  const spawned: any[] = []
  const asked: { port: number; body: any }[] = []
  let exited = false
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__opencode-go__${e.name}` } }))
  on('tool.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.read', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('http.fetch', (_: any, e: any) => {
    const port = Number(/:(\d+)\//.exec(e.url)?.[1])
    if (!up.has(port)) return { value: { status: 503, ok: false, headers: {}, text: '' } }
    if (e.init?.method === 'POST') {
      asked.push({ port, body: JSON.parse(e.init.body) })
      return { value: o.answer?.(port) ?? { status: 200, ok: true, headers: {}, text: answers(port === 8009 ? 0.9 : 0.7) } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('process.run', (_: any, e: any) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'printenv' ? '/home/test\n' : e.argv.includes('models') ? MODELS : '/usr/bin/opencode\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  on('process.spawn', async function* (_: any, e: any) {
    spawned.push(e)
    // The server comes up once spawned, and runs until the stream is closed. It idles in short
    // steps: a generator stuck in one await never reaches the yield where a close lands. `exit()`
    // ends every server as if it quit on its own.
    const port = e.argv[0].includes('laya') ? 8010 : 8009
    up.add(port)
    try {
      while (!exited) {
        yield { stream: 'stderr', text: 'serving\n' }
        await new Promise(r => setTimeout(r, 2))
      }
      return { value: { code: 0, signal: null } }
    } finally {
      up.delete(port)
    }
  })
  on('clock.sleep', async () => (await new Promise(r => setTimeout(r, 1)), { value: undefined }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return { up, spawned, asked, exit: () => void (exited = true) }
}

async function start($: any) {
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  // The catalog loads and the local servers are pinged in the background; let both settle.
  await new Promise(r => setTimeout(r, 10))
}

test('decide denies a call with no state or bad questions', async ($, on) => {
  const { asked } = setup(on, { up: new Set([8009]) })
  await start($)
  expect(((await $.tool.call(decide({ questions: QUESTIONS }) as any)) as any).deny).toBe('decide needs a state: the text the questions are about.')
  expect(((await $.tool.call(decide({ state: 's', questions: {} }) as any)) as any).deny).toBe('decide: questions is empty.')
  expect(asked.length).toBe(0)
})

test('decide asks Kev by default on a server that is already running', async ($, on) => {
  const { spawned, asked } = setup(on, { up: new Set([8009]) })
  await start($)
  const got: any = await $.tool.call(decide({ state: 'I was charged twice', questions: QUESTIONS }) as any)
  expect(got.deny).toBeUndefined()
  expect(got.result).toBe('Kev (12 ms)\nbilling: yes 90%')
  expect(spawned.length).toBe(0)
  expect(asked).toEqual([{ port: 8009, body: { state: 'I was charged twice', questions: QUESTIONS } }])
})

test('decide with both starts each server and asks Kev, then Laya', async ($, on) => {
  const { spawned, asked } = setup(on)
  await start($)
  const got: any = await $.tool.call(decide({ model: 'both', state: 's', questions: QUESTIONS }) as any)
  expect(got.result).toBe('Kev (12 ms)\nbilling: yes 90%\n\nLaya (12 ms)\nbilling: yes 70%')
  expect(spawned.map(s => s.argv[0])).toEqual(['/home/test/local-models/kev/.venv/bin/python', '/home/test/local-models/laya-env/bin/laya-serve'])
  expect(asked.map(a => a.port)).toEqual([8009, 8010])
  await $.command.run(opencode('local stop'))
})

test('decide reports a refused request and returns raw answers on request', async ($, on) => {
  let refuse = true
  setup(on, {
    up: new Set([8010]),
    answer: () => (refuse ? { status: 422, ok: false, headers: {}, text: JSON.stringify({ detail: 'bad criteria' }) } : undefined),
  })
  await start($)
  const refused: any = await $.tool.call(decide({ model: 'laya', state: 's', questions: QUESTIONS }) as any)
  expect(refused.result).toBe('Laya: HTTP 422: "bad criteria"')
  refuse = false
  const raw: any = await $.tool.call(decide({ model: 'laya', state: 's', questions: QUESTIONS, raw: true }) as any)
  expect(raw.result).toBe(`Laya (12 ms)\n${JSON.stringify({ billing: { type: 'noul', noul: 0.7 } }, null, 2)}`)
})

test('/opencode local reports, starts and stops the servers', async ($, on) => {
  const { spawned } = setup(on, { up: new Set([8010]) })
  await start($)
  expect((await $.command.run(opencode('local'))).text).toBe('Kev :8009 · off\nLaya :8010 · ready')
  expect((await $.command.run(opencode('local status bob'))).text).toBe('No local model "bob". Try kev or laya.')
  expect((await $.command.run(opencode('local stop laya'))).text).toBe('Laya was not started by this session.')

  expect((await $.command.run(opencode('local start kev'))).text).toBe('Starting Kev; the panel shows when it is ready.')
  for (let i = 0; i < 50 && spawned.length === 0; i++) await new Promise(r => setTimeout(r, 2))
  expect(spawned.length).toBe(1)
  expect((await $.command.run(opencode('local stop kev'))).text).toBe('Kev stopped.')
})

test('the LOCAL panel counts calls and starts a server', async ($, on) => {
  const { spawned, exit } = setup(on, { up: new Set([8009]) })
  await start($)
  await $.tool.call(decide({ state: 's', questions: QUESTIONS }) as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  expect(await ui.find({ type: 'Text', text: 'ready · 1 calls · 12 ms' })).toBeDefined()
  // Kev answered but this session did not start it, so there is no Stop; Laya is off, so there is Start.
  expect(await ui.find({ key: 'local-stop:kev' })).toBeUndefined()
  // A press settles once the work it started has, and a server runs until it exits.
  const pressed = ui.press({ key: 'local-start:laya' })
  for (let i = 0; i < 50 && spawned.length === 0; i++) await new Promise(r => setTimeout(r, 2))
  expect(spawned[0].argv[0]).toBe('/home/test/local-models/laya-env/bin/laya-serve')
  exit()
  await pressed
  // Laya quit on its own, so the row is back to off with Start.
  expect(await ui.find({ key: 'local-start:laya' })).toBeDefined()
  await ui.unmount()
})
