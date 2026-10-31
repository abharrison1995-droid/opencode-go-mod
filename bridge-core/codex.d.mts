export type CodexAccount = 'pro-1' | 'pro-2'
export type CodexExecRequest = {
  prompt: string
  cwd: string
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
  readOnly?: boolean
}
export const CODEX_ACCOUNTS: readonly CodexAccount[]
export function codexProfileHome(home: string, account: CodexAccount): string
export function codexExecArgs(bin: string, request: CodexExecRequest): string[]
export function parseCodexEvents(stdout: string): { answer: string; threadId?: string; error?: string; completed: boolean }
