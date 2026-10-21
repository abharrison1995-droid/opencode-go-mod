import type { EngineInterface } from 'claude-code'

import { runOpencode } from './delegate'

export type Check = { name: string; ok: boolean; detail: string }

const VERSION_TIMEOUT = 15_000

async function ignoreRun() {}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

function eventLine(value: unknown): string {
  return JSON.stringify(value)
}

async function guard(name: string, run: () => Promise<{ ok: boolean; detail: string }>): Promise<Check> {
  try {
    const outcome = await run()
    return { name, ok: outcome.ok, detail: outcome.detail }
  } catch (err) {
    return { name, ok: false, detail: message(err) }
  }
}

function version(result: { exitCode: number; stdout: string; stderr: string }): string {
  return result.stdout.trim() || result.stderr.trim() || `exit ${result.exitCode}`
}

// `/opencode selftest`: proves on this machine what tests can only fake.
export async function selfTest($: EngineInterface, o: { bin?: string; dir: string }): Promise<Check[]> {
  const checks: Check[] = []

  checks.push(
    await guard('opencode CLI', async () => {
      if (o.bin === undefined) return { ok: false, detail: 'not found on PATH' }
      const result = await $.process.run([o.bin, '--version'], { timeoutMs: VERSION_TIMEOUT })
      return { ok: result.exitCode === 0, detail: version(result) }
    }),
  )

  checks.push(
    await guard('git', async () => {
      const result = await $.process.run(['git', '--version'], { timeoutMs: VERSION_TIMEOUT })
      return { ok: result.exitCode === 0, detail: version(result) }
    }),
  )

  checks.push(
    await guard('hang watchdog', async () => {
      const started = Date.now()
      const result = await runOpencode($, ['sh', '-c', 'sleep 30'], o.dir, ignoreRun, { stallMs: 2000 })
      const seconds = (Date.now() - started) / 1000
      return { ok: result.reason === 'hung' && seconds < 10, detail: `${result.reason} in ${seconds.toFixed(1)}s` }
    }),
  )

  checks.push(
    await guard('rate-limit detection', async () => {
      const event = eventLine({ type: 'error', error: { data: { message: '429 Too Many Requests' } } })
      const result = await runOpencode($, ['sh', '-c', `printf '%s\\n' ${shQuote(event)}; exit 1`], o.dir, ignoreRun, { stallMs: VERSION_TIMEOUT })
      return { ok: result.reason === 'rate-limited', detail: result.reason }
    }),
  )

  checks.push(
    await guard('normal run', async () => {
      const text = eventLine({ type: 'text', part: { type: 'text', text: 'self-test text' } })
      const finish = eventLine({ type: 'step_finish', part: { type: 'step-finish', cost: 0.001 } })
      const result = await runOpencode($, ['sh', '-c', `printf '%s\\n' ${shQuote(text)} ${shQuote(finish)}; exit 0`], o.dir, ignoreRun, {
        stallMs: VERSION_TIMEOUT,
      })
      return {
        ok: result.reason === 'ok' && result.run.text.trim() !== '',
        detail: `${result.reason}: ${result.run.text.trim() || '(no text)'}`,
      }
    }),
  )

  checks.push(
    await guard('notification', async () => {
      const sent = await $.ui.notify('OpenCode self-test: notifications work', { title: 'OpenCode' })
      const detail = JSON.stringify(sent) ?? String(sent)
      return { ok: true, detail: detail.slice(0, 200) }
    }),
  )

  checks.push(
    await guard('report folder', async () => {
      const folder = o.dir.replace(/\/+$/, '')
      const path = `${folder}/.opencode/reports/selftest.md`
      await $.fs.write(path, formatChecks(checks))
      await $.fs.write(`${folder}/.opencode/reports/.gitignore`, '*\n')
      return { ok: true, detail: path }
    }),
  )

  return checks
}

export function formatChecks(checks: Check[]): string {
  if (checks.length === 0) return ['Self-test: no checks ran.', '0/0 checks passed'].join('\n')
  const passed = checks.filter(c => c.ok).length
  return [...checks.map(c => `${c.ok ? '✓' : '✕'} ${c.name}: ${c.detail}`), `${passed}/${checks.length} checks passed`].join('\n')
}
