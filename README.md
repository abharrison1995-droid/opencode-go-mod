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

## Configuration

| Option | What it does | Default |
| --- | --- | --- |
| `defaultModel` | Worker used until one is picked in the OpenCode panel (provider/model, or a bare id under `opencode-go/`). | `opencode-go/kimi-k3` |
| `orchestrate` | Adds a short system prompt section telling Claude to hand routine work to OpenCode Go models. | `true` |
| `fallbackModel` | Model a run switches to after the picked one keeps failing (429s, hangs). Empty: no fallback. | `opencode-go/deepseek-v4.1-flash` |
| `autoRetries` | How many times a failed or hung opencode run is resumed before giving up (and trying the fallback model). | `3` |
| `stallMinutes` | A run that prints nothing for this long is killed and resumed. | `10` |
| `dailyBudget` | No new paid runs start once today's OpenCode spend reaches this. 0: no limit. | `0` |

Change these with `/plugin configure opencode-go@opencode-go-mod` in a terminal session, or in the plugin settings in the desktop app.
