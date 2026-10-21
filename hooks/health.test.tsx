import { expect, test } from 'claude-code/testing'

import { recordRun } from './health'
import type { ModelHealth } from '../types'

const blank = (): ModelHealth => ({ ok: 0, failed: 0, rateLimited: 0, hung: 0, totalMs: 0, lastAt: 0 })

test('ok, failed, rate-limited and hung each increment the right counter', async () => {
  const ok = recordRun({}, 'm', 'ok', 0)
  expect(ok.m?.ok).toBe(1)
  expect(ok.m?.failed).toBe(0)
  expect(ok.m?.rateLimited).toBe(0)
  expect(ok.m?.hung).toBe(0)

  const failed = recordRun({}, 'm', 'failed', 0)
  expect(failed.m?.failed).toBe(1)
  expect(failed.m?.ok).toBe(0)

  const limited = recordRun({}, 'm', 'rate-limited', 0)
  expect(limited.m?.rateLimited).toBe(1)
  expect(limited.m?.failed).toBe(0)

  const hung = recordRun({}, 'm', 'hung', 0)
  expect(hung.m?.hung).toBe(1)
  expect(hung.m?.rateLimited).toBe(0)
})

test('verify and start count as ok', async () => {
  const once = recordRun({}, 'm', 'verify', 0)
  const twice = recordRun(once, 'm', 'start', 0)
  expect(twice.m?.ok).toBe(2)
  expect(twice.m?.failed).toBe(0)
})

test('cancelled returns the same record unchanged', async () => {
  const prev = { m: { ...blank(), ok: 3, failed: 1, totalMs: 900, lastAt: 42, lastError: 'old' } }
  const next = recordRun(prev, 'm', 'cancelled', 500, 'new error')
  expect(next).toBe(prev)
  expect(next).toEqual({ m: { ok: 3, failed: 1, rateLimited: 0, hung: 0, totalMs: 900, lastAt: 42, lastError: 'old' } })
})

test('totalMs accumulates and negative ms counts as zero', async () => {
  const first = recordRun({}, 'm', 'ok', 120)
  expect(first.m?.totalMs).toBe(120)

  const second = recordRun(first, 'm', 'ok', 80)
  expect(second.m?.totalMs).toBe(200)

  const negative = recordRun(second, 'm', 'ok', -50)
  expect(negative.m?.totalMs).toBe(200)
})

test('lastError is set only for non-ok results', async () => {
  const ok = recordRun({}, 'm', 'ok', 0, 'not an error')
  expect(ok.m?.lastError).toBeUndefined()

  const verify = recordRun({}, 'm', 'verify', 0, 'still fine')
  expect(verify.m?.lastError).toBeUndefined()

  const failed = recordRun({}, 'm', 'failed', 0, 'boom')
  expect(failed.m?.lastError).toBe('boom')

  const limited = recordRun({}, 'm', 'rate-limited', 0, '429')
  expect(limited.m?.lastError).toBe('429')

  const hung = recordRun({}, 'm', 'hung', 0, 'no output')
  expect(hung.m?.lastError).toBe('no output')
})

test('lastError is cut to 500 characters and trimmed', async () => {
  const failed = recordRun({}, 'm', 'failed', 0, 'x'.repeat(600))
  expect(failed.m?.lastError?.length).toBe(500)

  const padded = recordRun({}, 'm', 'failed', 0, '  bad  ')
  expect(padded.m?.lastError).toBe('bad')
})

test('the input record is not mutated', async () => {
  const before = { m: { ...blank(), ok: 2, totalMs: 300, lastAt: 10, lastError: 'old' } }
  const snapshot = JSON.parse(JSON.stringify(before))

  const next = recordRun(before, 'm', 'failed', 40, 'new')
  expect(before).toEqual(snapshot)
  expect(before.m).not.toBe(next.m)
  expect(next.m?.failed).toBe(1)
  expect(next.m?.totalMs).toBe(340)
})

test('adding a 61st model drops the one with the oldest lastAt', async () => {
  const prev: Record<string, ModelHealth> = {}
  for (let i = 0; i < 60; i++) prev[`m${i}`] = { ...blank(), lastAt: i + 1 }

  const next = recordRun(prev, 'fresh', 'ok', 0)
  const keys = Object.keys(next)
  expect(keys.length).toBe(60)
  expect(keys).toContain('fresh')
  expect(keys).toContain('m1')
  expect(keys).not.toContain('m0')
})
