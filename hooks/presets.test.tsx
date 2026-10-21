import { expect, test } from 'claude-code/testing'

import { presetNamed, rate } from './presets'
import type { ModelHealth } from '../types'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

const health = (h: Partial<ModelHealth> = {}): ModelHealth => ({
  ok: 0,
  failed: 0,
  rateLimited: 0,
  hung: 0,
  totalMs: 0,
  lastAt: NOW,
  ...h,
})

test('undefined health is unknown', async () => {
  expect(rate(undefined, NOW)).toBe('unknown')
})

test('zero runs is unknown', async () => {
  expect(rate(health(), NOW)).toBe('unknown')
})

test('under 20% bad is good', async () => {
  expect(rate(health({ ok: 9, failed: 1 }), NOW)).toBe('good')
  expect(rate(health({ ok: 19, rateLimited: 1 }), NOW)).toBe('good')
})

test('20% to 49% bad is shaky', async () => {
  expect(rate(health({ ok: 4, failed: 1 }), NOW)).toBe('shaky')
  expect(rate(health({ ok: 3, hung: 1 }), NOW)).toBe('shaky')
})

test('50% or more bad is bad', async () => {
  expect(rate(health({ ok: 1, failed: 1 }), NOW)).toBe('bad')
  expect(rate(health({ rateLimited: 3 }), NOW)).toBe('bad')
})

test('stale records are good under 50% bad and shaky at or above it', async () => {
  const lastAt = NOW - 7 * HOUR
  expect(rate(health({ ok: 4, failed: 1, lastAt }), NOW)).toBe('good')
  expect(rate(health({ ok: 1, failed: 1, lastAt }), NOW)).toBe('shaky')
  expect(rate(health({ failed: 1, lastAt }), NOW)).toBe('shaky')
})

test('failed, rateLimited and hung all count as bad', async () => {
  expect(rate(health({ failed: 1 }), NOW)).toBe('bad')
  expect(rate(health({ rateLimited: 1 }), NOW)).toBe('bad')
  expect(rate(health({ hung: 1 }), NOW)).toBe('bad')
})

test('presetNamed is case-insensitive and ignores unknown names', async () => {
  expect(presetNamed('CHEAP')?.name).toBe('cheap')
  expect(presetNamed('Reliable')?.name).toBe('reliable')
  expect(presetNamed('STRONG')?.name).toBe('strong')
  expect(presetNamed('missing')).toBeUndefined()
})
