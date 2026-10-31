import { expect, test } from 'claude-code/testing'

import {
  agyArgv,
  agyModelArg,
  checkPrompt,
  conversationIn,
  geminiChecker,
  parseAgyModels,
  parseAgyResponse,
  parsePlan,
  planPrompt,
} from './gemini'
import { geminiPreset, presetsFor } from './presets'
import { ladder } from './ladder'

const AGY_OUT =
  'Fetching available models...\n' +
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)\n' +
  'gemini-4-argon-high\tGemini 4 Argon (High)\n' +
  'gemini-4-argon-low\tGemini 4 Argon (Low)\n' +
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' +
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n' +
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)\n' +
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'

const wm = (
  id: string,
  o: {
    source?: 'go' | 'zen' | 'zai' | 'gemini'
    maker?: string
    input?: number
    output?: number
    efforts?: string[]
    context?: number
  } = {},
) => ({
  id,
  name: id,
  source: o.source ?? 'go',
  maker: o.maker ?? 'Other',
  input: o.input ?? 0,
  output: o.output ?? 0,
  efforts: o.efforts ?? ['low', 'high'],
  maxOutput: 32_000,
  context: o.context ?? 128_000,
})

test('parseAgyModels groups levels into one model per id', () => {
  const models = parseAgyModels(AGY_OUT)

  expect(models.map(m => m.id)).toEqual([
    'agy/gemini-4-argon',
    'agy/gemini-3.8-flash',
    'agy/claude-opus-5-5',
    'agy/gpt-oss-120b',
  ])
  expect(models.map(m => m.name)).toEqual(['Gemini 4 Argon', 'Gemini 3.8 Flash', 'Claude Opus 5.5', 'GPT-OSS 120B'])
  expect(models.map(m => m.efforts)).toEqual([['low', 'medium', 'high'], ['low', 'high'], ['low'], ['medium']])
  expect(models.map(m => m.source)).toEqual(['gemini', 'gemini', 'gemini', 'gemini'])
  expect(models.map(m => m.maker)).toEqual(['Google', 'Google', 'Anthropic', 'OpenAI'])
  expect(models.map(m => m.context)).toEqual([1_000_000, 1_000_000, 200_000, 200_000])
})

test('parseAgyModels ignores the fetching line and an empty list', () => {
  expect(parseAgyModels('Fetching available models...\n')).toEqual([])
  expect(parseAgyModels('')).toEqual([])
})

test('agyModelArg appends an offered level, defaulting to medium', () => {
  expect(agyModelArg('agy/gemini-4-argon', 'high')).toBe('gemini-4-argon-high')
  expect(agyModelArg('agy/gemini-4-argon')).toBe('gemini-4-argon-medium')
  expect(agyModelArg('agy/gemini-4-argon', 'xhigh')).toBe('gemini-4-argon-high')
  expect(agyModelArg('agy/gemini-4-argon', 'max')).toBe('gemini-4-argon-high')
  expect(agyModelArg('agy/gemini-4-argon', 'turbo')).toBe('gemini-4-argon-medium')
})

test('agyArgv builds the headless command', () => {
  const argv = agyArgv('/bin/agy', { model: 'agy/gemini-4-argon', level: 'high', prompt: 'do the work', logFile: '/tmp/log' })

  expect(argv).toEqual([
    '/bin/agy',
    '--print=do the work',
    '--model',
    'gemini-4-argon-high',
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--sandbox',
    '--print-timeout',
    '30m',
    '--log-file',
    '/tmp/log',
  ])
})

test('agyArgv adds plan mode and the conversation', () => {
  const argv = agyArgv('/bin/agy', {
    model: 'agy/gemini-4-argon',
    prompt: 'check',
    logFile: '/tmp/log',
    readOnly: true,
    sessionId: '31d83eb7-eab3-4e55-b584-dca128317958',
  })

  const mode = argv.indexOf('--mode')
  expect(argv.slice(mode, mode + 2)).toEqual(['--mode', 'plan'])
  const convo = argv.indexOf('--conversation')
  expect(argv.slice(convo, convo + 2)).toEqual(['--conversation', '31d83eb7-eab3-4e55-b584-dca128317958'])
})

test('agyArgv appends files to the prompt', () => {
  const argv = agyArgv('/bin/agy', { model: 'agy/gemini-4-argon', prompt: 'change it', files: ['a', 'b'], logFile: '/tmp/log' })

  expect(argv[1]).toBe('--print=change it\n\nRead these files first: a, b')
})

test('agyArgv keeps a leading-dash prompt inside --print=', () => {
  const argv = agyArgv('/bin/agy', { model: 'agy/gemini-4-argon', prompt: '--not-a-flag', logFile: '/tmp/log' })

  expect(argv[1]).toBe('--print=--not-a-flag')
  expect(argv).not.toContain('--not-a-flag')
})

test('conversationIn finds the uuid agy logged', () => {
  const log = 'I1026 12:27:47.757848  1 server.go:1225] Created conversation 31d83eb7-eab3-4e55-b584-dca128317958 (backend=X)'

  expect(conversationIn(log)).toBe('31d83eb7-eab3-4e55-b584-dca128317958')
  expect(conversationIn('I1026 12:27:47.757848  1 server.go:1225] Starting server')).toBeUndefined()
})

test('geminiChecker prefers Argon with high effort', () => {
  const models = parseAgyModels(AGY_OUT)

  expect(geminiChecker(models)).toEqual({ model: 'agy/gemini-4-argon', effort: 'high' })
})

test('geminiChecker falls back to a non-flash Gemini', () => {
  const models = [
    wm('agy/gemini-3.8-flash', { source: 'gemini', maker: 'Google', efforts: ['high'] }),
    wm('agy/gemini-3.8-pro', { source: 'gemini', maker: 'Google', efforts: ['medium'] }),
  ]

  expect(geminiChecker(models)).toEqual({ model: 'agy/gemini-3.8-pro', effort: 'medium' })
})

test('geminiChecker ignores non-Google agy models and takes no other source', () => {
  expect(geminiChecker([wm('agy/claude-opus-5-5', { source: 'gemini', maker: 'Anthropic' })])).toBeUndefined()
  expect(geminiChecker([wm('opencode-go/kimi-k3')])).toBeUndefined()
  expect(geminiChecker([wm('opencode/beam-free', { source: 'zen' })])).toBeUndefined()
})

test('parsePlan reads a clean JSON plan', () => {
  const plan = parsePlan(
    JSON.stringify({
      summary: 'Ship it',
      tasks: [
        { id: 'read-code', title: 'Read', prompt: 'Read the code', dependsOn: [] },
        { id: 'edit-file', title: 'Edit', prompt: 'Edit it', dependsOn: ['read-code'], verify: 'npm test' },
      ],
    }),
  )

  expect(plan).toEqual({
    summary: 'Ship it',
    tasks: [
      { id: 'read-code', title: 'Read', prompt: 'Read the code', dependsOn: [] },
      { id: 'edit-file', title: 'Edit', prompt: 'Edit it', dependsOn: ['read-code'], verify: 'npm test' },
    ],
  })
})

test('parsePlan tolerates prose and a json fence', () => {
  const json = JSON.stringify({ summary: 'Plan', tasks: [{ id: 'one', title: 'One', prompt: 'do it', dependsOn: [] }] })
  const plan = parsePlan(`Here is the plan:\n\`\`\`json\n${json}\n\`\`\`\nThat is all.`)

  expect(plan).toEqual({ summary: 'Plan', tasks: [{ id: 'one', title: 'One', prompt: 'do it', dependsOn: [] }] })
})

test('parsePlan normalises ids, drops duplicates and bad dependencies', () => {
  const plan = parsePlan(
    JSON.stringify({
      summary: 'Mixed',
      tasks: [
        { id: 'Fix Login!', title: 'Fix', prompt: 'p', dependsOn: ['Edit File', 'fix-login', 'ghost'], verify: '   ' },
        { id: 'Edit File', title: 'Edit', prompt: 'q', dependsOn: ['fix-login', 'edit-file'], verify: ' npm test ' },
        { id: 'Fix Login!', prompt: 'duplicate', dependsOn: [] },
      ],
    }),
  )

  expect(plan).toEqual({
    summary: 'Mixed',
    tasks: [
      { id: 'fix-login', title: 'Fix', prompt: 'p', dependsOn: [] },
      { id: 'edit-file', title: 'Edit', prompt: 'q', dependsOn: ['fix-login'], verify: 'npm test' },
    ],
  })
})

test('parsePlan returns an error string for bad plans', () => {
  expect(typeof parsePlan('no plan here')).toBe('string')
  expect(typeof parsePlan('{"tasks": [}')).toBe('string')
  expect(typeof parsePlan(JSON.stringify({ summary: 'empty', tasks: [] }))).toBe('string')
  expect(
    typeof parsePlan(
      JSON.stringify({
        summary: 'too many',
        tasks: [
          { id: 'a', prompt: 'a', dependsOn: [] },
          { id: 'b', prompt: 'b', dependsOn: [] },
          { id: 'c', prompt: 'c', dependsOn: [] },
        ],
      }),
      2,
    ),
  ).toBe('string')
})

test('planPrompt includes the goal, shared context and verify command', () => {
  const prompt = planPrompt('fix the build', { shared: 'the repo uses pnpm', verify: 'pnpm test', maxTasks: 3 })

  expect(prompt).toContain('fix the build')
  expect(prompt).toContain('the repo uses pnpm')
  expect(prompt).toContain('pnpm test')
})

test('checkPrompt includes the goal, the diff and asks for a verdict', () => {
  const prompt = checkPrompt('make it faster', 'diff --git a/x b/x')

  expect(prompt).toContain('make it faster')
  expect(prompt).toContain('diff --git a/x b/x')
  expect(prompt).toContain('VERDICT: OK')
})

test('presetsFor offers the gemini preset only when agy lists a model', () => {
  const withGemini = presetsFor(parseAgyModels(AGY_OUT))
  const gemini = withGemini.find(p => p.name === 'gemini')

  expect(gemini?.model).toBe('agy/gemini-4-argon')
  expect(gemini?.effort).toBe('high')
  expect(geminiPreset(parseAgyModels(AGY_OUT))?.model).toBe('agy/gemini-4-argon')
  expect(presetsFor([wm('opencode-go/beam-free')]).map(p => p.name)).not.toContain('gemini')
  expect(geminiPreset([wm('opencode-go/beam-free')])).toBeUndefined()
})

test('the ladder puts the gemini rung after the free rungs', () => {
  const models = [wm('opencode-go/beam-free'), ...parseAgyModels(AGY_OUT)]
  const rungs = ladder(models, {})

  expect(rungs[0]?.model).toBe('opencode-go/beam-free')
  expect(rungs[1]?.model).toBe('agy/gemini-4-argon')
  expect(rungs[1]?.effort).toBe('high')
})


test('agy model parser accepts aligned columns as well as tabs', () => {
  const models = parseAgyModels('gemini-3.8-flash-high    Gemini 3.8 Flash (High)\n')
  expect(models.map(m => m.id)).toEqual(['agy/gemini-3.8-flash'])
})

test('agy structured results reject failed statuses and retain useful error text', () => {
  expect(parseAgyResponse(JSON.stringify({ status: 'SUCCESS', response: 'done' })).response).toBe('done')
  const bad = parseAgyResponse(JSON.stringify({ status: 'ERROR', response: 'partial', error: 'quota exceeded' }))
  expect(bad.error).toBe('quota exceeded')
  expect(bad.status).toBe('ERROR')
  expect(parseAgyResponse('not JSON').status).toBe('INVALID')
})
