import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pairs = ['codex.mjs', 'usage.mjs'].map(name => ({
  source:resolve(root, 'bridge-core', name),
  packaged:resolve(root, 'codex-companion', 'shared', name),
}))
const checkOnly = process.argv.includes('--check')

for (const { source, packaged } of pairs) {
  const expected = await readFile(source, 'utf8')
  if (checkOnly) {
    let actual
    try { actual = await readFile(packaged, 'utf8') } catch { actual = undefined }
    assert.equal(actual, expected, `Packaged Codex shared module is out of date: ${packaged}`)
  } else {
    await mkdir(dirname(packaged), { recursive:true })
    await writeFile(packaged, expected)
  }
}

process.stdout.write(checkOnly ? 'Packaged Codex shared modules match the canonical engine.\n' : 'Updated packaged Codex shared modules.\n')
