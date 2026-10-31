import { spawn } from 'node:child_process'
import { realpathSync, statSync, existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { codexExecArgs, codexProfileHome, parseCodexEvents } from '../shared/codex.mjs'
import { locateCli as locateSharedCli, sanitizeDiagnostic } from '../shared/usage.mjs'

const CLI = { opencode: 'opencode', claude: 'claude', gemini: 'agy', codex: 'codex' }

export function classifyFailure(error) {
  const message = String(error ?? '')
  if (/cancel/i.test(message)) return 'cancelled'
  if (/timed out|timeout/i.test(message)) return 'timeout'
  if (/rate.?limit|quota|429|too many requests/i.test(message)) return 'rate-limited'
  if (/auth|sign[ -]?in|log[ -]?in|credential|401|unauthorized/i.test(message)) return 'unauthenticated'
  if (/not found|enoent|could not find|native .*\.exe/i.test(message)) return 'missing-cli'
  if (/invalid structured response|did not return valid json/i.test(message)) return 'malformed-response'
  return 'provider-error'
}

export async function delegateRouted(provider, task, { signal, fallback, invoke = delegate } = {}) {
  if (signal?.aborted) throw new Error('Agent cancelled')
  if (fallback) {
    if (!fallback || typeof fallback.provider !== 'string' || !CLI[fallback.provider]) throw new Error('Fallback must explicitly select a different supported provider.')
    if (provider === 'codex' && fallback.provider === 'codex') throw new Error('Automatic switching between Codex profiles is disabled; select a non-Codex fallback provider.')
    if (fallback.provider === provider) throw new Error('Fallback must explicitly select a different supported provider.')
    if (fallback.provider === 'codex' && !['pro-1','pro-2'].includes(fallback.account)) throw new Error('Select a Codex profile explicitly for the configured fallback.')
  }
  let primary
  try { primary = await invoke(provider, task, { signal }) }
  catch (error) {
    if (signal?.aborted) throw error
    primary = { provider, ok:false, error:sanitizeDiagnostic(error instanceof Error ? error.message : error) }
  }
  if (primary.ok) return primary
  const failureClass = primary.failureClass ?? classifyFailure(primary.error)
  if (!fallback || !['missing-cli','unauthenticated','rate-limited'].includes(failureClass)) return { ...primary, failureClass }
  try {
    const next = await invoke(fallback.provider, {
      ...task,
      model:fallback.model,
      effort:fallback.effort,
      ...(fallback.account ? { account:fallback.account } : { account:undefined }),
    }, { signal })
    return {
      ...next,
      routedFrom:provider,
      fallbackUsed:true,
      primaryError:sanitizeDiagnostic(primary.error || failureClass),
      attempts:[{ provider, ok:false, failureClass }, { provider:fallback.provider, ok:!!next.ok, failureClass:next.ok ? undefined : (next.failureClass ?? classifyFailure(next.error)) }],
    }
  } catch (error) {
    const fallbackError = sanitizeDiagnostic(error instanceof Error ? error.message : error)
    return { provider:fallback.provider, ok:false, routedFrom:provider, fallbackUsed:true, primaryError:sanitizeDiagnostic(primary.error || failureClass), error:fallbackError, failureClass:classifyFailure(fallbackError), attempts:[{ provider, ok:false, failureClass }, { provider:fallback.provider, ok:false, failureClass:classifyFailure(fallbackError) }] }
  }
}

export const locateCli = (provider, env = process.env, platform = process.platform) => locateSharedCli(provider, env, platform)

export function workingDirectory(input) {
  if (typeof input !== 'string' || !isAbsolute(input)) throw new Error('Provide an absolute working directory')
  const path = realpathSync(input)
  if (!statSync(path).isDirectory()) throw new Error('Working directory must be a folder')
  return path
}

export function buildCommand(provider, task, bin) {
  if (!CLI[provider]) throw new Error('Unknown provider')
  if (!task || typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > 30000) throw new Error('Invalid or oversized prompt')
  const write = task.allowWrites === true
  const model = typeof task.model === 'string' ? task.model.trim() : ''
  if (provider === 'gemini' && write) throw new Error('Gemini editing is not enabled in this draft')
  if (provider === 'codex') {
    if (task.account !== 'pro-1' && task.account !== 'pro-2') throw new Error('Select Codex profile pro-1 or pro-2 explicitly')
    const argv = codexExecArgs(bin, { prompt: task.prompt, cwd: task.directory, model, effort: task.effort, readOnly: !write })
    return { bin, args: argv.slice(1) }
  }
  if (provider === 'opencode') {
    const args = ['run','--format','json']
    if (model) args.push('-m',model)
    if (task.effort) args.push('--variant',task.effort)
    if (write) args.push('--auto')
    else args.push('--agent','plan')
    args.push('--',task.prompt)
    return { bin, args }
  }
  if (provider === 'gemini') {
    const args = ['--print=' + task.prompt, '--output-format','json','--mode','plan','--print-timeout','10m']
    if (model) args.push('--model',model)
    return { bin, args }
  }
  const args = ['--print',task.prompt,'--output-format','json','--permission-mode',write ? 'dontAsk':'plan']
  if (model) args.push('--model',model)
  return { bin, args }
}

export function parseResult(provider, stdout) {
  if (provider === 'codex') {
    const result = parseCodexEvents(stdout)
    return { ok: result.completed && !result.error && !!result.answer.trim(), text: result.answer, error: result.error || '' }
  }
  if (provider === 'opencode') {
    let text = '', error = '', count = 0
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      count++
      const part = ev.part || {}
      if ((ev.type === 'text' || part.type === 'text') && typeof part.text === 'string') text += (text ? '\n' : '') + part.text
      if (ev.type === 'error') error = String(ev.error?.data?.message || ev.error?.message || 'OpenCode error')
    }
    return { ok:count > 0 && !error && !!text.trim(), text, error }
  }
  let value
  try { value = JSON.parse(stdout.trim()) }
  catch { return { ok:false, text:'', error:'Invalid structured response' } }
  if (provider === 'gemini') {
    const text = typeof value?.response === 'string' ? value.response : ''
    return { ok:value?.status === 'SUCCESS' && !!text.trim(), text, error:String(value?.error || value?.status || '') }
  }
  const text = typeof value?.result === 'string' ? value.result : ''
  return { ok:value?.is_error !== true && !!text.trim(), text, error:value?.is_error ? 'Claude returned an error' : '' }
}

export async function delegate(provider, task, { signal, spawnImpl = spawn, binOverride, timeoutMs = 12 * 60_000 } = {}) {
  const cwd = workingDirectory(task.directory)
  if (task.allowWrites && process.env.BRIDGE_ENABLE_WRITES !== '1') throw new Error('Owner must explicitly enable BRIDGE_ENABLE_WRITES=1 for editing')
  let env = process.env
  if (provider === 'codex') {
    const account = task.account
    if (account !== 'pro-1' && account !== 'pro-2') throw new Error('Select Codex profile pro-1 or pro-2 explicitly')
    const root = process.env.USERPROFILE || process.env.HOME
    if (!root) throw new Error('User home directory unavailable')
    const codeHome = codexProfileHome(root, account)
    if (!existsSync(codeHome)) throw new Error(`Dedicated Codex profile ${account} is missing; sign in to that profile with CODEX_HOME set.`)
    env = { ...process.env, CODEX_HOME: codeHome }
  }
  const { bin, args } = buildCommand(provider,task,binOverride ?? locateCli(provider))
  const proc = await new Promise((resolve,reject) => {
    if (signal?.aborted) return reject(new Error('Agent cancelled'))
    const child = spawnImpl(bin,args,{cwd,shell:false,windowsHide:true,env:{...env,PWD:cwd},stdio:['ignore','pipe','pipe']})
    let stdout = '', stderr = '', settled = false
    const finish = cb => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); cb() }
    const abort = () => { child.kill(); finish(() => reject(new Error('Agent cancelled'))) }
    const timer = setTimeout(() => {child.kill(); finish(() => reject(new Error('Agent timed out'))) }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    const add = (kind,chunk) => {
      if (kind === 'out') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
      if (stdout.length + stderr.length > 2000000) {child.kill(); finish(() => reject(new Error('Agent output too large'))) }
    }
    child.stdout.on('data', x => add('out',x))
    child.stderr.on('data', x => add('err',x))
    child.on('error', err => finish(() => reject(err)))
    child.on('close', code => finish(() => resolve({stdout,stderr,code})))
  })
  const parsed = parseResult(provider,proc.stdout)
  const ok = proc.code === 0 && parsed.ok
  const codexEvents = provider === 'codex' ? parseCodexEvents(proc.stdout) : undefined
  const error = sanitizeDiagnostic(parsed.error || proc.stderr || 'No successful completion')
  return { provider, ok, exitCode:proc.code, answer:parsed.text, ...(codexEvents?.threadId ? { threadId: codexEvents.threadId } : {}), ...(ok ? {} : { error, failureClass:classifyFailure(error) }) }
}
