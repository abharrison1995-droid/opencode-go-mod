import type { Batch, BatchSummary, Effort, Job, LocalServer, Preset, WorkerModel } from '../types'
import { isFree, isPlan, price } from './catalog'
import type { LocalSpec } from './local'
import { ageOf, ICONS, shortModel } from './panel'

// The `/opencode` subcommands' parsing and text. register.tsx reads and changes the state around these.

export const HELP = [
  'OpenCode commands:',
  '  /opencode                      open the panel',
  '  /opencode model <name>         pick the worker model',
  '  /opencode effort <level>       set reasoning: low, medium, high, xhigh, max',
  '  /opencode chat on|off          send this chat through OpenCode Go',
  '  /opencode models [free|paid|zai|gemini] list models',
  '  /opencode preset [name]        apply or list model presets',
  '  /opencode batches              list this chat\'s batches',
  '  /opencode cancel <id>|all      stop a job, batch or every run',
  '  /opencode diff <batch> <task>  show a task branch\'s diff',
  '  /opencode merge <batch> <task> merge a task branch',
  '  /opencode discard <batch> <task> remove a task\'s worktree and branch',
  '  /opencode resume <batch> <task> continue a failed or cancelled task',
  '  /opencode history              recent batches and spend by model',
  '  /opencode status               what is running and what it cost',
  '  /opencode local [start|stop|setup] [kev|laya]  local decision models',
  '  /opencode freebuff             show interactive Freebuff handoff guidance',
  '  /opencode selftest             check opencode, model sources, local models, hangs, rate limits and notifications',
  '  /opencode help                 this list',
].join('\n')

export function parseArgs(args: string) {
  const trimmed = args.trim()
  const gap = trimmed.indexOf(' ')
  const sub = (gap < 0 ? trimmed : trimmed.slice(0, gap)).toLowerCase()
  const rest = gap < 0 ? '' : trimmed.slice(gap + 1).trim()
  return { sub, rest }
}

// One model by exact id, bare id or a unique part of its id or name; otherwise the text to show.
export function matchModel(list: WorkerModel[], rest: string, full: (id: string) => string): { model: WorkerModel } | { text: string } {
  const q = rest.toLowerCase()
  const exact = list.find(m => m.id === rest) ?? list.find(m => m.id === full(rest))
  const found = exact !== undefined ? [exact] : list.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  if (found.length > 1) {
    const ids = found.slice(0, 8).map(m => m.id)
    return { text: `Several match: ${ids.join(', ')}${found.length > 8 ? ' …' : ''}` }
  }
  const only = found[0]
  if (only === undefined) return { text: `No model matches "${rest}". Try /opencode models.` }
  return { model: only }
}

export function effortText(level: Effort, known: WorkerModel | undefined) {
  const note =
    known !== undefined && !known.efforts.includes(level)
      ? ` (${known.name} takes ${known.efforts.join(', ') || 'no reasoning levels'}; it runs at its default)`
      : ''
  return `Reasoning: ${level}${note}`
}

export function modelsText(free: WorkerModel[], paid: WorkerModel[], plan: WorkerModel[], rest: string, gemini: WorkerModel[] = []) {
  const line = (m: WorkerModel) => `${m.id} · ${isPlan(m) ? 'Z.AI plan' : m.source === 'gemini' ? `Google AI Pro · ${m.efforts.join('/')}` : isFree(m) ? 'free' : `${price(m.input)}/${price(m.output)}`}`
  const sections: [string, WorkerModel[]][] = []
  if (rest === '' || rest === 'free') sections.push(['FREE', free])
  if (rest === '' || rest === 'paid') sections.push(['PAID', paid])
  if (rest === '' || rest === 'zai') sections.push(['Z.AI PLAN', plan])
  if (rest === '' || rest === 'gemini') sections.push(['GEMINI (Google AI Pro via Antigravity)', gemini])
  return sections.map(([title, list]) => `${title}\n${list.length ? list.map(line).join('\n') : '(none)'}`).join('\n\n')
}

// Installing Kev and Laya takes minutes and gigabytes, so the mod gives the command rather than running it.
export function setupText(root: string, dir: string, only?: string) {
  const args = [`--dir ${dir}`, ...(only === 'kev' || only === 'laya' ? [`--only ${only}`] : [])].join(' ')
  return [
    `To install ${only === 'kev' ? 'Kev' : only === 'laya' ? 'Laya' : 'Kev and Laya'} into ${dir}, run in a terminal (needs git and uv):`,
    '',
    `  ${root}/scripts/setup-local.sh ${args}`,
    '',
    'Add --dry-run to see the steps first. Then start them from the panel or with /opencode local start.',
  ].join('\n')
}

export function localText(specs: LocalSpec[], all: Record<string, LocalServer>) {
  return specs.map(x => `${x.label} :${x.port} · ${all[x.name]?.status ?? 'off'}${all[x.name]?.error ? ` · ${all[x.name]?.error}` : ''}`).join('\n')
}

export function statusText(o: { model: string; level: Effort; isChat: boolean; running: Job[]; batches: Batch[]; session: number; runs: number; total: number }) {
  const live = o.batches.filter(b => b.status === 'running')
  return [
    `Worker: ${o.model} · ${o.level}`,
    `Chat mode: ${o.isChat ? 'on' : 'off'}`,
    `Running delegate jobs: ${o.running.length}`,
    live.length
      ? `Batches: ${live.length} running\n${live.map(b => `  ${b.title} · ${b.tasks.filter(t => t.status === 'done').length}/${b.tasks.length}`).join('\n')}`
      : 'Batches: none running',
    `Spend: $${o.session.toFixed(4)} this chat over ${o.runs} runs · $${o.total.toFixed(2)} all time`,
  ].join('\n')
}

export function presetsText(prefix: string, model: string, level: Effort, presets: Preset[]) {
  const rows = presets.map(
    (p: Preset) => `${p.name}${p.model === model && p.effort === level ? ' (current)' : ''} · ${p.model} · ${p.effort} · ${p.note}`,
  )
  return [prefix, ...rows].filter(line => line !== '').join('\n')
}

export function batchesText(list: Batch[]) {
  if (list.length === 0) return 'No batches in this chat.'
  const lines: string[] = []
  for (const b of [...list].sort((a, c) => c.startedAt - a.startedAt)) {
    const done = b.tasks.filter(t => t.status === 'done').length
    const cost = b.tasks.reduce((n, t) => n + t.cost, 0)
    lines.push(`${b.id} · ${b.title} · ${b.status} · ${done}/${b.tasks.length} · $${cost.toFixed(4)}`)
    for (const t of b.tasks) lines.push(`  ${ICONS[t.status]} ${t.id} ${t.status}`)
  }
  return lines.join('\n')
}

// A job by exact id or unique prefix; otherwise the text to show.
export function matchJob(list: Job[], rest: string): { job: Job } | { text: string } {
  const exact = list.find(j => j.id === rest)
  const matches = exact !== undefined ? [exact] : list.filter(j => j.id.startsWith(rest))
  if (matches.length > 1) return { text: `Several jobs match: ${matches.map(j => j.id).join(', ')}` }
  const only = matches[0]
  if (only === undefined) return { text: `Nothing matches "${rest}".` }
  return { job: only }
}

export function diffText(text: string) {
  const lines = text.split('\n')
  const shown = lines.slice(0, 200).join('\n')
  return lines.length > 200 ? `${shown}\n… ${lines.length - 200} more lines` : shown
}

export function historyText(history: BatchSummary[], spendByModel: Record<string, number>) {
  const finished = [...history].slice(-10).reverse()
  const byModel = Object.entries(spendByModel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, usd]) => `${shortModel(id)} $${usd.toFixed(2)}`)
  const lines = [
    finished.length === 0
      ? 'No finished batches yet.'
      : finished.map(entry => `${entry.title} · ${entry.status} · ${entry.done}/${entry.tasks} · $${entry.cost.toFixed(4)} · ${ageOf(entry.endedAt)}`).join('\n'),
    byModel.length > 0 ? `Spend by model:\n${byModel.join('\n')}` : '',
  ]
  return lines.filter(line => line !== '').join('\n\n')
}


/** No supported free headless/SDK interface exists today. */
export function freebuffText(task = ''): string {
  return [
    'Freebuff is currently interactive-only and cannot be an unattended worker or automatic fallback.',
    'Follow the official Freebuff installation instructions, sign in normally, and launch freebuff from your project directory.',
    'Paste the task into the Freebuff chat. Do not attempt to reuse device OAuth tokens in an undocumented API or bypass advertisements.',
    ...(task.trim() ? ['', 'Task to paste into Freebuff:', task.trim()] : []),
    'Headless support request: https://github.com/CodebuffAI/freebuff/issues/947',
  ].join('\n')
}
