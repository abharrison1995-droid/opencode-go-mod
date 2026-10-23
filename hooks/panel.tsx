import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { Batch, BatchSummary, BatchTask, Catalog, Effort, Job, LocalServer, ModelHealth, Phase, Preset, Preview, Spend, WorkerModel } from '../types'
import { colorOf, isFree, isPlan, price, worker } from './catalog'
import { cancel } from './control'
import { repoOf } from './git'
import type { TaskAction } from './git'
import { LOCAL, ownsLocal } from './local'
import type { LocalSpec } from './local'
import { EFFORTS, PRESETS, rate } from './presets'

// What the panel shows, read from state by register.tsx, which alone holds the atoms.
export type PanelView = {
  cat: Catalog
  model: string
  level: Effort
  isChat: boolean
  running: Job[]
  liveBatches: Batch[]
  money: Spend
  spendTotal: number
  recentIds: string[]
  allOpen: boolean
  query: string
  folds: Record<string, boolean>
  healthData: Record<string, ModelHealth>
  historyList: BatchSummary[]
  byModel: Record<string, number>
  shownPreview: Preview | null
  localNow: Record<string, LocalServer>
}

// The panel's buttons, as callbacks register.tsx builds around `$`.
export type PanelActions = {
  pick: (id: string) => void
  fold: (key: string, open: boolean) => void
  setChat: (on: boolean) => void
  closePreview: () => void
  pickEffort: (level: Effort) => void
  applyPreset: (preset: Preset) => void
  startLocal: (spec: LocalSpec) => void
  stopLocal: (spec: LocalSpec) => void
  toast: (text: string) => void
  taskAction: (kind: TaskAction, batchId: string, taskId: string) => void
  resume: (batchId: string, taskId: string) => void
  toggleShowAll: () => void
  search: (value: string) => void
  refresh: () => void
}

export const ICONS: Record<BatchTask['status'], string> = { pending: '○', running: '◐', done: '●', failed: '✕', skipped: '–', cancelled: '⊘' }

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

export function shortModel(id: string) {
  return id.split('/')[1] ?? id
}

export function ageOf(at: number) {
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

export function panel(elements: ElementTable, surface: RenderSurface, v: PanelView, act: PanelActions): RenderElement {
  const { Box, Text, Button } = elements
  const Input = 'Input' in elements ? elements.Input : undefined
  const { cat, model, level, isChat, running, liveBatches, money, spendTotal, recentIds, allOpen, folds, healthData, historyList, byModel, shownPreview, localNow } = v
  const search = v.query.trim().toLowerCase()
  const selected = cat.models.find(m => m.id === model)
  const { free, paid, plan } = worker(cat.models)
  const isMobile = surface === 'mobile'
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
  const toggle = (key: string, now: boolean) => () => act.fold(key, !now)

  const row = (m: WorkerModel, chip: string) => {
    const isPicked = m.id === model
    const chatOnly = isChat && m.source !== 'go'
    return (
      <Button key={`model:${m.id}`} plain onPress={() => act.pick(m.id)}>
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

  const section = (key: string, title: string, color: 'success' | 'warning' | 'suggestion', hint: string, list: WorkerModel[], chip: (m: WorkerModel) => string) => {
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
          <Button key="chat:claude" label="Claude" variant={isChat ? 'secondary' : 'primary'} onPress={() => act.setChat(false)} />
          <Button key="chat:opencode" label="OpenCode" variant={isChat ? 'primary' : 'secondary'} onPress={() => act.setChat(true)} />
        </Box>
        <Text dimColor size="caption">
          {isChat
            ? model.startsWith('opencode-go/')
              ? `Every turn goes to ${selected?.name ?? model}. Core tools only; replies arrive a step at a time.`
              : 'Pick a Go model: Zen and Z.AI models only work through delegate.'
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
          {selected ? (isPlan(selected) ? ' · Z.AI Coding Plan' : isFree(selected) ? ' · free' : ` · ${price(selected.input)}/${price(selected.output)} per Mtok`) : ''}
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
            <Button key="preview:close" plain label="Close" onPress={() => act.closePreview()} />
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
              onPress={() => act.pickEffort(l)}
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
              onPress={() => act.applyPreset(p)}
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
                {!busy && <Button key={`local-start:${spec.name}`} plain label="Start" onPress={() => act.startLocal(spec)} />}
                {busy && ownsLocal(spec.name) && (
                  <Button key={`local-stop:${spec.name}`} plain label="Stop" onPress={() => act.stopLocal(spec)} />
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
                      act.toast(stopped ? `Cancelling ${name}.` : `${name} is not running.`)
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
                        act.toast(stopped || b.status === 'running' ? `Cancelling batch ${b.id}.` : `Batch ${b.id} is not running.`)
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
                          {canDiff && <Button key={`diff:${b.id}:${t.id}`} plain label="Diff" onPress={() => act.taskAction('diff', b.id, t.id)} />}
                          {canMerge && <Button key={`merge:${b.id}:${t.id}`} plain label="Merge" onPress={() => act.taskAction('merge', b.id, t.id)} />}
                          {canDiscard && <Button key={`discard:${b.id}:${t.id}`} plain label="Discard" onPress={() => act.taskAction('discard', b.id, t.id)} />}
                          {canResume && <Button key={`resume:${b.id}:${t.id}`} plain label="Resume" onPress={() => act.resume(b.id, t.id)} />}
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
          {recentModels.map(m => row(m, isPlan(m) ? 'Z.AI' : isFree(m) ? (m.source === 'go' ? 'Go' : 'Zen') : `${price(m.input)}/${price(m.output)}`))}
        </Box>
      )}

      {isMobile && (
        <Button key="showAll" plain onPress={() => act.toggleShowAll()} label={allOpen ? 'Hide all models' : `All models (${free.length + paid.length + plan.length})`} />
      )}
      {isMobile && <Text dimColor size="caption">{'Or type /opencode model <name>'}</Text>}

      {!isMobile && Input !== undefined && (
        <Input
          key="search"
          placeholder="Search models or makers"
          value={v.query}
          onInput={value => act.search(value)}
          onSubmit={value => act.search(value)}
        />
      )}

      {cat.status === 'loading' && cat.models.length === 0 && <Text dimColor>Loading models…</Text>}
      {cat.status === 'error' && <Text color="error">Could not list models: {cat.error}</Text>}
      {cat.models.length > 0 && search !== '' && !cat.models.some(matches) && <Text dimColor>No model matches “{search}”.</Text>}

      {(!isMobile || allOpen) && section('free', 'FREE', 'success', 'No cost while OpenCode offers them', free, m => (m.source === 'go' ? 'Go' : 'Zen'))}
      {(!isMobile || allOpen) && section('paid', 'PAID', 'warning', 'Uses your Go allowance · $ in/out per Mtok', paid, m => `${price(m.input)}/${price(m.output)}`)}
      {(!isMobile || allOpen) && section('zai', 'Z.AI PLAN', 'suggestion', 'Uses your Z.AI Coding Plan quota · no per-token cost', plan, m => (m.id.startsWith('zhipuai') ? 'bigmodel.cn' : 'z.ai'))}

      <Button key="refresh" plain dimColor onPress={() => act.refresh()}>
        ↻ Refresh models
      </Button>
    </Box>
  )
}
