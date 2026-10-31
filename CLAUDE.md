# Installation routing for Claude and Codex agents

**Two variants; install the one intended for the user's destination application.**

- **Claude Code destination:** repository **root** (`.claude-plugin/`, `hooks/`); see [docs/INSTALLATION.md](docs/INSTALLATION.md). Verify with `/opencode selftest`.
- **Codex desktop or CLI destination:** separate **`codex-companion/`** package; see [docs/INSTALLATION.md](docs/INSTALLATION.md) and [Codex README](codex-companion/README.md) on branch `codex/agent-subscription-bridge`, under draft [PR #5](https://github.com/abharrison1995-droid/opencode-go-mod/pull/5). Actions run [#41198897383](https://github.com/abharrison1995-droid/opencode-go-mod/actions/runs/41198897383) passed on revision `277ff3a`; Codex Desktop discovery remains unverified. The Codex profiles are missing, OpenCode lacks its usage command on this machine, and Antigravity returned no structured quota values.

**Do not choose based on the installer agent's identity.** If Claude is asked to install into Codex, pick Codex; if Codex is asked to install into Claude, pick Claude. If target is unspecified, ask. Never treat the root Claude plugin as a Codex plugin or promise unverified live provider authentication. See [the integration audit](docs/INTEGRATION-AUDIT.md) for test results, provider-by-provider live status and remaining owner setup.
