import { expect, test } from 'claude-code/testing'

import { cancel, track, untrack } from './control'
import { MODELS, PANE, ready, RUN } from './testkit'

// command.run's input now carries where the run came from and where it shows; the engine stamps both for an Enter.
const opencode = (args: string) => ({ command: 'opencode', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
type Spawn = (_: any, e: any) => AsyncGenerator<any, any>

const result = (exitCode = 0, stdout = '', stderr = ''): RunResult => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// The git calls a worktree batch and the panel's actions make, as plain outputs.
function gitRun(argv: string[]): RunResult {
  if (argv[0] === 'sh') return result(0, '/usr/bin/opencode\n')
  if (argv.includes('models')) return result(0, MODELS)
  if (argv[0] !== 'git') return result(0, '/usr/bin/opencode\n')
  const at = argv.indexOf('-C')
  const top = at < 0 ? '' : argv[at + 1] ?? ''
  const args = at < 0 ? argv : argv.slice(at + 2)
  const cmd = args[0]
  const sub = args[1]
  if (cmd === 'rev-parse' && sub === '--show-toplevel') return result(0, '/repo\n')
  if (cmd === 'rev-parse' && sub === '--abbrev-ref') return result(0, 'main\n')
  if (cmd === 'worktree' && sub === 'add') return result(0, '')
  if (cmd === 'worktree' && sub === 'remove') return result(0, '')
  if (cmd === 'branch' && sub === '-D') return result(0, 'Deleted branch\n')
  if (cmd === 'status' && sub === '--porcelain') return result(0, top.startsWith('/repo-opencode/') ? ' M src/a.ts\n' : '')
  if (cmd === 'add') return result(0, '')
  if (cmd === 'commit') return result(0, '')
  if (cmd === 'show' && sub === '--stat') return result(0, ' src/a.ts | 2 +-\n')
  if (cmd === 'diff' && sub === '--stat') return result(0, ' src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n')
  if (cmd === 'diff' && sub === '--name-only') return result(0, '')
  if (cmd === 'diff') return result(0, 'diff --git a/src/a.ts b/src/a.ts\n+done\n')
  if (cmd === 'merge' && sub === '--abort') return result(0, '')
  if (cmd === 'merge') return result(0, "Merge made by the 'ort' strategy.\n")
  return result(0, '')
}

function setup(
  on: any,
  store: Map<string, unknown>,
  opts: { spawn?: Spawn; run?: (argv: string[]) => RunResult | undefined; toasts?: string[] } = {},
) {
  const runs: string[][] = []
  const submitted: string[] = []
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__opencode-go__${e.name}` } }))
  on('tool.list', () => ({ value: [{ name: 'Read', description: '', mcp: false }, { name: 'Bash', description: '', mcp: false }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_: any, e: any) => (opts.toasts?.push(e.text), { value: undefined }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.read', () => ({ value: '{"opencode":{"type":"api","key":"test-key"}}' }))
  on('session.messages', () => ({ value: [] }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('prompt.submit', (_: any, e: any) => (submitted.push(e.text), { text: e.text }))
  on('process.run', (_: any, e: any) => {
    const argv = [...e.argv]
    runs.push(argv)
    return { value: opts.run?.(argv) ?? gitRun(argv) }
  })
  on(
    'process.spawn',
    opts.spawn ??
      (async function* () {
        yield { stream: 'stdout', text: RUN + '\n' }
        return { value: { code: 0, signal: null } }
      }),
  )
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'text', index: 0, text: 'from claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  return { runs, submitted, store }
}

function batchIdFrom(runs: string[][]) {
  const add = runs.find(argv => argv.includes('worktree') && argv.includes('add'))
  const at = add === undefined ? -1 : add.indexOf('-b')
  const branch = at < 0 ? '' : add?.[at + 1] ?? ''
  return branch.slice(3).split('-')[0] ?? ''
}

async function worktreeBatch($: any) {
  return $.tool.call({
    tool: 'mcp__opencode-go__delegate_batch',
    title: 'Build it',
    isolation: 'worktree',
    tasks: [{ id: 'a', prompt: 'a', title: 'Alpha' }],
  } as any)
}

async function openPlan(ui: any, id: string) {
  await ui.press({ key: `plan:${id}` })
  await until(async () => (await ui.find({ key: `diff:${id}:a` })) !== undefined || (await ui.find({ key: `merge:${id}:a` })) !== undefined || (await ui.find({ key: `discard:${id}:a` })) !== undefined)
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 10))
  }
}

test('presets apply from the panel and from /opencode preset', async ($, on) => {
  const { store } = setup(on, new Map())
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  await ui.press({ key: 'preset:reliable' })
  await until(() => store.get('effort') === 'high')
  expect(store.get('model')).toBe('opencode-go/deepseek-v4.1-flash')
  expect(store.get('effort')).toBe('high')
  await ui.unmount()

  const out = await $.command.run(opencode('preset strong'))
  expect(out.text).toBe('Preset strong: opencode-go/kimi-k3 · high')
  expect(store.get('model')).toBe('opencode-go/kimi-k3')
  expect(store.get('effort')).toBe('high')
})

test('health restores from the store and shows on the row and worker card', async ($, on) => {
  const store = new Map<string, unknown>([
    [
      'health',
      {
        'opencode-go/kimi-k3': { ok: 1, failed: 0, rateLimited: 3, hung: 0, totalMs: 1000, lastAt: Date.now() },
      },
    ],
  ])
  setup(on, store)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  const row = await ui.find({ key: 'model:opencode-go/kimi-k3' })
  expect(row?.text).toMatch(/● Kimi K3/)
  expect(await ui.find({ type: 'Text', text: /3 rate limits/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 hangs · 0 failures in 4 runs/ })).toBeDefined()
  await ui.unmount()
})

test('merge merges a finished worktree task', async ($, on) => {
  const { runs } = setup(on, new Map())
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await worktreeBatch($)
  const id = batchIdFrom(runs)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  await openPlan(ui, id)
  expect(await ui.find({ key: `merge:${id}:a` })).toBeDefined()
  await ui.press({ key: `merge:${id}:a` })
  await until(() => runs.some(argv => argv.join(' ') === `git -C /repo merge --no-ff --no-edit oc/${id}-a`))

  expect(runs.some(argv => argv.join(' ') === `git -C /repo merge --no-ff --no-edit oc/${id}-a`)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /merged/ })).toBeDefined()
  await ui.unmount()
})

test('merge refuses when the main checkout is dirty', async ($, on) => {
  const toasts: string[] = []
  const { runs } = setup(on, new Map(), {
    toasts,
    run: argv => {
      const at = argv.indexOf('-C')
      const top = at < 0 ? '' : argv[at + 1]
      const args = at < 0 ? argv : argv.slice(at + 2)
      if (top === '/repo' && args[0] === 'status' && args[1] === '--porcelain') return result(0, ' M src/other.ts\n')
      return undefined
    },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await worktreeBatch($)
  const id = batchIdFrom(runs)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  await openPlan(ui, id)
  await ui.press({ key: `merge:${id}:a` })
  await until(() => toasts.length > 0)

  expect(runs.some(argv => argv.includes('merge') && argv.includes('--no-ff'))).toBe(false)
  expect(toasts.some(t => /uncommitted/i.test(t))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /merged/ })).toBeUndefined()
  await ui.unmount()
})

test('a merge conflict aborts and leaves the task unmerged', async ($, on) => {
  const { runs } = setup(on, new Map(), {
    run: argv => {
      const at = argv.indexOf('-C')
      const args = at < 0 ? argv : argv.slice(at + 2)
      if (args[0] === 'merge' && args[1] !== '--abort') return result(1, '', 'CONFLICT (content): Merge conflict in src/a.ts\n')
      if (args[0] === 'diff' && args.includes('--diff-filter=U')) return result(0, 'src/a.ts\n')
      return undefined
    },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await worktreeBatch($)
  const id = batchIdFrom(runs)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  await openPlan(ui, id)
  await ui.press({ key: `merge:${id}:a` })
  await until(() => runs.some(argv => argv.join(' ') === 'git -C /repo merge --abort'))

  expect(runs.some(argv => argv.join(' ') === 'git -C /repo merge --abort')).toBe(true)
  expect(runs.some(argv => argv.includes('--diff-filter=U'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /merged/ })).toBeUndefined()
  await ui.unmount()
})

test('diff opens a preview and preview:close hides it', async ($, on) => {
  const { runs } = setup(on, new Map())
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await worktreeBatch($)
  const id = batchIdFrom(runs)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  await openPlan(ui, id)
  await ui.press({ key: `diff:${id}:a` })
  await until(async () => (await ui.find({ type: 'Text', text: /1 file changed/ })) !== undefined)

  expect(await ui.find({ type: 'Text', text: /1 file changed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'a diff' })).toBeDefined()
  await ui.press({ key: 'preview:close' })
  expect(await ui.find({ type: 'Text', text: /1 file changed/ })).toBeUndefined()
  await ui.unmount()
})

test('discard removes the worktree and deletes its branch', async ($, on) => {
  const { runs } = setup(on, new Map())
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await worktreeBatch($)
  const id = batchIdFrom(runs)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  await openPlan(ui, id)
  await ui.press({ key: `discard:${id}:a` })
  await until(() => runs.some(argv => argv.includes('remove')))

  expect(runs.some(argv => argv.join(' ') === `git -C /repo worktree remove --force /repo-opencode/${id}-a`)).toBe(true)
  expect(runs.some(argv => argv.join(' ') === `git -C /repo branch -D oc/${id}-a`)).toBe(true)
  expect(await ui.find({ key: `merge:${id}:a` })).toBeUndefined()
  await ui.unmount()
})

test('cancel stops a running batch by its id', async ($, on) => {
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const spawn = async function* (_: any, e: any) {
    if (e.argv.at(-1) === 'a') await gate
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  }
  const { submitted } = setup(on, new Map(), { spawn })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const call = await $.tool.call({
    tool: 'mcp__opencode-go__delegate_batch',
    title: 'Slow',
    isolation: 'worktree',
    background: true,
    tasks: [{ id: 'a', prompt: 'a' }],
  } as any)
  const id = /Batch (\S+) started/.exec(String((call as any).result))?.[1] ?? ''
  expect(id).not.toBe('')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  // The plugin loads its own copy of control.ts, so a controller made here is not visible
  // to it. A running batch in the atom takes the batch branch, which calls
  // cancel('batch:<id>') and answers the cancellation; the registry itself is tested below.
  const out = await $.command.run(opencode(`cancel ${id}`))
  expect(out.text).toBe(`Cancelling batch ${id}.`)

  release()
  await until(() => submitted.length > 0)
  await ui.unmount()
})

test('/opencode history lists stored runs and spend, and HISTORY unfolds', async ($, on) => {
  const store = new Map<string, unknown>([
    [
      'history',
      [
        {
          id: 'b1',
          title: 'Old run',
          status: 'done',
          startedAt: Date.now() - 6 * 60_000,
          endedAt: Date.now() - 5 * 60_000,
          cost: 0.1234,
          tasks: 2,
          done: 2,
        },
      ],
    ],
    ['spendByModel', { 'opencode-go/kimi-k3': 1.2345 }],
  ])
  setup(on, store)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const out = await $.command.run(opencode('history'))
  expect(out.text).toContain('Old run · done · 2/2 · $0.1234 · 5m ago')
  expect(out.text).toContain('kimi-k3 $1.23')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  expect(await ui.find({ type: 'Text', text: /Old run/ })).toBeUndefined()
  await ui.press({ key: 'historyToggle' })
  expect(await ui.find({ type: 'Text', text: /Old run · done · 2\/2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /kimi-k3 \$1\.23/ })).toBeDefined()
  await ui.unmount()
})

test('/opencode batches lists a batch and its tasks', async ($, on) => {
  const { runs } = setup(on, new Map())
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await worktreeBatch($)
  const id = batchIdFrom(runs)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  const out = await $.command.run(opencode('batches'))
  expect(out.text).toContain(`${id} · Build it · done · 1/1 · $0.0000`)
  expect(out.text).toContain('  ● a done')
  await ui.unmount()
})


test('the control registry aborts a tracked batch id', () => {
  const signal = track('batch:b1')
  expect(cancel('batch:b1')).toBe(true)
  expect(signal.aborted).toBe(true)
  expect(cancel('batch:missing')).toBe(false)
  untrack('batch:b1')
})
