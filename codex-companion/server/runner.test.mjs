import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildCommand, classifyFailure, delegate, delegateRouted, parseResult, workingDirectory, locateCli } from './runner.mjs'

test('readonly default across each CLI',() => {
  assert.ok(buildCommand('opencode',{prompt:'review'},'opencode').args.includes('plan'))
  assert.ok(buildCommand('claude',{prompt:'review'},'claude').args.includes('plan'))
  assert.ok(buildCommand('gemini',{prompt:'review'},'agy').args.includes('plan'))
})
test('editing is opt-in and Gemini editing is unavailable',() => {
  assert.ok(buildCommand('opencode',{prompt:'edit',allowWrites:true},'opencode').args.includes('--auto'))
  assert.throws(() => buildCommand('gemini',{prompt:'edit',allowWrites:true},'agy'),/not enabled/)
})
test('Codex profiles are selected explicitly and default to its read-only sandbox',() => {
  const cmd = buildCommand('codex',{prompt:'review',directory:'C:\\project',account:'pro-2'},'codex.exe')
  assert.ok(cmd.args.includes('read-only'))
  assert.equal(cmd.args.at(-1),'review')
  assert.throws(() => buildCommand('codex',{prompt:'review',directory:'C:\\project'},'codex.exe'),/explicitly/)
  const edit = buildCommand('codex',{prompt:'edit',directory:'C:\\project',account:'pro-1',allowWrites:true,model:'gpt-6',effort:'high'},'codex.exe')
  assert.ok(edit.args.includes('workspace-write'))
  assert.ok(edit.args.includes('gpt-6'))
  assert.ok(edit.args.includes('model_reasoning_effort="high"'))
})
test('parsers reject error envelopes',() => {
  assert.equal(parseResult('opencode',JSON.stringify({type:'text',part:{text:'done',type:'text'}})).ok,true)
  assert.equal(parseResult('opencode',JSON.stringify({type:'error',error:{message:'failed'}})).ok,false)
  assert.equal(parseResult('gemini',JSON.stringify({status:'SUCCESS',response:'done'})).ok,true)
  assert.equal(parseResult('gemini',JSON.stringify({status:'FAILED',response:'partial'})).ok,false)
  assert.equal(parseResult('claude',JSON.stringify({result:'ok',is_error:false})).ok,true)
  assert.equal(parseResult('claude','{}').ok,false)
})
test('relative paths are rejected',() => assert.throws(() => workingDirectory('../other'),/absolute/))
test('manual Windows executables have precedence',async () => {
  assert.equal(await locateCli('opencode',{BRIDGE_OPENCODE_BIN:'C:\\agent\\opencode.exe',PATH:''},'win32'),'C:\\agent\\opencode.exe')
})

test('explicit fallback is bounded to one provider and never rotates Codex profiles', async () => {
  const tried = []
  const invoke = async provider => {
    tried.push(provider)
    return provider === 'opencode' ? { provider, ok:false, error:'401 Unauthorized' } : { provider, ok:true, answer:'fallback result' }
  }
  const result = await delegateRouted('opencode', { directory:'C:\\project', prompt:'review' }, { fallback:{ provider:'codex', account:'pro-2', model:'gpt-6' }, invoke })
  assert.deepEqual(tried, ['opencode','codex'])
  assert.equal(result.fallbackUsed, true)
  assert.equal(result.routedFrom, 'opencode')
  assert.equal(result.answer, 'fallback result')
  assert.equal(result.attempts.length, 2)
  assert.equal(classifyFailure('429 rate limit'), 'rate-limited')
  tried.length = 0
  const failure = await delegateRouted('opencode', { directory:'C:\\project', prompt:'review' }, { fallback:{ provider:'claude' }, invoke:async provider => { tried.push(provider); return { provider, ok:false, error:'invalid task response' } } })
  assert.deepEqual(tried, ['opencode'])
  assert.equal(failure.failureClass, 'provider-error')
  await assert.rejects(delegateRouted('codex', { account:'pro-1' }, { fallback:{ provider:'codex', account:'pro-2' }, invoke }), /switching between Codex profiles/)
})

test('delegation cancellation stops a running child and reports a cancelled task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-cancel-'))
  const controller = new AbortController()
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => { child.killed = true }
  try {
    const pending = delegate('opencode', { directory, prompt:'hang' }, {
      signal:controller.signal,
      binOverride:'opencode',
      spawnImpl:() => child,
      timeoutMs:1_000,
    })
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending, /Agent cancelled/)
    assert.equal(child.killed, true)
  } finally {
    await rm(directory, { recursive:true, force:true })
  }
})

test('routed cancellation does not become a provider failure or trigger fallback', async () => {
  const controller = new AbortController()
  const fallbackCalls = []
  const pending = delegateRouted('opencode', { prompt:'hang' }, {
    signal:controller.signal,
    fallback:{ provider:'claude' },
    invoke:async provider => {
      fallbackCalls.push(provider)
      return await new Promise((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('Agent cancelled')), { once:true })
      })
    },
  })
  controller.abort()
  await assert.rejects(pending, /Agent cancelled/)
  assert.deepEqual(fallbackCalls, ['opencode'])
})
