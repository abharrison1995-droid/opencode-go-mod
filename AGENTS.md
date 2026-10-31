# MANDATORY: Choose the correct host variant before installation

This is a **dual-variant project**. Choose based on the **user's requested destination app**, NOT based on whether the installing agent is Claude or Codex.

- Target **Claude Code** → install from repository **root**, with `.claude-plugin/`, `hooks/` and `types/`. This version is on `main`.
- Target **Codex desktop / CLI** → install **`codex-companion/`** using its portable manifest, skill and MCP server. The integrated package is on the review branch `codex/agent-subscription-bridge`; it is not on `main` until the owner accepts the draft PR.
- **A Codex agent installing into Claude must choose Claude. A Claude agent installing into Codex must choose Codex.** If target is not known, ask; do not install both or substitute.
- Begin with **[docs/INSTALLATION.md](docs/INSTALLATION.md)**; check the actual manifest and installed CLI; report host-specific smoke tests.
- The Codex variant is in [draft PR #5](https://github.com/abharrison1995-droid/opencode-go-mod/pull/5) on `codex/agent-subscription-bridge`; it has its own MCP tools and optional loopback dashboard, not Claude's sidebar API. GitHub Actions run [#41198897383](https://github.com/abharrison1995-droid/opencode-go-mod/actions/runs/41198897383) passed Claude validation/tests, Python tests, host-package validation and Codex checks on revision `277ff3a`. Codex Desktop discovery is unverified; Codex Pro profiles are not set up, OpenCode CLI lacks the usage API command, and Antigravity returned connected details without structured quota. Never present local run counts as remaining allowance; see `docs/INTEGRATION-AUDIT.md` for the live results.
- Do not handle secrets or merge code without permission.

The remaining sections of AGENTS.md document the **Claude Code root implementation**; `bridge-core/` is shared with the Codex companion.

---

# Working on opencode-go

opencode-go is a Claude Code mod (a function-hooks plugin). It lets Claude delegate tasks to OpenCode Go models through the `opencode` CLI. The README describes its features; this file is for agents changing the code.

## Layout

- `.claude-plugin/plugin.json`: the manifest and its `userConfig` options, which register.tsx reads as `options.<name>`.
- `.claude-plugin/marketplace.json`: makes the repo installable.
- `types/index.d.ts`: the state contract. Every `$.state` key and atom value is declared here.
  It also declares each tool's arguments (`DelegateInput`, `DelegateBatchInput`, `DecideInput`, merged into the engine's `McpToolInputs`), which type the `tool.call` hooks' `e`. When you change a tool's `inputSchema` in register.tsx, change its type here too.
- `ProviderUsageSnapshot` and `UsageWindow` in `types/index.d.ts`: normalized read-only telemetry shapes shared by the Claude panel and Codex package.
- `hooks/register.tsx`: the only module the engine loads. It holds every `atom(...)` and all the hooks:
  - session.start
  - command.run (the `/opencode` subcommands), which reads and changes state around `commands.ts`
  - prompt.compose
  - turn.step (chat mode)
  - tool.call for `delegate`, `delegate_batch`, `delegate_codex` and `decide`
  - ui.render (the OpenCode panel), which reads state and hands it to `panel`
  - cached provider-usage state and refresh cadence for the subscription section
- `hooks/panel.tsx`: `panel` draws the OpenCode panel from a plain `PanelView` and a `PanelActions` object of callbacks, which register.tsx builds around `$`.
- `hooks/usage.ts`: invokes the Node-based shared usage CLI in the active Claude workspace; provider readings are server-reported only when structured fields are returned.
- `hooks/codex.ts`: explicit Codex Pro profile delegation and Codex JSONL parsing, using the shared helper in `bridge-core/codex.mjs`.
- `bridge-core/`: canonical provider-usage and Codex helpers consumed by Claude and copied into `codex-companion/shared/` for the standalone Codex package. Run `node scripts/sync-codex-shared.mjs` after changing shared sources.
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
- `hooks/presets.ts`: the cheap, reliable and strong presets, the `plan` preset when the Z.AI Coding Plan is listed (`presetsFor`, `presetIn`), and `rate()`.
- `hooks/ladder.ts`: the `ladder` profile, models from cheapest to strongest.
- `hooks/resolve.ts`: autoResolve, where a worker fixes its own merge conflict.
- `hooks/review.ts`: a read-only reviewer that checks a task's diff.
- `hooks/selftest.ts`: `/opencode selftest`.
- `hooks/catalog.ts`: model list and cache, and the sources: Go, Zen, the Z.AI Coding Plan (`isPlan`) and Gemini (`isGemini`); `costsMoney`.
- `hooks/gemini.ts`: Gemini through the Antigravity CLI: `agy models` parsing, `agyArgv`, the conversation id in a run's log, and goal mode's plan and check prompts and `parsePlan`. runResilient (delegate.ts) runs any `agy/*` model through it.
- `hooks/quota.ts`: the Z.AI Coding Plan's 5-hour window: model calls used, when it eases, the `zaiQuota` message.
- `hooks/chat.ts`: chat mode.
- `hooks/control.ts`: AbortController registry for cancel.
- `hooks/platform.ts`: Windows support: `isWindows` (from `OS`), `homeOf` (USERPROFILE there), `whereAll` (`where.exe` or `command -v`), `shArgv` and `posixArgv`, which run scripts and POSIX tools through Git for Windows' sh. A spawn runs no shell, so on Windows `findOpencode` and `findAgy` return an `.exe`, never npm's `.cmd` shim. Elsewhere every argv is unchanged.
- `hooks/local.ts`: the local decision models (Kev, Laya) behind `decide`: `startLocal`, `askLocal`, `stopLocal`, `ping`. The servers it spawns live in a module-level map, so a reload stops them.
- `scripts/check.sh`: local root checks: Claude validation, Claude tests, Python script tests and the Claude host type-check. `.github/workflows/check.yml` also validates host routing and runs Codex package/bundle tests; CI does not run the separate Claude host type-check.
- `scripts/setup-local.sh`: installs Kev and Laya into the models folder; `/opencode local setup` prints its command.
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
scripts/check.sh
```

or the parts: `claude plugin validate .`, `claude plugin test .`.

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
