# opencode-go

A Claude Code mod that lets Claude delegate tasks to cheaper models through an [OpenCode Go](https://opencode.ai) subscription, using the `opencode` CLI. Claude plans and reviews; OpenCode workers do the routine work.

## Requirements

- The `opencode` CLI on your PATH (`npm i -g opencode-ai`), signed in with `opencode auth login`, choosing OpenCode Go.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install opencode-go --marketplace abharrison1995-droid/opencode-go-mod
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install opencode-go --marketplace abharrison1995-droid/opencode-go-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `abharrison1995-droid/opencode-go-mod`, then Add plugin.

## What it does

- `delegate` runs one OpenCode worker and waits for its answer.
- `delegate_batch` runs up to 12 tasks in parallel, each in its own git worktree, with `dependsOn` ordering.
- Runs resume their session after rate limits, stalls and failures, up to `autoRetries` times, then try `fallbackModel`.
- `verify` runs a shell command after each run and resumes the worker with the output until it passes.
- `shared` context and `files` are passed to every batch task.
- A task above 80% of the model's context is denied; above 50% it gets a warning.
- `maxCost` limits a batch, and `dailyBudget` limits the day's spend.
- Runs can be cancelled from the panel or with `/opencode cancel`.
- Results come back short, with the full report in `.opencode/reports/`.
- Each model is rated good, shaky or bad; unreliable models are flagged in the tool description.
- Batch history and spend by model are kept.
- A `profile` (cheap, reliable or strong) sets a preset model and reasoning level.
- `autoMerge` merges passing worktree tasks into `oc/<batch>-merged`; `autoResolve` has a task's own worker fix a merge conflict.
- `review` has a free model check each task's diff, so Claude reads only flagged tasks.
- The `ladder` profile starts on healthy free models and escalates to paid ones only on failure.
- Tasks with `dependsOn` build on their dependencies' branches.
- The OpenCode panel and `/opencode` commands cover models, reasoning, presets, batches, history and cancel.
- Chat mode answers turns through OpenCode Go's Anthropic-compatible endpoint.

## How Claude uses it

Claude hands routine, well-specified work to `delegate` and keeps planning and review for itself. The worker sees nothing of the conversation, so the prompt must be self-contained, including files, constraints and what to report back. For independent work, or a larger job split into parts, Claude uses `delegate_batch`: workers run in parallel in separate worktrees, common context goes in `shared`, and `dependsOn` orders tasks. A task that would exceed 80% of its model's context is denied before it starts.

Claude gives coding tasks a `verify` command, such as `npm test`. If the run succeeds but the check fails, the worker is resumed with the output for up to `verifyRounds` rounds. A `profile` picks a preset model and reasoning level, and an explicit model or effort wins over it. By default the result is a short report and the full report is written to a file, readable inline with `report: full`. With `autoMerge`, tasks in worktrees whose verify passed (or that had no verify) are merged into `oc/<batch>-merged` without touching the user's checkout; conflicting tasks are reported and left unmerged.

## The OpenCode panel

The panel opens when a session starts and with `/opencode`. It has these sections:

- **THIS CHAT**: switches between Claude and OpenCode for chat mode.
- **WORKER**: the picked model, its maker, and its price or free status, plus recent rate limits, hangs and failures when the model is shaky or bad.
- **SPENT**: this chat's spend and run count, and the all-time total.
- **REASONING**: the `low`, `medium`, `high`, `xhigh` and `max` levels.
- **PRESETS**: the cheap, reliable and strong presets, with a note for the matching one.
- **RUNNING**: live delegate jobs with their model, reasoning, steps and last action, each with Cancel.
- **PLAN**: the latest batches and their tasks, showing status, model, steps, attempts, verify result, merge state and branch. Tasks offer Diff, Merge, Discard and Resume where they apply. A diff opens in a preview.
- **HISTORY**: recent finished batches with status, task count, cost and age, plus spend by model.
- **FREE** and **PAID**: model lists grouped by maker. Free models show whether they are Go or Zen; paid models show input/output price per Mtok. Health dots mark good, shaky and bad models. A search field filters by model or maker, and Refresh models reloads the lists.

On mobile the panel is compact: it shows the worker, reasoning and presets, recent models, and an All models toggle instead of the full lists.

## Commands

| Command | What it does |
| --- | --- |
| `/opencode` | Opens the panel. |
| `/opencode model <name>` | Picks the worker model by id or name; several matches are listed. |
| `/opencode effort <level>` | Sets reasoning to `low`, `medium`, `high`, `xhigh` or `max`. |
| `/opencode chat on\|off` | Sends this chat's turns through OpenCode Go, or back to Claude. |
| `/opencode preset [name]` | Applies a preset (`cheap`, `reliable`, `strong`) or lists them. |
| `/opencode models [free\|paid]` | Lists models with free status or price. |
| `/opencode status` | Shows the worker, chat mode, running jobs and spend. |
| `/opencode selftest` | Checks the CLI, git, hang detection, rate-limit detection, notifications and the report folder. |
| `/opencode batches` | Lists this chat's batches and their task states. |
| `/opencode history` | Lists recent finished batches and spend by model. |
| `/opencode cancel <id>\|all` | Stops a job, a batch or every run. |
| `/opencode diff <batch> <task>` | Shows a task branch's diff. |
| `/opencode merge <batch> <task>` | Merges a task branch. |
| `/opencode discard <batch> <task>` | Removes a task's worktree and branch. |
| `/opencode resume <batch> <task>` | Continues a failed or cancelled task. |
| `/opencode help` | Lists the commands. |

## Configuration

| Option | What it does | Default |
| --- | --- | --- |
| `defaultModel` | Worker used until one is picked in the OpenCode panel (provider/model, or a bare id under `opencode-go/`). | `opencode-go/kimi-k3` |
| `orchestrate` | Adds a short system prompt section telling Claude to hand routine work to OpenCode Go models. | `true` |
| `fallbackModel` | Model a run switches to after the picked one keeps failing (429s, hangs). Empty: no fallback. | `opencode-go/deepseek-v4.1-flash` |
| `autoRetries` | How many times a failed or hung opencode run is resumed before giving up (and trying the fallback model). | `3` |
| `stallMinutes` | A run that prints nothing for this long is killed and resumed. | `10` |
| `reviewModel` | Model that reviews batch tasks when `review` is on. | `opencode/deepseek-v4.1-flash-free` |
| `dailyBudget` | No new paid runs start once today's OpenCode spend reaches this. 0: no limit. | `0` |

Change these with `/plugin configure opencode-go@opencode-go-mod` in a terminal session, or in the plugin settings in the desktop app.

## Troubleshooting

- **429 or 'Endpoint is unavailable'**: the endpoint is busy or rate-limited. Runs resume on their own; paid Go models may need Global regions enabled in the OpenCode workspace.
- **A run prints nothing for `stallMinutes`**: it is killed and resumed.
- **`/opencode selftest`**: checks the CLI, git, hang and rate-limit detection, notifications and the report folder.
- **A finished batch task marked 'no changes ⚠'**: it edited nothing in its worktree.
- **`opencode` missing or not signed in**: it must be on PATH and signed in with `opencode auth login`.

## Model health

Each finished attempt is counted against its model as `ok`, `failed`, `rate-limited` or `hung`. Cancelled runs are ignored. A run whose verify still fails after its fix-up rounds counts as `failed`, since the model did not produce working code. The rating is the bad share: `failed` plus `rateLimited` plus `hung`, over all runs.

- **good**: under 20% bad.
- **shaky**: 20% up to (not including) 50% bad.
- **bad**: 50% or more bad.

A record whose last run is more than 6 hours old is treated leniently: under 50% bad is **good**, and 50% or more is **shaky**, never **bad**.

Ratings show as the panel's health dots in the free and paid model lists, as `Unreliable right now` in the delegate tool description, and the `ladder` profile skips shaky and bad free models.
