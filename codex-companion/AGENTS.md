# Codex companion agent routing

This directory is the **Codex desktop / CLI variant** of the OpenCode Go Mod project. Its package is `codex-companion/plugin.json` plus `mcp.json`, `skills/` and `server/`. The **Claude Code variant is at the repository root** (`.claude-plugin/`, `hooks/`); it is **not** installed here.

When a user asks you to install this mod for Codex, install THIS package; when a user asks for Claude Code, go back to the repository root and follow the Claude installer, even if you are a Codex agent. Read `../docs/INSTALLATION.md` before installation. Do not promise a working Codex sidebar or quota dashboard in this draft. Verify plugin discovery and a read-only MCP call before declaring success.
