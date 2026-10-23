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
  - tool.call for `delegate`, `delegate_batch` and `decide`
  - ui.render (the OpenCode panel), which reads state and hands it to `panel`
- `hooks/panel.tsx`: `panel` draws the OpenCode panel from a plain `PanelView` and a `PanelActions` object of callbacks, which register.tsx builds around `$`.
- `hooks/delegate.ts`:
  - `runOpencode` is the spawn loop, with a stall watchdog and end reasons.
  - `runResilient` handles resumes, fallback models and the verify loop.
  - Also here: budgets, context-size checks, `formatReport`.
- `hooks/batch.ts`:
  - `prepareDir` makes a worktree or copy for each task.
  - `commitTask` commits a task's work; `runBatch` is the scheduler.
- `hooks/report.ts`: short and full reports, and the merge section.
- `hooks/git.ts`: diff, merge and discard for task branches, and `repoOf`.
- `hooks/health.ts`: `recordRun`, the per-model health counters.
- `hooks/presets.ts`: the cheap, reliable and strong presets, and `rate()`.
- `hooks/ladder.ts`: the `ladder` profile, models from cheapest to strongest.
- `hooks/resolve.ts`: autoResolve, where a worker fixes its own merge conflict.
- `hooks/review.ts`: a read-only reviewer that checks a task's diff.
- `hooks/selftest.ts`: `/opencode selftest`.
- `hooks/catalog.ts`: model list and cache.
- `hooks/chat.ts`: chat mode.
- `hooks/control.ts`: AbortController registry for cancel.
- `hooks/local.ts`: the local decision models (Kev, Laya) behind `decide`: `startLocal`, `askLocal`, `stopLocal`, `ping`. The servers it spawns live in a module-level map, so a reload stops them.
- `scripts/kev_split.py`: starts Kev split between the GPU and RAM when `kevGpuGb` is set. It runs outside the engine, in Kev's own venv.
- `hooks/timers.d.ts`: declares `setTimeout` for the tests, which have host timers. Hooks code must not rely on it.
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

Both must pass: validation reports "passed" or "passed with warnings", and every test passes. These need Claude Code 2.1.304 or later. Check `claude --version` first: an older `claude` on PATH fails validation with errors that are not about the mod (2.1.282 reports `"prompt.compose" is not an event`). The desktop app keeps newer builds in `~/.config/Claude/claude-code/<version>/*/claude`.

Type-checking should also show no errors. `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which the engine writes (with the API's declarations) only when it hot-reloads the mod from this folder, and which git ignores. Elsewhere, point a tsconfig with the same options at the plugin-authoring skill's `types/claude-code.d.ts` plus `hooks` and `types`, and run `tsc -p` on it.

## Tests

- Import with `import { expect, test } from 'claude-code/testing'`.
- A test is written `test(name, async ($, on) => { ... })`.
- `on('<noun>.<method>', hook)` installs a stand-in for a `$` call, which returns `{ value }`.
- The `process.spawn` stand-in is an async generator. It yields `{ stream, text }` and returns `{ value: { code, signal } }`.
- Pure functions can be imported and called directly in a test.
- See `hooks/insight.test.tsx` and `hooks/engine.test.tsx` for full examples.
- No network and no real `opencode run` in tests.
- `session.start` pings the local models (`http://127.0.0.1:8009`, `:8010`). A test that counts `http.fetch` calls must answer or leave out those pings.

## Style

- TypeScript, strict mode.
- 2-space indent, no semicolons, single quotes.
- Short names. Sparse comments that say why, not what.
- Touch only the files your task names.
- Don't reformat or reorder code you didn't change.
