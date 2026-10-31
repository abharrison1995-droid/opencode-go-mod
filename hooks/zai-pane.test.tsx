import { expect, test } from 'claude-code/testing'

import { model, MODELS, PANE, ready } from './testkit'

const ZAI = `${MODELS}\nzai-coding-plan/glm-5.3\n${model('GLM-5.3', 0, 0, [])}\nzai-coding-plan/glm-5.3-flash\n${model('GLM-5.3 Flash', 0, 0, [])}`

// testkit's engine, listing the given models.
function stand(on: any, store: Map<string, unknown>, models: string) {
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__opencode-go__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('process.run', (_: any, e: any) => ({
    value: { exitCode: 0, stdout: e.argv.includes('models') ? models : '/usr/bin/opencode\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
}

async function mount($: any) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  return ui
}

test('Z.AI PLAN lists the plan models with this window’s use', async ($, on) => {
  stand(on, new Map(), ZAI)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /▾ Z.AI PLAN$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Local task count · 0 model calls in the last 5 h; not a server-reported remaining allowance' })).toBeDefined()
  await ui.press({ key: 'zai:Z.ai' })
  expect(await ui.find({ key: 'model:zai-coding-plan/glm-5.3' })).toBeDefined()
  expect(await ui.find({ key: 'model:zai-coding-plan/glm-5.3-flash' })).toBeDefined()
  await ui.unmount()
})

test('Z.AI PLAN shows use against the zaiQuota option', { options: { zaiQuota: 100 } }, async ($, on) => {
  stand(on, new Map<string, unknown>([['planUse', [{ at: Date.now() - 60_000, calls: 12 }]]]), ZAI)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: 'Local task count · 12/100 model calls in the last 5 h; not a server-reported remaining allowance' })).toBeDefined()
  await ui.unmount()
})

test('the plan preset is offered only with the Z.AI Coding Plan', async ($, on) => {
  stand(on, new Map(), ZAI)
  const ui = await mount($)
  expect(await ui.find({ key: 'preset:plan' })).toBeDefined()
  await ui.press({ key: 'preset:plan' })
  expect(await ui.find({ type: 'Text', text: 'your Z.AI Coding Plan: no per-token cost, uses its 5-hour quota' })).toBeDefined()
  await ui.unmount()
})

test('without the Z.AI Coding Plan there is no Z.AI PLAN section or plan preset', async ($, on) => {
  stand(on, new Map(), MODELS)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /Z.AI PLAN$/ })).toBeUndefined()
  expect(await ui.find({ key: 'preset:plan' })).toBeUndefined()
  await ui.unmount()
})

test('LOCAL lists Kev and Laya with a Start button each', async ($, on) => {
  stand(on, new Map(), MODELS)
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: 'LOCAL' })).toBeDefined()
  expect(await ui.find({ key: 'local-start:kev' })).toBeDefined()
  expect(await ui.find({ key: 'local-start:laya' })).toBeDefined()
  await ui.unmount()
})
