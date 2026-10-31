export const CODEX_ACCOUNTS = Object.freeze(['pro-1', 'pro-2'])

export function codexProfileHome(home, account) {
  if (!CODEX_ACCOUNTS.includes(account)) throw new Error('Select Codex profile pro-1 or pro-2 explicitly.')
  return `${home.replace(/[\\/]+$/, '')}/.codex-profiles/${account}`
}

export function codexExecArgs(bin, request) {
  const args = [bin, 'exec', '--json', '--sandbox', request.readOnly === false ? 'workspace-write' : 'read-only']
  if (request.model?.trim()) args.push('-m', request.model.trim())
  if (request.effort) args.push('-c', `model_reasoning_effort="${request.effort}"`)
  args.push('-C', request.cwd, request.prompt)
  return args
}

export function parseCodexEvents(stdout) {
  let answer = ''
  let threadId
  let error
  let completed = false
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') answer = event.item.text
    if (event.type === 'turn.completed') completed = true
    if (event.type === 'turn.failed' || event.type === 'error') error = String(event.error?.message ?? event.message ?? 'Codex failed')
  }
  return { answer, ...(threadId ? { threadId } : {}), ...(error ? { error } : {}), completed }
}
