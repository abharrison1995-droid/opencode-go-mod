import type { EngineInterface } from 'claude-code'
import { homeOf, isExe, isWindows, whereAll } from './platform'
import { codexExecArgs, codexProfileHome, parseCodexEvents as parseSharedCodexEvents } from '../bridge-core/codex.mjs'

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

export const accountHome = codexProfileHome

export function codexVendorCandidates(root: string | undefined, home: string | undefined, architecture?: string): string[] {
  const isArm64 = /(?:arm64|aarch64)/i.test(architecture ?? '')
  const targets = isArm64
    ? ['aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc']
    : ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']
  const locations = [
    ...(root ? [`${root}/npm/node_modules/@openai/codex/vendor`] : []),
    ...(home ? [`${home}/AppData/Roaming/npm/node_modules/@openai/codex/vendor`] : []),
  ]
  return locations.flatMap(location => targets.map(target => `${location}/${target}/codex/codex.exe`))
}

/** Use real binaries, never the npm .cmd shim that process.run cannot spawn directly. */
export async function findCodex($: EngineInterface): Promise<string | undefined> {
  const matches = await whereAll($, 'codex').catch(() => [])
  if (!(await isWindows($))) return matches[0]
  const exe = matches.find(isExe)
  if (exe) return exe
  const root = await $.env.get('APPDATA')
  const home = await homeOf($)
  const architecture = [await $.env.get('PROCESSOR_ARCHITECTURE'), await $.env.get('PROCESSOR_ARCHITEW6432')].filter(Boolean).join(' ')
  const candidates = codexVendorCandidates(root, home, architecture)
  for (const path of candidates) if (await $.fs.stat(path).catch(() => undefined)) return path
  return undefined
}

export function codexArgv(bin: string, o: CodexRequest): string[] {
  return codexExecArgs(bin, o)
}

/** Codex exec JSONL contains lifecycle events and agent messages. Never treat a failed exit as success. */
export function parseCodexEvents(stdout: string): { answer: string; threadId?: string; error?: string; completed: boolean } {
  return parseSharedCodexEvents(stdout)
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
