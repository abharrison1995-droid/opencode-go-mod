import { spawn } from 'node:child_process'
import { realpathSync, statSync, existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const CLI = { opencode: 'opencode', claude: 'claude', gemini: 'agy' }
const ENV = { opencode: 'BRIDGE_OPENCODE_BIN', claude: 'BRIDGE_CLAUDE_BIN', gemini: 'BRIDGE_AGY_BIN' }

export function locateCli(provider, env = process.env, platform = process.platform) {
  const name = CLI[provider]
  if (!name) throw new Error('Unknown provider')
  if (env[ENV[provider]]) return env[ENV[provider]]
  if (platform !== 'win32') return name
  const candidates = (env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, name + '.exe'))
  if (provider === 'opencode' && env.APPDATA) candidates.push(join(env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
  if (provider === 'gemini' && env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'))
  const native = candidates.find(p => existsSync(p))
  if (native) return native
  throw new Error('Native ' + name + '.exe not found. Set ' + ENV[provider] + ' to its path; Windows npm .cmd shims are not spawned through a shell.')
}

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

function scrub(value) {
  return value.replace(/(Bearer\s+)[^\s]+/gi,'$1[REDACTED]')
    .replace(/\bsk-[\w-]{10,}\b/g,'[REDACTED]')
    .replace(/((?:api[_-]?key|auth[_-]?token)\s*[=:]\s*)[^\s]+/gi,'$1[REDACTED]').slice(-1200)
}
export async function delegate(provider, task) {
  const cwd = workingDirectory(task.directory)
  if (task.allowWrites && process.env.BRIDGE_ENABLE_WRITES !== '1') throw new Error('Owner must explicitly enable BRIDGE_ENABLE_WRITES=1 for editing')
  const { bin, args } = buildCommand(provider,task,locateCli(provider))
  const proc = await new Promise((resolve,reject) => {
    const child = spawn(bin,args,{cwd,shell:false,windowsHide:true,env:{...process.env,PWD:cwd},stdio:['ignore','pipe','pipe']})
    let stdout = '', stderr = '', settled = false
    const finish = cb => { if (settled) return; settled = true; clearTimeout(timer); cb() }
    const timer = setTimeout(() => {child.kill(); finish(() => reject(new Error('Agent timed out'))) }, 12 * 60_000)
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
  return { provider, ok, exitCode:proc.code, answer:parsed.text, ...(ok ? {} : { error:scrub(parsed.error || proc.stderr || 'No successful completion') }) }
}
