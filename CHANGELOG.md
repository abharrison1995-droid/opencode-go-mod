# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.11.0]

### Added

- Gemini on a Google AI Pro plan, through the Antigravity CLI (`agy`) signed in with your Google account: no API key and no per-token cost. Its models appear as `agy/*` in a GEMINI section of the panel, in `/opencode models gemini`, and in the delegate tools' model list, and run through `delegate` and `delegate_batch` like any other worker. Runs resume their agy conversation after a quota limit and fall back like any other; read-only runs use agy's plan mode.
- `gemini` preset and profile (Gemini 4 Argon, high reasoning). The `ladder` profile tries Gemini after the free models.
- Goal mode: `delegate_batch` with a `goal` instead of `tasks` has Gemini plan the tasks, review each task's diff, and check the merged result against the goal; review and autoMerge default to on.
- Gemini runs over the last 5 hours, shown under GEMINI, and a Google AI Pro check in `/opencode selftest`.

### Changed

- The `reviewModel` option defaults to `auto`: Gemini when connected, else the free model as before.

## [0.10.0]

### Added

- `plan` preset and profile for the Z.AI Coding Plan (GLM-5.3), offered when opencode lists the plan's models.
- The `ladder` profile tries the Z.AI Coding Plan between the free and paid models, while it is healthy and has quota.
- Z.AI Coding Plan use: model calls on plan models over the last 5 hours, shown under Z.AI PLAN. The `zaiQuota` option stops new plan runs at a limit.
- `/opencode selftest` checks which model sources opencode lists (Go, Zen, Z.AI) and whether Kev and Laya are installed or running. Optional parts not set up are skipped, not failed.
- `scripts/setup-local.sh` installs Kev and Laya; `/opencode local setup` prints its command.
- `scripts/check.sh` runs every release check, and a GitHub Actions workflow runs validate and the tests on each push and pull request.
- Panel tests for Z.AI PLAN, the plan preset and LOCAL.
- An icon.

### Changed

- Descriptions name Go, Zen and the Z.AI Coding Plan, not only OpenCode Go.
- Starting a local model that is not installed reports it instead of spawning a missing binary.
- README: a quick start, the LOCAL panel section, and the new options and commands.

## [0.9.0]

### Added

- Z.AI Coding Plan: models from opencode's `zai-coding-plan` (z.ai) and `zhipuai-coding-plan` (bigmodel.cn) providers appear in a Z.AI PLAN section of the OpenCode panel, in `/opencode models zai`, and in the delegate tool's model list. They run through `delegate` and `delegate_batch` like any other worker.
- `isPlan` and `costsMoney` in `hooks/catalog.ts`.

### Changed

- Z.AI Coding Plan models list $0 but are not counted as free: the ladder profile does not pick them, and the daily budget does not block them, since they draw on the plan's prompt quota, not dollars.

## [0.8.1]

### Added

- `kevGpuGb` splits Kev between the GPU and system RAM (`scripts/kev_split.py`, using accelerate), so Kev-4B runs on an 8 GB card.
- MIT license.
- Tests for the local servers and `decide`: start, reuse, crash and timeout, one start at a time, Stop, `askLocal` errors, `/opencode local`, and the LOCAL panel.
- Tests for `scripts/kev_split.py` (`scripts/test_kev_split.py`, with stand-ins for torch, Kev and accelerate) and for the `/opencode` subcommands' matching and text.
- `scripts/typecheck.sh` type-checks the mod against the engine's declarations.
- The tool inputs are typed: `DelegateInput`, `DelegateBatchInput` and `DecideInput` in `types/index.d.ts` type each `tool.call` hook's `e`, so a misspelled field fails the type-check.

### Changed

- Local models take turns: servers start one at a time, and `model: "both"` asks Kev and then Laya instead of both at once.
- The panel's drawing moved from register.tsx to `hooks/panel.tsx`; register.tsx now reads the state and passes in callbacks. Nothing it shows or does changed.
- The `/opencode` subcommands' parsing and text moved to `hooks/commands.ts`, the same way.
- testkit's engine answers the local models' health pings with a 503 and leaves them out of `fetched`.

### Fixed

- The hooks module loads under Claude Code 2.1.304, which refuses a closure that takes `$`; before this, every test that loaded the mod failed.
- Tests match 2.1.304's engine types (`command.run`'s `origin` and `presentation`), and the mod and its tests type-check with no errors.
- Chat-mode tests no longer count the local models' health pings as chat requests; the 503 retry test now exercises the retry.

## [0.8.0]

### Added

- `decide` tool: asks Kev or Laya, small decision models running on this machine, typed questions (`noul`, `choice`, `score`) about a text and returns calibrated probabilities. `model: "both"` compares them side by side. The first call starts the model's server, and the server is stopped when the session ends.
- LOCAL section in the OpenCode panel: each local model's status, call count and latency, with Start and Stop.
- `/opencode local [status|start|stop] [kev|laya]`.
- Options `localModelsDir`, `kevModel`, `localDevice` and `layaDevice`. Laya runs on the CPU by default, so Kev has the GPU.

## [0.7.0]

### Added

- AGENTS section in the OpenCode panel, replacing RUNNING: a card for each running delegate job and running batch task, numbered in order. The header shows the model and reasoning in its maker's colour, the stage line shows what the run is doing (working, starting, retrying, verifying or reviewing), and ACTIVITY shows its latest action. Batch cards also show the batch title, task id and verify result.
- Model names in the FREE and PAID lists and in PLAN task rows carry a dot in their maker's colour.
- `colorOf` and `MAKER_COLORS` in `hooks/catalog.ts`: one hex colour per maker, readable on light and dark themes.

## [0.6.2]

### Fixed

- `/opencode selftest` passes the notification check with a note where no terminal is attached (the desktop app, a phone). Notifications reach only a terminal there, and batches show a toast instead. Notifications turned off still fail the check.

## [0.6.1]

### Added

- Unit tests for `rate()` and `presetNamed`, and README sections on model health and troubleshooting (written by free OpenCode workers in a ladder, review and autoResolve batch).

### Fixed

- `/opencode selftest` reports a notification no surface took as failed instead of passed.

## [0.6.0]

### Added

- `ladder` profile: starts on up to two healthy free models and climbs to paid DeepSeek Flash, then Kimi K3, only when a rung fails. Free rungs get one retry, since a rate-limited free endpoint tends to stay limited.
- `autoResolve` for batches: a task whose branch conflicts during autoMerge gets the merged branch brought into its worktree, and its own worker resolves the conflict and re-runs verify before it is merged.
- `review` for batches: a read-only reviewer (the `reviewModel` setting, free by default) checks each task's diff against its prompt, and the report flags concerns.
- Tasks with `dependsOn` start from their dependencies' branches, so one batch can chain implement, test and document steps.
- `/opencode selftest`: checks the opencode CLI, git, the hang watchdog, rate-limit detection, notifications and the report folder on this machine.
- `AGENTS.md`: the layout, rules and test commands for agents working on the mod.
- The short report marks a finished task that changed nothing in its worktree.

### Fixed

- Workers now run in their own folder. opencode reads its project folder from `$PWD`, which spawned workers inherited from Claude Code, so a worker could edit the user's main checkout instead of its worktree.

## [0.5.0]

### Added

- Self-healing runs: a run resumes its session after rate limits, hangs (no output for `stallMinutes`) and failures, up to `autoRetries` times, then switches to `fallbackModel`.
- `verify` support: a shell command checked after each run; on failure the worker is resumed with the output, up to `verifyRounds` times.
- `shared` context and `files` attachments (`-f`) for batch tasks and the delegate tool.
- Context-size check: tasks above 80% of the model's context are denied, and tasks above 50% produce a warning.
- Budgets: `maxCost` per batch and a `dailyBudget` in USD.
- Cancelling a run from the OpenCode panel or with `/opencode cancel`.
- Short reports by default, with the full report written to `.opencode/reports/`.
- Model health records: each model is rated good, shaky or bad, and unreliable models are flagged in the tool description.
- Batch history and spend by model.
- `profile` option with `cheap`, `reliable` and `strong` presets, each combining a model and reasoning level.
- `autoMerge` for batches: passing worktree tasks are merged into `oc/<batch>-merged` without touching the user's checkout.
- OpenCode panel sections for RUNNING jobs with Cancel, PLAN batches with Diff, Merge, Discard and Resume actions, and HISTORY, plus a SPENT line.
- FREE and PAID model lists with search, health dots, a reasoning level and presets, and a compact mobile view.
- `/opencode` settings commands: `model <name>`, `effort <level>`, `chat on|off` and `preset [name]`.
- `/opencode` info commands: `models`, `status`, `batches`, `history` and `help`.
- `/opencode` batch actions: `cancel <id>|all` and `diff|merge|discard|resume <batch> <task>`.

### Changed

- The delegate and batch tools now recommend `verify` commands and describe model reliability so Claude can route work more safely.
- Batch tasks run through the resilient runner, including resumes, verification, budgets and health tracking.
- The panel was reorganised around RUNNING, PLAN and HISTORY, with spend reported in USD.

## [0.4.0]

### Added

- Each worktree task is committed on its own branch so its work can be reviewed and merged.

### Changed

- Parallel worktree creation is safer and no longer risks workers sharing or overwriting the same checkout.

### Fixed

- Rate-limit errors are reported more clearly.

## [0.3.0]

### Added

- The `delegate_batch` tool, running parallel tasks in separate git worktrees.
- A PLAN section in the OpenCode panel.
- The spend line in the panel.
- Recent models in the model lists.
- A compact mobile view.
- `readOnly` runs using opencode's read-only plan agent.

## [0.2.0]

### Added

- Chat mode, answering turns through OpenCode Go's Anthropic-compatible endpoint.
- Model search in the OpenCode panel.

## [0.1.0]

### Added

- The `delegate` tool for running a single OpenCode Go worker and waiting for its answer.
- An OpenCode panel to pick the worker model from FREE and PAID lists and choose a reasoning level.
