import type { EngineInterface } from 'claude-code'

export type Check = { name: string; ok: boolean; detail: string }

// `/opencode selftest`: proves on this machine what tests can only fake.
export async function selfTest($: EngineInterface, o: { bin?: string; dir: string }): Promise<Check[]> {
  void $
  void o
  return []
}

export function formatChecks(checks: Check[]): string {
  if (checks.length === 0) return 'Self-test: no checks ran.'
  return checks.map(c => `${c.ok ? '✓' : '✕'} ${c.name}: ${c.detail}`).join('\n')
}
