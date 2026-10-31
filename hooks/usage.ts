import type { EngineInterface } from 'claude-code'
import type { ProviderUsageSnapshot } from '../types'
import { isExe, isWindows, whereAll } from './platform'

const CLI_TIMEOUT_MS = 45_000

function localPath(url: string): string {
  const path = decodeURIComponent(new URL(url).pathname)
  return path.replace(/^\/([A-Za-z]:\/)/, '$1')
}

async function findNode($: EngineInterface): Promise<string | undefined> {
  const matches = await whereAll($, 'node').catch(() => [])
  if (!(await isWindows($))) return matches[0]
  return matches.find(isExe)
}

export async function fetchProviderUsage($: EngineInterface, directory: string, force = false): Promise<ProviderUsageSnapshot[]> {
  const node = await findNode($)
  if (!node) throw new Error('Node.js was not found; subscription readings are unavailable.')
  const script = localPath(new URL('../bridge-core/usage-cli.mjs', import.meta.url).href)
  const args = [node, script, 'usage', '--directory', directory]
  if (force) args.push('--force')
  const result = await $.process.run(args, { cwd: directory, timeoutMs: CLI_TIMEOUT_MS })
  if (result.exitCode !== 0) {
    const message = result.stderr.trim().slice(-600) || 'The shared telemetry engine could not refresh provider usage.'
    throw new Error(message)
  }
  try {
    const parsed = JSON.parse(result.stdout) as { usage?: ProviderUsageSnapshot[] }
    if (!Array.isArray(parsed.usage)) throw new Error('Missing usage list.')
    return parsed.usage
  } catch {
    throw new Error('The shared telemetry engine returned an invalid response.')
  }
}
