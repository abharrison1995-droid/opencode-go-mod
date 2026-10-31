import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRoomForJob } from './job-registry.mjs'

test('concurrent jobs stay within the hard limit while terminal history remains evictable', () => {
  const active = new Map([
    ['a',{ id:'a', status:'running' }],
    ['b',{ id:'b', status:'queued' }],
  ])
  assert.throws(() => makeRoomForJob(active, 2), /2-job concurrency limit/)
  assert.equal(active.size, 2)
  active.delete('b')
  active.set('c',{ id:'c', status:'completed' })
  makeRoomForJob(active, 2)
  assert.equal(active.has('c'), false)
  assert.equal(active.size, 1)
})
