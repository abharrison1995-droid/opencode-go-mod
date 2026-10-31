import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runPipeline, buildVerificationCommand, resolveVerificationCommand, verificationEnvironment, assertIndependentReviewer } from './pipeline.mjs'

function processResult(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, shell:false, windowsHide:true, stdio:['ignore','pipe','pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

async function git(cwd, ...args) {
  const result = await processResult('git', args, cwd)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

test('pipeline isolates edits in a preserved worktree and leaves dirty source changes untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-pipeline-'))
  const repo = join(root, 'repo with spaces')
  const worktreeRoot = join(root, 'worktrees')
  await mkdir(repo)
  try {
    await git(repo, 'init')
    await git(repo, 'config', 'user.name', 'Bridge Test')
    await git(repo, 'config', 'user.email', 'bridge@example.invalid')
    await writeFile(join(repo, 'tracked.txt'), 'committed base\n')
    await git(repo, 'add', 'tracked.txt')
    await git(repo, 'commit', '-m', 'base')
    await writeFile(join(repo, 'tracked.txt'), 'uncommitted owner edit\n')

    const calls = []
    let verificationRuns = 0
    const delegateFn = async (provider, task) => {
      calls.push({ provider, task })
      if (task.allowWrites) await writeFile(join(task.directory, 'tracked.txt'), 'agent worktree edit\n')
      if (task.prompt.startsWith('Create an implementation plan')) return { ok:true, answer:'p'.repeat(100_000) }
      return { ok:true, answer:task.allowWrites ? 'implemented' : task.prompt.includes('independent read-only review') ? 'No findings.' : 'Use the tracked file.' }
    }
    const input = {
      repoDirectory:repo, task:'Update tracked.txt',
      plannerProvider:'claude', implementerProvider:'opencode', reviewerProvider:'codex', reviewerAccount:'pro-1',
      verification:'git-diff-check', maxRounds:2,
    }
    await assert.rejects(runPipeline(input, { delegateFn, worktreeRoot, env:{} }), /BRIDGE_ENABLE_WRITES=1/)
    assert.equal(calls.length, 0)
    const stages = []
    const execute = async (bin, args, options) => {
      if (bin === 'git' && args[0] === 'diff' && args.includes('--check')) {
        verificationRuns++
        if (verificationRuns === 1) return { code:1, stdout:'', stderr:'first verification failed' }
      }
      return processResult(bin, args, options.cwd)
    }
    const result = await runPipeline(input, { delegateFn, execute, worktreeRoot, env:{ BRIDGE_ENABLE_WRITES:'1' }, onStage:stage => stages.push(stage) })
    assert.equal(result.ok, true)
    assert.equal(verificationRuns, 2)
    assert.equal(result.planner.length, 6_000)
    assert.ok(calls.every(call => call.task.prompt.length <= 30_000))
    assert.equal(calls.filter(call => call.task.allowWrites).length, 2)
    assert.equal(result.sourceDirty, true)
    assert.match(result.branch, /^codex-bridge\//)
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'uncommitted owner edit\n')
    assert.equal(await readFile(join(result.worktreePath, 'tracked.txt'), 'utf8'), 'agent worktree edit\n')
    assert.equal(await git(result.worktreePath, 'branch', '--show-current'), result.branch)
    assert.deepEqual(stages, ['creating-worktree','worktree-ready','implementing','verifying','retrying-implementation','verifying','reviewing'])
    assert.equal(buildVerificationCommand('git-diff-check').bin, 'git')
  } finally {
    const worktreeList = await processResult('git', ['worktree','list','--porcelain'], repo).catch(() => ({stdout:''}))
    const match = worktreeList.stdout.match(/worktree (.+)/g) ?? []
    for (const row of match.slice(1)) await processResult('git', ['worktree','remove','--force',row.slice('worktree '.length)], repo)
    await rm(root, { recursive:true, force:true })
  }
})

test('pipeline requires a supported verifier and an independent reviewer selection', () => {
  assert.throws(() => buildVerificationCommand('powershell -Command arbitrary'), /supported/)
  assert.throws(() => assertIndependentReviewer({ provider:'opencode' }, { provider:'opencode' }), /independent reviewer/)
  assert.throws(() => assertIndependentReviewer({ provider:'codex', account:'pro-1' }, { provider:'codex', account:'pro-1' }), /independent reviewer/)
  assert.throws(() => assertIndependentReviewer(
    { provider:'opencode', fallback:{ provider:'claude' } },
    { provider:'claude' },
  ), /independent reviewer/)
  assert.throws(() => assertIndependentReviewer(
    { provider:'opencode', fallback:{ provider:'claude' } },
    { provider:'gemini', fallback:{ provider:'claude' } },
  ), /independent reviewer/)
  assert.doesNotThrow(() => assertIndependentReviewer(
    { provider:'codex', account:'pro-1', fallback:{ provider:'claude' } },
    { provider:'codex', account:'pro-2' },
  ))
  assert.doesNotThrow(() => assertIndependentReviewer({ provider:'codex', account:'pro-1' }, { provider:'codex', account:'pro-2' }))
})

test('pipeline bounds task size before any delegation to keep wrapped prompts within the worker limit', async () => {
  let calls = 0
  await assert.rejects(runPipeline({
    repoDirectory:process.cwd(), task:'x'.repeat(18_001),
    plannerProvider:'claude', implementerProvider:'opencode', reviewerProvider:'codex', reviewerAccount:'pro-1', verification:'git-diff-check',
  }, { env:{ BRIDGE_ENABLE_WRITES:'1' }, delegateFn:async () => { calls++; return { ok:true, answer:'unexpected' } } }), /18,000 characters/)
  assert.equal(calls, 0)
})

test('Windows npm verification invokes npm-cli.js through the active Node executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-npm-bin-'))
  const nodePath = join(root, 'node.exe')
  const npmCli = join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  try {
    await mkdir(join(root, 'node_modules', 'npm', 'bin'), { recursive:true })
    await writeFile(nodePath, '')
    await writeFile(npmCli, '')
    assert.deepEqual(resolveVerificationCommand('npm-codex-check', { platform:'win32', execPath:nodePath }), {
      bin:nodePath,
      args:[npmCli, 'run', 'check', '--prefix', 'codex-companion'],
    })
  } finally {
    await rm(root, { recursive:true, force:true })
  }
})

test('verification subprocesses use a system allowlist without inherited secrets or user-profile paths', () => {
  const env = verificationEnvironment({ PATH:'system-path', PATHEXT:'.EXE', SystemRoot:'C:/Windows', TMPDIR:'temp-dir', NODE_ENV:'test', OPENAI_API_KEY:'secret', GITHUB_TOKEN:'secret', OPENCODE_SERVER_PASSWORD:'secret', DATABASE_URL:'credential-bearing', HOME:'C:/Users/Alex', USERPROFILE:'C:/Users/Alex', CUSTOM_FLAG:'1' })
  assert.deepEqual(env, { PATH:'system-path', PATHEXT:'.EXE', SystemRoot:'C:/Windows', TMPDIR:'temp-dir', NODE_ENV:'test' })
})
