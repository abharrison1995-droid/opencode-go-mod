import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const exists = path => assert.ok(existsSync(resolve(root, path)), `Required host package file missing: ${path}`)

const claude = readJson('.claude-plugin/plugin.json')
assert.equal(claude.name, 'opencode-go', 'The Claude root variant must retain its plugin ID.')
exists('hooks/register.tsx')

const codex = readJson('codex-companion/plugin.json')
assert.equal(codex.name, 'agent-subscription-bridge')
assert.equal(codex.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
assert.equal(codex.extensions?.['com.openai']?.onboardingSkill, './skills/delegate/SKILL.md')
const mcp = readJson('codex-companion/mcp.json')
assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')
assert.equal(mcp.mcpServers?.bridge?.type, 'stdio')
assert.equal(mcp.mcpServers.bridge.command, 'node')
assert.deepEqual(mcp.mcpServers.bridge.args, ['${PLUGIN_ROOT}/server/dist/index.mjs'])
exists('codex-companion/server/index.mjs')
exists('codex-companion/server/dist/index.mjs')
exists('codex-companion/package-lock.json')
exists('codex-companion/server/dashboard.mjs')
exists('codex-companion/server/pipeline.mjs')
exists('codex-companion/server/job-registry.mjs')
exists('codex-companion/skills/delegate/SKILL.md')
for (const name of ['codex.mjs', 'usage.mjs']) {
  const canonical = readFileSync(resolve(root, 'bridge-core', name), 'utf8')
  assert.equal(readFileSync(resolve(root, 'codex-companion', 'shared', name), 'utf8'), canonical, `Packaged Codex shared module ${name} must match the canonical engine.`)
}
for (const path of ['index.mjs', 'runner.mjs', 'dashboard.mjs', 'history.mjs', 'pipeline.mjs']) {
  const source = readFileSync(resolve(root, 'codex-companion', 'server', path), 'utf8')
  assert.doesNotMatch(source, /\.\.\/\.\.\/bridge-core\//, `Installed Codex package must not load files outside its package: ${path}`)
}

const marketplace = readJson('.agents/plugins/marketplace.json')
assert.ok(marketplace.plugins.some(plugin => plugin.source?.path === './codex-companion'))
const installation = readFileSync(resolve(root, 'docs/INSTALLATION.md'), 'utf8')
assert.match(installation, /Select by the application that will run the plugin, not by which AI agent/)
assert.match(installation, /\*\*Repository root\*\*/i)
assert.match(installation, /\*\*`codex-companion\/`\*\*/)

process.stdout.write('Claude and Codex package manifests and host routing are valid.\n')
