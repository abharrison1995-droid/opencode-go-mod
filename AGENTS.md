# Working on opencode-go

opencode-go is a Claude Code mod (a function-hooks plugin). It lets Claude delegate tasks to OpenCode Go models through the `opencode` CLI. The README describes its features; this file is for agents changing the code.

## Layout

- `.claude-plugin/plugin.json`: the manifest and its `userConfig` options, which register.tsx reads as `options.<name>`.
- `.claude-plugin/marketplace.json`: makes the repo installable.
- `types/index.d.ts`: the state contract. Every `$.state` key and atom value is declared here.
- `hooks/register.tsx`: the only module the engine loads. It holds every `atom(...)` and all the hooks:
  - session.start
  - command.run (the `/opencode` subcommands)
  - prompt.compose
  - turn.step (chat mode)
  - tool.call for `delegate` and `delegate_batch`
  - ui.render (the OpenCode panel)
- `hooks/delegate.ts`:
  - `runOpencode` is the spawn loop, with a stall watchdog and end reasons.
  - `runResilient` handles resumes, fallback models and the verify loop.
  - Also here: budgets, context-size checks, `formatReport`.
- `hooks/batch.ts`:
  - `prepareDir` makes a worktree or copy for each task.
  - `commitTask` commits a task's work; `runBatch` is the scheduler.
- `hooks/report.ts`: short and full reports, and the merge section.
- `hooks/git.ts`: diff, merge and discard for task branches.
- `hooks/health.ts`: `recordRun`, the per-model health counters.
- `hooks/presets.ts`: the cheap, reliable and strong presets, and `rate()`.
- `hooks/ladder.ts`: the `ladder` profile, models from cheapest to strongest.
- `hooks/resolve.ts`: autoResolve, where a worker fixes its own merge conflict.
- `hooks/review.ts`: a read-only reviewer that checks a task's diff.
- `hooks/selftest.ts`: `/opencode selftest`.
- `hooks/catalog.ts`: model list and cache.
- `hooks/chat.ts`: chat mode.
- `hooks/control.ts`: AbortController registry for cancel.
- `hooks/testkit.ts`: shared test stand-ins. Don't edit it; copy from it instead.
- `hooks/*.test.tsx`: the tests.

## Rules the validator enforces

1. A function that takes `$` (the engine interface) must be declared at the top level of a module file. Never pass `$` to an inner closure or arrow function as an argument. A closure inside register.tsx that *captures* `$` is fine.
2. `atom(...)` refs live only in register.tsx, and only register.tsx calls `read`/`update`. Other modules take plain values and callbacks.
3. A `tool.call` hook needs `.catch(...)`.
4. Every state key must be declared in `types/index.d.ts`.
5. The module has no Node APIs and no DOM. Everything outside goes through `$`: `$.process.run`, `$.process.spawn`, `$.fs`, `$.clock`, `$.store`, `$.ui`.

## Checking your work

```bash
claude plugin validate .
claude plugin test .
```

Both must pass: validation reports "passed" or "passed with warnings", and every test passes. These need Claude Code 2.1.304 or later.

## Tests

- Import with `import { expect, test } from 'claude-code/testing'`.
- A test is written `test(name, async ($, on) => { ... })`.
- `on('<noun>.<method>', hook)` installs a stand-in for a `$` call, which returns `{ value }`.
- The `process.spawn` stand-in is an async generator. It yields `{ stream, text }` and returns `{ value: { code, signal } }`.
- Pure functions can be imported and called directly in a test.
- See `hooks/insight.test.tsx` and `hooks/engine.test.tsx` for full examples.
- No network and no real `opencode run` in tests.

## Style

- TypeScript, strict mode.
- 2-space indent, no semicolons, single quotes.
- Short names. Sparse comments that say why, not what.
- Touch only the files your task names.
- Don't reformat or reorder code you didn't change.
