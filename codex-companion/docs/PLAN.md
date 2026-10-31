# Cross-host engineering plan

C0 (this draft): portable Codex plugin, MCP server, skill, CLI discovery, read-only OpenCode / Claude Code / Antigravity delegation, explicit editing gate and parser tests. Validate on Windows.

C1: share provider adapters, model catalog, job status, history, cancellation, verification and security policy with Claude's existing mod. Do not duplicate OAuth or private credentials.

C2: integrate the two independently authenticated Codex Pro accounts from the separate dual-account PR. The Codex desktop's native agent is primary. Second-account execution is explicit and never used for automatic quota-circumvention.

C3: implement authenticated, read-only, server-reported usage adapters for Go, Codex Pro 1/2 and Gemini AI Pro. Show accuracy, window, reset timestamp, last refresh and unavailable/stale states. Never treat local task counters as actual remaining quota.

C4: parallel isolated worktree scheduling, planner/implementer/reviewer delegation, bounded retries and explicit fallbacks, deterministic verification. No implicit pushes, merges or worktree edits.

C5: UI parity. Keep Claude panel; use Codex MCP and skills as baseline. Validate Codex panel support and otherwise use a secure local browser dashboard. No injection into Codex internals.

Freebuff remains excluded. Neither existing draft PR is merged.
