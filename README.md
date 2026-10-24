# opencode-go

A Claude Code mod that lets Claude delegate tasks to cheaper models through the `opencode` CLI: an [OpenCode Go](https://opencode.ai) subscription, Zen's free models, and a [Z.AI Coding Plan](https://z.ai) if you have one. Claude plans and reviews; OpenCode workers do the routine work.

## Requirements

- The `opencode` CLI on your PATH (`npm i -g opencode-ai`), signed in with `opencode auth login`, choosing OpenCode Go. Zen's free models work without a subscription; a Z.AI Coding Plan is optional.
- git, for `delegate_batch` worktrees.
- For the local decision models only: git, [uv](https://docs.astral.sh/uv/), and a few GB of disk.

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

## Quick start

1. `npm i -g opencode-ai`, then `opencode auth login` and choose OpenCode Go (run it again for a Z.AI Coding Plan).
2. Install the mod as above and start a new Claude Code session. The OpenCode panel opens.
3. Run `/opencode selftest`. Every check should pass; optional parts you have not set up (the Z.AI Coding Plan, Kev, Laya) show as skipped.
4. Pick a worker in the panel, or a preset, and ask Claude to hand it something routine.
5. Optional: `/opencode local setup` prints the command that installs Kev and Laya.

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
- A `profile` (cheap, reliable, strong, or plan for the Z.AI Coding Plan) sets a preset model and reasoning level.
- `autoMerge` merges passing worktree tasks into `oc/<batch>-merged`; `autoResolve` has a task's own worker fix a merge conflict.
- `review` has a free model check each task's diff, so Claude reads only flagged tasks.
- The `ladder` profile starts on healthy free models and escalates, through the Z.AI Coding Plan when connected, to paid ones only on failure.
- Tasks with `dependsOn` build on their dependencies' branches.
- The OpenCode panel and `/opencode` commands cover models, reasoning, presets, batches, history and cancel.
- Chat mode answers turns through OpenCode Go's Anthropic-compatible endpoint.

## Z.AI Coding Plan

A Z.AI (GLM) Coding Plan subscription works as a third source of workers beside OpenCode Go and Zen. Connect it to opencode once:

```bash
opencode auth login
```

Pick **Z.AI Coding Plan** (or **Zhipu AI Coding Plan** for a bigmodel.cn subscription) and paste the plan's API key. Then press ↻ Refresh models in the OpenCode panel: the GLM models appear under Z.AI PLAN, and `delegate` can run them by id, e.g. `zai-coding-plan/glm-5.3`.

Plan models have no per-token cost, so the daily budget never blocks them, but they are not treated as free either: they use the plan's 5-hour quota.

- The `plan` preset and profile run on the plan's GLM-5.3 (its flash model when that is all there is).
- The `ladder` profile tries the plan after the free models and before paid ones, while the plan is healthy and has quota.
- The mod counts model calls (each step a worker takes) on plan models over the last 5 hours and shows them under Z.AI PLAN. Set `zaiQuota` to stop starting plan runs at a number of calls; the plan itself counts prompts, so pick it from your z.ai usage page. A run that hits the plan's own limit is rate-limited and falls back like any other.
- Chat mode stays on Go models.

## Local decision models (Kev, Laya)

`decide` asks a small model on your own machine typed questions about a piece of text: yes/no (`noul`), one-of (`choice`) or a scale (`score`). It returns calibrated probabilities, with nothing generated. It is free, private, and takes milliseconds once the model is loaded. Claude uses it for cheap, repeatable judgements such as triage, routing and classification.

| Model | Port | What it is |
| --- | --- | --- |
| `kev` | 8009 | [Kev](https://github.com/jaredpalmer/kev), a LoRA on Qwen3.5. The default checkpoint is `jaredpalmer/kev-0.8b`, which fits a 4 GB GPU. |
| `laya` | 8010 | [Laya](https://github.com/NandhaKishorM/laya), ModernBERT-based. English, plus 100+ languages. |

Setup, once, with git and [uv](https://docs.astral.sh/uv/). `/opencode local setup` prints this command with your mod and models folders filled in:

```bash
scripts/setup-local.sh --dir ~/local-models
```

It clones Kev into `kev/` with its venv in `kev/.venv`, and makes a `laya-env/` venv with `laya[serve]`. `--only kev` or `--only laya` installs one, and `--dry-run` prints the steps. Run it again to update Kev. Weights download on each model's first start.

To run a model bigger than your GPU, set `kevGpuGb` to what the card can spare (about 4 on an 8 GB card with a desktop on it), and Kev splits itself between the GPU and RAM.

Models take turns: servers start one at a time, and `model: "both"` asks Kev and then Laya, never the two at once.

The first `decide` call starts that model's server on 127.0.0.1 and downloads its weights on first use. The server runs until you press Stop or the session ends. A server you started yourself on the same port is used as is.

## How Claude uses it

Claude hands routine, well-specified work to `delegate` and keeps planning and review for itself. The worker sees nothing of the conversation, so the prompt must be self-contained, including files, constraints and what to report back. For independent work, or a larger job split into parts, Claude uses `delegate_batch`: workers run in parallel in separate worktrees, common context goes in `shared`, and `dependsOn` orders tasks. A task that would exceed 80% of its model's context is denied before it starts.

Claude gives coding tasks a `verify` command, such as `npm test`. If the run succeeds but the check fails, the worker is resumed with the output for up to `verifyRounds` rounds. A `profile` picks a preset model and reasoning level, and an explicit model or effort wins over it. By default the result is a short report and the full report is written to a file, readable inline with `report: full`. With `autoMerge`, tasks in worktrees whose verify passed (or that had no verify) are merged into `oc/<batch>-merged` without touching the user's checkout; conflicting tasks are reported and left unmerged.

## The OpenCode panel

The panel opens when a session starts and with `/opencode`. It has these sections:

- **THIS CHAT**: switches between Claude and OpenCode for chat mode.
- **WORKER**: the picked model, its maker, and its price or free status, plus recent rate limits, hangs and failures when the model is shaky or bad.
- **SPENT**: this chat's spend and run count, and the all-time total.
- **REASONING**: the `low`, `medium`, `high`, `xhigh` and `max` levels.
- **PRESETS**: the cheap, reliable and strong presets, and plan when the Z.AI Coding Plan is connected, with a note for the matching one.
- **LOCAL**: Kev and Laya, with status (off, starting, ready or error), call count, last latency, and Start or Stop.
- **AGENTS**: a card for each running delegate job and running batch task, numbered in order. The header reads `<n> : <MODEL> : <REASONING>` in the model maker's colour. The stage line shows the stage (working, starting, retrying, verifying or reviewing), the step count, the try number above 1, and for batch tasks the batch title, task id and verify result. ACTIVITY shows the latest action. Each card has Cancel.
- **PLAN**: the latest batches and their tasks, showing status, model, steps, attempts, verify result, merge state and branch. Tasks offer Diff, Merge, Discard and Resume where they apply. A diff opens in a preview.
- **HISTORY**: recent finished batches with status, task count, cost and age, plus spend by model.
- **FREE**, **PAID** and **Z.AI PLAN**: model lists grouped by maker. Z.AI PLAN appears when the Coding Plan is connected and shows its model calls in the last 5 hours. Free models show whether they are Go or Zen; paid models show input/output price per Mtok. Each model name has a dot in its maker's colour, and health dots mark good, shaky and bad models. A search field filters by model or maker, and Refresh models reloads the lists.

On mobile the panel is compact: it shows the worker, reasoning and presets, recent models, and an All models toggle instead of the full lists.

## Commands

| Command | What it does |
| --- | --- |
| `/opencode` | Opens the panel. |
| `/opencode model <name>` | Picks the worker model by id or name; several matches are listed. |
| `/opencode effort <level>` | Sets reasoning to `low`, `medium`, `high`, `xhigh` or `max`. |
| `/opencode chat on\|off` | Sends this chat's turns through OpenCode Go, or back to Claude. |
| `/opencode preset [name]` | Applies a preset (`cheap`, `reliable`, `strong`, `plan`) or lists them. |
| `/opencode models [free\|paid\|zai]` | Lists models with free status or price. |
| `/opencode local [start\|stop\|setup] [kev\|laya]` | Shows, starts or stops the local decision models, or prints the command that installs them. |
| `/opencode status` | Shows the worker, chat mode, running jobs and spend. |
| `/opencode selftest` | Checks the CLI, git, hang detection, rate-limit detection, notifications, the report folder, which model sources opencode lists, and Kev and Laya. |
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
| `orchestrate` | Adds a short system prompt section telling Claude to hand routine work to OpenCode workers. | `true` |
| `fallbackModel` | Model a run switches to after the picked one keeps failing (429s, hangs). Empty: no fallback. | `opencode-go/deepseek-v4.1-flash` |
| `autoRetries` | How many times a failed or hung opencode run is resumed before giving up (and trying the fallback model). | `3` |
| `stallMinutes` | A run that prints nothing for this long is killed and resumed. | `10` |
| `reviewModel` | Model that reviews batch tasks when `review` is on. | `opencode/deepseek-v4.1-flash-free` |
| `dailyBudget` | No new paid runs start once today's OpenCode spend reaches this. 0: no limit. | `0` |
| `zaiQuota` | Z.AI Coding Plan model calls per 5 hours after which no new plan runs start. 0: no limit. | `0` |
| `localModelsDir` | Folder holding `kev/` (with its `.venv`) and `laya-env/`. Empty: `~/local-models`. | empty |
| `kevModel` | Checkpoint Kev serves. `jaredpalmer/kev-4b` is more accurate: give it a GPU with about 16 GB, or split it with `kevGpuGb`. | `jaredpalmer/kev-0.8b` |
| `kevGpuGb` | Above 0, Kev's first layers fill this many GiB of the GPU and the rest run from system RAM (through `scripts/kev_split.py` and Hugging Face accelerate). This lets a model larger than the card run, more slowly. 0: Kev runs whole on one device. | `0` |
| `localDevice` | `auto`, `cuda` or `cpu`, for Kev. | `auto` |
| `layaDevice` | `auto`, `cuda` or `cpu`, for Laya. CPU leaves the GPU to Kev; on an 8 GB card the two don't fit together. | `cpu` |

Change these with `/plugin configure opencode-go@opencode-go-mod` in a terminal session, or in the plugin settings in the desktop app.

## Troubleshooting

- **429 or 'Endpoint is unavailable'**: the endpoint is busy or rate-limited. Runs resume on their own; paid Go models may need Global regions enabled in the OpenCode workspace.
- **A run prints nothing for `stallMinutes`**: it is killed and resumed.
- **`/opencode selftest`**: checks the CLI, git, hang and rate-limit detection, notifications, the report folder, the model sources, and Kev and Laya.
- **A finished batch task marked 'no changes ⚠'**: it edited nothing in its worktree.
- **`opencode` missing or not signed in**: it must be on PATH and signed in with `opencode auth login`.
- **No Z.AI PLAN section**: run `opencode auth login`, pick Z.AI Coding Plan, then Refresh models.
- **Kev or Laya 'is not installed'**: run `/opencode local setup` and the command it prints.

## Model health

Each finished attempt is counted against its model as `ok`, `failed`, `rate-limited` or `hung`. Cancelled runs are ignored. A run whose verify still fails after its fix-up rounds counts as `failed`, since the model did not produce working code. The rating is the bad share: `failed` plus `rateLimited` plus `hung`, over all runs.

- **good**: under 20% bad.
- **shaky**: 20% up to (not including) 50% bad.
- **bad**: 50% or more bad.

A record whose last run is more than 6 hours old is treated leniently: under 50% bad is **good**, and 50% or more is **shaky**, never **bad**.

Ratings show as the panel's health dots in the free and paid model lists, as `Unreliable right now` in the delegate tool description, and the `ladder` profile skips shaky and bad free models.

## Developing

`scripts/check.sh` runs everything a release must pass: `claude plugin validate .`, `claude plugin test .`, the scripts' Python tests, and `scripts/typecheck.sh`. GitHub Actions runs all but the type-check on every push and pull request (the engine types it needs exist only where Claude Code has run). AGENTS.md describes the layout and the rules the validator enforces.
