import { expect, test } from 'claude-code/testing'

import { checkQuestions, formatAnswers, localNamed } from './local'
import type { LocalOptions } from './local'

test('checkQuestions accepts the three question types', async () => {
  expect(
    checkQuestions({
      billing: { type: 'noul', instructions: 'About billing?' },
      team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'charges', shipping: 'delivery' } },
      urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] },
    }),
  ).toBe(undefined)
})

test('checkQuestions names what is wrong', async () => {
  expect(checkQuestions([])).toBe('questions must be an object of name → question.')
  expect(checkQuestions({})).toBe('questions is empty.')
  expect(checkQuestions({ a: { type: 'noul' } })).toBe('a: needs instructions.')
  expect(checkQuestions({ a: { type: 'maybe', instructions: 'x' } })).toBe('a: type must be noul, choice or score.')
  expect(checkQuestions({ a: { type: 'choice', instructions: 'x', criteria: { one: null } } })).toBe('a: a choice needs at least two criteria.')
  expect(checkQuestions({ a: { type: 'score', instructions: 'x', criteria: ['one'] } })).toBe('a: a score needs a criteria list of at least two levels.')
})

test('formatAnswers gives one line per question, top answer first', async () => {
  const text = formatAnswers({
    escalate: { type: 'noul', noul: 0.93 },
    department: { type: 'choice', choice: 'returns', probabilities: { shipping: 0.28, returns: 0.47, billing: 0.25 } },
    frustration: { type: 'score', score: 1.44, legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' }, probabilities: { 0: 0, 1: 0.56, 2: 0.44 } },
  })
  expect(text).toBe(
    'escalate: yes 93%\ndepartment: returns (returns 47%, shipping 28%, billing 25%)\nfrustration: 1.44 ≈ Frustrated (Frustrated 56%, Very angry 44%, Calm 0%)',
  )
})

test('localNamed ignores case', async () => {
  expect(localNamed('Kev')?.port).toBe(8009)
  expect(localNamed('LAYA')?.port).toBe(8010)
  expect(localNamed('other')).toBe(undefined)
})

const opts = (kevGpuGb: number): LocalOptions => ({ dir: '/m', kevRun: 'jaredpalmer/kev-4b', device: 'auto', layaDevice: 'cpu', kevGpuGb, root: '/mod' })

test('Kev runs plain kev.serve with no GPU budget', async () => {
  const kev = localNamed('kev')!
  expect(kev.argv('/m', opts(0))).toEqual(['/m/kev/.venv/bin/python', '-m', 'kev.serve', '--run', 'jaredpalmer/kev-4b', '--port', '8009', '--host', '127.0.0.1', '--device', 'auto'])
  expect(kev.env(opts(0))).toEqual({})
})

test('Kev splits across GPU and RAM through kev_split.py with a budget', async () => {
  const kev = localNamed('kev')!
  expect(kev.argv('/m', opts(4))).toEqual(['/m/kev/.venv/bin/python', '/mod/scripts/kev_split.py', '--run', 'jaredpalmer/kev-4b', '--port', '8009', '--host', '127.0.0.1', '--device', 'cuda'])
  expect(kev.env(opts(4))).toEqual({ KEV_GPU_GB: '4' })
})
