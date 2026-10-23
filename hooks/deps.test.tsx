import { expect, test } from 'claude-code/testing'

import { prepareDir } from './batch'
import { MODELS, RUN } from './testkit'

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

const batch = (input: Record<string, unknown>) => ({ tool: 'mcp__opencode-go__delegate_batch', ...input })

function fake(run: (argv: string[]) => RunResult | undefined = () => undefined) {
  const runs: string[][] = []
  const $ = {
    process: {
      run: async (argv: string[]) => {
        runs.push([...argv])
        return run(argv) ?? result(0)
      },
    },
  }
  return { $: $ as any, runs }
}

type Options = { runs?: string[][]; spawned?: SpawnCall[]; run?: (argv: string[]) => RunResult | undefined }

function setup(on: any, o: Options = {}) {
  const store = new Map<string, unknown>()
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__opencode-go__${e.name}` } }))
  on('tool.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.read', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
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
    o.spawned?.push({ argv: [...e.argv], cwd: e.cwd })
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'text', index: 0, text: 'from claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
}

async function start($: any, cwd = '/repo') {
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
  await new Promise(r => setTimeout(r, 15))
}

test('a worktree with from starts at the dependency branch', async () => {
  const { $, runs } = fake(argv => (argv.includes('--show-toplevel') ? result(0, '/repo\n') : undefined))

  const made = await prepareDir($, 'worktree', '/repo', 'b1', 't', ['oc/b1-a'])
  expect(made.branch).toBe('oc/b1-t')
  const add = runs.find(argv => argv.includes('worktree') && argv.includes('add'))
  expect(add).toEqual(['git', '-C', '/repo', 'worktree', 'add', '-b', 'oc/b1-t', '/repo-opencode/b1-t', 'oc/b1-a'])
})

test('a conflicting second dependency aborts the merge and cleans up', async () => {
  const { $, runs } = fake(argv => {
    if (argv.includes('--show-toplevel')) return result(0, '/repo\n')
    if (argv.includes('merge') && argv.includes('--no-edit') && argv.at(-1) === 'oc/b1-b') return result(1, '', 'CONFLICT (content)\n')
    if (argv.includes('diff') && argv.includes('--diff-filter=U')) return result(0, 'src/c.ts\nsrc/d.ts\n')
    return undefined
  })

  let caught: Error | undefined
  try {
    await prepareDir($, 'worktree', '/repo', 'b1', 't', ['oc/b1-a', 'oc/b1-b'])
  } catch (err) {
    caught = err instanceof Error ? err : new Error(String(err))
  }
  expect(caught).toBeDefined()
  expect(caught?.message).toContain('dependencies oc/b1-a and oc/b1-b conflict')
  expect(caught?.message).toContain('src/c.ts')
  expect(caught?.message).toContain('src/d.ts')

  const merge = runs.find(argv => argv.includes('merge') && argv.includes('--no-edit'))
  expect(merge).toEqual([
    'git', '-C', '/repo-opencode/b1-t', '-c', 'user.name=OpenCode worker', '-c', 'user.email=opencode-worker@localhost',
    'merge', '--no-ff', '--no-edit', 'oc/b1-b',
  ])
  const files = runs.findIndex(argv => argv.includes('--diff-filter=U'))
  const aborted = runs.findIndex(argv => argv.includes('merge') && argv.includes('--abort'))
  expect(files).toBeGreaterThanOrEqual(0)
  expect(files).toBeLessThan(aborted)
  expect(runs.some(argv => argv.join(' ') === 'git -C /repo-opencode/b1-t merge --abort')).toBe(true)
  expect(runs.some(argv => argv.join(' ') === 'git -C /repo worktree remove --force /repo-opencode/b1-t')).toBe(true)
  expect(runs.some(argv => argv.join(' ') === 'git -C /repo branch -D oc/b1-t')).toBe(true)
})

test('a worktree with no from starts at HEAD', async () => {
  const { $, runs } = fake(argv => (argv.includes('--show-toplevel') ? result(0, '/repo\n') : undefined))

  await prepareDir($, 'worktree', '/repo', 'b2', 't')
  const add = runs.find(argv => argv.includes('worktree') && argv.includes('add'))
  expect(add).toEqual(['git', '-C', '/repo', 'worktree', 'add', '-b', 'oc/b2-t', '/repo-opencode/b2-t', 'HEAD'])
})

test('a dependent batch task builds on its dependency branch', async ($, on) => {
  const runs: string[][] = []
  const run = (argv: string[]): RunResult | undefined => {
    if (argv.includes('--show-toplevel')) return result(0, '/repo\n')
    if (argv.includes('--abbrev-ref')) return result(0, 'main\n')
    return undefined
  }
  setup(on, { runs, run })
  await start($)

  await $.tool.call(
    batch({
      title: 'deps',
      isolation: 'worktree',
      tasks: [
        { id: 'a', prompt: 'A' },
        { id: 'b', prompt: 'B', dependsOn: ['a'] },
      ],
    }) as any,
  )

  const adds = runs.filter(argv => argv.includes('worktree') && argv.includes('add'))
  expect(adds.length).toBe(2)
  const second = adds.find(argv => (argv[argv.indexOf('-b') + 1] ?? '').endsWith('-b'))
  expect(second).toBeDefined()
  const branchB = second![second!.indexOf('-b') + 1]!
  const id = /^oc\/(.+)-b$/.exec(branchB)?.[1] ?? ''
  expect(id).not.toBe('')
  expect(second!.at(-1)).toBe(`oc/${id}-a`)

  const first = adds.find(argv => argv[argv.indexOf('-b') + 1] === `oc/${id}-a`)
  expect(first).toBeDefined()
  expect(first!.at(-1)).toBe('HEAD')
})
