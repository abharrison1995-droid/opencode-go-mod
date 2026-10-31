# Cross-host engineering plan

C0: portable Codex plugin, self-contained bundled MCP server, skill, CLI discovery, read-only OpenCode / Claude Code / Antigravity delegation, explicit editing gate and parser tests. Source is present; Codex desktop discovery remains to verify on the owner's installation.

C1: share provider-neutral usage normalization, cache/backoff, Codex profile path and Codex JSONL parsing across both host packages. The Codex plugin receives generated copies of canonical shared modules so its installed package remains self-contained; CI checks byte identity. Do not duplicate OAuth or private credentials.

C2: the two independently authenticated Codex Pro accounts now have explicit delegation and read-only usage reads. The Codex desktop's native agent is primary. Account selection is explicit and never used for automatic quota-circumvention.

C3: server-reported usage adapters for Go, Codex Pro 1/2 and Google AI Pro, normalized windows, caching/backoff and unavailable/stale states are implemented. Confirm the current Antigravity structured schema and real account reads on the owner's authenticated machine. Never treat local task counters as actual remaining quota.

C4: asynchronous cancellable delegation and metadata-only history; planner/implementer/independent-reviewer workflow in isolated worktrees; up to two verification rounds; explicit single cross-provider fallbacks for classified missing-CLI, unauthenticated and rate-limited failures. Multiple pipeline jobs can run concurrently with a hard cap. Verification commands are allow-listed. No implicit pushes or merges.

C5: the Claude panel renders subscription readings; Codex uses its native MCP/skill integration plus a loopback-only local dashboard. Provider parser and MCP bundle checks pass locally. Live desktop discovery, authenticated account reads and the Claude-specific checks still need the owner-installed host runtimes. No injection into Codex internals.

Freebuff remains excluded. Neither existing draft PR is merged.
