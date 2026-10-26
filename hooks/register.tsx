import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Batch, BatchSummary, PlanUse, BatchTask, Phase, Catalog, DecideInput, DelegateBatchInput, DelegateInput, Effort, Job, LocalName, LocalServer, ModelHealth, Preset, Preview, Spend, WorkerModel } from '../types'
import { batchSpecs, checkTasks, commitTask, prepareDir, rememberBatch, runBatch } from './batch'
import type { BatchRunSpec, BatchTaskSpec, Isolation, RunnerDefaults, TaskResult } from './batch'
import { costsMoney, findOpencode, fullId, isFree, isPlan, loadCatalog, price, readCache, worker, writeCache } from './catalog'
import { checkPrompt, isAgyId, MAX_PLANNED, NO_GEMINI, parsePlan, pickChecker, planPrompt } from './gemini'
import type { Plan } from './gemini'
import { batchesText, diffText, effortText, HELP, historyText, localText, setupText, matchJob, matchModel, modelsText, parseArgs, presetsText, statusText } from './commands'
import { chatTools, explainError, readKey, requestBody, sendWithRetry, toMessages } from './chat'
import { cancel, track, tracked, untrack } from './control'
import { attachedChars, budgetMessage, contextVerdict, contextWarning, dailySpent, formatReport, localDate, notify, overContext, resolveDir, runResilient } from './delegate'
import { branchDiff, discardTask, mergeBranch, repoOf, worktreeFolder } from './git'
import type { TaskAction } from './git'
import { recordRun } from './health'
import { ladder } from './ladder'
import { askLocal, checkQuestions, formatAnswers, LOCAL, localNamed, ping, startLocal, stopLocal } from './local'
import type { LocalOptions, LocalSpec } from './local'
import type { Rung } from './ladder'
import { panel } from './panel'
import type { PanelView } from './panel'
import { EFFORTS, geminiPreset, isEffort, NO_PLAN, planPreset, presetIn, presetNamed, presetsFor, rate } from './presets'
import { batchReport, batchShortReport, changedFiles, delegateShort, writeReport } from './report'
import type { ReportExtras } from './report'
import { resolveConflict } from './resolve'
import { reviewTask } from './review'
import { formatChecks, selfTest } from './selftest'
import { planCalls, prune, quotaMessage, resetAt, usedIn } from './quota'

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
const planUse = atom({ plugin: 'opencode-go', key: 'planUse' } as const, [] as PlanUse[])
const geminiUse = atom({ plugin: 'opencode-go', key: 'geminiUse' } as const, [] as PlanUse[])

const TOOL = 'mcp__opencode-go__delegate'
const BATCH_TOOL = 'mcp__opencode-go__delegate_batch'
const DECIDE_TOOL = 'mcp__opencode-go__decide'
const PANE = 'opencode'

let sessionCwd = ''

function describe(models: WorkerModel[], health: Record<string, ModelHealth> = {}) {
  const { free, paid, plan, gemini } = worker(models)
  const shown = paid.slice(0, 8).map(m => `${m.id} (${price(m.input)}/${price(m.output)})`).join(', ')
  const more = paid.length > 8 ? `, and ${paid.length - 8} more in the OpenCode panel` : ''
  const shaky = (id: string) => (rate(health[id]) === 'shaky' ? ' (shaky)' : '')
  const unreliable = [...free, ...paid, ...plan, ...gemini].filter(m => rate(health[m.id]) === 'bad').map(m => m.id)
  return `Delegate a self-contained task to a cheaper model through opencode (the user's OpenCode Go subscription, Zen's free models, or their Z.AI Coding Plan) or Antigravity (their Google AI Pro plan's Gemini models, agy/*), run as a full agent (it can read, edit and run commands in the given directory), and wait for its answer.

Use it for routine, well-specified work: boilerplate, bulk edits, writing tests to a clear spec, summarising files, first drafts, mechanical refactors. Keep planning, judgement and review for yourself, and check what it changed (git diff, tests) before reporting success.

The worker sees nothing of this conversation: put everything it needs in the prompt (files, constraints, acceptance criteria, what to report back). Pass files to attach them. Pass the returned sessionId to continue the same opencode session.

Give every coding task a verify command (e.g. npm test) so failures are fixed by the worker, not by you. Runs resume themselves after rate limits, hangs and failures, and fall back to the fallback model. The user can cancel a run from the OpenCode panel.

Set profile to cheap, reliable or strong to pick a preset model and reasoning level, plan for the user's Z.AI Coding Plan, gemini for Gemini on their Google AI Pro plan, or ladder to start on a healthy free model and escalate (through Gemini and the Z.AI Coding Plan, when connected) to paid ones if it fails (an explicit model or effort wins). Report defaults to short with the full report in a file; pass full to read it inline.

Several delegate calls in one message may run one after another rather than together; for real parallel work use delegate_batch, which gives each worker its own folder.

Set readOnly true for research, review or planning: it runs the read-only plan agent (opencode's or Antigravity's plan mode), which cannot edit files. Gemini's 1M-token context suits reading a whole codebase. A Gemini (agy/*) worker runs with its permission prompts skipped, as headless Antigravity needs.

FREE: ${free.map(m => `${m.id}${shaky(m.id)}`).join(', ') || 'none right now'}
PAID (cheapest first, $ in/out per Mtok): ${shown || 'none right now'}${more}${plan.length > 0 ? `\nZ.AI PLAN (the user's GLM Coding Plan: no per-token cost, draws on the plan's prompt quota): ${plan.map(m => `${m.id}${shaky(m.id)}`).join(', ')}` : ''}${gemini.length > 0 ? `\nGEMINI (the user's Google AI Pro plan via Antigravity: no per-token cost, draws on the plan's quota): ${gemini.map(m => `${m.id}${shaky(m.id)}`).join(', ')}` : ''}${unreliable.length > 0 ? `\nUnreliable right now: ${unreliable.join(', ')}` : ''}

Do not pick a paid model other than the user's choice unless they ask. Paid models drain the user's Go allowance; Z.AI PLAN models drain the Coding Plan's quota; GEMINI models the Google AI Pro plan's.`
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
        profile: { type: 'string', enum: ['cheap', 'reliable', 'strong', 'ladder', 'plan', 'gemini'], description: 'Preset model and reasoning level; an explicit model or effort wins.' },
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

Use it for independent pieces of work that can run in parallel, or for a larger job split into clear parts. Workers see nothing of this conversation: put common context in shared and each task's own work in its prompt. Pass files to attach them. Give every coding task a verify command so failures are fixed by the worker, not by you. maxCost stops the batch starting more tasks once it has cost that much. Set profile (cheap, reliable, strong, plan for the Z.AI Coding Plan, or ladder: healthy free models first, then the Z.AI Coding Plan when connected, escalating to paid) for preset models and reasoning; autoMerge merges passing worktree tasks into a branch of its own, autoResolve has workers fix their own merge conflicts, and review has a model (Gemini when connected, else a free one) check each task's diff so you read only flagged ones. A task with dependsOn starts from its dependencies' branches.

Pass goal instead of tasks to hand the orchestration to Gemini (the user's Google AI Pro plan): it reads the folder and splits the goal into tasks, each task's diff is reviewed by Gemini, passing tasks are merged into oc/<batch>-merged, and Gemini checks the merged result against the goal. You read one report. review and autoMerge default to true in goal mode.

Runs resume themselves after rate limits, hangs and failures, and fall back to the fallback model. The user can cancel from the OpenCode panel. Report defaults to short with the full report in a file; pass full to read it inline.

With background true it returns at once and the report arrives as a new message when the batch ends.`,
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short name for the batch.' },
        goal: { type: 'string', description: 'Instead of tasks: what the batch should achieve. Gemini plans the tasks, reviews each, and checks the merged result.' },
        checker: { type: 'string', description: 'Model that plans (goal mode), reviews and checks, e.g. agy/gemini-3.8-flash. Default: Gemini 4 Argon when connected.' },
        checkerEffort: { type: 'string', enum: EFFORTS, description: "The checker's reasoning level. Default: high." },
        shared: { type: 'string', description: 'Common context prefixed to every task prompt.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files attached to every task, absolute or relative to dir.' },
        verify: { type: 'string', description: 'Default verify command for tasks without one. Strongly recommended for coding tasks.' },
        verifyRounds: { type: 'integer', minimum: 0, maximum: 5, description: 'Default verify fix-up rounds. Default 2.' },
        maxCost: { type: 'number', minimum: 0, description: 'USD; no more tasks start once the batch has cost this much.' },
        profile: { type: 'string', enum: ['cheap', 'reliable', 'strong', 'ladder', 'plan', 'gemini'], description: 'Default preset model and reasoning for tasks; explicit model/effort wins.' },
        autoResolve: { type: 'boolean', description: 'With autoMerge: a task that conflicts gets the merged branch brought into its worktree, its worker resolves the conflict, and it is merged. Default false.' },
        review: { type: 'boolean', description: "After each task, a read-only reviewer (the reviewModel setting: Gemini when connected, else a free model) checks its diff against its prompt; the report flags concerns. Default false." },
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
              profile: { type: 'string', enum: ['cheap', 'reliable', 'strong', 'ladder', 'plan', 'gemini'], description: 'Preset model and reasoning for this task; an explicit model or effort wins.' },
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
      required: ['title'],
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
    await update($, catalog, c => ({ ...c, status: 'loading' as const }))
  }
  const loaded = await loadCatalog($)
  if (loaded.status === 'ready') {
    await update($, catalog, () => loaded)
    await writeCache($, loaded.models)
    await registerTool($, loaded.models)
    return
  }
  const models = cached ?? previous.models
  await update($, catalog, () => ({ status: 'error' as const, models, error: loaded.error }))
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
      await addSpend($, outcome.run.cost, outcome.model, outcome.run.calls)
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
  if (!up.ok) return `${spec.label}: could not start. ${up.error}${up.error.includes('not installed') ? '' : `\nIs it installed in ${opts.dir}? (/opencode local status)`}`
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
  const one = all.length === 1 ? all[0] : undefined
  if (all.length === 0) {
    $.ui.status(undefined)
  } else if (one !== undefined) {
    const short = one.model.split('/')[1] ?? one.model
    $.ui.status(`opencode ${short}: ${one.steps} steps${retry(one.attempt)}${one.last ? ` · ${one.last.slice(0, 50)}` : ''}`)
  } else {
    const parts = all.map(r => `${r.model.split('/')[1] ?? r.model}:${r.steps}${retry(r.attempt)}`).join(', ')
    $.ui.status(`opencode: ${all.length} running · ${parts}`)
  }
}

// Whether the zaiQuota option leaves room for another Z.AI Coding Plan run.
async function planRoom($: EngineInterface, quota: number): Promise<boolean> {
  return quota === 0 || usedIn(await read($, planUse), Date.now()) < quota
}

async function addSpend($: EngineInterface, cost: number, model: string, calls?: Record<string, number>) {
  const onPlan = planCalls(calls)
  if (onPlan > 0) {
    const now = Date.now()
    await update($, planUse, u => [...prune(u, now), { at: now, calls: onPlan }])
    await $.store.set('planUse', await read($, planUse))
  }
  const onGemini = Object.entries(calls ?? {}).reduce((n, [id, c]) => n + (isAgyId(id) ? c : 0), 0) || (calls === undefined && isAgyId(model) ? 1 : 0)
  if (onGemini > 0) {
    const now = Date.now()
    await update($, geminiUse, u => [...prune(u, now), { at: now, calls: onGemini }])
    await $.store.set('geminiUse', await read($, geminiUse))
  }
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

function isHealthMap(v: unknown): v is Record<string, ModelHealth> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v).every(h => h !== null && typeof h === 'object' && !Array.isArray(h))
}

function isNumberMap(v: unknown): v is Record<string, number> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v).every(n => typeof n === 'number')
}

async function applyPreset($: EngineInterface, preset: Preset) {
  await pick($, preset.model)
  await pickEffort($, preset.effort)
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

// Aborts when either signal does.
function either(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (a === undefined) return b
  const both = new AbortController()
  const stop = () => both.abort()
  if (a.aborted || b.aborted) stop()
  a.addEventListener('abort', stop)
  b.addEventListener('abort', stop)
  return both.signal
}

// The checker's work (planning, a review, the final check) as a card in the panel's AGENTS,
// cancellable like a delegate job. fn gets the card's abort signal.
async function asJob<T>($: EngineInterface, o: { model: string; effort?: string; stage: Phase; last: string }, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const job: Job = { id: taskId(), model: o.model, effort: o.effort, steps: 0, stage: o.stage, last: o.last }
  await update($, jobs, list => [...list, job])
  await showStatus($)
  const signal = track(job.id)
  try {
    return await fn(signal)
  } finally {
    untrack(job.id)
    await update($, jobs, list => list.filter(j => j.id !== job.id))
    await showStatus($)
  }
}

// Goal mode: Gemini reads the folder and splits the goal into batch tasks.
async function planGoal(
  $: EngineInterface,
  o: { goal: string; title: string; shared?: string; verify?: string; dir: string; checker?: { model: string; effort: Effort }; retries: number; stallMs: number },
): Promise<{ plan: Plan; model: string } | string> {
  const checker = o.checker
  if (checker === undefined) return NO_GEMINI
  return asJob($, { model: checker.model, effort: checker.effort, stage: 'planning', last: `planning ${o.title}` }, async signal => {
    const outcome = await runResilient(
      $,
      {
        bin: '',
        model: checker.model,
        level: checker.effort,
        prompt: planPrompt(o.goal, { shared: o.shared, verify: o.verify, maxTasks: MAX_PLANNED }),
        cwd: o.dir,
        readOnly: true,
        retries: o.retries,
        stallMs: o.stallMs,
        signal,
        verifyRounds: 0,
      },
      () => undefined,
    )
    await addSpend($, outcome.run.cost, outcome.model, outcome.run.calls)
    if (outcome.reason === 'cancelled') return 'Planning was cancelled.'
    if (outcome.reason !== 'ok') {
      const why = (outcome.run.errors.join('\n') || outcome.stderr || outcome.run.text).trim().slice(0, 500)
      return `Gemini could not plan the goal (${outcome.reason})${why ? `: ${why}` : '.'}`
    }
    const plan = parsePlan(outcome.run.text)
    return typeof plan === 'string' ? `${plan} Its answer began: ${outcome.run.text.slice(0, 300)}` : { plan, model: outcome.model }
  })
}

// Goal mode's last step: Gemini checks the merged branch as a whole against the goal.
async function checkMerged(
  $: EngineInterface,
  o: { goal: string; top: string; base: string; integration: string; checker?: { model: string; effort: Effort }; retries: number; stallMs: number; signal?: AbortSignal },
) {
  const checker = o.checker
  if (checker === undefined) return undefined
  return asJob($, { model: checker.model, effort: checker.effort, stage: 'checking', last: 'checking the merged result' }, async signal => {
    const review = await reviewTask($, {
      bin: '',
      dir: o.top,
      base: o.base,
      rev: `${o.base}...${o.integration}`,
      prompt: o.goal,
      ask: diff => checkPrompt(o.goal, diff),
      model: checker.model,
      level: checker.effort,
      retries: o.retries,
      stallMs: o.stallMs,
      signal: either(o.signal, signal),
    })
    await addSpend($, review.cost, review.model)
    return review
  })
}

function planText(plan: Plan, model: string, goal: string) {
  const tasks = plan.tasks.map(t => `- ${t.id}: ${t.title}${t.dependsOn.length > 0 ? ` (after ${t.dependsOn.join(', ')})` : ''}`).join('\n')
  return `## Plan (${model})\nGoal: ${goal.length > 300 ? `${goal.slice(0, 300)}…` : goal}\n${plan.summary ? `${plan.summary}\n` : ''}${tasks}`
}

function checkText(check: { verdict: string; notes: string; model: string } | undefined, why?: string) {
  if (check === undefined) return why === undefined ? '' : `## Final check\n${why}`
  const head = check.verdict === 'ok' ? 'OK' : check.verdict === 'concerns' ? 'CONCERNS' : 'could not run'
  return `## Final check (${check.model}): ${head}${check.notes ? `\n${check.notes}` : ''}`
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
    const storedPlanUse = await $.store.get('planUse')
    if (Array.isArray(storedPlanUse) && (await read($, planUse)).length === 0) {
      const uses = storedPlanUse.filter((u): u is PlanUse => typeof u?.at === 'number' && typeof u?.calls === 'number')
      await update($, planUse, () => prune(uses, Date.now()))
    }
    const storedGeminiUse = await $.store.get('geminiUse')
    if (Array.isArray(storedGeminiUse) && (await read($, geminiUse)).length === 0) {
      const uses = storedGeminiUse.filter((u): u is PlanUse => typeof u?.at === 'number' && typeof u?.calls === 'number')
      await update($, geminiUse, () => prune(uses, Date.now()))
    }
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
    const { sub, rest } = parseArgs(e.args)

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

    if (sub === 'help') return { text: HELP }

    if (sub === 'selftest') {
      const local = await localOpts($, options, localDir)
      return { text: formatChecks(await selfTest($, { bin: await findOpencode($), dir: sessionCwd, models: await models(), local })) }
    }

    if (sub === 'model') {
      if (rest === '') return { text: 'Usage: /opencode model <name>.' }
      const { free, paid, plan } = worker(await models())
      const found = matchModel([...free, ...paid, ...plan], rest, fullId)
      if ('text' in found) return found
      await pick($, found.model.id)
      return { text: `Worker: ${found.model.name} (${found.model.id})` }
    }

    if (sub === 'effort') {
      if (!EFFORTS.includes(rest as Effort)) return { text: `Reasoning must be one of ${EFFORTS.join(', ')}.` }
      const level = rest as Effort
      await pickEffort($, level)
      const pickedId = await current($, defaultModel)
      return { text: effortText(level, (await read($, catalog)).models.find(m => m.id === pickedId)) }
    }

    if (sub === 'chat') {
      const want = rest.toLowerCase()
      if (want !== 'on' && want !== 'off') return { text: 'Usage: /opencode chat on|off.' }
      const model = await current($, defaultModel)
      if (want === 'on' && !model.startsWith('opencode-go/')) {
        return { text: `Chat mode needs a Go model. ${model} is not one: Zen models are served only to OpenCode's own app, and Z.AI Coding Plan models run through delegate. Pick a Go model with /opencode model <name>.` }
      }
      await setChat($, want === 'on', model)
      return { text: want === 'on' ? `Chat mode on: this chat now runs on ${model}.` : 'Chat mode off: this chat is back on Claude.' }
    }

    if (sub === 'models') {
      const { free, paid, plan, gemini } = worker(await models())
      return { text: modelsText(free, paid, plan, rest, gemini) }
    }

    if (sub === 'local') {
      const [verb = 'status', which = 'all'] = rest.toLowerCase().split(/\s+/).filter(Boolean)
      if (verb === 'setup') {
        const opts = await localOpts($, options, localDir)
        return { text: setupText($.plugin.root, opts.dir, which === 'all' ? undefined : which) }
      }
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
      return { text: localText(specs, await read($, local)) }
    }

    if (sub === 'status') {
      const money = await read($, spend)
      return {
        text: statusText({
          model: await current($, defaultModel),
          level: await read($, effort),
          isChat: await read($, chat),
          running: await read($, jobs),
          batches: await read($, batches),
          session: money.session,
          runs: money.runs,
          total: Number((await $.store.get('spendTotal')) ?? 0) || 0,
        }),
      }
    }

    if (sub === 'preset') {
      const list = async (prefix: string) => ({ text: presetsText(prefix, await current($, defaultModel), await read($, effort), presetsFor((await read($, catalog)).models)) })
      if (rest === '') return list('Presets:')
      const preset = presetIn((await read($, catalog)).models, rest)
      if (preset === undefined) return list(`Unknown preset "${rest}". Presets:`)
      await applyPreset($, preset)
      return { text: `Preset ${preset.name}: ${preset.model} · ${preset.effort}` }
    }

    if (sub === 'batches') return { text: batchesText(await read($, batches)) }

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
      const found = matchJob(await read($, jobs), rest)
      if ('text' in found) return found
      return { text: cancel(found.job.id) ? `Cancelling ${found.job.id}.` : `${found.job.id} is not running.` }
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
      return { text: sub === 'diff' ? diffText(result.text) : result.text }
    }

    if (sub === 'history') return { text: historyText(await read($, history), await read($, spendByModel)) }

    return { text: `Unknown subcommand. ${HELP}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (options.orchestrate === false || (await read($, chat))) return composed
    const text = `# Delegating to OpenCode
The user has OpenCode workers (Go, Zen and any Z.AI Coding Plan models) wired in through the ${TOOL} tool. Act as the orchestrator: plan, split work into independent, clearly specified pieces, hand routine pieces to OpenCode models with ${TOOL} (or ${BATCH_TOOL} to run several at once, each in its own git worktree), and review their output yourself. Do the hard reasoning, architecture and final verification yourself. Do small one-step edits directly when explaining them would cost more than doing them.
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
      const text = `OpenCode chat mode needs a Go model. ${modelId} is not one: Zen models are served only to OpenCode's own app, and Z.AI Coding Plan models run through delegate. Pick a Go model in the OpenCode panel.`
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
    const input: DecideInput = e
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
    const input: DelegateInput = e
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') return { deny: 'delegate needs a prompt.' }

    const bin = await findOpencode($)
    if (bin === undefined) {
      return { deny: 'The opencode CLI is not installed or not on PATH. Ask the user to install it (npm i -g opencode-ai) and run `opencode auth login`, choosing OpenCode Go.' }
    }

    const allModels = (await read($, catalog)).models
    if (input.profile === 'plan' && !input.model && planPreset(allModels) === undefined) return { deny: NO_PLAN }
    if (input.profile === 'gemini' && !input.model && geminiPreset(allModels) === undefined) return { deny: NO_GEMINI }
    const planOk = await planRoom($, Number(options.zaiQuota ?? 0) || 0)
    const rungs = input.profile === 'ladder' && !input.model ? ladder(allModels, await read($, health), planOk) : []
    const profile = typeof input.profile === 'string' ? presetIn(allModels, input.profile) ?? (input.profile === 'ladder' ? presetNamed('reliable') : undefined) : undefined
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
    if (budget > 0 && known !== undefined && costsMoney(known)) {
      const spent = await dailySpent($, localDate(Date.now()))
      if (spent >= budget) return { deny: budgetMessage(budget, spent) }
    }
    const quota = Number(options.zaiQuota ?? 0) || 0
    if (quota > 0 && known !== undefined && isPlan(known)) {
      const uses = await read($, planUse)
      const now = Date.now()
      if (usedIn(uses, now) >= quota) return { deny: quotaMessage(usedIn(uses, now), quota, resetAt(uses, now)) }
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
      await addSpend($, outcome.run.cost, outcome.model, outcome.run.calls)
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
    const input: DelegateBatchInput = e
    if (typeof input.title !== 'string' || input.title.trim() === '') return { deny: 'delegate_batch needs a title.' }
    let specs: TaskSpec[] = Array.isArray(input.tasks) ? input.tasks : []
    const goal = typeof input.goal === 'string' && input.goal.trim() !== '' ? input.goal.trim() : undefined
    if (goal === undefined && specs.length === 0) return { deny: 'delegate_batch needs tasks, or a goal for Gemini to plan.' }
    let planned: { plan: Plan; model: string } | undefined
    const checkerEffort = isEffort(input.checkerEffort) ? input.checkerEffort : undefined
    const checker = pickChecker((await read($, catalog)).models, input.checker, checkerEffort)
    if (goal !== undefined && specs.length === 0) {
      const got = await planGoal($, {
        goal,
        title: input.title,
        shared: typeof input.shared === 'string' ? input.shared : undefined,
        verify: typeof input.verify === 'string' && input.verify.trim() !== '' ? input.verify : undefined,
        dir: resolveDir(sessionCwd, input.dir) ?? sessionCwd,
        checker,
        retries: Math.max(0, Math.round(Number(options.autoRetries ?? 3) || 0)),
        stallMs: Math.max(1, (Number(options.stallMinutes ?? 10) || 10) * 60_000),
      })
      if (typeof got === 'string') return { deny: got }
      planned = got
      specs = got.plan.tasks.map(t => ({ ...t }))
    }
    // Goal mode hands the checking to Gemini too, unless the call says otherwise.
    const wantReview = input.review ?? planned !== undefined
    const wantMerge = input.autoMerge ?? planned !== undefined
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
    if ((input.profile === 'plan' || specs.some(t => t.profile === 'plan' && !t.model)) && planPreset(models) === undefined) return { deny: NO_PLAN }
    if ((input.profile === 'gemini' || specs.some(t => t.profile === 'gemini' && !t.model)) && geminiPreset(models) === undefined) return { deny: NO_GEMINI }
    const healthNow = await read($, health)
    const planOk = await planRoom($, Number(options.zaiQuota ?? 0) || 0)
    const ladders = new Map<string, Rung[]>()
    const choose = (t: TaskSpec) => {
      const name = typeof t.profile === 'string' ? t.profile : typeof input.profile === 'string' ? input.profile : undefined
      const rungs = name === 'ladder' && !t.model ? ladder(models, healthNow, planOk) : []
      if (rungs.length > 0) ladders.set(t.id, rungs)
      const profile = name === undefined ? undefined : presetIn(models, name) ?? (name === 'ladder' ? presetNamed('reliable') : undefined)
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
    // A checker named in the call reviews too; auto: Gemini when the Google AI Pro plan is connected, else a free model.
    const reviewSetting = typeof input.checker === 'string' && input.checker.trim() !== '' ? 'auto' : String(options.reviewModel ?? 'auto').trim()
    const reviewModel =
      reviewSetting === '' || reviewSetting === 'auto' ? checker?.model ?? 'opencode/deepseek-v4.1-flash-free' : fullId(reviewSetting)
    const reviewLevel = reviewModel === checker?.model ? checker.effort : undefined

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
      if (dailyBudget > 0 && known !== undefined && costsMoney(known)) {
        const spent = await dailySpent($, localDate(Date.now()))
        if (spent >= dailyBudget) return { status: 'skipped' as const, cost: 0, steps: 0, error: budgetMessage(dailyBudget, spent) }
      }
      const quota = Number(options.zaiQuota ?? 0) || 0
      if (quota > 0 && known !== undefined && isPlan(known)) {
        const uses = await read($, planUse)
        const now = Date.now()
        if (usedIn(uses, now) >= quota) return { status: 'skipped' as const, cost: 0, steps: 0, error: quotaMessage(usedIn(uses, now), quota, resetAt(uses, now)) }
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
        await addSpend($, outcome.run.cost, outcome.model, outcome.run.calls)

        extras.answers![task.id] = outcome.run.text || '(no text answer)'
        if (isolation === 'worktree') {
          const stat = await commitTask($, prepared.dir, `opencode ${id}/${task.id}: ${task.title}`)
          if (stat !== undefined && stat !== '') extras.diffs![task.id] = stat
        }
        let reviewCost = 0
        if (wantReview && !failed && prepared.branch !== undefined && batch.base !== undefined) {
          task.stage = 'reviewing'
          await sync()
          const reviewBase = batch.base
          const review = await asJob($, { model: reviewModel, effort: reviewLevel, stage: 'reviewing', last: `reviewing ${task.id}` }, cardSignal =>
            reviewTask($, { bin, dir: prepared.dir, base: reviewBase, prompt: spec.prompt, model: reviewModel, level: reviewLevel, retries, stallMs, fallback, signal: either(signal, cardSignal) }),
          )
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
      if (wantMerge && isolation === 'worktree') await autoMerge($, batch, extras, input.autoResolve === true ? resolver : undefined)
      let check = ''
      if (goal !== undefined && planned !== undefined) {
        if (batch.integration !== undefined && batch.top !== undefined && (extras.merged ?? []).length > 0) {
          const review = await checkMerged($, { goal, top: batch.top, base: batch.base ?? 'HEAD', integration: batch.integration, checker, retries, stallMs, signal: batchSignal })
          check = checkText(review, 'Gemini is not connected, so the merged result was not checked.')
        } else check = checkText(undefined, 'Nothing was merged, so there was no merged result to check.')
      }
      const head = planned === undefined ? '' : `${planText(planned.plan, planned.model, goal ?? '')}\n\n`
      const tail = check === '' ? '' : `\n\n${check}`
      const full = `${head}${batchReport(batch, extras)}${tail}`
      const path = await writeReport($, base, id, full)
      batch.reportPath = path
      await sync()
      await addHistory($, batch)
      return input.report === 'full' ? full : `${head}${batchShortReport({ batch, extras, path })}${tail}`
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
    const total = await $.store.get('spendTotal')
    const view: PanelView = {
      cat: await read($, catalog),
      model: await current($, defaultModel),
      level: await read($, effort),
      isChat: await read($, chat),
      running: await read($, jobs),
      liveBatches: await read($, batches),
      money: await read($, spend),
      spendTotal: typeof total === 'number' ? total : 0,
      recentIds: await read($, recent),
      allOpen: await read($, showAll),
      query: await read($, query),
      folds: await read($, open),
      healthData: await read($, health),
      historyList: await read($, history),
      byModel: await read($, spendByModel),
      shownPreview: await read($, preview),
      localNow: await read($, local),
      planUses: await read($, planUse),
      planQuota: Number(options.zaiQuota ?? 0) || 0,
      geminiUses: await read($, geminiUse),
    }
    return panel($.ui.resolve(e), e.surface, view, {
      pick: id => void pick($, id),
      fold: (key, now) => void update($, open, f => ({ ...f, [key]: now })),
      setChat: isOn => void setChat($, isOn, view.model),
      closePreview: () => void update($, preview, () => null),
      pickEffort: l => void pickEffort($, l),
      applyPreset: p => void applyPreset($, p),
      startLocal: spec => void localOpts($, options, localDir).then(o => bringUp($, spec, o)),
      stopLocal: spec => void stopLocal(spec.name).then(() => setLocal($, spec.name, { status: 'off', error: undefined })),
      toast: text => void $.ui.toast(text),
      taskAction: (kind, batchId, taskId) => void taskAction($, kind, batchId, taskId),
      resume: (batchId, taskId) => void resumeTask($, batchId, taskId),
      toggleShowAll: () => void update($, showAll, v => !v),
      search: value => void update($, query, () => value),
      refresh: () => void refresh($),
    })
  })
}
