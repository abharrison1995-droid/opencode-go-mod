import { expect, test } from 'claude-code/testing'

import { engine, MODELS, PANE, ready, RUN } from './testkit'

type Spawn = (_: any, e: any) => AsyncGenerator<any, any>

// testkit's engine, with a spawn the test scripts per task.
function stand(on: any, store: Map<string, unknown>, spawn: Spawn) {
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__opencode-go__${e.name}` } }))
  on('tool.list', () => ({ value: [{ name: 'Read', description: '', mcp: false }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.read', () => ({ value: '{"opencode":{"type":"api","key":"test-key"}}' }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('process.run', (_: any, e: any) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('models') ? MODELS : '/usr/bin/opencode\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('process.spawn', spawn)
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'text', index: 0, text: 'from claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
}

async function until(ui: any, check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 10))
  }
}

test('mobile shows recent models, then all models on demand', async ($, on) => {
  const store = new Map<string, unknown>()
  store.set('recent', ['opencode-go/kimi-k3', 'opencode-go/glm-5.3-flash'])
  engine(on, store, [], [])
  await $.session.start({ cwd: '/', surface: 'mobile', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ready(ui)
  expect(await ui.find({ type: 'Text', text: /RECENT$/ })).toBeDefined()
  expect(await ui.find({ key: 'model:opencode-go/kimi-k3' })).toBeDefined()
  expect(await ui.find({ key: 'model:opencode-go/glm-5.3-flash' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▾ FREE$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▾ PAID$/ })).toBeUndefined()

  await ui.press({ key: 'showAll' })
  expect(await ui.find({ type: 'Text', text: /▾ FREE$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▾ PAID$/ })).toBeDefined()

  await ui.press({ key: 'showAll' })
  expect(await ui.find({ type: 'Text', text: /▾ FREE$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▾ PAID$/ })).toBeUndefined()
  await ui.unmount()
})

test('desktop shows FREE and PAID without the all models toggle', async ($, on) => {
  engine(on, new Map(), [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  expect(await ui.find({ type: 'Text', text: /▾ FREE$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▾ PAID$/ })).toBeDefined()
  expect(await ui.find({ key: 'showAll' })).toBeUndefined()
  await ui.unmount()
})

test('AGENTS shows a running job as a card with its header and activity', async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const spawn = async function* () {
    yield { stream: 'stdout', text: RUN + '\n' }
    await gate
    return { value: { code: 0, signal: null } }
  }
  stand(on, new Map(), spawn)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const call = $.tool.call({ tool: 'mcp__opencode-go__delegate', prompt: 'a', model: 'kimi-k3', effort: 'high' } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await until(ui, async () => (await ui.find({ type: 'Text', text: /ACTIVITY edit: src/ })) !== undefined)

  expect(await ui.find({ type: 'Text', text: '1 : KIMI-K3 : HIGH' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ACTIVITY edit: src\/a\.ts/ })).toBeDefined()

  release()
  await call
  await ui.unmount()
})

test('PLAN draws a running batch and its task states', async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const spawn = async function* (_: any, e: any) {
    const prompt = e.argv.at(-1)
    if (prompt === 'a') await gate
    if (prompt === 'd') {
      yield { stream: 'stderr', text: 'boom\n' }
      return { value: { code: 1, signal: null } }
    }
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  }
  stand(on, new Map(), spawn)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const call = $.tool.call({
    tool: 'mcp__opencode-go__delegate_batch',
    title: 'Build it',
    maxParallel: 3,
    isolation: 'none',
    tasks: [
      { id: 'a', prompt: 'a', title: 'Alpha' },
      { id: 'b', prompt: 'b' },
      { id: 'c', prompt: 'c', dependsOn: ['a'] },
      { id: 'd', prompt: 'd' },
    ],
  } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await until(ui, async () => (await ui.find({ type: 'Text', text: /1\/4 done/ })) !== undefined)

  expect(await ui.find({ type: 'Text', text: /●/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◐/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /○/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✕/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /after a/ })).toBeDefined()

  release()
  await call
  await ui.unmount()
})

test('PLAN folds and unfolds on its header', async ($, on) => {
  const spawn = async function* () {
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  }
  stand(on, new Map(), spawn)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__opencode-go__delegate_batch',
    title: 'Fold me',
    isolation: 'none',
    tasks: [
      { id: 'x', prompt: 'x' },
      { id: 'y', prompt: 'y' },
    ],
  } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /2\/2 done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● x · ● kimi-k3/ })).toBeUndefined()

  const header = await ui.find({ type: 'Button', text: /Fold me/ })
  expect(header).toBeDefined()
  await ui.press({ key: header?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: /● x · ● kimi-k3/ })).toBeDefined()
  await ui.press({ key: header?.key ?? '' })
  expect(await ui.find({ type: 'Text', text: /● x · ● kimi-k3/ })).toBeUndefined()
  await ui.unmount()
})

const finished = (cost: number) =>
  [
    '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}',
    '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"edit","state":{"status":"completed","title":"src/a.ts"}}}',
    '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"done"}}',
    `{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","cost":${cost}}}`,
  ].join('\n')

test('SPENT shows this chat and the all-time total', async ($, on) => {
  const store = new Map<string, unknown>([['spendTotal', 1.3766]])
  const spawn = async function* (_: any, e: any) {
    const cost = e.argv.at(-1) === 'first' ? 0.1234 : 0
    yield { stream: 'stdout', text: finished(cost) + '\n' }
    return { value: { code: 0, signal: null } }
  }
  stand(on, store, spawn)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__opencode-go__delegate', prompt: 'first' } as any)
  await $.tool.call({ tool: 'mcp__opencode-go__delegate', prompt: 'second' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  expect(await ui.find({ type: 'Text', text: 'Spent $0.1234 this chat · 2 runs · $1.50 all time' })).toBeDefined()
  await ui.unmount()
})

test('SPENT stays hidden with no runs and no total', async ($, on) => {
  engine(on, new Map(), [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  expect(await ui.find({ type: 'Text', text: /Spent/ })).toBeUndefined()
  await ui.unmount()
})

test('picking models keeps recent newest first without duplicates', async ($, on) => {
  const store = new Map<string, unknown>()
  engine(on, store, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  for (const [search, id] of [
    ['beam-free', 'opencode-go/beam-free'],
    ['deepseek', 'opencode/deepseek-v4.1-flash-free'],
    ['glm', 'opencode-go/glm-5.3-flash'],
  ] as const) {
    await ui.input({ key: 'search', text: search, kind: 'change' })
    await ui.press({ key: `model:${id}` })
  }
  await ui.unmount()

  expect(store.get('recent')).toEqual(['opencode-go/glm-5.3-flash', 'opencode/deepseek-v4.1-flash-free', 'opencode-go/beam-free'])
})
