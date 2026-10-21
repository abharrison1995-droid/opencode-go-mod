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
