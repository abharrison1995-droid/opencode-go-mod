import { expect, test } from 'claude-code/testing'

import type { Job, WorkerModel } from '../types'
import { diffText, historyText, matchJob, matchModel, parseArgs } from './commands'

const m = (id: string, name: string) => ({ id, name }) as WorkerModel
const full = (id: string) => (id.includes('/') ? id : `opencode-go/${id}`)
const job = (id: string) => ({ id, model: 'opencode-go/kimi-k3', steps: 0 }) as Job

test('parseArgs splits the subcommand from the rest', () => {
  expect(parseArgs('  Model   kimi k3 ')).toEqual({ sub: 'model', rest: 'kimi k3' })
  expect(parseArgs('')).toEqual({ sub: '', rest: '' })
})

test('matchModel finds one model by id, bare id or part of its name', () => {
  const list = [m('opencode-go/kimi-k3', 'Kimi K3'), m('opencode-go/kimi-k2.7-code', 'Kimi K2.7 Code'), m('opencode/beam-free', 'Beam Free')]
  expect(matchModel(list, 'kimi-k3', full)).toEqual({ model: list[0]! })
  expect(matchModel(list, 'beam', full)).toEqual({ model: list[2]! })
  expect(matchModel(list, 'kimi', full)).toEqual({ text: 'Several match: opencode-go/kimi-k3, opencode-go/kimi-k2.7-code' })
  expect(matchModel(list, 'gpt', full)).toEqual({ text: 'No model matches "gpt". Try /opencode models.' })
})

test('matchModel lists at most eight matches', () => {
  const list = Array.from({ length: 9 }, (_, i) => m(`opencode-go/m${i}`, `M${i}`))
  const found = matchModel(list, 'm', full)
  expect('text' in found && found.text.endsWith('opencode-go/m7 …')).toBe(true)
})

test('matchJob takes an exact id over a prefix', () => {
  const list = [job('j1'), job('j12')]
  expect(matchJob(list, 'j1')).toEqual({ job: list[0]! })
  expect(matchJob([job('j12'), job('j13')], 'j1')).toEqual({ text: 'Several jobs match: j12, j13' })
  expect(matchJob(list, 'x')).toEqual({ text: 'Nothing matches "x".' })
})

test('diffText shows the first 200 lines', () => {
  const long = Array.from({ length: 205 }, (_, i) => `line ${i}`).join('\n')
  expect(diffText(long).split('\n').length).toBe(201)
  expect(diffText(long).endsWith('… 5 more lines')).toBe(true)
  expect(diffText('a\nb')).toBe('a\nb')
})

test('historyText says when nothing has finished', () => {
  expect(historyText([], {})).toBe('No finished batches yet.')
  expect(historyText([], { 'opencode-go/kimi-k3': 1.5 })).toBe('No finished batches yet.\n\nSpend by model:\nkimi-k3 $1.50')
})
