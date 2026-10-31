import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startDashboard } from './dashboard.mjs'

test('dashboard is loopback-only, uses a one-time token, and refreshes only same-origin', async () => {
  let refreshes = 0
  const app = await startDashboard({ readUsage: async ({ force }) => {
    if (force) refreshes++
    return [{ provider: 'codex-pro-1', accountId: 'pro-1', status: 'available', measurement: 'server-reported', source: 'mock', windows: [] }]
  } })
  try {
    const unauth = await fetch(`${app.origin}/api/usage`)
    assert.equal(unauth.status, 401)
    const link = await fetch(app.url, { redirect: 'manual' })
    assert.equal(link.status, 302)
    assert.equal(link.headers.get('location'), '/')
    const cookie = link.headers.get('set-cookie').split(';')[0]
    const page = await fetch(app.origin, { headers: { cookie } })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    const data = await fetch(`${app.origin}/api/usage`, { headers: { cookie } })
    assert.equal(data.status, 200)
    assert.equal((await data.json()).providers[0].accountId, 'pro-1')
    const badOrigin = await fetch(`${app.origin}/api/refresh`, { method: 'POST', headers: { cookie, origin: 'https://attacker.invalid' } })
    assert.equal(badOrigin.status, 403)
    assert.equal(refreshes, 0)
    const refreshed = await fetch(`${app.origin}/api/refresh`, { method: 'POST', headers: { cookie, origin: app.origin } })
    assert.equal(refreshed.status, 200)
    assert.equal(refreshes, 1)
  } finally {
    await app.close()
  }
})

test('dashboard refuses non-loopback bind addresses', async () => {
  await assert.rejects(startDashboard({ host: '0.0.0.0' }), /local computer/)
})

test('IPv6 loopback dashboard URLs use valid bracketed authority syntax', async () => {
  const app = await startDashboard({ host:'::1', readUsage:async () => [] })
  try {
    assert.match(app.origin, /^http:\/\/\[::1\]:\d+$/)
    const link = await fetch(app.url, { redirect:'manual' })
    assert.equal(link.status, 302)
  } finally {
    await app.close()
  }
})
