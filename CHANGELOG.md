# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
