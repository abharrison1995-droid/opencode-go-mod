import type { EngineInterface } from 'claude-code'

import type { Catalog, WorkerModel } from '../types'

export const isFree = (m: WorkerModel) => m.input === 0 && m.output === 0
export const price = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, '') : n}`
export const fullId = (id: string) => (id.includes('/') ? id : `opencode-go/${id}`)

const MAKERS: [RegExp, string][] = [
  [/^kimi/, 'Moonshot AI'],
  [/^glm/, 'Z.ai'],
  [/^deepseek/, 'DeepSeek'],
  [/^qwen/, 'Qwen'],
  [/^minimax/, 'MiniMax'],
  [/^mimo/, 'Xiaomi'],
  [/^grok/, 'xAI'],
  [/^gpt/, 'OpenAI'],
  [/^claude/, 'Anthropic'],
  [/^gemini/, 'Google'],
  [/^muse/, 'Meta'],
  [/^hy\d/, 'Tencent'],
  [/^longcat/, 'Meituan'],
  [/^step/, 'StepFun'],
  [/^nemotron/, 'NVIDIA'],
  [/^mistral/, 'Mistral'],
]

export const makerOf = (id: string) => {
  const bare = id.split('/')[1] ?? id
  return MAKERS.find(([re]) => re.test(bare))?.[1] ?? 'Other'
}

export async function findOpencode($: EngineInterface): Promise<string | undefined> {
  const which = await $.process.run(['sh', '-c', 'command -v opencode'])
  if (which.exitCode === 0 && which.stdout.trim() !== '') return which.stdout.trim()
  const home = await $.env.get('HOME')
  if (home === undefined) return undefined
  for (const dir of ['.opencode/bin', '.local/bin', '.bun/bin', '.npm-global/bin']) {
    const path = `${home}/${dir}/opencode`
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat !== undefined) return path
  }
  return undefined
}

// `opencode models --verbose` prints each model as a `provider/id` line followed by its JSON.
export function parseModels(out: string): WorkerModel[] {
  const models: WorkerModel[] = []
  for (const block of out.split(/^(?=(?:opencode|opencode-go)\/\S+$)/m)) {
    const nl = block.indexOf('\n')
    if (nl < 0) continue
    const id = block.slice(0, nl).trim()
    let m: any
    try {
      m = JSON.parse(block.slice(nl + 1))
    } catch {
      continue
    }
    if (m.status === 'deprecated') continue
    models.push({
      id,
      name: m.name ?? id,
      source: id.startsWith('opencode-go/') ? 'go' : 'zen',
      maker: makerOf(id),
      input: Number(m.cost?.input ?? 0),
      output: Number(m.cost?.output ?? 0),
      efforts: Object.keys(m.variants ?? {}),
      maxOutput: Number(m.limit?.output ?? 32_000),
      context: Number(m.limit?.context ?? 128_000),
    })
  }
  return models
}

// What the panel lists: every free model (Go's copy first), and Go's paid ones. Zen's paid
// models bill pay-as-you-go credit, not the Go plan, so they are left out.
export function worker(models: WorkerModel[]) {
  const goFree = new Set(models.filter(m => m.source === 'go' && isFree(m)).map(m => m.id.split('/')[1]))
  const free = models
    .filter(m => isFree(m) && (m.source === 'go' || !goFree.has(m.id.split('/')[1])))
    .sort((a, b) => a.name.localeCompare(b.name))
  const paid = models
    .filter(m => m.source === 'go' && !isFree(m))
    .sort((a, b) => a.input + a.output - (b.input + b.output))
  return { free, paid }
}

const CACHE = 'catalog'

const isModel = (m: unknown): m is WorkerModel => {
  if (m === null || typeof m !== 'object') return false
  const x = m as WorkerModel
  return (
    typeof x.id === 'string' &&
    typeof x.name === 'string' &&
    (x.source === 'go' || x.source === 'zen') &&
    typeof x.maker === 'string' &&
    typeof x.input === 'number' &&
    typeof x.output === 'number' &&
    Array.isArray(x.efforts) &&
    typeof x.maxOutput === 'number'
  )
}

// `opencode models --verbose` takes seconds; the last list the panel saw is good enough to draw at
// once, and the fresh one replaces it when it arrives.
export async function readCache($: EngineInterface): Promise<WorkerModel[] | undefined> {
  const held = (await $.store.get(CACHE).catch(() => undefined)) as { models?: unknown } | undefined
  if (held === null || typeof held !== 'object' || !Array.isArray(held.models)) return undefined
  // Caches written before models carried their context window get the usual default.
  const models = held.models.filter(isModel).map(m => ({ ...m, context: typeof m.context === 'number' ? m.context : 128_000 }))
  return models.length > 0 ? models : undefined
}

export async function writeCache($: EngineInterface, models: WorkerModel[]) {
  await $.store.set(CACHE, { at: Date.now(), models }).catch(() => undefined)
}

export async function loadCatalog($: EngineInterface): Promise<Catalog> {
  const bin = await findOpencode($)
  if (bin === undefined) return { status: 'error', models: [], error: 'opencode CLI not found' }
  const out = await $.process
    .run([bin, 'models', '--verbose'], { timeoutMs: 60_000 })
    .catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const models = parseModels(out.stdout.replace(/\x1b\[[0-9;]*m/g, ''))
  return models.length > 0
    ? { status: 'ready', models }
    : { status: 'error', models: [], error: out.stderr.trim().split('\n').at(-1) || 'no models listed' }
}
