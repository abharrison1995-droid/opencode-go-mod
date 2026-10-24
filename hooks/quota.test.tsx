import { expect, test } from 'claude-code/testing'

import { readEvent } from './delegate'
import { planCalls, prune, quotaMessage, quotaText, resetAt, usedIn, WINDOW_MS } from './quota'

const NOW = 1_800_000_000_000

test('usedIn counts only the calls of the last 5 hours', () => {
  const uses = [
    { at: NOW - WINDOW_MS - 1, calls: 50 },
    { at: NOW - 60_000, calls: 7 },
    { at: NOW, calls: 3 },
  ]
  expect(prune(uses, NOW).length).toBe(2)
  expect(usedIn(uses, NOW)).toBe(10)
  expect(resetAt(uses, NOW)).toBe(NOW - 60_000 + WINDOW_MS)
  expect(resetAt([], NOW)).toBeUndefined()
})

test('planCalls sums plan models only', () => {
  expect(planCalls({ 'zai-coding-plan/glm-5.3': 4, 'opencode-go/kimi-k3': 9, 'zhipuai-coding-plan/glm-5.3-flash': 2 })).toBe(6)
  expect(planCalls(undefined)).toBe(0)
})

test('quotaText shows the limit only when one is set', () => {
  const uses = [{ at: NOW, calls: 12 }]
  expect(quotaText(uses, 0, NOW)).toBe('12 model calls in the last 5 h')
  expect(quotaText(uses, 100, NOW)).toBe('12/100 model calls in the last 5 h')
  expect(quotaMessage(100, 100, undefined)).toContain('100/100 model calls')
})

test('readEvent counts a model call per step_finish', () => {
  const run = { text: '', tools: [], errors: [], cost: 0 }
  readEvent(run, '{"type":"step_finish","part":{"type":"step-finish","cost":0}}')
  readEvent(run, '{"type":"step_finish","part":{"type":"step-finish","cost":0.01}}')
  expect((run as any).steps).toBe(2)
})
