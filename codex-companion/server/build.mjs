import { build } from 'esbuild'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const serverDirectory = dirname(fileURLToPath(import.meta.url))
const installedBundle = resolve(serverDirectory, 'dist', 'index.mjs')
const checkOnly = process.argv.includes('--check')
const temporaryDirectory = checkOnly ? await mkdtemp(join(tmpdir(), 'bridge-build-check-')) : undefined
const output = temporaryDirectory ? join(temporaryDirectory, 'index.mjs') : installedBundle
try {
  if (!temporaryDirectory) await mkdir(dirname(output), { recursive:true })
  await build({
    entryPoints:[resolve(serverDirectory, 'index.mjs')],
    outfile:output,
    bundle:true,
    packages:'bundle',
    platform:'node',
    format:'esm',
    target:'node20',
    tsconfigRaw:{ compilerOptions:{ module:'esnext', target:'es2020' } },
    external:['node:*'],
    legalComments:'inline',
  })
  if (checkOnly) {
    const [expected, actual] = await Promise.all([readFile(installedBundle, 'utf8'), readFile(output, 'utf8')])
    if (actual !== expected) throw new Error('Committed MCP bundle is stale; run npm run build and commit server/dist/index.mjs.')
    process.stdout.write('Committed Codex MCP bundle matches the current source.\n')
  } else {
    process.stdout.write('Built the self-contained Codex MCP server bundle.\n')
  }
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive:true, force:true })
}
