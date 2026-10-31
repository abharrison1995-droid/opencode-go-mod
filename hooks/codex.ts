import type { EngineInterface } from 'claude-code'
import { homeOf, isExe, isWindows, whereAll } from './platform'

export type CodexAccount = 'pro-1' | 'pro-2'
export type CodexRequest = {
  account: CodexAccount
  prompt: string
  cwd: string
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
  readOnly?: boolean
}
export type CodexOutcome = { ok: boolean; answer: string; threadId?: string; error?: string; exitCode: number; account: CodexAccount }

export function accountHome(home: string, account: CodexAccount): string {
  return `${home.replace(/[\\/]+$/, '')}/.codex-profiles/${account}`
}

/** Use real binaries, never the npm .cmd shim that process.run cannot spawn directly. */
export async function findCodex($: EngineInterface): Promise<string | undefined> {
  const matches = await whereAll($, 'codex').catch(() => [])
  if (!(await isWindows($))) return matches[0]
  const exe = matches.find(isExe)
  if (exe) return exe
  const root = await $.env.get('APPDATA')
  const home = await homeOf($)
  const candidates = [
    ...(root ? [`${root}/npm/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe`] : []),
    ...(home ? [`${home}/AppData/Roaming/npm/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe`] : []),
  ]
  for (const path of candidates) if (await $.fs.stat(path).catch(() => undefined)) return path
  return undefined
}

export function codexArgv(bin: string, o: CodexRequest): string[] {
  const argv = [bin, 'exec', '--json', '--sandbox', o.readOnly === false ? 'workspace-write' : 'read-only']
  if (o.model?.trim()) argv.push('-m', o.model.trim())
  if (o.effort) argv.push('-c', `model_reasoning_effort="${o.effort}"`)
  argv.push('-C', o.cwd, o.prompt)
  return argv
}

/** Codex exec JSONL contains lifecycle events and agent messages. Never treat a failed exit as success. */
export function parseCodexEvents(stdout: string): { answer: string; threadId?: string; error?: string; completed: boolean } {
  let answer = ''
  let threadId: string | undefined
  let error: string | undefined
  let completed = false
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event: any
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') answer = event.item.text
    if (event.type === 'turn.completed') completed = true
    if (event.type === 'turn.failed' || event.type === 'error') error = String(event.error?.message ?? event.message ?? 'Codex failed')
  }
  return { answer, ...(threadId ? { threadId } : {}), ...(error ? { error } : {}), completed }
}

export async function runCodex($: EngineInterface, o: CodexRequest): Promise<CodexOutcome> {
  const home = await homeOf($)
  if (!home) return { ok: false, answer: '', account: o.account, exitCode: 1, error: 'Home directory unavailable' }
  const bin = await findCodex($)
  if (!bin) return { ok: false, answer: '', account: o.account, exitCode: 127, error: 'Codex executable missing; install Codex CLI and ensure a native executable is available on PATH' }
  const dir = accountHome(home, o.account)
  const info = await $.fs.stat(dir).catch(() => undefined)
  if (!info) return { ok: false, answer: '', account: o.account, exitCode: 1, error: `Account profile missing: ${dir}. Sign in first with CODEX_HOME set to that profile.` }
  try {
    const result = await $.process.run(codexArgv(bin, o), { cwd: o.cwd, env: { CODEX_HOME: dir }, timeoutMs: 1_800_000 })
    const parsed = parseCodexEvents(result.stdout)
    const ok = result.exitCode === 0 && parsed.completed && !parsed.error
    return { ok, answer: parsed.answer, threadId: parsed.threadId, exitCode: result.exitCode, account: o.account,
      ...(!ok ? { error: parsed.error ?? result.stderr.trim().slice(-1500) ?? 'Incomplete Codex run' } : {}) }
  } catch (err) {
    return { ok: false, answer: '', account: o.account, exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  }
}
