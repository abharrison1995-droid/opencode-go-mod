# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
