import { expect, test } from 'claude-code/testing'

import { setupText } from './commands'
import { colorOf, costsMoney, isFree, isPlan, MAKER_COLORS, parseModels, worker } from './catalog'

test('colorOf is blue for a DeepSeek id', async () => {
  expect(colorOf('opencode/deepseek-v4.1-flash-free')).toBe('#4D7CFE')
  expect(colorOf('opencode-go/deepseek-v4.1-flash')).toBe(MAKER_COLORS.DeepSeek)
})

test('colorOf is purple for a GLM id', async () => {
  expect(colorOf('opencode-go/glm-5.3-flash')).toBe('#A06CF0')
})

test('colorOf is the subtle theme key for an unknown maker', async () => {
  expect(colorOf('opencode-go/grok-4')).toBe('subtle')
  expect(colorOf('opencode-go/no-such-model')).toBe('subtle')
})

const json = (name: string) => JSON.stringify({ name, status: 'active', cost: { input: 0, output: 0 }, limit: { output: 131072, context: 1000000 } })
const LISTED = [
  `opencode-go/kimi-k3\n${JSON.stringify({ name: 'Kimi K3', cost: { input: 3, output: 15 } })}`,
  `opencode/big-pickle\n${json('Big Pickle')}`,
  `zai-coding-plan/glm-5.3\n${json('GLM-5.3')}`,
  `zhipuai-coding-plan/glm-5.3-flash\n${json('GLM-5.3 Flash')}`,
].join('\n')

test('parseModels reads Z.AI Coding Plan models as the zai source', async () => {
  const models = parseModels(LISTED)
  expect(models.map(m => [m.id, m.source])).toEqual([
    ['opencode-go/kimi-k3', 'go'],
    ['opencode/big-pickle', 'zen'],
    ['zai-coding-plan/glm-5.3', 'zai'],
    ['zhipuai-coding-plan/glm-5.3-flash', 'zai'],
  ])
  expect(models[2]?.maker).toBe('Z.ai')
})

test('worker lists Z.AI Coding Plan models in their own section, not as free', async () => {
  const { free, paid, plan } = worker(parseModels(LISTED))
  expect(free.map(m => m.id)).toEqual(['opencode/big-pickle'])
  expect(paid.map(m => m.id)).toEqual(['opencode-go/kimi-k3'])
  expect(plan.map(m => m.id)).toEqual(['zai-coding-plan/glm-5.3', 'zhipuai-coding-plan/glm-5.3-flash'])
})

test('a Z.AI Coding Plan model is not free and costs no money', async () => {
  const [kimi, pickle, glm] = parseModels(LISTED)
  expect(isPlan(glm!)).toBe(true)
  expect(isFree(glm!)).toBe(false)
  expect(costsMoney(glm!)).toBe(false)
  expect(costsMoney(kimi!)).toBe(true)
  expect(costsMoney(pickle!)).toBe(false)
})

test('setupText gives the install command for the models folder', async () => {
  expect(setupText('/mod', '/home/a/local-models')).toContain('/mod/scripts/setup-local.sh --dir /home/a/local-models')
  expect(setupText('/mod', '/m', 'kev')).toContain('--dir /m --only kev')
})
