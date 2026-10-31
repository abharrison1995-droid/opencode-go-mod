# Cross-host implementation status

This file records the current implementation and remaining verification for draft [PR #5](https://github.com/abharrison1995-droid/opencode-go-mod/pull/5). It is not a roadmap of unimplemented code.

- **Host packages:** Claude Code remains at the repository root. The Codex companion uses its own plugin manifest, MCP server, skill and loopback dashboard. Host selection follows the destination application.
- **Shared engine:** canonical provider-usage and Codex profile/JSONL helpers live in `bridge-core/`. The Codex package has generated local copies; CI checks identity and checks the committed bundle against a fresh build.
- **Delegation:** OpenCode, Codex Pro profiles, Claude Code and Antigravity are selectable workers. Jobs are cancellable and bounded. Fallback is explicit and limited to classified missing-CLI, authentication and rate-limit failures; Codex profiles never rotate automatically.
- **Editing workflow:** planner → implementer → independent reviewer → allow-listed verifier runs in a new worktree from committed `HEAD`. All reachable implementer and reviewer routes must be independent. One verification retry is allowed (two verification runs maximum). The pipeline preserves the worktree and never merges or pushes. Editing requires per-task opt-in and `BRIDGE_ENABLE_WRITES=1`.
- **Usage:** read-only telemetry covers OpenCode Go, both Codex profiles and Antigravity. Missing structured values remain unavailable/details. Z.AI model selection remains through OpenCode, but it has no dedicated server-reported quota adapter. Local task counts are never presented as remaining server quota.
- **Verification:** GitHub Actions run [#41198897383](https://github.com/abharrison1995-droid/opencode-go-mod/actions/runs/41198897383) passed Claude validation/tests, Python tests, host routing and Codex checks. Local Codex validation passes 32 tests. The MCP bundle starts in an isolated directory.
- **Still open:** Codex Desktop marketplace discovery, authenticated Codex Pro reads, OpenCode usage with a CLI exposing the documented API, and structured Antigravity quota data need owner-machine verification. The separate Claude host type-check needs engine declarations.

The verifier process receives an environment allowlist, but test code is not OS-sandboxed and retains the current user's filesystem permissions. Use trusted repositories only. Never access, copy, log or commit provider credentials. See [`../../docs/INTEGRATION-AUDIT.md`](../../docs/INTEGRATION-AUDIT.md) for detailed findings and live results.

PRs #1–#4 remain unmerged. PR #1–#3 histories are preserved in this branch; PR #4 duplicates installation documentation already present in PR #3. PR #5 is also a draft and awaits external audit/owner acceptance.
