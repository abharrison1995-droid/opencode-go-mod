import { expect, test } from 'claude-code/testing'

import { colorOf, MAKER_COLORS } from './catalog'

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
