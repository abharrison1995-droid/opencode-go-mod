import { expect, test } from 'claude-code/testing'

import { reviewTask } from './review'

type RunCall = { argv: string[] }
type SpawnCall = { argv: string[]; cwd?: string }

type Options = {
  stat?: string
  diff?: string
  spawn?: (n: number) => AsyncGenerator<any, any>
}

const plain = (stdout: string, exitCode = 0, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const reply = (text: string, cost = 0, code = 0) =>
  (async function* () {
    yield {
      stream: 'stdout',
      text:
        [
          '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}',
          JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text } }),
          `{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","cost":${cost}}}`,
        ].join('\n') + '\n',
    }
    return { value: { code, signal: null } }
  })()

function fakeEngine(o: Options = {}) {
  const runs: RunCall[] = []
  const spawned: SpawnCall[] = []
  let calls = 0
  const $: any = {
    process: {
      run: async (argv: string[]) => {
        runs.push({ argv: [...argv] })
        if (argv.includes('--stat')) return plain(o.stat ?? 'src/a.ts | 1 +\n')
        return plain(o.diff ?? 'diff --git a/src/a.ts b/src/a.ts\n+done\n')
      },
      spawn: (request: any) => {
        calls++
        spawned.push({ argv: [...request.argv], cwd: request.cwd })
        const inner =
          o.spawn?.(calls) ??
          (async function* () {
            yield { stream: 'stdout', text: '' }
            return { value: { code: 0, signal: null } }
          })()
        return (async function* () {
          const finale = yield* inner
          return finale !== null && typeof finale === 'object' && 'value' in finale ? finale.value : finale
        })()
      },
    },
  }
  return { $, runs, spawned }
}

const options = (over: Record<string, unknown> = {}) => ({
  bin: '/usr/bin/opencode',
  dir: '/proj/worktree',
  base: 'main',
  prompt: 'PRIVATE TASK PROMPT',
  model: 'opencode/deepseek-v4.1-flash-free',
  retries: 0,
  stallMs: 0,
  ...over,
})

test('an OK verdict is reported with the run cost and model', async () => {
  const { $, spawned } = fakeEngine({ spawn: () => reply('VERDICT: OK\n', 0.25) })
  const review = await reviewTask($, options())
  expect(review.verdict).toBe('ok')
  expect(review.notes).toBe('')
  expect(review.cost).toBe(0.25)
  expect(review.model).toBe('opencode/deepseek-v4.1-flash-free')
  expect(spawned.length).toBe(1)
})

test('a CONCERNS verdict keeps the bullets after the verdict line', async () => {
  const { $ } = fakeEngine({ spawn: () => reply('VERDICT: CONCERNS\n- src/a.ts:12 leaves the value unset\n- no test for the new branch\n') })
  const review = await reviewTask($, options())
  expect(review.verdict).toBe('concerns')
  expect(review.notes).toBe('- src/a.ts:12 leaves the value unset\n- no test for the new branch')
})

test('an empty diff returns concerns without spawning a worker', async () => {
  const { $, runs, spawned } = fakeEngine({ stat: '', diff: '' })
  const review = await reviewTask($, options())
  expect(review).toEqual({ verdict: 'concerns', notes: 'The task changed nothing.', cost: 0, model: 'opencode/deepseek-v4.1-flash-free' })
  expect(spawned.length).toBe(0)
  expect(runs.map(call => call.argv)).toEqual([
    ['git', '-C', '/proj/worktree', 'diff', '--stat', 'main...HEAD'],
    ['git', '-C', '/proj/worktree', 'diff', 'main...HEAD'],
  ])
})

test('an answer without a verdict line is an error', async () => {
  const { $ } = fakeEngine({ spawn: () => reply('looks fine to me\n') })
  const review = await reviewTask($, options())
  expect(review.verdict).toBe('error')
  expect(review.notes).toBe('looks fine to me')
})

test('the worker runs read-only with the task prompt and the diff', async () => {
  const { $, spawned } = fakeEngine({ spawn: () => reply('VERDICT: OK\n') })
  await reviewTask($, options())
  const call = spawned[0]
  expect(call.cwd).toBe('/proj/worktree')
  expect(call.argv[call.argv.indexOf('--agent') + 1]).toBe('plan')
  const prompt = call.argv.at(-1) ?? ''
  expect(prompt).toContain('PRIVATE TASK PROMPT')
  expect(prompt).toContain('+done')
})

test('a long diff is cut at 40000 characters', async () => {
  const { $, spawned } = fakeEngine({ stat: '', diff: 'x'.repeat(45_000), spawn: () => reply('VERDICT: OK\n') })
  await reviewTask($, options())
  const prompt = spawned[0].argv.at(-1) ?? ''
  expect(prompt).toContain('x'.repeat(40_000))
  expect(prompt).toContain('cut')
  expect(prompt).not.toContain('x'.repeat(40_001))
})
