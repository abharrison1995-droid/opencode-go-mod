import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Batch, BatchSummary, BatchTask, Catalog, Effort, Job, LocalName, LocalServer, ModelHealth, Phase, Preset, Preview, Spend, WorkerModel } from '../types'
import { batchSpecs, checkTasks, commitTask, prepareDir, rememberBatch, runBatch } from './batch'
import type { BatchRunSpec, BatchTaskSpec, Isolation, RunnerDefaults, TaskResult } from './batch'
import { colorOf, findOpencode, fullId, isFree, loadCatalog, price, readCache, worker, writeCache } from './catalog'
import { chatTools, explainError, readKey, requestBody, sendWithRetry, toMessages } from './chat'
import { cancel, track, tracked, untrack } from './control'
import { attachedChars, budgetMessage, contextVerdict, contextWarning, dailySpent, formatReport, localDate, notify, overContext, resolveDir, runResilient } from './delegate'
import { branchDiff, discardTask, mergeBranch, worktreeFolder } from './git'
import { recordRun } from './health'
import { ladder } from './ladder'
import { askLocal, checkQuestions, formatAnswers, LOCAL, localNamed, ownsLocal, ping, startLocal, stopLocal } from './local'
import type { LocalOptions, LocalSpec } from './local'
import type { Rung } from './ladder'
import { PRESETS, presetNamed, rate } from './presets'
import { batchReport, batchShortReport, changedFiles, delegateShort, writeReport } from './report'
import type { ReportExtras } from './report'
import { resolveConflict } from './resolve'
import { reviewTask } from './review'
import { formatChecks, selfTest } from './selftest'

const catalog = atom({ plugin: 'opencode-go', key: 'catalog' } as const, { status: 'loading', models: [] } as Catalog)
const picked = atom({ plugin: 'opencode-go', key: 'model' } as const, '')
const effort = atom({ plugin: 'opencode-go', key: 'effort' } as const, 'medium' as Effort)
const jobs = atom({ plugin: 'opencode-go', key: 'jobs' } as const, [] as Job[])
const chat = atom({ plugin: 'opencode-go', key: 'chat' } as const, false)
const chatSession = atom({ plugin: 'opencode-go', key: 'chatSession' } as const, '')
const query = atom({ plugin: 'opencode-go', key: 'query' } as const, '')
const open = atom({ plugin: 'opencode-go', key: 'open' } as const, {} as Record<string, boolean>)
const batches = atom({ plugin: 'opencode-go', key: 'batches' } as const, [] as Batch[])
const spend = atom({ plugin: 'opencode-go', key: 'spend' } as const, { session: 0, runs: 0 } as Spend)
const recent = atom({ plugin: 'opencode-go', key: 'recent' } as const, [] as string[])
const showAll = atom({ plugin: 'opencode-go', key: 'showAll' } as const, false)
const health = atom({ plugin: 'opencode-go', key: 'health' } as const, {} as Record<string, ModelHealth>)
const history = atom({ plugin: 'opencode-go', key: 'history' } as const, [] as BatchSummary[])
const spendByModel = atom({ plugin: 'opencode-go', key: 'spendByModel' } as const, {} as Record<string, number>)
const preview = atom({ plugin: 'opencode-go', key: 'preview' } as const, null as Preview | null)
const local = atom({ plugin: 'opencode-go', key: 'local' } as const, {} as Record<string, LocalServer>)

const TOOL = 'mcp__opencode-go__delegate'
const BATCH_TOOL = 'mcp__opencode-go__delegate_batch'
const DECIDE_TOOL = 'mcp__opencode-go__decide'
const PANE = 'opencode'
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

let sessionCwd = ''

function describe(models: WorkerModel[], health: Record<string, ModelHealth> = {}) {
  const { free, paid } = worker(models)
  const shown = paid.slice(0, 8).map(m => `${m.id} (${price(m.input)}/${price(m.output)})`).join(', ')
  const more = paid.length > 8 ? `, and ${paid.length - 8} more in the OpenCode panel` : ''
  const shaky = (id: string) => (rate(health[id]) === 'shaky' ? ' (shaky)' : '')
  const unreliable = [...free, ...paid].filter(m => rate(health[m.id]) === 'bad').map(m => m.id)
  return `Delegate a self-contained task to a cheaper model through the user's OpenCode Go subscription, run as a full opencode agent (it can read, edit and run commands in the given directory), and wait for its answer.

Use it for routine, well-specified work: boilerplate, bulk edits, writing tests to a clear spec, summarising files, first drafts, mechanical refactors. Keep planning, judgement and review for yourself, and check what it changed (git diff, tests) before reporting success.

The worker sees nothing of this conversation: put everything it needs in the prompt (files, constraints, acceptance criteria, what to report back). Pass files to attach them. Pass the returned sessionId to continue the same opencode session.

Give every coding task a verify command (e.g. npm test) so failures are fixed by the worker, not by you. Runs resume themselves after rate limits, hangs and failures, and fall back to the fallback model. The user can cancel a run from the OpenCode panel.

Set profile to cheap, reliable or strong to pick a preset model and reasoning level, or ladder to start on a healthy free model and escalate to paid ones if it fails (an explicit model or effort wins). Report defaults to short with the full report in a file; pass full to read it inline.

Several delegate calls in one message may run one after another rather than together; for real parallel work use delegate_batch, which gives each worker its own folder.

Set readOnly true for research, review or planning: it runs opencode's read-only plan agent, which cannot edit files.

FREE: ${free.map(m => `${m.id}${shaky(m.id)}`).join(', ') || 'none right now'}
PAID (cheapest first, $ in/out per Mtok): ${shown || 'none right now'}${more}${unreliable.length > 0 ? `\nUnreliable right now: ${unreliable.join(', ')}` : ''}

Do not pick a paid model other than the user's choice unless they ask. Paid models drain the user's Go allowance.`
}

async function registerTool($: EngineInterface, models: WorkerModel[]) {
  const healthNow = await read($, health)
  await $.tool.register({
    name: 'delegate',
    description: describe(models, healthNow),
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The complete, self-contained task for the worker model.' },
        model: { type: 'string', description: 'provider/model (e.g. opencode-go/kimi-k3), or a bare id under opencode-go/. Default: the model picked in the OpenCode panel.' },
        profile: { type: 'string', enum: ['cheap', 'reliable', 'strong', 'ladder'], description: 'Preset model and reasoning level; an explicit model or effort wins.' },
        effort: { type: 'string', enum: EFFORTS, description: 'Reasoning level. Default: the level picked in the OpenCode panel. Ignored by a model without that level.' },
        dir: { type: 'string', description: 'Directory the worker runs in (absolute, or relative to the session). Default: the session directory.' },
        sessionId: { type: 'string', description: 'An earlier sessionId from this tool, to continue that opencode session.' },
        autoApprove: { type: 'boolean', description: 'Pass --auto so opencode auto-approves permission prompts that are not explicitly denied. Default false.' },
        readOnly: { type: 'boolean', description: "Run opencode's read-only plan agent (--agent plan) for research, review or planning that must not edit files. Default false." },
        files: { type: 'array', items: { type: 'string' }, description: 'Files to attach for the worker (-f each), absolute or relative to dir.' },
        verify: { type: 'string', description: 'Shell command that checks the work, e.g. npm test. Strongly recommended: give every coding task a verify command so failures are fixed by the worker, not by you.' },
        verifyRounds: { type: 'integer', minimum: 0, maximum: 5, description: 'How many times to resume the worker to fix a failed verify. Default 2.' },
        report: { type: 'string', enum: ['short', 'full'], description: 'short (default): a compact summary with the full report in .opencode/reports. full: everything inline.' },
      },
      required: ['prompt'],
    },
  })

  await $.tool.register({
    name: 'delegate_batch',
    description: `Runs several opencode workers at once, each in its own git worktree (or a copy) so they never edit the same files. Tasks may depend on each other and start in dependency order. The report gives each task's status, cost, folder/branch, git diff --stat, actions and answer; review their branches and merge what is good.

Use it for independent pieces of work that can run in parallel, or for a larger job split into clear parts. Workers see nothing of this conversation: put common context in shared and each task's own work in its prompt. Pass files to attach them. Give every coding task a verify command so failures are fixed by the worker, not by you. maxCost stops the batch starting more tasks once it has cost that much. Set profile (cheap, reliable, strong, or ladder: healthy free models first, escalating to paid) for preset models and reasoning; autoMerge merges passing worktree tasks into a branch of its own, autoResolve has workers fix their own merge conflicts, and review has a free model check each task's diff so you read only flagged ones. A task with dependsOn starts from its dependencies' branches.

Runs resume themselves after rate limits, hangs and failures, and fall back to the fallback model. The user can cancel from the OpenCode panel. Report defaults to short with the full report in a file; pass full to read it inline.

With background true it returns at once and the report arrives as a new message when the batch ends.`,
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short name for the batch.' },
        shared: { type: 'string', description: 'Common context prefixed to every task prompt.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files attached to every task, absolute or relative to dir.' },
        verify: { type: 'string', description: 'Default verify command for tasks without one. Strongly recommended for coding tasks.' },
        verifyRounds: { type: 'integer', minimum: 0, maximum: 5, description: 'Default verify fix-up rounds. Default 2.' },
        maxCost: { type: 'number', minimum: 0, description: 'USD; no more tasks start once the batch has cost this much.' },
        profile: { type: 'string', enum: ['cheap', 'reliable', 'strong', 'ladder'], description: 'Default preset model and reasoning for tasks; explicit model/effort wins.' },
        autoResolve: { type: 'boolean', description: 'With autoMerge: a task that conflicts gets the merged branch brought into its worktree, its worker resolves the conflict, and it is merged. Default false.' },
        review: { type: 'boolean', description: "After each task, a read-only reviewer (the reviewModel setting, free by default) checks its diff against its prompt; the report flags concerns. Default false." },
        autoMerge: { type: 'boolean', description: 'With worktree isolation, merge tasks whose verify passed (or that had none) into oc/<batch>-merged. Default false.' },
        report: { type: 'string', enum: ['short', 'full'], description: 'short (default): a compact summary with the full report in .opencode/reports. full: everything inline.' },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique id for this task in the batch.' },
              prompt: { type: 'string', description: 'The complete, self-contained task for this worker.' },
              title: { type: 'string', description: 'A short title for the report. Default: the id.' },
              model: { type: 'string', description: 'provider/model, or a bare id under opencode-go/. Default: the panel model.' },
              profile: { type: 'string', enum: ['cheap', 'reliable', 'strong', 'ladder'], description: 'Preset model and reasoning for this task; an explicit model or effort wins.' },
              effort: { type: 'string', enum: EFFORTS, description: 'Reasoning level. Default: the panel level. Ignored by a model without that level.' },
              readOnly: { type: 'boolean', description: "Run the read-only plan agent (--agent plan) for this task." },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks in this batch that must finish (done) first.' },
              files: { type: 'array', items: { type: 'string' }, description: 'Files to attach for this task, absolute or relative to dir.' },
              verify: { type: 'string', description: 'Shell command that checks this task, e.g. npm test. Overrides the batch verify.' },
              verifyRounds: { type: 'integer', minimum: 0, maximum: 5, description: 'How many times to resume this task to fix a failed verify.' },
            },
            required: ['id', 'prompt'],
          },
        },
        maxParallel: { type: 'integer', minimum: 1, maximum: 6, description: 'How many workers may run at once (1..6). Default 3.' },
        isolation: { type: 'string', enum: ['worktree', 'copy', 'none'], description: "How to keep workers from editing the same files. Default: worktree when dir is in a git repo, else none." },
        dir: { type: 'string', description: 'Base folder (absolute, or relative to the session). Default: the session directory.' },
        autoApprove: { type: 'boolean', description: 'Pass --auto so opencode auto-approves permission prompts that are not explicitly denied. Default false.' },
        background: { type: 'boolean', description: 'Return at once and deliver the report as a new message when the batch ends. Default false.' },
      },
      required: ['title', 'tasks'],
    },
  })
}

async function refresh($: EngineInterface) {
  const previous = await read($, catalog)
  const cached = previous.models.length === 0 ? await readCache($) : undefined
  if (cached !== undefined) {
    await update($, catalog, () => ({ status: 'loading', models: cached }))
    await registerTool($, cached)
  } else {
    await update($, catalog, c => ({ ...c, status: 'loading' }))
  }
  const loaded = await loadCatalog($)
  if (loaded.status === 'ready') {
    await update($, catalog, () => loaded)
    await writeCache($, loaded.models)
    await registerTool($, loaded.models)
    return
  }
  const models = cached ?? previous.models
  await update($, catalog, () => ({ status: 'error', models, error: loaded.error }))
  if (models.length > 0) await registerTool($, models)
}

// Continues a failed or cancelled batch task's opencode session in its folder (the panel's Resume).
export async function resumeTask($: EngineInterface, batchId: string, taskId: string) {
  const held = batchSpecs(batchId)
  const list = await read($, batches)
  const batch = list.find(b => b.id === batchId)
  const task = batch?.tasks.find(t => t.id === taskId)
  if (batch === undefined || task === undefined) {
    $.ui.toast(`No batch task ${batchId}/${taskId}.`)
    return
  }
  if (task.status !== 'failed' && task.status !== 'cancelled' && task.status !== 'skipped') {
    $.ui.toast(`${taskId} is ${task.status}; only failed, cancelled or skipped tasks can resume.`)
    return
  }
  if (task.sessionId === undefined && task.dir === undefined) {
    $.ui.toast(`${taskId} has no session or folder to resume.`)
    return
  }
  const spec = held?.specs.find(t => t.id === taskId)
  if (spec === undefined) {
    $.ui.toast(`No saved prompt for ${batchId}/${taskId}.`)
    return
  }
  const bin = await findOpencode($)
  if (bin === undefined) {
    $.ui.toast('The opencode CLI is not installed or not on PATH.')
    return
  }

  const patch = (change: Partial<BatchTask>) =>
    update($, batches, all =>
      all.map(b => (b.id === batchId ? { ...b, tasks: b.tasks.map(t => (t.id === taskId ? { ...t, ...change } : t)) } : b)),
    )
  const dir = task.dir ?? sessionCwd
  const key = `task:${batchId}:${taskId}`
  const signal = track(key)
  $.ui.toast(`Resuming ${taskId}…`)

  void (async () => {
    await patch({ status: 'running', error: undefined, verify: undefined })
    await showStatus($)
    try {
      const outcome = await runResilient(
        $,
        {
          bin,
          model: task.model,
          fallback: held?.defaults.fallback,
          level: task.effort,
          prompt: spec.prompt,
          cwd: dir,
          readOnly: spec.readOnly,
          files: spec.files,
          sessionId: task.sessionId,
          retries: held?.defaults.retries ?? 3,
          stallMs: held?.defaults.stallMs ?? 600_000,
          signal,
          verify: spec.verify,
          verifyRounds: spec.verifyRounds ?? 2,
          onAttempt: async info => {
            await patch({ attempts: info.attempt, model: info.model })
            await showStatus($)
          },
          onStage: async stage => {
            await patch({ stage })
            await showStatus($)
          },
        },
        async run => {
          const last = run.tools.at(-1)
          await patch(last === undefined ? { steps: run.tools.length } : { steps: run.tools.length, last })
          await showStatus($)
        },
      )
      await addSpend($, outcome.run.cost, outcome.model)
      if (task.branch !== undefined) await commitTask($, dir, `opencode ${batchId}/${taskId}: ${task.title}`)

      const failed = outcome.reason !== 'ok'
      const error =
        !failed
          ? undefined
          : outcome.verify !== undefined && !outcome.verify.passed
            ? `verify: FAILED after ${outcome.verify.rounds ?? 0} rounds\n${outcome.verify.output.slice(-1500)}`
            : outcome.run.errors.join('\n') || undefined
      await patch({
        status: outcome.reason === 'cancelled' ? 'cancelled' : failed ? 'failed' : 'done',
        model: outcome.model,
        cost: task.cost + outcome.run.cost,
        steps: outcome.run.tools.length,
        last: outcome.run.tools.at(-1),
        sessionId: outcome.sessionId,
        attempts: outcome.attempts,
        verify: outcome.verify === undefined ? undefined : outcome.verify.passed ? 'passed' : 'failed',
        error,
      })
      await showStatus($)
      $.ui.toast(`${taskId}: ${outcome.reason === 'cancelled' ? 'cancelled' : failed ? 'still failing' : 'done'} on resume.`)
    } catch (err) {
      await patch({ status: 'failed', error: reason(err) })
      await showStatus($)
      $.ui.toast(`${taskId}: resume failed: ${reason(err)}`)
    } finally {
      untrack(key)
    }
  })()
}

async function current($: EngineInterface, defaultModel: string) {
  return (await read($, picked)) || defaultModel
}

async function registerDecide($: EngineInterface) {
  await $.tool.register({
    name: 'decide',
    description: `Ask a small decision model running on this machine (free, private, no network) typed questions about a piece of text, and get calibrated probabilities back in well under a second once loaded. Nothing is generated, so nothing is hallucinated: each answer is a probability over the options you give.

Models: kev (Kev, a Qwen3.5 decision model; the more accurate on unfamiliar questions) and laya (Laya, a ModernBERT decision model; faster, English plus 100+ languages, 512-token English limit). model "both" asks Kev, then Laya (one after the other), and shows them side by side. The first call starts the server, which can take a minute or more (longer on the very first run, which downloads weights).

Question types, keyed by a name you choose:
- noul: yes/no. {"type":"noul","instructions":"Is this about billing?"} → probability of yes
- choice: one of several. {"type":"choice","instructions":"Which team?","criteria":{"billing":"charges, refunds","shipping":"delivery"}}
- score: an ordered scale. {"type":"score","instructions":"How urgent?","criteria":["low","normal","high"]}

Use it for cheap, repeatable judgements: triage, routing, classifying files or messages, flagging risk, checking a rule against a document. Questions cannot read each other. Treat confidence below about 0.6 as unsure and decide those yourself. Accuracy is well below yours, so don't use it for anything that needs reasoning.`,
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['kev', 'laya', 'both'], description: 'Which local model answers. Default kev.' },
        state: { description: 'The text (or a JSON object) the questions are about.' },
        questions: { type: 'object', description: 'Name → {type: noul|choice|score, instructions, criteria?}.' },
        raw: { type: 'boolean', description: 'Return the full JSON answers, with every probability, instead of one line per question.' },
      },
      required: ['state', 'questions'],
    },
  })
}

async function homeDir($: EngineInterface) {
  const { stdout } = await $.process.run(['printenv', 'HOME'])
  return stdout.trim()
}

async function setLocal($: EngineInterface, name: LocalName, patch: Partial<LocalServer>) {
  await update($, local, all => ({ ...all, [name]: { ...(all[name] ?? { status: 'off' }), ...patch } }))
}

// `cache` holds the folder once found, so HOME is read only the first time.
async function localOpts($: EngineInterface, options: Parameters<Register>[1], cache: { dir: string }): Promise<LocalOptions> {
  if (cache.dir === '') cache.dir = `${await homeDir($)}/local-models`
  return { dir: cache.dir, kevRun: String(options.kevModel ?? '') || 'jaredpalmer/kev-0.8b', device: String(options.localDevice ?? '') || 'auto', layaDevice: String(options.layaDevice ?? '') || 'cpu', kevGpuGb: Number(options.kevGpuGb ?? 0) || 0, root: $.plugin.root }
}

async function bringUp($: EngineInterface, spec: LocalSpec, opts: LocalOptions) {
  return startLocal($, spec, opts, patch => setLocal($, spec.name, patch))
}

async function refreshLocal($: EngineInterface) {
  for (const spec of LOCAL) {
    const now = (await read($, local))[spec.name]?.status
    if (now === 'starting') continue
    const up = await ping($, spec)
    if (up && now !== 'ready') await setLocal($, spec.name, { status: 'ready', error: undefined })
    if (!up && now === 'ready') await setLocal($, spec.name, { status: 'off' })
  }
}

async function askOne($: EngineInterface, spec: LocalSpec, opts: LocalOptions, state: unknown, questions: unknown, raw: boolean) {
  const up = await bringUp($, spec, opts)
  if (!up.ok) return `${spec.label}: could not start. ${up.error}\nIs it installed in ${opts.dir}? (/opencode local status)`
  const t0 = Date.now()
  const got = await askLocal($, spec, state, questions)
  if ('error' in got) return `${spec.label}: ${got.error}`
  const ms = got.latencyMs ?? Date.now() - t0
  await setLocal($, spec.name, { status: 'ready', calls: ((await read($, local))[spec.name]?.calls ?? 0) + 1, lastMs: ms })
  return `${spec.label} (${Math.round(ms)} ms)\n${raw ? JSON.stringify(got.answers, null, 2) : formatAnswers(got.answers)}`
}

async function pick($: EngineInterface, id: string) {
  await update($, picked, () => id)
  await $.store.set('model', id)
  const list = [id, ...(await read($, recent)).filter(r => r !== id)].slice(0, 5)
  await update($, recent, () => list)
  await $.store.set('recent', list)
}

async function pickEffort($: EngineInterface, level: Effort) {
  await update($, effort, () => level)
  await $.store.set('effort', level)
}

async function setChat($: EngineInterface, on: boolean, model: string) {
  await update($, chat, () => on)
  if (on && (await read($, chatSession)) === '') await update($, chatSession, () => crypto.randomUUID())
  $.ui.toast(on ? `This chat now runs on ${model}.` : 'This chat is back on Claude.')
}

// One line for every delegate job and batch task, so parallel calls do not clear each other.
async function showStatus($: EngineInterface) {
  const running = await read($, jobs)
  const tasks = (await read($, batches)).flatMap(b => b.tasks.filter(t => t.status === 'running'))
  const retry = (attempt: number | undefined) => (attempt !== undefined && attempt > 1 ? ` (retry ${attempt})` : '')
  const all = [
    ...running.map(j => ({ model: j.model, steps: j.steps, last: j.last, attempt: j.attempt })),
    ...tasks.map(t => ({ model: t.model, steps: t.steps, last: t.last, attempt: t.attempts })),
  ]
  if (all.length === 0) {
    $.ui.status(undefined)
  } else if (all.length === 1) {
    const one = all[0]
    const short = one.model.split('/')[1] ?? one.model
    $.ui.status(`opencode ${short}: ${one.steps} steps${retry(one.attempt)}${one.last ? ` · ${one.last.slice(0, 50)}` : ''}`)
  } else {
    const parts = all.map(r => `${r.model.split('/')[1] ?? r.model}:${r.steps}${retry(r.attempt)}`).join(', ')
    $.ui.status(`opencode: ${all.length} running · ${parts}`)
  }
}

async function addSpend($: EngineInterface, cost: number, model: string) {
  await update($, spend, s => ({ session: s.session + cost, runs: s.runs + 1 }))
  await update($, spendByModel, m => ({ ...m, [model]: (m[model] ?? 0) + cost }))
  await $.store.set('spendByModel', await read($, spendByModel))
  const total = await $.store.get('spendTotal')
  await $.store.set('spendTotal', (typeof total === 'number' ? total : 0) + cost)
  const day = localDate(Date.now())
  const spent = await dailySpent($, day)
  await $.store.set('spendDaily', { date: day, usd: spent + cost })
}

function taskId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function reason(err: unknown) {
  if (err instanceof Error) return err.message
  const message = (err as { message?: unknown } | undefined)?.message
  return typeof message === 'string' ? message : String(err)
}

function batchId() {
  return `b${Math.random().toString(36).slice(2, 8).padEnd(6, '0').slice(0, 6)}`
}

const ICONS: Record<BatchTask['status'], string> = { pending: '○', running: '◐', done: '●', failed: '✕', skipped: '–', cancelled: '⊘' }

// A card in the AGENTS section: a running delegate job, or a running task of a batch.
type Agent = {
  key: string
  cancelKey: string
  model: string
  effort?: string
  steps: number
  last?: string
  attempt?: number
  stage?: Phase
  batch?: { title: string; task: string; verify?: 'passed' | 'failed' }
}

type CardStage = 'starting' | 'working' | 'retrying' | Phase

const STAGES: Record<CardStage, { icon: string; word: string; color: string }> = {
  starting: { icon: '◐', word: 'starting', color: 'subtle' },
  working: { icon: '●', word: 'working', color: 'suggestion' },
  retrying: { icon: '↻', word: 'retrying', color: 'warning' },
  verifying: { icon: '◆', word: 'verifying', color: 'permission' },
  reviewing: { icon: '◇', word: 'reviewing', color: 'permission' },
}

function stageOf(a: Pick<Agent, 'steps' | 'attempt' | 'stage'>): CardStage {
  if (a.stage !== undefined) return a.stage
  if (a.attempt !== undefined && a.attempt > 1) return 'retrying'
  return a.steps === 0 ? 'starting' : 'working'
}

type TaskAction = 'diff' | 'merge' | 'discard'

function isHealthMap(v: unknown): v is Record<string, ModelHealth> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v).every(h => h !== null && typeof h === 'object' && !Array.isArray(h))
}

function isNumberMap(v: unknown): v is Record<string, number> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v).every(n => typeof n === 'number')
}

function shortModel(id: string) {
  return id.split('/')[1] ?? id
}

function ageOf(at: number) {
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

async function applyPreset($: EngineInterface, preset: Preset) {
  await pick($, preset.model)
  await pickEffort($, preset.effort)
}

// Batches made before top/base were recorded still know their worktree's folder; the
// folder is `<top>-opencode/<batch>-<task>`, so its head is the repo.
function repoOf(batch: Batch, task: BatchTask) {
  if (batch.top !== undefined) return { top: batch.top, base: batch.base }
  const at = task.dir === undefined ? -1 : task.dir.indexOf('-opencode/')
  return at > 0 ? { top: task.dir?.slice(0, at), base: batch.base } : { top: batch.top, base: batch.base }
}

// The panel's Diff/Merge/Discard buttons and /opencode diff|merge|discard share these.
async function taskAction($: EngineInterface, kind: TaskAction, batchId: string, taskId: string): Promise<{ ok: boolean; text: string }> {
  const batch = (await read($, batches)).find(b => b.id === batchId)
  if (batch === undefined) return { ok: false, text: `No batch ${batchId}.` }
  const task = batch.tasks.find(t => t.id === taskId)
  if (task === undefined) return { ok: false, text: `No task ${taskId} in batch ${batchId}.` }

  const repo = repoOf(batch, task)

  if (kind === 'diff') {
    if (task.branch === undefined || repo.top === undefined) {
      return { ok: false, text: `${batchId}/${taskId} has no branch to diff.` }
    }
    const diff = await branchDiff($, repo.top, repo.base ?? 'HEAD', task.branch)
    await update($, preview, () => ({ title: `${task.id} diff`, text: diff.text }))
    return diff
  }

  if (kind === 'merge') {
    if (task.status !== 'done' || task.branch === undefined) return { ok: false, text: `${batchId}/${taskId} has no finished branch to merge.` }
    if (task.merged === true) return { ok: true, text: `${batchId}/${taskId} is already merged.` }
    if (repo.top === undefined) return { ok: false, text: `Batch ${batchId} has no repo top to merge into.` }
    const merged = await mergeBranch($, repo.top, task.branch)
    if (merged.ok) {
      await update($, batches, list =>
        list.map(b => (b.id === batchId ? { ...b, tasks: b.tasks.map(t => (t.id === taskId ? { ...t, merged: true } : t)) } : b)),
      )
    }
    $.ui.toast(merged.ok ? `Merged ${task.branch}.` : `Merge failed: ${merged.text.split('\n')[0] ?? ''}`)
    return merged
  }

  if (task.branch === undefined) return { ok: false, text: `${batchId}/${taskId} has no branch to discard.` }
  if (batch.status === 'running') return { ok: false, text: `Batch ${batchId} is still running.` }
  if (repo.top === undefined) return { ok: false, text: `Batch ${batchId} has no repo top to discard from.` }
  const discarded = await discardTask($, repo.top, worktreeFolder(repo.top, batch.id, task.id), task.branch)
  if (discarded.ok) {
    await update($, batches, list =>
      list.map(b =>
        b.id === batchId
          ? {
              ...b,
              tasks: b.tasks.map(t => {
                if (t.id !== taskId) return t
                const next = { ...t, last: 'discarded' }
                delete next.branch
                return next
              }),
            }
          : b,
      ),
    )
  }
  $.ui.toast(discarded.ok ? `Discarded ${batchId}/${taskId}.` : `Discard failed: ${discarded.text.split('\n')[0] ?? ''}`)
  return discarded
}

async function noteHealth($: EngineInterface, model: string, reason: string, ms: number, error?: string) {
  if (reason === 'cancelled') return
  // Parallel tasks finish together: update in place so no record is lost.
  await update($, health, h => recordRun(h, model, reason, ms, error))
  await $.store.set('health', await read($, health))
}

async function addHistory($: EngineInterface, batch: Batch) {
  const entry: BatchSummary = {
    id: batch.id,
    title: batch.title,
    status: batch.status,
    startedAt: batch.startedAt,
    endedAt: batch.endedAt ?? Date.now(),
    cost: batch.tasks.reduce((sum, t) => sum + t.cost, 0),
    tasks: batch.tasks.length,
    done: batch.tasks.filter(t => t.status === 'done').length,
    reportPath: batch.reportPath,
  }
  await update($, history, list => [...list, entry].slice(-30))
  await $.store.set('history', await read($, history))
}

// Ladder rungs after the first, as runResilient fallbacks, each with a level its model offers.
function laterRungs(rungs: Rung[], models: WorkerModel[]) {
  if (rungs.length < 2) return undefined
  return rungs.slice(1).map(rung => {
    const known = models.find(m => m.id === rung.model)
    const fits = rung.effort !== undefined && (known === undefined || known.efforts.includes(rung.effort))
    return { model: rung.model, level: fits ? rung.effort : undefined, retries: rung.retries }
  })
}

async function git($: EngineInterface, argv: string[]) {
  return $.process.run(argv).catch(err => ({ exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }))
}

// Merges passing task branches into oc/<id>-merged through a temporary worktree, so the
// user's checkout and current branch never move.
async function autoMerge(
  $: EngineInterface,
  batch: Batch,
  extras: ReportExtras,
  resolve?: (task: BatchTask, files: string[]) => Promise<boolean>,
) {
  if (batch.top === undefined) return
  const top = batch.top
  const branch = `oc/${batch.id}-merged`
  const base = batch.base ?? 'HEAD'
  const made = await git($, ['git', '-C', top, 'branch', branch, base])
  if (made.exitCode !== 0) return
  batch.integration = branch

  const folder = worktreeFolder(top, batch.id, 'merged')
  const added = await git($, ['git', '-C', top, 'worktree', 'add', folder, branch])
  if (added.exitCode !== 0) return

  try {
    for (const task of batch.tasks) {
      if (task.status !== 'done' || task.branch === undefined || task.verify === 'failed') continue
      const merged = await git($, ['git', '-C', folder, 'merge', '--no-ff', '--no-edit', task.branch])
      if (merged.exitCode === 0) {
        task.merged = true
        extras.merged ??= []
        extras.merged.push(task.id)
        continue
      }
      const conflicts = await git($, ['git', '-C', folder, 'diff', '--name-only', '--diff-filter=U'])
      const files = conflicts.exitCode === 0 ? conflicts.stdout.split('\n').map(line => line.trim()).filter(line => line !== '') : []
      await git($, ['git', '-C', folder, 'merge', '--abort'])
      if (resolve !== undefined && (await resolve(task, files))) {
        const again = await git($, ['git', '-C', folder, 'merge', '--no-ff', '--no-edit', task.branch])
        if (again.exitCode === 0) {
          task.merged = true
          extras.merged ??= []
          extras.merged.push(task.id)
          extras.resolved ??= []
          extras.resolved.push(task.id)
          continue
        }
        await git($, ['git', '-C', folder, 'merge', '--abort'])
      }
      extras.conflicts ??= {}
      extras.conflicts[task.id] = files
    }
  } finally {
    await git($, ['git', '-C', top, 'worktree', 'remove', '--force', folder])
  }
}

export const register: Register = (on, options) => {
  const defaultModel = fullId(String(options.defaultModel ?? 'opencode-go/kimi-k3'))
  const localDir = { dir: String(options.localModelsDir ?? '').trim() }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionCwd = e.cwd
    const storedModel = await $.store.get('model')
    const storedEffort = await $.store.get('effort')
    if (typeof storedModel === 'string' && (await read($, picked)) === '') await update($, picked, () => storedModel)
    if (EFFORTS.includes(storedEffort as Effort)) await update($, effort, () => storedEffort as Effort)
    const storedRecent = await $.store.get('recent')
    if (Array.isArray(storedRecent) && storedRecent.every(r => typeof r === 'string') && (await read($, recent)).length === 0) {
      await update($, recent, () => storedRecent as string[])
    }
    const storedHealth = await $.store.get('health')
    if (isHealthMap(storedHealth) && Object.keys(await read($, health)).length === 0) await update($, health, () => storedHealth)
    const storedHistory = await $.store.get('history')
    if (Array.isArray(storedHistory) && (await read($, history)).length === 0) await update($, history, () => storedHistory as BatchSummary[])
    const storedSpendByModel = await $.store.get('spendByModel')
    if (isNumberMap(storedSpendByModel) && Object.keys(await read($, spendByModel)).length === 0) {
      await update($, spendByModel, () => storedSpendByModel)
    }

    await registerTool($, [])
    await registerDecide($)
    void refreshLocal($)
    await $.command.register({ name: 'opencode', description: 'OpenCode panel and settings: /opencode [model <name> | effort <level> | chat on|off | models | status | help]' })
    void refresh($)
    void $.ui.open({ id: PANE, title: 'OpenCode' })
    return started
  })

  on('command.run', { command: 'opencode' }, async ($, e) => {
    const args = e.args.trim()
    const gap = args.indexOf(' ')
    const sub = (gap < 0 ? args : args.slice(0, gap)).toLowerCase()
    const rest = gap < 0 ? '' : args.slice(gap + 1).trim()
    const help = [
      'OpenCode commands:',
      '  /opencode                      open the panel',
      '  /opencode model <name>         pick the worker model',
      '  /opencode effort <level>       set reasoning: low, medium, high, xhigh, max',
      '  /opencode chat on|off          send this chat through OpenCode Go',
      '  /opencode models [free|paid]   list models',
      '  /opencode preset [name]        apply or list model presets',
      '  /opencode batches              list this chat\'s batches',
      '  /opencode cancel <id>|all      stop a job, batch or every run',
      '  /opencode diff <batch> <task>  show a task branch\'s diff',
      '  /opencode merge <batch> <task> merge a task branch',
      '  /opencode discard <batch> <task> remove a task\'s worktree and branch',
      '  /opencode resume <batch> <task> continue a failed or cancelled task',
      '  /opencode history              recent batches and spend by model',
      '  /opencode status               what is running and what it cost',
      '  /opencode local [start|stop] [kev|laya]  local decision models',
      '  /opencode selftest             check hang detection, rate limits and notifications here',
      '  /opencode help                 this list',
    ].join('\n')

    const models = async () => {
      if ((await read($, catalog)).models.length === 0) await refresh($)
      return (await read($, catalog)).models
    }

    if (sub === '') {
      if ((await read($, catalog)).models.length === 0) void refresh($)
      await $.ui.open({ id: PANE, title: 'OpenCode' })
      const isChat = await read($, chat)
      return { text: `OpenCode panel opened. Worker: ${await current($, defaultModel)} · ${await read($, effort)}${isChat ? ' · chat mode on' : ''}` }
    }

    if (sub === 'help') return { text: help }

    if (sub === 'selftest') return { text: formatChecks(await selfTest($, { bin: await findOpencode($), dir: sessionCwd })) }

    if (sub === 'model') {
      if (rest === '') return { text: 'Usage: /opencode model <name>.' }
      const { free, paid } = worker(await models())
      const list = [...free, ...paid]
      const q = rest.toLowerCase()
      const exact = list.find(m => m.id === rest) ?? list.find(m => m.id === fullId(rest))
      const found = exact !== undefined ? [exact] : list.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      if (found.length === 0) return { text: `No model matches "${rest}". Try /opencode models.` }
      if (found.length > 1) {
        const ids = found.slice(0, 8).map(m => m.id)
        return { text: `Several match: ${ids.join(', ')}${found.length > 8 ? ' …' : ''}` }
      }
      const only = found[0]
      if (only === undefined) return { text: `No model matches "${rest}". Try /opencode models.` }
      await pick($, only.id)
      return { text: `Worker: ${only.name} (${only.id})` }
    }

    if (sub === 'effort') {
      if (!EFFORTS.includes(rest as Effort)) return { text: `Reasoning must be one of ${EFFORTS.join(', ')}.` }
      const level = rest as Effort
      await pickEffort($, level)
      const pickedId = await current($, defaultModel)
      const known = (await read($, catalog)).models.find(m => m.id === pickedId)
      const note =
        known !== undefined && !known.efforts.includes(level)
          ? ` (${known.name} takes ${known.efforts.join(', ') || 'no reasoning levels'}; it runs at its default)`
          : ''
      return { text: `Reasoning: ${level}${note}` }
    }

    if (sub === 'chat') {
      const want = rest.toLowerCase()
      if (want !== 'on' && want !== 'off') return { text: 'Usage: /opencode chat on|off.' }
      const model = await current($, defaultModel)
      if (want === 'on' && !model.startsWith('opencode-go/')) {
        return { text: `Chat mode needs a Go model. ${model} is a Zen model, which OpenCode only serves to its own app. Pick a Go model with /opencode model <name>.` }
      }
      await setChat($, want === 'on', model)
      return { text: want === 'on' ? `Chat mode on: this chat now runs on ${model}.` : 'Chat mode off: this chat is back on Claude.' }
    }

    if (sub === 'models') {
      const { free, paid } = worker(await models())
      const line = (m: WorkerModel) => `${m.id} · ${isFree(m) ? 'free' : `${price(m.input)}/${price(m.output)}`}`
      const sections: [string, WorkerModel[]][] = []
      if (rest !== 'paid') sections.push(['FREE', free])
      if (rest !== 'free') sections.push(['PAID', paid])
      return { text: sections.map(([title, list]) => `${title}\n${list.length ? list.map(line).join('\n') : '(none)'}`).join('\n\n') }
    }

    if (sub === 'local') {
      const [verb = 'status', which = 'all'] = rest.toLowerCase().split(/\s+/).filter(Boolean)
      const specs = which === 'all' ? LOCAL : [localNamed(which)].filter((x): x is LocalSpec => x !== undefined)
      if (specs.length === 0) return { text: `No local model "${which}". Try kev or laya.` }
      if (verb === 'start') {
        const opts = await localOpts($, options, localDir)
        for (const spec of specs) void bringUp($, spec, opts)
        return { text: `Starting ${specs.map(x => x.label).join(' and ')}; the panel shows when ${specs.length > 1 ? 'they are' : 'it is'} ready.` }
      }
      if (verb === 'stop') {
        const lines: string[] = []
        for (const spec of specs) {
          const stopped = await stopLocal(spec.name)
          if (stopped) await setLocal($, spec.name, { status: 'off', error: undefined })
          lines.push(stopped ? `${spec.label} stopped.` : `${spec.label} was not started by this session.`)
        }
        return { text: lines.join('\n') }
      }
      await refreshLocal($)
      const all = await read($, local)
      return { text: specs.map(x => `${x.label} :${x.port} · ${all[x.name]?.status ?? 'off'}${all[x.name]?.error ? ` · ${all[x.name]?.error}` : ''}`).join('\n') }
    }

    if (sub === 'status') {
      const isChat = await read($, chat)
      const running = await read($, jobs)
      const live = (await read($, batches)).filter(b => b.status === 'running')
      const money = await read($, spend)
      const total = Number((await $.store.get('spendTotal')) ?? 0) || 0
      const lines = [
        `Worker: ${await current($, defaultModel)} · ${await read($, effort)}`,
        `Chat mode: ${isChat ? 'on' : 'off'}`,
        `Running delegate jobs: ${running.length}`,
        live.length
          ? `Batches: ${live.length} running\n${live.map(b => `  ${b.title} · ${b.tasks.filter(t => t.status === 'done').length}/${b.tasks.length}`).join('\n')}`
          : 'Batches: none running',
        `Spend: $${money.session.toFixed(4)} this chat over ${money.runs} runs · $${total.toFixed(2)} all time`,
      ]
      return { text: lines.join('\n') }
    }

    if (sub === 'preset') {
      const list = async (prefix: string) => {
        const nowModel = await current($, defaultModel)
        const nowLevel = await read($, effort)
        const rows = PRESETS.map(
          p => `${p.name}${p.model === nowModel && p.effort === nowLevel ? ' (current)' : ''} · ${p.model} · ${p.effort} · ${p.note}`,
        )
        return { text: [prefix, ...rows].filter(line => line !== '').join('\n') }
      }
      if (rest === '') return list('Presets:')
      const preset = presetNamed(rest)
      if (preset === undefined) return list(`Unknown preset "${rest}". Presets:`)
      await applyPreset($, preset)
      return { text: `Preset ${preset.name}: ${preset.model} · ${preset.effort}` }
    }

    if (sub === 'batches') {
      const list = await read($, batches)
      if (list.length === 0) return { text: 'No batches in this chat.' }
      const lines: string[] = []
      for (const b of [...list].sort((a, c) => c.startedAt - a.startedAt)) {
        const done = b.tasks.filter(t => t.status === 'done').length
        const cost = b.tasks.reduce((n, t) => n + t.cost, 0)
        lines.push(`${b.id} · ${b.title} · ${b.status} · ${done}/${b.tasks.length} · $${cost.toFixed(4)}`)
        for (const t of b.tasks) lines.push(`  ${ICONS[t.status]} ${t.id} ${t.status}`)
      }
      return { text: lines.join('\n') }
    }

    if (sub === 'cancel') {
      if (rest === '') return { text: 'Usage: /opencode cancel <id>|all.' }
      if (rest.toLowerCase() === 'all') {
        const ids = tracked()
        const stopped = ids.filter(id => cancel(id)).length
        return { text: stopped > 0 ? `Cancelled ${stopped} run${stopped === 1 ? '' : 's'}.` : 'Nothing was running.' }
      }
      const batch = (await read($, batches)).find(b => b.id === rest)
      if (batch !== undefined) {
        const stopped = cancel(`batch:${batch.id}`)
        return { text: stopped || batch.status === 'running' ? `Cancelling batch ${batch.id}.` : `Batch ${batch.id} is not running.` }
      }
      const list = await read($, jobs)
      const exact = list.find(j => j.id === rest)
      const matches = exact !== undefined ? [exact] : list.filter(j => j.id.startsWith(rest))
      if (matches.length === 0) return { text: `Nothing matches "${rest}".` }
      if (matches.length > 1) return { text: `Several jobs match: ${matches.map(j => j.id).join(', ')}` }
      const only = matches[0]
      if (only === undefined) return { text: `Nothing matches "${rest}".` }
      return { text: cancel(only.id) ? `Cancelling ${only.id}.` : `${only.id} is not running.` }
    }

    if (sub === 'merge' || sub === 'discard' || sub === 'diff' || sub === 'resume') {
      const parts = rest.split(/\s+/).filter(p => p !== '')
      const batch = parts[0]
      const task = parts[1]
      if (batch === undefined || task === undefined) return { text: `Usage: /opencode ${sub} <batch> <task>.` }
      if (sub === 'resume') {
        await resumeTask($, batch, task)
        return { text: `Resuming ${batch}/${task}.` }
      }
      const result = await taskAction($, sub, batch, task)
      if (sub !== 'diff') return { text: result.text }
      const lines = result.text.split('\n')
      const shown = lines.slice(0, 200).join('\n')
      return { text: lines.length > 200 ? `${shown}\n… ${lines.length - 200} more lines` : shown }
    }

    if (sub === 'history') {
      const finished = [...(await read($, history))].slice(-10).reverse()
      const byModel = Object.entries(await read($, spendByModel))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, usd]) => `${shortModel(id)} $${usd.toFixed(2)}`)
      const lines = [
        finished.length === 0
          ? 'No finished batches yet.'
          : finished.map(entry => `${entry.title} · ${entry.status} · ${entry.done}/${entry.tasks} · $${entry.cost.toFixed(4)} · ${ageOf(entry.endedAt)}`).join('\n'),
        byModel.length > 0 ? `Spend by model:\n${byModel.join('\n')}` : '',
      ]
      return { text: lines.filter(line => line !== '').join('\n\n') }
    }

    return { text: `Unknown subcommand. ${help}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (options.orchestrate === false || (await read($, chat))) return composed
    const text = `# Delegating to OpenCode Go
The user has OpenCode Go wired in through the ${TOOL} tool. Act as the orchestrator: plan, split work into independent, clearly specified pieces, hand routine pieces to OpenCode models with ${TOOL} (or ${BATCH_TOOL} to run several at once, each in its own git worktree), and review their output yourself. Do the hard reasoning, architecture and final verification yourself. Do small one-step edits directly when explaining them would cost more than doing them.
The user's chosen worker is ${await current($, defaultModel)} at ${await read($, effort)} reasoning (set in the OpenCode panel).`
    return { sections: [...composed.sections, { id: 'opencode-go:orchestrate', text, scope: 'session' as const }] }
  })

  // Chat mode: the main loop's model requests go to the picked OpenCode Go model instead of Claude.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || !(await read($, chat))) return yield* next(e)

    const modelId = await current($, defaultModel)
    const stop = (text: string) => ({ kind: 'text' as const, index: 0, text })
    const failed = { turnId: e.turnId, index: e.index, toolUses: [], stopReason: 'end_turn' as const, usage: null }
    if (!modelId.startsWith('opencode-go/')) {
      const text = `OpenCode chat mode needs a Go model. ${modelId} is a Zen model, which OpenCode only serves to its own app. Pick a Go model in the OpenCode panel.`
      yield stop(text)
      return { ...failed, answer: text }
    }
    const key = await readKey($)
    if (key === undefined) {
      const text = 'OpenCode chat mode found no OpenCode key. Run `opencode auth login` and choose OpenCode Go.'
      yield stop(text)
      return { ...failed, answer: text }
    }

    const transcript = await $.session.messages()
    if ('deny' in transcript) {
      const text = `OpenCode chat mode could not read the conversation: ${transcript.deny}`
      yield stop(text)
      return { ...failed, answer: text }
    }
    const tools = await chatTools($)
    const { sections } = await $.prompt.compose({ tools: tools.map(t => t.name) })
    const system = sections.map(s => s.text).join('\n\n')
    const model = (await read($, catalog)).models.find(m => m.id === modelId)
    const body = requestBody(modelId, model, await read($, effort), system, tools, toMessages(transcript))

    const short = modelId.split('/')[1]
    $.ui.status(`OpenCode chat: ${short} thinking…`)
    const sent = await sendWithRetry($, key, await read($, chatSession), body, next.signal).finally(() => $.ui.status(undefined))
    if ('aborted' in sent) return { ...failed, answer: '' }
    if ('error' in sent) {
      const text = `OpenCode request failed (${short}): ${explainError(sent.error.status, sent.error.message)}`
      yield stop(text)
      return { ...failed, answer: text }
    }

    const { response } = sent
    let index = 0
    let answer = ''
    const toolUses: { name: string; input: unknown }[] = []
    for (const block of response.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        answer += block.text
        yield { kind: 'text', index: index++, text: block.text }
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        // Gateway ids vary by model; give each call an id the Anthropic API would also accept.
        const id = `toolu_oc${crypto.randomUUID().replace(/-/g, '').slice(0, 22)}`
        toolUses.push({ name: block.name, input: block.input ?? {} })
        yield { kind: 'tool', index, id, name: block.name }
        yield { kind: 'input', index: index++, json: JSON.stringify(block.input ?? {}) }
      }
      // Thinking blocks are left out: they carry no Anthropic signature, and the transcript must
      // stay valid for Claude when the chat switches back.
    }
    const u = response.usage ?? {}
    const usage = {
      model: response.model ?? short ?? modelId,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    }
    const stopReason = toolUses.length > 0 ? 'tool_use' : response.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn'
    yield { kind: 'stop', stopReason, usage }
    return { turnId: e.turnId, index: e.index, answer, toolUses, stopReason, usage }
  })

  on('tool.call', { tool: DECIDE_TOOL }, async ($, e) => {
    const input = e as unknown as { model?: string; state?: unknown; questions?: unknown; raw?: boolean }
    if (input.state === undefined || input.state === '') return { deny: 'decide needs a state: the text the questions are about.' }
    const bad = checkQuestions(input.questions)
    if (bad) return { deny: `decide: ${bad}` }
    const specs = input.model === 'both' ? LOCAL : LOCAL.filter(x => x.name === (localNamed(input.model ?? '')?.name ?? 'kev'))
    const opts = await localOpts($, options, localDir)
    // One model after the other, never both at once: they share the machine's GPU and RAM.
    const parts: string[] = []
    for (const spec of specs) parts.push(await askOne($, spec, opts, input.state, input.questions, input.raw === true))
    return { result: parts.join('\n\n') }
  }).catch(($, e, next) => ({
    deny: 'decide failed unexpectedly. Try /opencode local status.',
  }))

  on('tool.call', { tool: TOOL }, async ($, e, next) => {
    const input = e as unknown as {
      prompt?: string
      model?: string
      profile?: string
      effort?: string
      dir?: string
      sessionId?: string
      autoApprove?: boolean
      readOnly?: boolean
      files?: string[]
      verify?: string
      verifyRounds?: number
      report?: string
    }
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') return { deny: 'delegate needs a prompt.' }

    const bin = await findOpencode($)
    if (bin === undefined) {
      return { deny: 'The opencode CLI is not installed or not on PATH. Ask the user to install it (npm i -g opencode-ai) and run `opencode auth login`, choosing OpenCode Go.' }
    }

    const allModels = (await read($, catalog)).models
    const rungs = input.profile === 'ladder' && !input.model ? ladder(allModels, await read($, health)) : []
    const profile = typeof input.profile === 'string' ? presetNamed(input.profile) ?? (input.profile === 'ladder' ? presetNamed('reliable') : undefined) : undefined
    const model = input.model ? fullId(input.model) : rungs[0]?.model ?? profile?.model ?? (await current($, defaultModel))
    const wanted = input.effort ?? rungs[0]?.effort ?? profile?.effort ?? (await read($, effort))
    const known = allModels.find(m => m.id === model)
    const level = known === undefined || known.efforts.includes(wanted) ? wanted : undefined

    const dir = resolveDir(sessionCwd, input.dir)
    const base = dir ?? sessionCwd
    const files = (Array.isArray(input.files) ? input.files : [])
      .filter(file => typeof file === 'string' && file.trim() !== '')
      .map(file => resolveDir(base, file))
      .filter((file): file is string => file !== undefined)

    const budget = Number(options.dailyBudget ?? 0) || 0
    if (budget > 0 && known !== undefined && !isFree(known)) {
      const spent = await dailySpent($, localDate(Date.now()))
      if (spent >= budget) return { deny: budgetMessage(budget, spent) }
    }

    const verdict = contextVerdict(input.prompt.length + (await attachedChars($, files)), known)
    if (verdict !== undefined && verdict.level === 'over') return { deny: overContext(verdict) }
    const warning = verdict !== undefined && verdict.level === 'warn' ? contextWarning(verdict) : undefined

    const verify = typeof input.verify === 'string' && input.verify.trim() !== '' ? input.verify : undefined
    const verifyRounds = typeof input.verifyRounds === 'number' && Number.isFinite(input.verifyRounds) ? Math.max(0, Math.round(input.verifyRounds)) : 2
    const retries = Math.max(0, Math.round(Number(options.autoRetries ?? 3) || 0))
    const stallMs = Math.max(1, (Number(options.stallMinutes ?? 10) || 10) * 60_000)
    const fallbackSetting = String(options.fallbackModel ?? '')
    const fallback = fallbackSetting === '' ? undefined : fullId(fallbackSetting)

    const job: Job = { id: taskId(), model, effort: level, steps: 0, attempt: 1 }
    const setJob = (patch: Partial<Job>) => update($, jobs, list => list.map(j => (j.id === job.id ? { ...j, ...patch } : j)))
    await update($, jobs, list => [...list, job])
    await showStatus($)

    const signal = track(job.id)
    let attemptModel = model
    let attemptAt = Date.now()
    try {
      const outcome = await runResilient(
        $,
        {
          bin,
          model,
          fallback,
          fallbacks: laterRungs(rungs, allModels),
          firstRetries: rungs[0]?.retries,
          level,
          prompt: input.prompt,
          cwd: base,
          autoApprove: input.autoApprove,
          readOnly: input.readOnly,
          files,
          sessionId: input.sessionId,
          retries,
          stallMs,
          signal,
          verify,
          verifyRounds,
          onAttempt: async info => {
            if (info.attempt > 1) {
              await noteHealth($, attemptModel, info.previous, Date.now() - attemptAt)
              attemptModel = info.model
              attemptAt = Date.now()
            }
            await setJob({ attempt: info.attempt, model: info.model })
            await showStatus($)
          },
          onStage: async stage => {
            await setJob({ stage })
            await showStatus($)
          },
        },
        async run => {
          const last = run.tools.at(-1)
          await setJob(last === undefined ? { steps: run.tools.length } : { steps: run.tools.length, last })
          await showStatus($)
        },
      )

      const failure = [...outcome.run.errors, outcome.stderr].filter(text => text.trim() !== '').join('\n')
      await noteHealth($, attemptModel, outcome.reason, Date.now() - attemptAt, outcome.reason === 'ok' ? undefined : failure)
      await addSpend($, outcome.run.cost, outcome.model)
      const used = (await read($, catalog)).models.find(m => m.id === outcome.model)
      const short = outcome.model.split('/')[1] ?? outcome.model
      const same = outcome.model === model
      const full = formatReport({
        model: outcome.model,
        level: same ? level : undefined,
        wanted: same ? wanted : undefined,
        short,
        run: outcome.run,
        end: outcome.end,
        stderr: outcome.stderr,
        free: used !== undefined && isFree(used),
        attempts: outcome.attempts,
        verify: outcome.verify,
        warning,
      })
      const path = await writeReport($, base, `d-${job.id}`, full)
      const filesChanged = await changedFiles($, base)
      const report =
        input.report === 'full'
          ? full
          : delegateShort({
              model: outcome.model,
              level: same ? level : undefined,
              wanted: same ? wanted : undefined,
              short,
              run: outcome.run,
              end: outcome.end,
              reason: outcome.reason,
              stderr: outcome.stderr,
              free: used !== undefined && isFree(used),
              attempts: outcome.attempts,
              verify: outcome.verify,
              warning,
              files: filesChanged,
              path,
            })
      if (outcome.reason === 'cancelled') return { deny: `opencode run cancelled.\n\n${report}` }
      return outcome.reason === 'ok' ? { result: report } : { deny: `opencode run failed.\n\n${report}` }
    } finally {
      untrack(job.id)
      await update($, jobs, list => list.filter(j => j.id !== job.id))
      await showStatus($)
    }
  }).catch(($, e, next) => ({
    deny: `opencode-go: delegate failed: ${reason(next.error)}`,
  }))

  on('tool.call', { tool: BATCH_TOOL }, async ($, e, next) => {
    type TaskSpec = BatchTaskSpec & { profile?: string }
    const input = e as unknown as {
      title?: string
      tasks?: TaskSpec[]
      maxParallel?: number
      isolation?: Isolation
      dir?: string
      autoApprove?: boolean
      background?: boolean
      shared?: string
      files?: string[]
      verify?: string
      verifyRounds?: number
      maxCost?: number
      profile?: string
      autoMerge?: boolean
      autoResolve?: boolean
      review?: boolean
      report?: string
    }
    if (typeof input.title !== 'string' || input.title.trim() === '') return { deny: 'delegate_batch needs a title.' }
    const specs: TaskSpec[] = Array.isArray(input.tasks) ? input.tasks : []
    if (specs.some(t => t === null || typeof t !== 'object')) return { deny: 'Every task needs an id.' }
    const problem = checkTasks(specs)
    if (problem !== undefined) return { deny: problem }

    const bin = await findOpencode($)
    if (bin === undefined) {
      return { deny: 'The opencode CLI is not installed or not on PATH. Ask the user to install it (npm i -g opencode-ai) and run `opencode auth login`, choosing OpenCode Go.' }
    }

    const base = resolveDir(sessionCwd, input.dir) ?? sessionCwd
    let isolation: Isolation = input.isolation ?? 'none'
    if (input.isolation === undefined) {
      const found = await $.process.run(['git', '-C', base, 'rev-parse', '--show-toplevel']).catch(() => undefined)
      if (found !== undefined && found.exitCode === 0 && found.stdout.trim() !== '') isolation = 'worktree'
    }
    const parallel = typeof input.maxParallel === 'number' && Number.isFinite(input.maxParallel) ? Math.round(input.maxParallel) : 3
    const maxParallel = Math.max(1, Math.min(6, parallel))

    const panelModel = await current($, defaultModel)
    const panelEffort = await read($, effort)
    const models = (await read($, catalog)).models
    const healthNow = await read($, health)
    const ladders = new Map<string, Rung[]>()
    const choose = (t: TaskSpec) => {
      const name = typeof t.profile === 'string' ? t.profile : typeof input.profile === 'string' ? input.profile : undefined
      const rungs = name === 'ladder' && !t.model ? ladder(models, healthNow) : []
      if (rungs.length > 0) ladders.set(t.id, rungs)
      const profile = name === undefined ? undefined : presetNamed(name) ?? (name === 'ladder' ? presetNamed('reliable') : undefined)
      const model = t.model ? fullId(t.model) : rungs[0]?.model ?? profile?.model ?? panelModel
      const wanted = t.effort ?? rungs[0]?.effort ?? profile?.effort ?? panelEffort
      const known = models.find(m => m.id === model)
      return { model, effort: known === undefined || known.efforts.includes(wanted) ? wanted : undefined }
    }

    const shared = typeof input.shared === 'string' ? input.shared : ''
    const batchFiles = (Array.isArray(input.files) ? input.files : []).filter(file => typeof file === 'string' && file.trim() !== '')
    const batchVerify = typeof input.verify === 'string' && input.verify.trim() !== '' ? input.verify : undefined
    const batchRounds = typeof input.verifyRounds === 'number' && Number.isFinite(input.verifyRounds) ? Math.max(0, Math.round(input.verifyRounds)) : 2
    const effective: TaskSpec[] = specs.map(t => ({
      ...t,
      prompt: shared === '' ? t.prompt : `${shared}\n\n# Your task\n${t.prompt}`,
      verify: t.verify ?? batchVerify,
      verifyRounds: t.verifyRounds ?? batchRounds,
      files: t.files ?? (batchFiles.length > 0 ? batchFiles : undefined),
    }))

    const retries = Math.max(0, Math.round(Number(options.autoRetries ?? 3) || 0))
    const stallMs = Math.max(1, (Number(options.stallMinutes ?? 10) || 10) * 60_000)
    const dailyBudget = Number(options.dailyBudget ?? 0) || 0
    const fallbackSetting = String(options.fallbackModel ?? '')
    const fallback = fallbackSetting === '' ? undefined : fullId(fallbackSetting)
    const reviewModel = fullId(String(options.reviewModel ?? 'opencode/deepseek-v4.1-flash-free'))

    const id = batchId()
    const batch: Batch = {
      id,
      title: input.title,
      status: 'running',
      background: input.background === true,
      startedAt: Date.now(),
      maxCost: typeof input.maxCost === 'number' && Number.isFinite(input.maxCost) && input.maxCost >= 0 ? input.maxCost : undefined,
      tasks: effective.map(t => {
        const chosen = choose(t)
        return {
          id: t.id,
          title: typeof t.title === 'string' && t.title !== '' ? t.title : t.id,
          model: chosen.model,
          effort: chosen.effort,
          status: 'pending',
          dependsOn: Array.isArray(t.dependsOn) ? [...t.dependsOn] : [],
          steps: 0,
          cost: 0,
        }
      }),
    }
    await update($, batches, list => [...list, batch].slice(-5))

    const defaults: RunnerDefaults = { fallback, retries, stallMs }
    rememberBatch(id, effective, defaults)

    const snapshot = (b: Batch): Batch => ({ ...b, tasks: b.tasks.map(t => ({ ...t, dependsOn: [...t.dependsOn] })) })
    const sync = () => update($, batches, list => list.map(b => (b.id === batch.id ? snapshot(batch) : b)))

    const extras: ReportExtras = { isolation, diffs: {}, answers: {} }
    if (isolation === 'worktree') {
      const found = await $.process.run(['git', '-C', base, 'rev-parse', '--show-toplevel']).catch(() => undefined)
      if (found !== undefined && found.exitCode === 0) extras.top = found.stdout.trim()
      if (extras.top !== undefined) {
        const head = await $.process.run(['git', '-C', extras.top, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => undefined)
        if (head !== undefined && head.exitCode === 0 && head.stdout.trim() !== '') extras.branch = head.stdout.trim()
      }
    }
    batch.top = extras.top
    batch.base = extras.branch

    const batchSignal = track('batch:' + id)
    const abortTasks = () => {
      for (const task of batch.tasks) if (task.status === 'running') cancel(`task:${id}:${task.id}`)
    }
    batchSignal.addEventListener('abort', abortTasks)

    const specsById = new Map(effective.map(t => [t.id, t]))
    const runTask = async (task: BatchTask): Promise<TaskResult> => {
      const spec = specsById.get(task.id)
      if (spec === undefined) return { status: 'failed' as const, cost: 0, steps: 0, error: `missing task ${task.id}` }

      const known = models.find(m => m.id === task.model)
      const files = (spec.files ?? [])
        .filter(file => typeof file === 'string' && file.trim() !== '')
        .map(file => resolveDir(base, file))
        .filter((file): file is string => file !== undefined)
      const verdict = contextVerdict(spec.prompt.length + (await attachedChars($, files)), known)
      if (verdict !== undefined && verdict.level === 'over') {
        return { status: 'failed' as const, cost: 0, steps: 0, error: overContext(verdict) }
      }
      if (dailyBudget > 0 && known !== undefined && !isFree(known)) {
        const spent = await dailySpent($, localDate(Date.now()))
        if (spent >= dailyBudget) return { status: 'skipped' as const, cost: 0, steps: 0, error: budgetMessage(dailyBudget, spent) }
      }
      if (batchSignal.aborted) return { status: 'cancelled' as const, cost: 0, steps: 0, error: 'batch cancelled' }

      let prepared: { dir: string; branch?: string }
      try {
        // A dependent task builds on its dependencies' work, not on the batch's starting point.
        const from = task.dependsOn.map(dep => batch.tasks.find(t => t.id === dep)?.branch).filter((b): b is string => b !== undefined)
        prepared = await prepareDir($, isolation, base, id, task.id, from)
      } catch (err) {
        return { status: 'failed' as const, cost: 0, steps: 0, error: err instanceof Error ? err.message : String(err) }
      }
      task.dir = prepared.dir
      if (prepared.branch !== undefined) task.branch = prepared.branch
      await sync()
      await showStatus($)

      const key = `task:${id}:${task.id}`
      const signal = track(key)
      let attemptModel = task.model
      let attemptAt = Date.now()
      try {
        const outcome = await runResilient(
          $,
          {
            bin,
            model: task.model,
            fallback,
            fallbacks: laterRungs(ladders.get(task.id) ?? [], models),
            firstRetries: ladders.get(task.id)?.[0]?.retries,
            level: task.effort,
            prompt: spec.prompt,
            cwd: prepared.dir,
            autoApprove: input.autoApprove,
            readOnly: spec.readOnly,
            files,
            retries,
            stallMs,
            signal,
            verify: spec.verify,
            verifyRounds: spec.verifyRounds ?? 2,
            onAttempt: async info => {
              if (info.attempt > 1) {
                await noteHealth($, attemptModel, info.previous, Date.now() - attemptAt)
                attemptModel = info.model
                attemptAt = Date.now()
              }
              task.attempts = info.attempt
              task.model = info.model
              await sync()
              await showStatus($)
            },
            onStage: async stage => {
              task.stage = stage
              await sync()
              await showStatus($)
            },
          },
          async run => {
            task.steps = run.tools.length
            const last = run.tools.at(-1)
            if (last !== undefined) task.last = last
            await sync()
            await showStatus($)
          },
        )

        const failed = outcome.reason !== 'ok'
        const errors = [...outcome.run.errors]
        if (failed && outcome.verify !== undefined && !outcome.verify.passed) {
          errors.unshift(`verify: FAILED after ${outcome.verify.rounds ?? 0} rounds\n${outcome.verify.output.slice(-1500)}`)
        }
        if (failed && outcome.stderr.trim() !== '') errors.push(outcome.stderr.trim())
        await noteHealth($, attemptModel, outcome.reason, Date.now() - attemptAt, failed ? errors.join('\n') : undefined)
        await addSpend($, outcome.run.cost, outcome.model)

        extras.answers![task.id] = outcome.run.text || '(no text answer)'
        if (isolation === 'worktree') {
          const stat = await commitTask($, prepared.dir, `opencode ${id}/${task.id}: ${task.title}`)
          if (stat !== undefined && stat !== '') extras.diffs![task.id] = stat
        }
        let reviewCost = 0
        if (input.review === true && !failed && prepared.branch !== undefined && batch.base !== undefined) {
          task.stage = 'reviewing'
          await sync()
          const review = await reviewTask($, { bin, dir: prepared.dir, base: batch.base, prompt: spec.prompt, model: reviewModel, retries, stallMs, fallback, signal })
          task.stage = undefined
          extras.reviews ??= {}
          extras.reviews[task.id] = { verdict: review.verdict, notes: review.notes }
          reviewCost = review.cost
          if (review.cost > 0) await addSpend($, review.cost, review.model)
        }
        if (verdict !== undefined && verdict.level === 'warn') {
          extras.warnings ??= {}
          extras.warnings[task.id] = contextWarning(verdict)
        }

        const result: TaskResult = {
          status: outcome.reason === 'cancelled' ? 'cancelled' : failed ? 'failed' : 'done',
          cost: outcome.run.cost + reviewCost,
          steps: outcome.run.tools.length,
          dir: prepared.dir,
          attempts: outcome.attempts,
        }
        const last = outcome.run.tools.at(-1)
        if (last !== undefined) result.last = last
        if (outcome.sessionId !== undefined) result.sessionId = outcome.sessionId
        if (prepared.branch !== undefined) result.branch = prepared.branch
        if (outcome.verify !== undefined) result.verify = outcome.verify
        if (errors.length > 0) result.error = errors.join('\n')
        return result
      } finally {
        untrack(key)
      }
    }

    // autoResolve: the conflicting task's own worker merges the integration branch in and fixes it.
    const resolver = async (task: BatchTask, conflictFiles: string[]) => {
      const spec = specsById.get(task.id)
      if (spec === undefined || task.dir === undefined || batch.integration === undefined) return false
      const outcome = await resolveConflict($, {
        bin,
        dir: task.dir,
        integration: batch.integration,
        files: conflictFiles,
        sessionId: task.sessionId,
        prompt: spec.prompt,
        model: task.model,
        level: task.effort,
        verify: spec.verify,
        verifyRounds: spec.verifyRounds ?? 2,
        retries,
        stallMs,
        fallback,
        autoApprove: input.autoApprove,
        signal: batchSignal,
      })
      task.cost += outcome.cost
      if (outcome.cost > 0) await addSpend($, outcome.cost, outcome.model)
      return outcome.ok
    }

    const finish = async () => {
      batch.status =
        batchSignal.aborted || batch.tasks.some(t => t.status === 'cancelled')
          ? 'cancelled'
          : batch.tasks.every(t => t.status === 'done')
            ? 'done'
            : 'failed'
      batch.endedAt = Date.now()
      await sync()
      await showStatus($)
      if (input.autoMerge === true && isolation === 'worktree') await autoMerge($, batch, extras, input.autoResolve === true ? resolver : undefined)
      const full = batchReport(batch, extras)
      const path = await writeReport($, base, id, full)
      batch.reportPath = path
      await sync()
      await addHistory($, batch)
      return input.report === 'full' ? full : batchShortReport({ batch, extras, path })
    }

    if (batch.background) {
      const background: BatchRunSpec = { batch, maxParallel, signal: batchSignal }
      void (async () => {
        try {
          await runBatch($, background, runTask, async () => {
            await sync()
            await showStatus($)
          })
          const report = await finish()
          const done = batch.tasks.filter(t => t.status === 'done').length
          const cost = batch.tasks.reduce((n, t) => n + t.cost, 0)
          notify($, `${batch.title}: ${done}/${batch.tasks.length} done · $${cost.toFixed(2)}`, 'OpenCode batch')
          $.ui.toast(`OpenCode batch ${batch.title} ${batch.status}.`)
          await $.prompt.submit({ text: `OpenCode batch ${id} finished.\n\n${report}` })
        } catch (err) {
          batch.status = batchSignal.aborted ? 'cancelled' : 'failed'
          batch.endedAt = Date.now()
          await sync()
          await showStatus($)
          const report = await finish()
          notify($, `${batch.title}: ${batch.status}`, 'OpenCode batch')
          $.ui.toast(`OpenCode batch ${batch.title} ${batch.status}.`)
          await $.prompt.submit({ text: `OpenCode batch ${id} failed: ${err instanceof Error ? err.message : String(err)}\n\n${report}` })
        } finally {
          batchSignal.removeEventListener('abort', abortTasks)
          untrack('batch:' + id)
        }
      })()
      return {
        result: `Batch ${id} started: ${batch.tasks.length} tasks, up to ${maxParallel} at once. Its report arrives as a new message when it ends; the OpenCode panel shows progress.`,
      }
    }

    try {
      await runBatch($, { batch, maxParallel, signal: batchSignal }, runTask, async () => {
        await sync()
        await showStatus($)
      })
      return { result: await finish() }
    } catch (err) {
      batch.status = batchSignal.aborted ? 'cancelled' : 'failed'
      batch.endedAt = Date.now()
      await sync()
      await showStatus($)
      const report = await finish()
      return { deny: `opencode-go: delegate_batch failed: ${err instanceof Error ? err.message : String(err)}\n\n${report}` }
    } finally {
      batchSignal.removeEventListener('abort', abortTasks)
      untrack('batch:' + id)
    }
  }).catch(($, e, next) => ({
    deny: `opencode-go: delegate_batch failed: ${reason(next.error)}`,
  }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const cat = await read($, catalog)
    const model = await current($, defaultModel)
    const level = await read($, effort)
    const isChat = await read($, chat)
    const running = await read($, jobs)
    const liveBatches = await read($, batches)
    const money = await read($, spend)
    const spendTotalRaw = await $.store.get('spendTotal')
    const spendTotal = typeof spendTotalRaw === 'number' ? spendTotalRaw : 0
    const recentIds = await read($, recent)
    const allOpen = await read($, showAll)
    const search = (await read($, query)).trim().toLowerCase()
    const folds = await read($, open)
    const healthData = await read($, health)
    const historyList = await read($, history)
    const byModel = await read($, spendByModel)
    const shownPreview = await read($, preview)
    const localNow = await read($, local)
    const selected = cat.models.find(m => m.id === model)
    const { free, paid } = worker(cat.models)
    const isMobile = e.surface === 'mobile'
    const recentModels = recentIds
      .map(id => cat.models.find(m => m.id === id))
      .filter((m): m is WorkerModel => m !== undefined)
    const agents: Agent[] = [
      ...running.map(j => ({ key: j.id, cancelKey: j.id, model: j.model, effort: j.effort, steps: j.steps, last: j.last, attempt: j.attempt, stage: j.stage })),
      ...liveBatches.flatMap(b =>
        b.tasks
          .filter(t => t.status === 'running')
          .map(t => ({
            key: `${b.id}:${t.id}`,
            cancelKey: `task:${b.id}:${t.id}`,
            model: t.model,
            effort: t.effort,
            steps: t.steps,
            last: t.last,
            attempt: t.attempts,
            stage: t.stage,
            batch: { title: b.title, task: t.id, verify: t.verify },
          })),
      ),
    ]
    const planBatches = [...liveBatches].sort((a, b) => b.startedAt - a.startedAt).slice(0, 3)
    const matchingPreset = PRESETS.find(p => p.model === model && p.effort === level)
    const modelHealth = healthData[model]
    const modelRating = rate(modelHealth)
    const modelRuns = modelHealth === undefined ? 0 : modelHealth.ok + modelHealth.failed + modelHealth.rateLimited + modelHealth.hung
    const recentHistory = [...historyList].slice(-10).reverse()
    const topModels = Object.entries(byModel)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    const historyOpen = folds.history ?? false

    const dot = (id: string) => {
      const rating = rate(healthData[id])
      if (rating === 'unknown') return undefined
      return <Text color={rating === 'good' ? 'success' : rating === 'shaky' ? 'warning' : 'error'}>● </Text>
    }

    const matches = (m: WorkerModel) =>
      search === '' || `${m.name} ${m.id} ${m.maker}`.toLowerCase().includes(search)
    const isOpen = (key: string, byDefault: boolean) => (search !== '' ? true : folds[key] ?? byDefault)
    const toggle = (key: string, now: boolean) => () => void update($, open, f => ({ ...f, [key]: !now }))

    const row = (m: WorkerModel, chip: string) => {
      const isPicked = m.id === model
      const chatOnly = isChat && m.source === 'zen'
      return (
        <Button key={`model:${m.id}`} plain onPress={() => void pick($, m.id)}>
          <Text bold={isPicked} color={isPicked ? 'suggestion' : undefined} dimColor={chatOnly}>
            {isPicked ? '● ' : '○ '}
            {dot(m.id)}
            <Text color={colorOf(m.id)}>● </Text>
            {m.name}
          </Text>
          <Text dimColor> {chatOnly ? `${chip} · delegate only` : chip}</Text>
        </Button>
      )
    }

    const section = (key: string, title: string, color: 'success' | 'warning', hint: string, list: WorkerModel[], chip: (m: WorkerModel) => string) => {
      const shown = list.filter(matches)
      if (shown.length === 0) return undefined
      const sectionOpen = isOpen(key, true)
      const makers = [...new Set(shown.map(m => m.maker))].sort((a, b) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)))
      return (
        <Box flexDirection="column">
          <Button key={key} plain onPress={toggle(key, sectionOpen)}>
            <Text color={color} bold>
              {sectionOpen ? '▾ ' : '▸ '}
              {title}
            </Text>
            <Text dimColor> {shown.length}</Text>
          </Button>
          {sectionOpen && <Text dimColor size="caption">{hint}</Text>}
          {sectionOpen &&
            makers.map(maker => {
              const group = shown.filter(m => m.maker === maker)
              const groupKey = `${key}:${maker}`
              const groupOpen = isOpen(groupKey, group.some(m => m.id === model))
              return (
                <Box flexDirection="column" paddingLeft={1}>
                  <Button key={groupKey} plain onPress={toggle(groupKey, groupOpen)}>
                    <Text bold={group.some(m => m.id === model)}>
                      {groupOpen ? '▾ ' : '▸ '}
                      {maker}
                    </Text>
                    <Text dimColor> {group.length}</Text>
                  </Button>
                  {groupOpen && <Box flexDirection="column" paddingLeft={2}>{group.map(m => row(m, chip(m)))}</Box>}
                </Box>
              )
            })}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text dimColor size="caption">THIS CHAT</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="chat:claude" label="Claude" variant={isChat ? 'secondary' : 'primary'} onPress={() => void setChat($, false, model)} />
            <Button key="chat:opencode" label="OpenCode" variant={isChat ? 'primary' : 'secondary'} onPress={() => void setChat($, true, model)} />
          </Box>
          <Text dimColor size="caption">
            {isChat
              ? model.startsWith('opencode-go/')
                ? `Every turn goes to ${selected?.name ?? model}. Core tools only; replies arrive a step at a time.`
                : 'Pick a Go model: Zen models only work through delegate.'
              : 'Claude answers and hands work to OpenCode with delegate.'}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text dimColor size="caption">{isChat ? 'MODEL' : 'WORKER'}</Text>
          <Text bold>
            {dot(model)}
            {selected?.name ?? model}
          </Text>
          <Text dimColor>
            {selected?.maker ? `${selected.maker} · ` : ''}
            {model}
            {selected ? (isFree(selected) ? ' · free' : ` · ${price(selected.input)}/${price(selected.output)} per Mtok`) : ''}
          </Text>
          {modelHealth !== undefined && (modelRating === 'shaky' || modelRating === 'bad') && (
            <Text dimColor size="caption">
              {modelHealth.rateLimited} rate limits · {modelHealth.hung} hangs · {modelHealth.failed} failures in {modelRuns} runs
            </Text>
          )}
        </Box>

        {shownPreview !== null && (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text dimColor size="caption">{shownPreview.title}</Text>
              <Button key="preview:close" plain label="Close" onPress={() => void update($, preview, () => null)} />
            </Box>
            <Box flexDirection="column">
              {shownPreview.text.split('\n').slice(0, 400).map((line, i) => (
                <Text key={`preview:${i}`} dimColor>{line === '' ? ' ' : line}</Text>
              ))}
              {shownPreview.text.split('\n').length > 400 && (
                <Text dimColor>… {shownPreview.text.split('\n').length - 400} more lines</Text>
              )}
            </Box>
          </Box>
        )}

        {(money.runs > 0 || spendTotal > 0) && (
          <Text dimColor size="caption">
            Spent ${money.session.toFixed(4)} this chat · {money.runs} runs · ${spendTotal.toFixed(2)} all time
          </Text>
        )}

        <Box flexDirection="column">
          <Text dimColor size="caption">REASONING</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {EFFORTS.map(l => (
              <Button
                key={`effort:${l}`}
                label={l}
                variant={l === level ? 'primary' : 'secondary'}
                dimColor={selected !== undefined && !selected.efforts.includes(l)}
                onPress={() => void pickEffort($, l)}
              />
            ))}
          </Box>
          {selected !== undefined && !selected.efforts.includes(level) && (
            <Text dimColor size="caption">
              {selected.efforts.length ? `${selected.name} takes ${selected.efforts.join(', ')}; it runs at its default.` : `${selected.name} has no reasoning levels; it runs at its default.`}
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          <Text dimColor size="caption">PRESETS</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {PRESETS.map(p => (
              <Button
                key={`preset:${p.name}`}
                label={p.name}
                variant={p.model === model && p.effort === level ? 'primary' : 'secondary'}
                onPress={() => void applyPreset($, p)}
              />
            ))}
          </Box>
          {matchingPreset !== undefined && <Text dimColor size="caption">{matchingPreset.note}</Text>}
        </Box>

        <Box flexDirection="column">
          <Text dimColor size="caption">LOCAL</Text>
          {LOCAL.map(spec => {
            const srv = localNow[spec.name] ?? { status: 'off' as const }
            const color = srv.status === 'ready' ? 'success' : srv.status === 'starting' ? 'warning' : srv.status === 'error' ? 'error' : undefined
            const busy = srv.status === 'starting' || srv.status === 'ready'
            return (
              <Box key={`local:${spec.name}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={color}>● </Text>
                  <Text bold>{spec.label}</Text>
                  <Text dimColor>{srv.status}{srv.calls ? ` · ${srv.calls} calls · ${Math.round(srv.lastMs ?? 0)} ms` : ''}</Text>
                  {!busy && <Button key={`local-start:${spec.name}`} plain label="Start" onPress={() => void localOpts($, options, localDir).then(o => bringUp($, spec, o))} />}
                  {busy && ownsLocal(spec.name) && (
                    <Button key={`local-stop:${spec.name}`} plain label="Stop" onPress={() => void stopLocal(spec.name).then(() => setLocal($, spec.name, { status: 'off', error: undefined }))} />
                  )}
                </Box>
                {srv.error !== undefined ? <Text color="error" size="caption">{srv.error}</Text> : <Text dimColor size="caption">{spec.note}</Text>}
              </Box>
            )
          })}
        </Box>

        {agents.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor size="caption">AGENTS</Text>
            {agents.map((a, i) => {
              const look = STAGES[stageOf(a)]
              const name = a.batch?.task ?? a.key
              return (
                <Box key={a.key} flexDirection="column" borderStyle="round" paddingX={1}>
                  <Box flexDirection="row" gap={1}>
                    <Text bold color={colorOf(a.model)}>
                      {`${i + 1} : ${(a.model.split('/')[1] ?? a.model).toUpperCase()} : ${a.effort ? a.effort.toUpperCase() : '—'}`}
                    </Text>
                    <Button
                      key={`cancel:${a.key}`}
                      plain
                      label="Cancel"
                      onPress={() => {
                        const stopped = cancel(a.cancelKey)
                        $.ui.toast(stopped ? `Cancelling ${name}.` : `${name} is not running.`)
                      }}
                    />
                  </Box>
                  {!isMobile && (
                    <Text>
                      <Text color={look.color}>{`${look.icon} ${look.word}`}</Text>
                      <Text dimColor>
                        {` · step ${a.steps}`}
                        {a.attempt !== undefined && a.attempt > 1 ? ` · try ${a.attempt}` : ''}
                        {a.batch !== undefined ? ` · ${a.batch.title} · ${a.batch.task}` : ''}
                        {a.batch?.verify !== undefined ? ` · verify ${a.batch.verify === 'passed' ? '✓' : '✗'}` : ''}
                      </Text>
                    </Text>
                  )}
                  <Text>
                    <Text dimColor>ACTIVITY </Text>
                    {a.last !== undefined ? a.last.slice(0, 60) : <Text dimColor>—</Text>}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}

        {planBatches.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor size="caption">PLAN</Text>
            {planBatches.map(b => {
              const key = `plan:${b.id}`
              const planOpen = folds[key] ?? b.status === 'running'
              const done = b.tasks.filter(t => t.status === 'done').length
              const cost = b.tasks.reduce((n, t) => n + t.cost, 0)
              return (
                <Box key={b.id} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Button key={key} plain onPress={toggle(key, planOpen)}>
                      <Text>{planOpen ? '▾ ' : '▸ '}{b.title}</Text>
                      <Text dimColor> {done}/{b.tasks.length} done · ${cost.toFixed(4)}{b.background ? ' · background' : ''}</Text>
                    </Button>
                    {b.status === 'running' && (
                      <Button
                        key={`cancel:${b.id}`}
                        plain
                        label="Cancel"
                        onPress={() => {
                          const stopped = cancel(`batch:${b.id}`)
                          $.ui.toast(stopped || b.status === 'running' ? `Cancelling batch ${b.id}.` : `Batch ${b.id} is not running.`)
                        }}
                      />
                    )}
                  </Box>
                  {planOpen && b.tasks.map(t => {
                    const faded = t.status === 'pending' || t.status === 'skipped' || t.status === 'cancelled'
                    const tone = t.status === 'done' ? 'success' : t.status === 'failed' ? 'error' : undefined
                    const title = t.title !== t.id ? t.title : ''
                    const detail = [
                      t.steps > 0 ? `${t.steps} steps` : '',
                      t.status === 'running' && t.last ? t.last.slice(0, 36) : '',
                      t.status === 'pending' && t.dependsOn.length > 0 ? `after ${t.dependsOn.join(', ')}` : '',
                      (t.status === 'failed' || t.status === 'skipped') && t.error ? t.error.slice(0, 60) : '',
                      t.attempts !== undefined && t.attempts > 1 ? `try ${t.attempts}` : '',
                      t.verify === 'passed' ? 'verify ✓' : t.verify === 'failed' ? 'verify ✗' : '',
                      t.merged ? 'merged' : '',
                      t.status === 'done' && t.branch ? t.branch : '',
                    ].filter(d => d !== '')
                    const repo = repoOf(b, t)
                    const canDiff = t.branch !== undefined && repo.top !== undefined
                    const canMerge = t.status === 'done' && t.branch !== undefined && !t.merged
                    const canDiscard = t.branch !== undefined && b.status !== 'running'
                    const canResume = t.status === 'failed' || t.status === 'cancelled' || t.status === 'skipped'
                    return (
                      <Box key={t.id} flexDirection="column">
                        <Text>
                          <Text color={tone} dimColor={faded}>{ICONS[t.status]}</Text> {t.id}
                          <Text dimColor>{title !== '' ? ` · ${title}` : ''} · </Text>
                          <Text color={colorOf(t.model)} dimColor={faded}>● </Text>
                          <Text dimColor>{t.model.split('/')[1] ?? t.model}{detail.map(d => ` · ${d}`).join('')}</Text>
                        </Text>
                        {(canDiff || canMerge || canDiscard || canResume) && (
                          <Box flexDirection="row" gap={1} flexWrap="wrap">
                            {canDiff && <Button key={`diff:${b.id}:${t.id}`} plain label="Diff" onPress={() => void taskAction($, 'diff', b.id, t.id)} />}
                            {canMerge && <Button key={`merge:${b.id}:${t.id}`} plain label="Merge" onPress={() => void taskAction($, 'merge', b.id, t.id)} />}
                            {canDiscard && <Button key={`discard:${b.id}:${t.id}`} plain label="Discard" onPress={() => void taskAction($, 'discard', b.id, t.id)} />}
                            {canResume && <Button key={`resume:${b.id}:${t.id}`} plain label="Resume" onPress={() => void resumeTask($, b.id, t.id)} />}
                          </Box>
                        )}
                      </Box>
                    )
                  })}
                </Box>
              )
            })}
          </Box>
        )}

        <Box flexDirection="column">
          <Button key="historyToggle" plain onPress={toggle('history', historyOpen)}>
            <Text dimColor size="caption">{historyOpen ? '▾ ' : '▸ '}HISTORY</Text>
          </Button>
          {historyOpen && (
            <Box flexDirection="column">
              {recentHistory.length === 0 ? (
                <Text dimColor size="caption">No finished batches yet.</Text>
              ) : (
                recentHistory.map(entry => (
                  <Text key={entry.id} dimColor>
                    {entry.title} · {entry.status} · {entry.done}/{entry.tasks} · ${entry.cost.toFixed(4)} · {ageOf(entry.endedAt)}
                  </Text>
                ))
              )}
              {topModels.length > 0 && (
                <Text dimColor size="caption">
                  {topModels.map(([id, usd]) => `${shortModel(id)} $${usd.toFixed(2)}`).join(' · ')}
                </Text>
              )}
            </Box>
          )}
        </Box>

        {isMobile && recentModels.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor size="caption">RECENT</Text>
            {recentModels.map(m => row(m, isFree(m) ? (m.source === 'go' ? 'Go' : 'Zen') : `${price(m.input)}/${price(m.output)}`))}
          </Box>
        )}

        {isMobile && (
          <Button key="showAll" plain onPress={() => void update($, showAll, v => !v)} label={allOpen ? 'Hide all models' : `All models (${free.length + paid.length})`} />
        )}
        {isMobile && <Text dimColor size="caption">{'Or type /opencode model <name>'}</Text>}

        {!isMobile && Input !== undefined && (
          <Input
            key="search"
            placeholder="Search models or makers"
            value={await read($, query)}
            onInput={value => void update($, query, () => value)}
            onSubmit={value => void update($, query, () => value)}
          />
        )}

        {cat.status === 'loading' && cat.models.length === 0 && <Text dimColor>Loading models…</Text>}
        {cat.status === 'error' && <Text color="error">Could not list models: {cat.error}</Text>}
        {cat.models.length > 0 && search !== '' && !cat.models.some(matches) && <Text dimColor>No model matches “{search}”.</Text>}

        {(!isMobile || allOpen) && section('free', 'FREE', 'success', 'No cost while OpenCode offers them', free, m => (m.source === 'go' ? 'Go' : 'Zen'))}
        {(!isMobile || allOpen) && section('paid', 'PAID', 'warning', 'Uses your Go allowance · $ in/out per Mtok', paid, m => `${price(m.input)}/${price(m.output)}`)}

        <Button key="refresh" plain dimColor onPress={() => void refresh($)}>
          ↻ Refresh models
        </Button>
      </Box>
    )
  })
}
