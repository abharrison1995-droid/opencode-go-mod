import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCommand, parseResult, workingDirectory, locateCli } from './runner.mjs'

test('readonly default across each CLI',() => {
  assert.ok(buildCommand('opencode',{prompt:'review'},'opencode').args.includes('plan'))
  assert.ok(buildCommand('claude',{prompt:'review'},'claude').args.includes('plan'))
  assert.ok(buildCommand('gemini',{prompt:'review'},'agy').args.includes('plan'))
})
test('editing is opt-in and Gemini editing is unavailable',() => {
  assert.ok(buildCommand('opencode',{prompt:'edit',allowWrites:true},'opencode').args.includes('--auto'))
  assert.throws(() => buildCommand('gemini',{prompt:'edit',allowWrites:true},'agy'),/not enabled/)
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
test('manual Windows executables have precedence',() => {
  assert.equal(locateCli('opencode',{BRIDGE_OPENCODE_BIN:'C:\\agent\\opencode.exe',PATH:''},'win32'),'C:\\agent\\opencode.exe')
})
