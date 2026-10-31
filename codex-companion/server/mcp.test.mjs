import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

test('Codex MCP starts and registers stable tool schemas over stdio', async () => {
  const installCopy = await mkdtemp(resolve(tmpdir(), 'bridge-plugin-copy-'))
  const entry = resolve(installCopy, 'index.mjs')
  await copyFile(resolve(here, 'dist', 'index.mjs'), entry)
  const child = spawn(process.execPath, [entry], { cwd: installCopy, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  let buffer = ''
  const pending = new Map()
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8')
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        if (message.id !== undefined) {
          const resolveRequest = pending.get(message.id)
          if (resolveRequest) { pending.delete(message.id); resolveRequest(message) }
        }
      } catch {}
    }
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
  const request = (id, method, params = {}) => new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out waiting for MCP ${method}: ${stderr || stdout.slice(-500)}`)) }, 5_000)
    pending.set(id, value => { clearTimeout(timer); resolveRequest(value) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    const initialized = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-test', version: '0.1.0' } })
    assert.equal(initialized.error, undefined)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
    const reply = await request(2, 'tools/list')
    const byName = Object.fromEntries(reply.result.tools.map(tool => [tool.name, tool]))
    assert.ok(byName.bridge_status)
    assert.ok(byName.bridge_usage)
    assert.ok(byName.bridge_usage.inputSchema.properties.directory)
    assert.ok(byName.bridge_history)
    assert.ok(byName.delegate_agent)
    assert.ok(byName.start_agent_job)
    assert.ok(byName.get_agent_job)
    assert.ok(byName.cancel_agent_job)
    assert.ok(byName.start_pipeline_job)
    assert.ok(byName.delegate_agent.inputSchema.properties.account.enum.includes('pro-1'))
    assert.ok(byName.delegate_agent.inputSchema.properties.account.enum.includes('pro-2'))
    assert.ok(byName.start_pipeline_job.inputSchema.required.includes('reviewerProvider'))
    assert.ok(byName.start_pipeline_job.inputSchema.properties.verification.enum.includes('git-diff-check'))
    const rejected = await request(3, 'tools/call', { name:'start_agent_job', arguments:{ provider:'codex', directory:process.cwd(), prompt:'read only smoke test' } })
    assert.equal(rejected.result.isError, true)
    assert.match(rejected.result.content[0].text, /Select Codex profile/)
  } finally {
    child.stdin.end()
    await new Promise(resolveRequest => child.once('close', resolveRequest))
    await rm(installCopy, { recursive:true, force:true })
  }
})
