import type { EngineInterface } from 'claude-code'

import type { WorkerModel } from '../types'
import { runOpencode } from './delegate'
import { LOCAL, ping } from './local'
import type { LocalOptions, LocalSpec } from './local'

/** skipped: an optional part that is not set up here, counted neither as passed nor failed. */
export type Check = { name: string; ok: boolean; detail: string; skipped?: boolean }

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

async function guard(name: string, run: () => Promise<{ ok: boolean; detail: string; skipped?: boolean }>): Promise<Check> {
  try {
    const outcome = await run()
    return { name, ok: outcome.ok, detail: outcome.detail, ...(outcome.skipped ? { skipped: true } : {}) }
  } catch (err) {
    return { name, ok: false, detail: message(err) }
  }
}

function version(result: { exitCode: number; stdout: string; stderr: string }): string {
  return result.stdout.trim() || result.stderr.trim() || `exit ${result.exitCode}`
}

export function sourcesCheck(models: WorkerModel[]): Check {
  const count = (source: WorkerModel['source']) => models.filter(m => m.source === source).length
  const go = count('go')
  const zen = count('zen')
  if (go + zen === 0) return { name: 'model sources', ok: false, detail: 'opencode lists no Go or Zen models: run opencode auth login' }
  return { name: 'model sources', ok: true, detail: `Go ${go} · Zen ${zen} · Z.AI ${count('zai')}` }
}

export function zaiCheck(models: WorkerModel[]): Check {
  const plan = models.filter(m => m.source === 'zai').length
  return plan > 0
    ? { name: 'Z.AI Coding Plan', ok: true, detail: `${plan} models` }
    : { name: 'Z.AI Coding Plan', ok: true, skipped: true, detail: 'not connected: run opencode auth login and pick Z.AI Coding Plan' }
}

async function localCheck($: EngineInterface, spec: LocalSpec, opts: LocalOptions): Promise<Check> {
  const bin = spec.argv(opts.dir, opts)[0] ?? ''
  if ((await $.fs.stat(bin).catch(() => undefined)) === undefined) {
    return { name: spec.label, ok: true, skipped: true, detail: `not installed (${bin} missing): run scripts/setup-local.sh` }
  }
  return (await ping($, spec))
    ? { name: spec.label, ok: true, detail: `running on :${spec.port}` }
    : { name: spec.label, ok: true, detail: 'installed, not running (starts on the first decide call)' }
}

// `/opencode selftest`: proves on this machine what tests can only fake. models and local add
// the checks for what opencode can reach and for the local decision models.
export async function selfTest($: EngineInterface, o: { bin?: string; dir: string; models?: WorkerModel[]; local?: LocalOptions }): Promise<Check[]> {
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
      const sent: unknown = await $.ui.notify('OpenCode self-test: notifications work', { title: 'OpenCode' })
      // The host answers { isSent: false, reason } when no channel sent it. Notifications reach only a
      // terminal, so no-surface (the desktop app, a phone) is expected there; batches toast as well.
      if (typeof sent === 'object' && sent !== null && (sent as { isSent?: unknown }).isSent === false) {
        const why = String((sent as { reason?: unknown }).reason ?? 'unknown')
        if (why === 'no-surface') return { ok: true, detail: 'not used here: notifications reach only a terminal; batches show a toast instead' }
        return { ok: false, detail: `not delivered (${why})${why === 'disabled' ? ': notifications are turned off in Claude Code settings' : ''}` }
      }
      return { ok: true, detail: (JSON.stringify(sent) ?? String(sent)).slice(0, 200) }
    }),
  )

  if (o.models !== undefined) checks.push(sourcesCheck(o.models), zaiCheck(o.models))
  if (o.local !== undefined) {
    const local = o.local
    for (const spec of LOCAL) checks.push(await guard(spec.label, () => localCheck($, spec, local)))
  }

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
  const counted = checks.filter(c => !c.skipped)
  const passed = counted.filter(c => c.ok).length
  const skipped = checks.length - counted.length
  return [
    ...checks.map(c => `${c.skipped ? '·' : c.ok ? '✓' : '✕'} ${c.name}: ${c.detail}`),
    `${passed}/${counted.length} checks passed${skipped > 0 ? `, ${skipped} skipped` : ''}`,
  ].join('\n')
}
