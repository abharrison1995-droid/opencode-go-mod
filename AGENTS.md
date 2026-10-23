# Working on opencode-go

opencode-go is a Claude Code mod (a function-hooks plugin). It lets Claude delegate tasks to OpenCode Go models through the `opencode` CLI. The README describes its features; this file is for agents changing the code.

## Layout

- `.claude-plugin/plugin.json`: the manifest and its `userConfig` options, which register.tsx reads as `options.<name>`.
- `.claude-plugin/marketplace.json`: makes the repo installable.
- `types/index.d.ts`: the state contract. Every `$.state` key and atom value is declared here.
  It also declares each tool's arguments (`DelegateInput`, `DelegateBatchInput`, `DecideInput`, merged into the engine's `McpToolInputs`), which type the `tool.call` hooks' `e`. When you change a tool's `inputSchema` in register.tsx, change its type here too.
- `hooks/register.tsx`: the only module the engine loads. It holds every `atom(...)` and all the hooks:
  - session.start
  - command.run (the `/opencode` subcommands), which reads and changes state around `commands.ts`
  - prompt.compose
  - turn.step (chat mode)
  - tool.call for `delegate`, `delegate_batch` and `decide`
  - ui.render (the OpenCode panel), which reads state and hands it to `panel`
- `hooks/panel.tsx`: `panel` draws the OpenCode panel from a plain `PanelView` and a `PanelActions` object of callbacks, which register.tsx builds around `$`.
- `hooks/commands.ts`: the `/opencode` subcommands' parsing, matching and text (help, models, status, presets, batches, history, diff). Pure functions, no `$`.
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
- `scripts/typecheck.sh`: type-checks `hooks` and `types` against the engine's declarations.
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

Type-checking should also show no errors: run `scripts/typecheck.sh`. The engine's declarations aren't in the repo, so the script uses `.claude-plugin/types/` (written when the engine hot-reloads the mod from this folder, and ignored by git), or else the copy the plugin-authoring skill unpacks under `/tmp`. Set `CLAUDE_CODE_TYPES` to point it at a `claude-code.d.ts` yourself. It uses `tsc` from `TSC`, from PATH, or through `npx`.

## Tests

- Import with `import { expect, test } from 'claude-code/testing'`.
- A test is written `test(name, async ($, on) => { ... })`.
- `on('<noun>.<method>', hook)` installs a stand-in for a `$` call, which returns `{ value }`.
- The `process.spawn` stand-in is an async generator. It yields `{ stream, text }` and returns `{ value: { code, signal } }`.
- Pure functions can be imported and called directly in a test.
- See `hooks/insight.test.tsx` and `hooks/engine.test.tsx` for full examples.
- No network and no real `opencode run` in tests.
- In tests, chat mode's `$.prompt.compose({ tools })` skips the mod's own `prompt.compose` hook. A failing test shows this as "next() passed an argument with no { promptModel }". The test engine has no session to fill in the model, output style and other details that a real session supplies. Leave it alone: the hook adds nothing while chat mode is on, and the mod must not invent those values.
- `session.start` pings the local models (`http://127.0.0.1:8009`, `:8010`). testkit's `engine` answers those pings with a 503 and leaves them out of `fetched`. A test with its own `http.fetch` stand-in must do the same.

## Style

- TypeScript, strict mode.
- 2-space indent, no semicolons, single quotes.
- Short names. Sparse comments that say why, not what.
- Touch only the files your task names.
- Don't reformat or reorder code you didn't change.
