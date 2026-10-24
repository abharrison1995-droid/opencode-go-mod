import { expect, test } from 'claude-code/testing'

import type { ModelHealth, WorkerModel } from '../types'
import { runResilient } from './delegate'
import { ladder } from './ladder'
import { planPreset, presetNamed, presetsFor } from './presets'
import { RUN } from './testkit'

const wm = (id: string, free = true): WorkerModel => ({
  id,
  name: id,
  source: 'go',
  maker: 'Other',
  input: free ? 0 : 1,
  output: free ? 0 : 1,
  efforts: ['low', 'high'],
  maxOutput: 32_000,
  context: 128_000,
})

const health = (ok: number, failed: number): ModelHealth => ({
  ok,
  failed,
  rateLimited: 0,
  hung: 0,
  totalMs: 1000,
  lastAt: Date.now(),
})

const reliable = presetNamed('reliable')!
const strong = presetNamed('strong')!

async function* rateLimited(session = 'ses_1') {
  yield {
    stream: 'stdout',
    text:
      [
        `{"type":"step_start","sessionID":"${session}","part":{"type":"step-start"}}`,
        `{"type":"error","sessionID":"${session}","error":{"message":"429 rate limit reached"}}`,
      ].join('\n') + '\n',
  }
  return { code: 1, signal: null }
}

const ok = async function* () {
  yield { stream: 'stdout', text: RUN + '\n' }
  return { code: 0, signal: null }
}

type Spawner = (argv: string[], n: number) => AsyncGenerator<any, any>

function engine(spawn: Spawner) {
  const spawned: string[][] = []
  const $: any = {
    process: {
      spawn: (request: any) => {
        spawned.push([...request.argv])
        return spawn([...request.argv], spawned.length)
      },
    },
    clock: { sleep: async () => undefined },
  }
  return { $, spawned }
}

test('ladder puts good and unknown free models before the presets', () => {
  const models = [wm('free-good'), wm('free-unknown'), wm('free-shaky'), wm('free-bad')]
  const rungs = ladder(models, {
    'free-good': health(9, 1),
    'free-shaky': health(6, 4),
    'free-bad': health(1, 9),
  })

  expect(rungs.map(r => r.model)).toEqual(['free-good', 'free-unknown', reliable.model, strong.model])
  expect(rungs[0]).toEqual({ model: 'free-good', effort: 'high', retries: 1 })
  expect(rungs[1]).toEqual({ model: 'free-unknown', effort: 'high', retries: 1 })
  expect(rungs[2]!.retries).toBeUndefined()
  expect(rungs[3]!.retries).toBeUndefined()
})

test('ladder keeps at most two free rungs, best first', () => {
  const models = [wm('free-a'), wm('free-b'), wm('free-c')]
  const rungs = ladder(models, {
    'free-a': health(7, 3),
    'free-b': health(19, 1),
    'free-c': health(9, 1),
  })

  expect(rungs.map(r => r.model)).toEqual(['free-b', 'free-c', reliable.model, strong.model])
})

test('an empty catalog leaves just the two presets', () => {
  expect(ladder([], {})).toEqual([
    { model: reliable.model, effort: reliable.effort },
    { model: strong.model, effort: strong.effort },
  ])
})

test('a rate-limited free model climbs to the next rung and stops at the first ok', async () => {
  const { $, spawned } = engine((_argv, n) => (n === 1 ? rateLimited() : ok()))

  const outcome = await runResilient(
    $,
    {
      bin: '/usr/bin/opencode',
      model: 'opencode/free-a',
      fallbacks: [
        { model: 'opencode-go/beam-free', level: 'high', retries: 1 },
        { model: 'opencode-go/kimi-k3', level: 'max' },
      ],
      level: 'low',
      prompt: 'work',
      cwd: '/proj',
      retries: 0,
      stallMs: 0,
      verifyRounds: 0,
    },
    () => undefined,
  )

  expect(outcome.reason).toBe('ok')
  expect(spawned.length).toBe(2)
  const rung = spawned[1]!
  expect(rung[rung.indexOf('-m') + 1]).toBe('opencode-go/beam-free')
  expect(rung[rung.indexOf('--variant') + 1]).toBe('high')
})

test('firstRetries 1 limits the starting model to one retry', async () => {
  const { $, spawned } = engine((_argv, n) => (n <= 2 ? rateLimited(`ses_${n}`) : ok()))

  const outcome = await runResilient(
    $,
    {
      bin: '/usr/bin/opencode',
      model: 'opencode-go/kimi-k3',
      fallbacks: [{ model: 'opencode-go/beam-free', level: 'high', retries: 0 }],
      level: 'high',
      prompt: 'work',
      cwd: '/proj',
      retries: 3,
      firstRetries: 1,
      stallMs: 0,
      verifyRounds: 0,
    },
    () => undefined,
  )

  expect(outcome.reason).toBe('ok')
  expect(outcome.attempts).toBe(3)
  expect(spawned.length).toBe(3)
  expect(spawned[0]![spawned[0]!.indexOf('-m') + 1]).toBe('opencode-go/kimi-k3')
  expect(spawned[1]![spawned[1]!.indexOf('-m') + 1]).toBe('opencode-go/kimi-k3')
  expect(spawned[2]![spawned[2]!.indexOf('-m') + 1]).toBe('opencode-go/beam-free')
})

const zai = (id: string): WorkerModel => ({ ...wm(id), source: 'zai' })

test('planPreset picks GLM-5.3 from the Z.AI Coding Plan, and none without it', () => {
  expect(planPreset([wm('opencode-go/beam-free')])).toBeUndefined()
  expect(planPreset([zai('zai-coding-plan/glm-5.3-flash'), zai('zai-coding-plan/glm-5.3')])?.model).toBe('zai-coding-plan/glm-5.3')
  expect(planPreset([zai('zhipuai-coding-plan/glm-5.3-flash')])?.model).toBe('zhipuai-coding-plan/glm-5.3-flash')
  expect(presetsFor([wm('opencode-go/beam-free')]).map(p => p.name)).toEqual(['cheap', 'reliable', 'strong'])
  expect(presetsFor([zai('zai-coding-plan/glm-5.3')]).map(p => p.name)).toEqual(['cheap', 'reliable', 'strong', 'plan'])
})

test('the ladder climbs through the Z.AI Coding Plan between free and paid models', () => {
  const models = [wm('opencode-go/beam-free'), zai('zai-coding-plan/glm-5.3')]
  expect(ladder(models, {}).map(r => r.model)).toEqual(['opencode-go/beam-free', 'zai-coding-plan/glm-5.3', reliable.model, strong.model])
})

test('the ladder skips the Z.AI Coding Plan when its quota is used up or it keeps failing', () => {
  const models = [wm('opencode-go/beam-free'), zai('zai-coding-plan/glm-5.3')]
  expect(ladder(models, {}, false).map(r => r.model)).toEqual(['opencode-go/beam-free', reliable.model, strong.model])
  expect(ladder(models, { 'zai-coding-plan/glm-5.3': health(0, 10) }).map(r => r.model)).not.toContain('zai-coding-plan/glm-5.3')
})
