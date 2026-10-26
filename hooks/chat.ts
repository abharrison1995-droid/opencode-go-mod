import type { EngineInterface, SessionMessage } from 'claude-code'

import type { Effort, WorkerModel } from '../types'
import { homeOf } from './platform'

// Chat mode answers a turn's model request through OpenCode Go's Anthropic Messages endpoint.
// OpenCode lists Claude Code as a validated Go client; Zen's free tier serves only OpenCode itself,
// so chat mode runs on opencode-go/* models alone.
export const ENDPOINT = 'https://opencode.ai/inference/go/anthropic/v1/messages'
const USER_AGENT = 'claude-code-opencode-go-mod/0.6'

const THINKING: Record<Effort, number> = { low: 2_048, medium: 8_192, high: 16_384, xhigh: 32_768, max: 64_000 }

const str = (description: string) => ({ type: 'string', description })
const int = (description: string) => ({ type: 'integer', description })
const bool = (description: string) => ({ type: 'boolean', description })

// The input schemas of the session's core tools, as Claude Code's own tools take them.
// The mod sends only those the session actually has.
const TOOLS: { name: string; description: string; input_schema: Record<string, unknown> }[] = [
  {
    name: 'Read',
    description: 'Read a file from the local filesystem. file_path must be absolute. Returns lines numbered like cat -n.',
    input_schema: { type: 'object', properties: { file_path: str('Absolute path'), offset: int('First line to read'), limit: int('Number of lines') }, required: ['file_path'] },
  },
  {
    name: 'Write',
    description: 'Write a file, replacing it if it exists. Read an existing file first.',
    input_schema: { type: 'object', properties: { file_path: str('Absolute path'), content: str('The whole new content') }, required: ['file_path', 'content'] },
  },
  {
    name: 'Edit',
    description: 'Replace an exact string in a file. old_string must match exactly and be unique unless replace_all is true. Read the file first.',
    input_schema: {
      type: 'object',
      properties: { file_path: str('Absolute path'), old_string: str('Text to replace'), new_string: str('Replacement'), replace_all: bool('Replace every occurrence') },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Bash',
    description: 'Run a bash command and return its output.',
    input_schema: {
      type: 'object',
      properties: { command: str('The command'), description: str('What it does, in a few words'), timeout: { type: 'number', description: 'Milliseconds, max 600000' }, run_in_background: bool('Run detached') },
      required: ['command'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files by glob pattern, newest first.',
    input_schema: { type: 'object', properties: { pattern: str('Glob pattern'), path: str('Directory to search') }, required: ['pattern'] },
  },
  {
    name: 'Grep',
    description: 'Search file contents with ripgrep.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: str('Regular expression'),
        path: str('File or directory'),
        glob: str('Filter files by glob'),
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        '-i': bool('Case insensitive'),
        '-n': bool('Show line numbers'),
        head_limit: int('Limit results'),
      },
      required: ['pattern'],
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetch a URL and answer a prompt about its content.',
    input_schema: { type: 'object', properties: { url: str('The URL'), prompt: str('What to extract') }, required: ['url', 'prompt'] },
  },
]

export async function chatTools($: EngineInterface) {
  const have = new Set((await $.tool.list()).map(t => t.name))
  return TOOLS.filter(t => have.has(t.name))
}

type Block = Record<string, unknown>
type Msg = { role: 'user' | 'assistant'; content: Block[] }

// Rebuilds the conversation as Anthropic messages from the engine's transcript summary:
// text and tool calls with their results. Images and earlier thinking are not carried.
export function toMessages(transcript: readonly SessionMessage[]): Msg[] {
  const out: Msg[] = []
  const push = (role: Msg['role'], content: Block[]) => {
    if (content.length === 0) return
    const last = out.at(-1)
    if (last?.role === role) last.content.push(...content)
    else out.push({ role, content })
  }
  for (const m of transcript) {
    if (m.role === 'assistant') {
      const blocks: Block[] = []
      if (m.text.trim()) blocks.push({ type: 'text', text: m.text })
      for (const use of m.toolUses) blocks.push({ type: 'tool_use', id: use.tool_use_id, name: use.tool, input: use.input ?? {} })
      push('assistant', blocks)
      // Each call's result goes in the next user message, ahead of any text, as the API requires.
      const results = m.toolUses.map(use => ({
        type: 'tool_result',
        tool_use_id: use.tool_use_id,
        content: use.text ?? (use.result === undefined ? '(no result)' : JSON.stringify(use.result)),
        ...(use.isError ? { is_error: true } : {}),
      }))
      push('user', results)
    } else if (m.text.trim()) {
      push('user', [{ type: 'text', text: m.text }])
    }
  }
  while (out[0]?.role === 'assistant') out.shift()
  return out
}

export async function readKey($: EngineInterface): Promise<string | undefined> {
  const data = (await $.env.get('XDG_DATA_HOME')) ?? `${await homeOf($)}/.local/share`
  const text = await $.fs.read(`${data}/opencode/auth.json`).catch(() => undefined)
  if (typeof text !== 'string') return undefined
  try {
    const auth = JSON.parse(text)
    return auth['opencode-go']?.key ?? auth.opencode?.key
  } catch {
    return undefined
  }
}

export function requestBody(modelId: string, model: WorkerModel | undefined, level: Effort, system: string, tools: unknown[], messages: Msg[]) {
  const maxOutput = Math.min(model?.maxOutput ?? 32_000, 128_000)
  const canThink = model === undefined || model.efforts.length > 0
  const budget = Math.min(THINKING[level], maxOutput - 4_096)
  return {
    model: modelId.split('/')[1] ?? modelId,
    max_tokens: maxOutput,
    system,
    tools,
    messages,
    ...(canThink && budget >= 1_024 ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
  }
}

type Reply = { content: Block[]; stop_reason: string | null; model?: string; usage?: Record<string, number> }
type SendError = { status: number; message: string; thrown: boolean }

export function explainError(status: number, message: string) {
  if (status === 401 || status === 403) return 'OpenCode rejected the key. Run `opencode auth login` and choose OpenCode Go.'
  if (status === 429) return `OpenCode Go is busy or rate limiting (${message}); try again shortly or pick another model. If it keeps happening, your allowance may be used up.`
  if (/global region/i.test(message)) return `${message} (OpenCode web console → your workspace → Privacy → Global)`
  if (status === 400 && /tool|thinking/i.test(message))
    return `${message} (this model may not support tools or thinking; try another model or a lower reasoning level)`
  return message
}

// `$.http.fetch` takes no AbortSignal, so the wait around it is the abortable part: an interrupted
// dispatch stops waiting at once, and whatever the request later answers is dropped.
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | { aborted: true }> {
  if (signal.aborted) return Promise.resolve({ aborted: true })
  return new Promise((resolve, reject) => {
    const stop = () => resolve({ aborted: true })
    signal.addEventListener('abort', stop, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      err => {
        signal.removeEventListener('abort', stop)
        reject(err)
      },
    )
  })
}

export async function send($: EngineInterface, key: string, session: string, body: unknown): Promise<{ response: Reply } | { error: SendError }> {
  let res: Awaited<ReturnType<EngineInterface['http']['fetch']>>
  try {
    res = await $.http.fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'x-opencode-session': session,
        'user-agent': USER_AGENT,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { error: { status: 0, message: err instanceof Error ? err.message : String(err), thrown: true } }
  }
  let json: any
  try {
    json = JSON.parse(res.text)
  } catch {
    json = undefined
  }
  if (!res.ok || json?.type === 'error') {
    const message = String(json?.error?.message ?? json?.error?.type ?? res.text.slice(0, 300)).trim()
    return { error: { status: res.status, message: message || 'request failed', thrown: false } }
  }
  return { response: json as Reply }
}

const RETRY = new Set([429, 500, 502, 503, 504, 529])

export async function sendWithRetry(
  $: EngineInterface,
  key: string,
  session: string,
  body: ReturnType<typeof requestBody>,
  signal: AbortSignal,
) {
  const sent = await abortable(send($, key, session, body), signal)
  if ('aborted' in sent) return sent
  const retry = 'error' in sent && (sent.error.thrown || RETRY.has(sent.error.status))
  if (!retry) return sent
  $.ui.status(`OpenCode chat: ${body.model} retrying…`)
  try {
    await $.clock.sleep(2_000, { signal })
  } catch {
    return { aborted: true as const }
  }
  return abortable(send($, key, session, body), signal)
}
