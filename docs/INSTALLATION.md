# Installation and agent routing: Claude Code vs Codex

**This repository has TWO separate variants. Select by the application that will run the plugin, not by which AI agent is doing the installation.**

| User's target application | Package to install | Current source |
| --- | --- | --- |
| **Claude Code (CLI or Claude plugin UI)** | **Repository root**: `.claude-plugin/` plus `hooks/` and `types/` | Available on `main` |
| **Codex desktop / Codex CLI** | **`codex-companion/`** (portable `plugin.json`, `mcp.json`, `skills/`, `server/`) | Draft [PR #3](https://github.com/abharrison1995-droid/opencode-go-mod/pull/3), branch `feat/codex-desktop-companion` — NOT yet on `main` |

**Never install the Claude root plugin as the Codex variant, or the Codex companion as the Claude variant.** A Claude agent can install the Codex version if the user asks for Codex; a Codex agent can install the Claude version if the user asks for Claude. If the destination truly is unknown, ask before changing the environment.

## For a fresh Claude Code environment

1. Choose the **Claude Code variant in the repo root**. The manifest is `.claude-plugin/plugin.json`, and the marketplace metadata is `.claude-plugin/marketplace.json`.
2. Install the OpenCode CLI if needed; authenticate through the normal `opencode auth login` flow. Additional providers must be authorized by the owner.
3. In Claude Code, add the repository marketplace, then install its actual plugin identifier. Start with:

```text
/plugin marketplace add abharrison1995-droid/opencode-go-mod
```

The repository's `.claude-plugin/marketplace.json` identifies plugin **`opencode-go`** in marketplace **`opencode-go-mod`**. Install it with:

```text
/plugin install opencode-go@opencode-go-mod
```

If the installed marketplace metadata ever changes, verify those names instead of guessing. The root README also documents the existing installation command and UI method.
4. Restart the Claude session; run `/opencode selftest`. Confirm the Claude side panel and delegation tools actually load. In a developer clone run `scripts/check.sh` as applicable.
5. Do NOT install `codex-companion/` into Claude as a substitute.

## For a fresh Codex desktop / CLI environment

1. Choose the **Codex companion package in `codex-companion/`**. While PR #3 remains unmerged, explicitly clone its draft branch:

```bash
git clone --branch feat/codex-desktop-companion --single-branch https://github.com/abharrison1995-droid/opencode-go-mod.git
cd opencode-go-mod/codex-companion
npm install
npm run check
```

2. Read [Codex companion README](../codex-companion/README.md) and inspect `codex-companion/plugin.json`. The repo-scoped Codex marketplace is `.agents/plugins/marketplace.json`, pointing to `./codex-companion`; register that local marketplace with `codex plugin marketplace add <absolute-path-to-opencode-go-mod>`, inspect it with `codex plugin marketplace list`, and open the clone in a supported, trusted Codex client to verify the marketplace/plugin is discovered. Alternatively, Codex supports `codex plugin marketplace add abharrison1995-droid/opencode-go-mod --ref feat/codex-desktop-companion` on a compatible CLI; this does not replace the Node dependency install or local smoke tests. Alternatively, configure the companion's local stdio MCP server according to the installed Codex client's documented MCP setup.
3. Install/authenticate any delegated CLIs separately (OpenCode Go, Claude Code, Antigravity). Never copy authentication tokens into prompts, GitHub or plugin source.
4. Verify MCP handshake, `bridge_status` and a **read-only** `delegate_agent` on a disposable project. Report actual errors. Do NOT claim a native Codex side panel, real quota telemetry, or dual Codex profile dispatch: these are not implemented in the current companion draft.
5. Do NOT use Claude's root marketplace installation command for this package.

## Fresh-install agent contract

- Identify and state the **target host and chosen variant** in the completion report.
- Verify that the package directory exists at the **checked-out branch/ref**. If `codex-companion/` is absent on `main`, fetch PR #3's branch intentionally; do not silently substitute the Claude package.
- Use the target host's own plugin / MCP install workflow, not the other host's installer.
- Run a meaningful host-specific smoke test. Never report success merely because a clone or install command exited zero.
- No unauthorized changes to authentication, enabled permissions, source branches or remote repository. No automatic account-switching to bypass quotas.

## Suggested prompts for a new coding agent

**For Claude Code:**

> Install the Claude Code variant of https://github.com/abharrison1995-droid/opencode-go-mod from the repository ROOT (not codex-companion). Read docs/INSTALLATION.md and .claude-plugin/marketplace.json first; use the Claude plugin marketplace and run /opencode selftest. Report exact verification results.

**For Codex desktop:**

> Install the Codex companion variant of https://github.com/abharrison1995-droid/opencode-go-mod from codex-companion/ (not .claude-plugin). The Codex version currently lives on draft PR #3, branch feat/codex-desktop-companion. Read docs/INSTALLATION.md and codex-companion/README.md, follow the current Codex plugin or local MCP instructions, then confirm bridge_status and a read-only delegation. Do not claim unimplemented features.
