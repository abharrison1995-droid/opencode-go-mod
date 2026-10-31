# Codex desktop companion — draft

This is a separate Codex-native plugin package in the same repository as the Claude mod. It uses a local MCP server and a Codex skill, not the Claude-only UI hooks.

Supported first-pass tools: bridge_status, delegate_agent. Delegate to existing OpenCode Go, Claude Code and Gemini Antigravity CLI logins. Read-only by default. Model is optional. Editing requires both allowWrites=true and the owner-set BRIDGE_ENABLE_WRITES=1 environment variable. Gemini edits remain disabled.

**Not yet implemented:** quota readings, identical side panel UI, live per-provider discovery, automatic fallback, worktree scheduling, separate Codex Pro account delegation, and shared history. Do not present any of those as available.

## Windows 11 installation

1. Install Node.js 20+ and run npm install inside this codex-companion directory.
2. Run npm run check.
3. Use official OpenCode, Claude Code and Antigravity CLI sign-ins on the same machine.
4. Configure BRIDGE_OPENCODE_BIN, BRIDGE_CLAUDE_BIN or BRIDGE_AGY_BIN when Windows PATH provides only a .cmd shim; a native executable is required.
5. Register this package in a local Codex plugin marketplace, or configure the included stdio MCP server directly in Codex.
6. Restart Codex desktop and test bridge_status, then a read-only call against a disposable Git repository.

The repository includes a marketplace example under .agents/plugins/marketplace.json. Actual package installation and compatibility must be tested locally.

The separate local MCP server can later be extracted into a shared transport-neutral backend used by both this Codex plugin and the Claude sidebar. Codex native embedded custom side-panel support is not established: a separate localhost dashboard is the supported fallback concept, pending testing.
