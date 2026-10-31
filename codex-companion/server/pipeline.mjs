import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { workingDirectory, delegateRouted } from './runner.mjs'
import { sanitizeDiagnostic } from '../shared/usage.mjs'

const verificationCommands = Object.freeze({
  'git-diff-check': ['git', ['diff', '--check']],
  'npm-test': ['npm', ['test']],
  'npm-check': ['npm', ['run', 'check']],
  'npm-codex-check': ['npm', ['run', 'check', '--prefix', 'codex-companion']],
  'python-unittest': ['python', ['-m', 'unittest', 'discover']],
  'go-test': ['go', ['test', './...']],
  'cargo-test': ['cargo', ['test']],
  'pytest': ['python', ['-m', 'pytest']],
})

export function buildVerificationCommand(name) {
  const command = verificationCommands[name]
  if (!command) throw new Error('Select a supported deterministic verification command.')
  return { bin:command[0], args:[...command[1]] }
}

export function resolveVerificationCommand(name, { platform = process.platform, execPath = process.execPath } = {}) {
  const command = buildVerificationCommand(name)
  if (platform === 'win32' && command.bin === 'npm') {
    const npmCli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!existsSync(npmCli)) throw new Error('Could not locate npm-cli.js beside the active Node installation for Windows verification.')
    return { bin:execPath, args:[npmCli, ...command.args] }
  }
  return command
}

export function verificationEnvironment(environment = process.env) {
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|CI|NODE_ENV|FORCE_COLOR|NO_COLOR)$/i
  return Object.fromEntries(Object.entries(environment).filter(([name]) => allowed.test(name)))
}

export function assertIndependentReviewer(implementer, reviewer) {
  const routes = stage => [stage, ...(stage.fallback ? [stage.fallback] : [])]
  const sameIdentity = (left, right) => left.provider === right.provider &&
    (left.provider !== 'codex' || left.account === right.account)
  const overlap = routes(implementer).some(left => routes(reviewer).some(right => sameIdentity(left, right)))
  if (overlap) {
    throw new Error('Choose an independent reviewer from a different provider or a different Codex profile.')
  }
}

function runProcess(bin, args, { cwd, signal, env = process.env, timeoutMs = 20 * 60_000, maxOutput = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Pipeline cancelled.'))
    const child = spawn(bin, args, { cwd, env:{ ...env, ...(cwd ? { PWD:cwd } : {}) }, shell:false, windowsHide:true, stdio:['ignore','pipe','pipe'] })
    let stdout = '', stderr = '', settled = false
    const finish = fn => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn() }
    const kill = () => { try { child.kill() } catch {} }
    const abort = () => { kill(); finish(() => reject(new Error('Pipeline cancelled.'))) }
    const timer = setTimeout(() => { kill(); finish(() => reject(new Error(`${bin} verification timed out.`))) }, timeoutMs)
    const collect = (kind, chunk) => {
      if (kind === 'out') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
      if (stdout.length + stderr.length > maxOutput) { kill(); finish(() => reject(new Error(`${bin} output exceeded the safety limit.`))) }
    }
    signal?.addEventListener('abort', abort, { once:true })
    child.stdout.on('data', chunk => collect('out', chunk))
    child.stderr.on('data', chunk => collect('err', chunk))
    child.on('error', error => finish(() => reject(error)))
    child.on('close', code => finish(() => resolve({ code, stdout, stderr })))
  })
}

function accountArg(provider, account) {
  if (provider === 'codex' && !['pro-1','pro-2'].includes(account)) throw new Error('Select Codex profile pro-1 or pro-2 explicitly for each Codex stage.')
  return provider === 'codex' ? account : undefined
}

export async function runPipeline(input, { signal, delegateFn = delegateRouted, execute = runProcess, onStage = () => {}, worktreeRoot = join(tmpdir(), 'agent-subscription-bridge'), env = process.env } = {}) {
  const repoDirectory = workingDirectory(input.repoDirectory)
  if (env.BRIDGE_ENABLE_WRITES !== '1') throw new Error('Owner must explicitly enable BRIDGE_ENABLE_WRITES=1 before a pipeline creates an implementation worktree.')
  const maxRounds = Math.max(1, Math.min(2, Number.isInteger(input.maxRounds) ? input.maxRounds : 1))
  const planner = { provider:input.plannerProvider, account:accountArg(input.plannerProvider, input.plannerAccount), model:input.plannerModel, effort:input.plannerEffort, fallback:input.plannerFallback }
  const implementer = { provider:input.implementerProvider, account:accountArg(input.implementerProvider, input.implementerAccount), model:input.implementerModel, effort:input.implementerEffort, fallback:input.implementerFallback }
  const reviewer = { provider:input.reviewerProvider, account:accountArg(input.reviewerProvider, input.reviewerAccount), model:input.reviewerModel, effort:input.reviewerEffort, fallback:input.reviewerFallback }
  assertIndependentReviewer(implementer, reviewer)
  if (reviewer.fallback) assertIndependentReviewer(implementer, reviewer.fallback)
  const verification = resolveVerificationCommand(input.verification)
  if (typeof input.task !== 'string' || !input.task.trim() || input.task.length > 18_000) throw new Error('Provide a bounded pipeline task of at most 18,000 characters.')
  const identity = randomUUID()
  const branch = `codex-bridge/${identity}`
  const worktreePath = join(worktreeRoot, identity)
  const rootResult = await execute('git', ['rev-parse', '--show-toplevel'], { cwd:repoDirectory, signal, timeoutMs:15_000 })
  if (rootResult.code !== 0) throw new Error('Pipeline requires a Git repository.')
  const gitRoot = workingDirectory(rootResult.stdout.trim())
  const status = await execute('git', ['status', '--porcelain'], { cwd:gitRoot, signal, timeoutMs:15_000 })
  if (status.code !== 0) throw new Error('Could not inspect the repository working-tree state.')
  const sourceDirty = !!status.stdout.trim()
  const planResult = await delegateFn(planner.provider, {
    directory:gitRoot, prompt:`Create an implementation plan for this task. Do not edit files. Identify relevant paths, likely risks, and concrete verification steps.\n\nTask:\n${input.task}`,
    model:planner.model, effort:planner.effort, account:planner.account, allowWrites:false,
  }, { signal, fallback:planner.fallback })
  if (!planResult.ok) throw new Error(`Planner failed: ${sanitizeDiagnostic(planResult.error || 'no successful response')}`)
  onStage('creating-worktree')
  await mkdir(worktreeRoot, { recursive:true })
  const added = await execute('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], { cwd:gitRoot, signal, timeoutMs:30_000 })
  if (added.code !== 0) throw new Error(`Could not create an isolated implementation worktree: ${sanitizeDiagnostic(added.stderr || added.stdout)}`)
  onStage('worktree-ready', { branch, worktreePath, sourceDirty })
  const plannerNotes = String(planResult.answer ?? '').slice(0, 6_000)
  const baseContext = `Task:\n${input.task}\n\nPlanner notes:\n${plannerNotes}\n\nConstraints: Work only in this worktree. Do not merge, push, switch accounts, or alter the source checkout.`
  let implementation
  let verify
  for (let round = 1; round <= maxRounds; round++) {
    onStage(round === 1 ? 'implementing' : 'retrying-implementation')
    const feedback = round > 1 ? `\n\nThe previous verification failed (exit ${verify.code}). Fix the relevant issues and preserve the existing changes.\n${sanitizeDiagnostic(verify.stderr || verify.stdout || 'No verification output')}` : ''
    implementation = await delegateFn(implementer.provider, {
      directory:worktreePath, prompt:`Implement the requested task in this isolated worktree.\n\n${baseContext}${feedback}`,
      model:implementer.model, effort:implementer.effort, account:implementer.account, allowWrites:true,
    }, { signal, fallback:implementer.fallback })
    if (!implementation.ok) break
    onStage('verifying')
    verify = await execute(verification.bin, verification.args, { cwd:worktreePath, env:verificationEnvironment(), signal, timeoutMs:20 * 60_000 })
    if (verify.code === 0) break
  }
  onStage('reviewing')
  const review = await delegateFn(reviewer.provider, {
    directory:worktreePath,
    prompt:`Perform an independent read-only review of the implementation for this task. Inspect git status --short, review changed tracked files and any new untracked files, and report actionable correctness, security, portability, and regression findings. Do not edit files.\n\n${baseContext}\n\nVerification command: ${verification.bin} ${verification.args.join(' ')}\nVerification exit code: ${verify?.code ?? 'not run'}\nVerification output:\n${sanitizeDiagnostic(verify?.stderr || verify?.stdout || 'not available')}`,
    model:reviewer.model, effort:reviewer.effort, account:reviewer.account, allowWrites:false,
  }, { signal, fallback:reviewer.fallback })
  const report = {
    ok:!!implementation?.ok && verify?.code === 0 && !!review.ok,
    branch, worktreePath, sourceDirty,
    agents:[
      { role:'planner', provider:planResult.provider ?? planner.provider, accountId:(planResult.provider ?? planner.provider) === 'codex' ? (planResult.fallbackUsed ? planner.fallback?.account : planner.account) : 'default', ok:!!planResult.ok, fallbackUsed:planResult.fallbackUsed === true },
      { role:'implementer', provider:implementation?.provider ?? implementer.provider, accountId:(implementation?.provider ?? implementer.provider) === 'codex' ? (implementation?.fallbackUsed ? implementer.fallback?.account : implementer.account) : 'default', ok:!!implementation?.ok, fallbackUsed:implementation?.fallbackUsed === true },
      { role:'reviewer', provider:review.provider ?? reviewer.provider, accountId:(review.provider ?? reviewer.provider) === 'codex' ? (review.fallbackUsed ? reviewer.fallback?.account : reviewer.account) : 'default', ok:!!review.ok, fallbackUsed:review.fallbackUsed === true },
    ],
    sourceCheckoutNote:sourceDirty ? 'The source checkout had uncommitted changes; the isolated worktree starts from committed HEAD and leaves them untouched.' : 'The isolated worktree starts from committed HEAD.',
    planner:plannerNotes,
    implementation:implementation?.answer ?? '',
    verification:{ command:[verification.bin, ...verification.args], exitCode:verify?.code ?? null, stdout:sanitizeDiagnostic(verify?.stdout ?? ''), stderr:sanitizeDiagnostic(verify?.stderr ?? '') },
    review:review.answer,
    ...(implementation?.ok ? {} : { error:sanitizeDiagnostic(implementation?.error || 'Implementation did not complete successfully.') }),
    ...(review.ok ? {} : { reviewError:sanitizeDiagnostic(review.error || 'Reviewer did not complete successfully.') }),
    note:'The worktree and branch are preserved for owner inspection. No merge or push was performed.',
  }
  return report
}
