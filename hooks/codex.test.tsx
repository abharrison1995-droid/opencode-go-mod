import { expect, test } from 'claude-code/testing'
import { accountHome, codexArgv, parseCodexEvents } from './codex'

test('two Pro profiles use independent isolated home directories', () => {
  expect(accountHome('C:/Users/Alex', 'pro-1')).toBe('C:/Users/Alex/.codex-profiles/pro-1')
  expect(accountHome('C:/Users/Alex', 'pro-2')).toBe('C:/Users/Alex/.codex-profiles/pro-2')
})

test('Codex defaults to read-only without an explicit edit request', () => {
  const argv = codexArgv('/usr/bin/codex', { account: 'pro-1', prompt: 'Review only', cwd: '/project' })
  expect(argv).toContain('read-only')
  expect(argv).not.toContain('workspace-write')
  expect(argv.at(-1)).toBe('Review only')
})

test('editing mode and selectable model and effort are explicit', () => {
  const argv = codexArgv('/usr/bin/codex', { account: 'pro-2', prompt: 'Implement', cwd: '/project', readOnly: false, model: 'gpt-6', effort: 'high' })
  expect(argv).toContain('workspace-write')
  expect(argv).toContain('gpt-6')
  expect(argv).toContain('model_reasoning_effort="high"')
})

test('Codex JSONL parser captures completion and final answer', () => {
  const result = parseCodexEvents([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'All checks passed' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ].join('\n'))
  expect(result).toEqual({ answer: 'All checks passed', threadId: 'thread-123', completed: true })
})

test('Codex JSONL parser detects failed events, not false successes', () => {
  const result = parseCodexEvents(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }))
  expect(result.completed).toBe(false)
  expect(result.error).toBe('quota exceeded')
})
