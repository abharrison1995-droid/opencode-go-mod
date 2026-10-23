// Shared stand-ins for the mod's tests: an engine that answers every $ call the mod makes.

export const PANE = {
  plugin: 'opencode-go',
  component: 'Pane',
  requestId: 'opencode',
  props: {
    title: 'OpenCode',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

export const model = (name: string, input: number, output: number, variants: string[]) =>
  JSON.stringify(
    { name, status: 'active', cost: { input, output }, limit: { output: 32000 }, variants: Object.fromEntries(variants.map(v => [v, { reasoningEffort: v }])) },
    null,
    2,
  )

export const MODELS = [
  `opencode-go/beam-free\n${model('Beam Free', 0, 0, ['low', 'medium', 'high', 'xhigh'])}`,
  `opencode-go/kimi-k3\n${model('Kimi K3', 3, 15, ['low', 'high'])}`,
  `opencode-go/kimi-k2.7-code\n${model('Kimi K2.7 Code', 0.95, 4, ['high'])}`,
  `opencode-go/glm-5.3-flash\n${model('GLM 5.3 Flash', 0.15, 0.5, [])}`,
  `opencode/beam-free\n${model('Beam Free', 0, 0, [])}`,
  `opencode/deepseek-v4.1-flash-free\n${model('DeepSeek V4.1 Flash Free', 0, 0, ['high', 'max'])}`,
  `opencode/claude-opus-5-5\n${model('Claude Opus 5.5', 5, 25, [])}`,
].join('\n')

export const RUN = [
  '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}',
  '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"edit","state":{"status":"completed","title":"src/a.ts"}}}',
  '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"done"}}',
  '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","cost":0}}',
].join('\n')

export const REPLY = {
  type: 'message',
  role: 'assistant',
  model: 'kimi-k3',
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: 'look at the file' },
    { type: 'text', text: 'Reading it.' },
    { type: 'tool_use', id: 'functions.Read:0', name: 'Read', input: { file_path: '/x.ts' } },
  ],
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
}

export function engine(on: any, store: Map<string, unknown>, spawned: string[][], fetched: any[]) {
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__opencode-go__${e.name}` } }))
  on('tool.list', () => ({ value: [{ name: 'Read', description: '', mcp: false }, { name: 'Bash', description: '', mcp: false }, { name: 'Agent', description: '', mcp: false }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.read', () => ({ value: '{"opencode":{"type":"api","key":"test-key"}}' }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Fix /x.ts', toolUses: [] },
      { role: 'assistant', text: 'Looking.', toolUses: [{ tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'ls' }, text: 'x.ts' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: 'x.ts', isError: false }] },
    ],
  }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
  on('http.fetch', (_: any, e: any) => {
    // session.start pings the local decision models; none runs here, and the pings are not counted.
    if (e.url.startsWith('http://127.0.0.1:')) return { value: { status: 503, ok: false, headers: {}, text: '' } }
    return (fetched.push(e), { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(REPLY) } })
  })
  on('process.run', (_: any, e: any) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('models') ? MODELS : '/usr/bin/opencode\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('process.spawn', async function* (_: any, e: any) {
    spawned.push([...e.argv])
    yield { stream: 'stdout', text: RUN + '\n' }
    return { value: { code: 0, signal: null } }
  })
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'text', index: 0, text: 'from claude' }
    return { turnId: e.turnId, index: e.index, answer: 'from claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
}

export async function ready(ui: any) {
  // The catalog loads in the background after session.start.
  for (let i = 0; i < 100 && (await ui.find({ type: 'Text', text: /FREE$/ })) === undefined; i++) {
    await new Promise(r => setTimeout(r, 10))
  }
}

export async function step($: any) {
  const chunks: any[] = []
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })[Symbol.asyncIterator]()
  while (true) {
    const r = await stream.next()
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}

