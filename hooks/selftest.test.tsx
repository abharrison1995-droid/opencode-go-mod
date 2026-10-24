import { expect, test } from 'claude-code/testing'

import { formatChecks, selfTest, sourcesCheck, zaiCheck } from './selftest'

type RunCall = { argv: string[]; init?: any }
type WriteCall = { path: string; text: string }

type Options = {
  run?: (argv: string[], init?: any) => any
  spawn?: (argv: string[]) => AsyncGenerator<any, any>
  notify?: () => Promise<any>
  write?: (path: string, text: string) => Promise<unknown> | unknown
}

const plain = (stdout = '', exitCode = 0, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

async function* scripted(argv: string[]) {
  const script = argv[2] ?? ''
  if (script.includes('sleep 30')) {
    await new Promise(() => undefined)
  }
  if (script.includes('429 Too Many Requests')) {
    yield {
      stream: 'stdout',
      text: `${JSON.stringify({ type: 'error', error: { data: { message: '429 Too Many Requests' } } })}\n`,
    }
    return { code: 1, signal: null }
  }
  yield { stream: 'stdout', text: '{"type":"text","part":{"type":"text","text":"self-test"}}\n' }
  yield { stream: 'stdout', text: '{"type":"step_finish","part":{"type":"step-finish","cost":0.001}}\n' }
  return { code: 0, signal: null }
}

async function* instant() {
  return { code: 0, signal: null }
}

function fakeEngine(o: Options = {}) {
  const runs: RunCall[] = []
  const writes: WriteCall[] = []
  const notified: string[] = []
  const $: any = {
    process: {
      run: async (argv: string[], init?: any) => {
        runs.push({ argv: [...argv], init })
        if (o.run !== undefined) return o.run(argv, init)
        if (argv[0] === 'git') return plain('git version 2.43.0\n')
        return plain('1.2.3\n')
      },
      spawn: (request: any) => {
        if (o.spawn !== undefined) return o.spawn(request.argv)
        return scripted(request.argv)
      },
    },
    ui: {
      notify: async (text: string) => {
        notified.push(text)
        if (o.notify !== undefined) return o.notify()
        return { isSent: true, channel: 'terminal_bell' }
      },
    },
    fs: {
      write: async (path: string, text: string) => {
        writes.push({ path, text })
        if (o.write !== undefined) return o.write(path, text)
        return { bytes: text.length }
      },
    },
  }
  return { $, runs, writes, notified }
}

const names = ['opencode CLI', 'git', 'hang watchdog', 'rate-limit detection', 'normal run', 'notification', 'report folder']
const ended = (argv: string[]) => (argv[2]?.includes('sleep 30') ? instant() : scripted(argv))

test('every check passes', async () => {
  const fake = fakeEngine()
  const checks = await selfTest(fake.$, { bin: '/usr/bin/opencode', dir: '/proj' })

  expect(checks.map(c => c.name)).toEqual(names)
  expect(checks.every(c => c.ok)).toBe(true)
  expect(fake.runs[0]!.argv).toEqual(['/usr/bin/opencode', '--version'])
  expect(fake.runs[0]!.init.timeoutMs).toBe(15000)
  expect(fake.runs[1]!.argv).toEqual(['git', '--version'])
  expect(fake.notified).toEqual(['OpenCode self-test: notifications work'])
  expect(fake.writes.map(w => w.path)).toEqual(['/proj/.opencode/reports/selftest.md', '/proj/.opencode/reports/.gitignore'])
  expect(fake.writes[1]!.text).toBe('*\n')
  expect(fake.writes[0]!.text).toContain('6/6 checks passed')
})

test('a missing opencode CLI fails its check without running the binary', async () => {
  const fake = fakeEngine({ spawn: ended })
  const checks = await selfTest(fake.$, { bin: undefined, dir: '/proj' })

  expect(checks[0]!.name).toBe('opencode CLI')
  expect(checks[0]!.ok).toBe(false)
  expect(checks[0]!.detail).toBe('not found on PATH')
  expect(fake.runs.some(r => r.argv[0] === '/usr/bin/opencode')).toBe(false)
  expect(checks[1]!.ok).toBe(true)
})

test('the hang check fails when the spawn ends at once with code 0', async () => {
  const fake = fakeEngine({ spawn: ended })
  const checks = await selfTest(fake.$, { bin: '/usr/bin/opencode', dir: '/proj' })

  expect(checks[2]!.name).toBe('hang watchdog')
  expect(checks[2]!.ok).toBe(false)
  expect(checks[2]!.detail).toContain('ok')
  expect(checks[2]!.detail).toMatch(/\d+\.\d+s$/)
})

test('a rejected notification is a failed check, not a throw', async () => {
  const fake = fakeEngine({ notify: () => Promise.reject(new Error('no surface')) })
  const checks = await selfTest(fake.$, { bin: '/usr/bin/opencode', dir: '/proj' })

  expect(checks.length).toBe(7)
  expect(checks[5]!.name).toBe('notification')
  expect(checks[5]!.ok).toBe(false)
  expect(checks[5]!.detail).toContain('no surface')
})

test('no terminal to notify (desktop, phone) passes with a note', async () => {
  const fake = fakeEngine({ notify: async () => ({ isSent: false, reason: 'no-surface' }) })
  const checks = await selfTest(fake.$, { bin: '/usr/bin/opencode', dir: '/proj' })

  expect(checks[5]!.ok).toBe(true)
  expect(checks[5]!.detail).toContain('only a terminal')
})

test('notifications turned off is a failed check', async () => {
  const fake = fakeEngine({ notify: async () => ({ isSent: false, reason: 'disabled' }) })
  const checks = await selfTest(fake.$, { bin: '/usr/bin/opencode', dir: '/proj' })

  expect(checks[5]!.ok).toBe(false)
  expect(checks[5]!.detail).toContain('not delivered (disabled)')
})

test('formatChecks ends with the pass summary', () => {
  const text = formatChecks([
    { name: 'first', ok: true, detail: 'yes' },
    { name: 'second', ok: false, detail: 'no' },
  ])

  expect(text).toContain('✓ first: yes')
  expect(text).toContain('✕ second: no')
  expect(text.split('\n').at(-1)).toBe('1/2 checks passed')
})

const worker = (id: string, source: 'go' | 'zen' | 'zai') => ({ id, name: id, source, maker: 'Other', input: 0, output: 0, efforts: [], maxOutput: 32000, context: 128000 })
const LOCAL_OPTS = { dir: '/models', kevRun: 'jaredpalmer/kev-0.8b', device: 'auto', layaDevice: 'cpu', kevGpuGb: 0, root: '/mod' }

test('sourcesCheck counts each source and fails with no Go or Zen model', () => {
  expect(sourcesCheck([worker('opencode-go/a', 'go'), worker('opencode/b', 'zen'), worker('zai-coding-plan/c', 'zai')])).toEqual({
    name: 'model sources',
    ok: true,
    detail: 'Go 1 · Zen 1 · Z.AI 1',
  })
  expect(sourcesCheck([worker('zai-coding-plan/c', 'zai')]).ok).toBe(false)
})

test('zaiCheck is skipped, not failed, without the Coding Plan', () => {
  expect(zaiCheck([worker('opencode-go/a', 'go')])).toMatchObject({ ok: true, skipped: true })
  expect(zaiCheck([worker('zai-coding-plan/c', 'zai')])).toEqual({ name: 'Z.AI Coding Plan', ok: true, detail: '1 models' })
})

test('local models are skipped when not installed and reported when running', async () => {
  const fake = fakeEngine({ spawn: ended })
  fake.$.fs.stat = async (path: string) => {
    if (path === '/models/kev/.venv/bin/python') return { size: 1 }
    throw new Error('ENOENT')
  }
  fake.$.http = { fetch: async (url: string) => ({ ok: url.includes(':8009') }) }
  const checks = await selfTest(fake.$, { bin: '/usr/bin/opencode', dir: '/proj', models: [worker('opencode-go/a', 'go')], local: LOCAL_OPTS })

  expect(checks.map(c => c.name)).toEqual([...names.slice(0, 6), 'model sources', 'Z.AI Coding Plan', 'Kev', 'Laya', 'report folder'])
  expect(checks[8]).toEqual({ name: 'Kev', ok: true, detail: 'running on :8009' })
  expect(checks[9]).toMatchObject({ name: 'Laya', skipped: true })
  expect(checks[9]!.detail).toContain('/models/laya-env/bin/laya-serve')
})

test('formatChecks leaves skipped checks out of the count', () => {
  const text = formatChecks([
    { name: 'first', ok: true, detail: 'yes' },
    { name: 'extra', ok: true, skipped: true, detail: 'not set up' },
  ])
  expect(text).toContain('· extra: not set up')
  expect(text.split('\n').at(-1)).toBe('1/1 checks passed, 1 skipped')
})
