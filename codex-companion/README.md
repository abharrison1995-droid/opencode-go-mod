# Codex variant of OpenCode Go Mod — draft Codex Desktop Companion

> **FOR CODEX HOSTS ONLY.** This is the **Codex** variant of the same two-host project. The separate **Claude Code** variant lives at the repository root (`.claude-plugin/`, `hooks/`). If asked to install this mod into **Codex desktop or Codex CLI**, use **this `codex-companion/` package**, never the root Claude plugin. If asked to install into **Claude Code**, follow the root README instead—even if the installing agent is Codex. Start with [the host-selection installation guide](../docs/INSTALLATION.md).

**Development status:** this Codex companion exists on draft PR #3 / branch `feat/codex-desktop-companion`, not yet on `main`. Read-only MCP delegation is implemented in source but requires installation and authenticated Windows smoke tests. The Claude-style side panel and actual quota dashboard are not yet implemented.

This is a separate Codex-native plugin package in the same repository as the Claude mod. It uses a local MCP server and a Codex skill, not the Claude-only UI hooks.

Supported first-pass tools: bridge_status, delegate_agent. Delegate to existing OpenCode Go, Claude Code and Gemini Antigravity CLI logins. Read-only by default. Model is optional. Editing requires both allowWrites=true and the owner-set BRIDGE_ENABLE_WRITES=1 environment variable. Gemini edits remain disabled.

**Not yet implemented:** quota readings, identical side panel UI, live per-provider discovery, automatic fallback, worktree scheduling, separate Codex Pro account delegation, and shared history. Do not present any of those as available.

## Windows 11 installation

1. Install Node.js 20+ and run npm install inside this codex-companion directory.
2. Run npm run check.
3. Use official OpenCode, Claude Code and Antigravity CLI sign-ins on the same machine.
4. Configure BRIDGE_OPENCODE_BIN, BRIDGE_CLAUDE_BIN or BRIDGE_AGY_BIN when Windows PATH provides only a .cmd shim; a native executable is required.
5. From the cloned repository root, run `codex plugin marketplace add <absolute-path-to-opencode-go-mod>` and confirm it with `codex plugin marketplace list`, then install the `agent-subscription-bridge` entry in your Codex plugin browser. Alternatively configure the included stdio MCP server directly according to your Codex client's documentation. Neither route has yet been validated on the target Windows desktop build.
6. Restart Codex desktop and test bridge_status, then a read-only call against a disposable Git repository.

The repository includes a marketplace example under .agents/plugins/marketplace.json. Actual package installation and compatibility must be tested locally.

The separate local MCP server can later be extracted into a shared transport-neutral backend used by both this Codex plugin and the Claude sidebar. Codex native embedded custom side-panel support is not established: a separate localhost dashboard is the supported fallback concept, pending testing.
