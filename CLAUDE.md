# Installation routing for Claude and Codex agents

**Two variants; install the one intended for the user's destination application.**

- **Claude Code destination:** repository **root** (`.claude-plugin/`, `hooks/`); see [docs/INSTALLATION.md](docs/INSTALLATION.md). Verify with `/opencode selftest`.
- **Codex desktop or CLI destination:** separate **`codex-companion/`** package; see [docs/INSTALLATION.md](docs/INSTALLATION.md) and [Codex README](codex-companion/README.md) on branch `feat/codex-desktop-companion` (draft PR #3, not yet on main).

**Do not choose based on the installer agent's identity.** If Claude is asked to install into Codex, pick Codex; if Codex is asked to install into Claude, pick Claude. If target is unspecified, ask. Never treat the root Claude plugin as a Codex plugin or promise unvalidated Codex features.
