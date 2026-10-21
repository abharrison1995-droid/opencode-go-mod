import { expect, test } from 'claude-code/testing'

import { engine, PANE, ready, step } from './testkit'

test('the panel folds models by maker, searches them, and sets the worker', async ($, on) => {
  const store = new Map<string, unknown>()
  const spawned: string[][] = []
  engine(on, store, spawned, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ready(ui)
    expect(await ui.find({ type: 'Text', text: /▾ FREE$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▾ PAID$/ })).toBeDefined()
    // Maker groups start folded unless they hold the worker (kimi-k3, Moonshot AI).
    expect(await ui.find({ type: 'Text', text: /▾ Moonshot AI$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▸ DeepSeek$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /DeepSeek V4.1 Flash Free/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Opus/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  await ui.press({ key: 'free:DeepSeek' })
  expect(await ui.find({ type: 'Text', text: /DeepSeek V4.1 Flash Free/ })).toBeDefined()
  await ui.press({ key: 'free:DeepSeek' })
  expect(await ui.find({ type: 'Text', text: /DeepSeek V4.1 Flash Free/ })).toBeUndefined()

  await ui.input({ key: 'search', text: 'glm', kind: 'change' })
  expect(await ui.find({ key: 'model:opencode-go/glm-5.3-flash' })).toBeDefined()
  expect(await ui.find({ key: 'model:opencode-go/kimi-k3' })).toBeUndefined()
  await ui.input({ key: 'search', text: '', kind: 'change' })

  await ui.press({ key: 'free:Other' })
  await ui.press({ key: 'model:opencode-go/beam-free' })
  await ui.press({ key: 'effort:xhigh' })
  expect((await ui.find({ type: 'Text', text: /opencode-go\/beam-free · free$/ }))?.text).toBe('Other · opencode-go/beam-free · free')
  await ui.unmount()

  expect(store.get('model')).toBe('opencode-go/beam-free')
  expect(store.get('effort')).toBe('xhigh')

  const ran = await $.tool.call({ tool: 'mcp__opencode-go__delegate', prompt: 'do it' } as any)
  expect(String((ran as any).result)).toContain('sessionId: ses_1')
  expect(spawned[0]).toEqual(['/usr/bin/opencode', 'run', '--format', 'json', '-m', 'opencode-go/beam-free', '--variant', 'xhigh', '--', 'do it'])

  await $.tool.call({ tool: 'mcp__opencode-go__delegate', prompt: 'again', model: 'kimi-k3' } as any)
  expect(spawned[1]).toEqual(['/usr/bin/opencode', 'run', '--format', 'json', '-m', 'opencode-go/kimi-k3', '--', 'again'])
})

test('chat mode answers the turn through OpenCode Go', async ($, on) => {
  const fetched: any[] = []
  engine(on, new Map(), [], fetched)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // Off: the step goes to Claude.
  const before = await step($)
  expect(before.result.answer).toBe('from claude')
  expect(fetched.length).toBe(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ready(ui)
  await ui.press({ key: 'effort:high' })
  await ui.press({ key: 'chat:opencode' })
  await ui.unmount()

  const { chunks, result } = await step($)
  expect(fetched.length).toBe(1)
  expect(fetched[0].url).toBe('https://opencode.ai/inference/go/anthropic/v1/messages')
  expect(fetched[0].init.headers.authorization).toBe('Bearer test-key')
  expect(fetched[0].init.headers['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/)
  const body = JSON.parse(fetched[0].init.body)
  expect(body.model).toBe('kimi-k3')
  expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 })
  expect(body.tools.map((t: any) => t.name)).toEqual(['Read', 'Bash'])
  expect(body.system).toBe('You are Claude Code.')
  expect(body.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'Fix /x.ts' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x.ts' }] },
  ])

  expect(chunks.map(c => c.kind)).toEqual(['text', 'tool', 'input', 'stop'])
  expect(chunks[1].id).toMatch(/^toolu_oc[0-9a-f]{22}$/)
  expect(chunks[1].name).toBe('Read')
  expect(result.stopReason).toBe('tool_use')
  expect(result.toolUses).toEqual([{ name: 'Read', input: { file_path: '/x.ts' } }])
  expect(result.usage.input_tokens).toBe(100)
})
