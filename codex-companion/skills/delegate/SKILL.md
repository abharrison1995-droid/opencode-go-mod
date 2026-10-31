---
name: delegate
description: Delegate a bounded coding or review task from Codex to locally authenticated OpenCode Go, Claude Code, or Gemini agents.
---

Use bridge_status first to check configured binaries. The MCP tool delegate_agent takes a provider, absolute directory and self-contained prompt including file locations, constraints, and verification instructions. Default to read-only; the worker has no prior Codex chat context.

Do not set allowWrites true without explicit user authorization and an isolated Git worktree. Owner must enable BRIDGE_ENABLE_WRITES=1 independently. Inspect diffs and run tests before reporting success. Do not access subscription credentials, invent quotas, or switch accounts to evade provider limits. This first draft does not support automatic routing, remaining usage values, or native Codex-internal sidebars.
