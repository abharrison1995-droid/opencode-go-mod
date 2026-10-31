# Agent Subscription Bridge integration audit

## Scope and current state

- Base: `main` at `1c5558dda71acea2ce70b684d8e99b4d852e7afa`.
- Integration branch: `codex/agent-subscription-bridge`.
- The branch preserves the existing PR histories by incorporating PR #1, then #2, then #3. PR #4's installation guidance was checked against PR #3 and adds no distinct file changes. No remote PR was merged, no `main` push was made, and no release was published.
- Freebuff remains excluded from the final PR #1 diff against `main`.

## Existing pull request audit

| PR | Scope and relationship | Recorded check result |
| --- | --- | --- |
| [#1 Gemini reliability](https://github.com/abharrison1995-droid/opencode-go-mod/pull/1) | The historical structured JSON fixture regression is already fixed at `9f99a9bbb925c9c7cb4245feb7ef0679ec656174`. The final PR diff contains the Gemini reliability work; it does not reintroduce Freebuff. | Green Actions run `41196005301`; 199 plugin tests and Python script tests passed. |
| [#2 Dual Codex Subscription Bridge](https://github.com/abharrison1995-droid/opencode-go-mod/pull/2) | Adds explicit `pro-1` / `pro-2` Codex profiles and a Claude `delegate_codex` tool. It needs host-specific Windows and authentication checks; no shared quota telemetry was present. | Green Actions run `41160287879`; the workflow did not exercise native Codex. |
| [#3 Codex Desktop Companion](https://github.com/abharrison1995-droid/opencode-go-mod/pull/3) | Adds the portable Codex package, MCP/skill surfaces and basic CLI delegation. It was a separate runner and had no Claude-style sidebar. It depended conceptually on explicit Codex profile support from #2. | Green Actions run `41195569296`; CI did not exercise the installed Codex package. |
| [#4 Dual-host installation docs](https://github.com/abharrison1995-droid/opencode-go-mod/pull/4) | Documents host selection. Its docs were byte-identical to those already present in PR #3, so no additional integration commit was needed for that PR. | Green Actions run `41195599614`; docs-only validation does not establish host runtime support. |

The old pull requests were all open during the audit; #1–#3 were drafts, and #4 was not. Their green checks were not treated as acceptance of the untested host runtimes.

## Integration branch validation

- Latest commit: `c8c738a7dc59ceb7a70cae8733f5f8e35d464019` on `codex/agent-subscription-bridge`.
- GitHub Actions run [#41198725480](https://github.com/abharrison1995-droid/opencode-go-mod/actions/runs/41198725480) completed successfully: Claude plugin validation, 205 Claude tests, Python script tests, host package validation, and the Codex MCP/usage checks all passed.
- Local `npm run check --prefix codex-companion` passes all 32 tests and confirms the committed bundle matches a clean build. `node scripts/validate-host-packages.mjs` and `git diff --check` also pass.
- Claude's validator reports a non-fatal warning that root `CLAUDE.md` is not loaded as plugin context. The working instructions also ship in skills; the warning does not affect this successful validation.

## Integration choices

1. Keep the Claude plugin at the repository root and the Codex plugin in `codex-companion/`. Installation routing states that the destination application selects the package.
2. Put shared provider usage normalization, cache/backoff, Codex profile paths and Codex JSONL parsing in canonical `bridge-core/` modules. Generate package-local copies into `codex-companion/shared/`; CI verifies they match so the installed Codex plugin does not import files outside its package.
3. Bundle the Codex MCP entry point and runtime dependencies to `codex-companion/server/dist/index.mjs`. The MCP startup test copies only that bundle to a temporary directory without `node_modules` and performs a real stdio MCP handshake.
4. Keep the Codex native surface in MCP tools and a skill. Use a loopback-only dashboard for visual usage details rather than claiming a Claude sidebar exists in Codex.
5. Keep the existing Claude batch scheduler host-specific. The Codex companion provides cancellable jobs and a worktree-based planner/implementer/reviewer flow; a future extraction could unify more of the orchestration implementation.
6. Make fallback explicit and limited to one different provider for classified missing-CLI, unauthenticated or rate-limited failures. Codex-to-Codex switching is rejected. Editing requires both per-task opt-in and `BRIDGE_ENABLE_WRITES=1`.

## Usage sources and limits

- **OpenCode Go:** the official v2 docs list `GET /api/experimental/usage/limits`, including Go `rolling`, `weekly`, and `monthly` meters. The adapter uses the CLI's documented `api GET` surface and verifies that the installed CLI exposes that command before calling it. The local OpenCode CLI is `1.19.4` and does not expose `api`, so its live reading is `Unavailable`; no quota percentage was inferred. Source: [OpenCode API docs](https://dev.opencode.ai/v2/docs/api), [CLI API command docs](https://dev.opencode.ai/v2/docs/cli/commands/), [server docs](https://dev.opencode.ai/docs/server/).
- **Codex Pro 1 and 2:** the adapter uses separate `CODEX_HOME` roots and read-only `account/read` plus `account/rateLimits/read` app-server JSON-RPC. The installed CLI is `codex-cli 0.164.0-alpha.11.1`, but neither dedicated profile directory exists, so both live readings are `Unauthenticated`. No authentication files were read. Source: [Codex app-server account protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs).
- **Google AI Pro:** Antigravity CLI `1.4.12` accepted the read-only `/usage` command and returned `SUCCESS`, but no machine-readable quota percentage/reset fields were present. The live reading is `Connected · no structured quota`; no percentage was invented. Source: [Antigravity usage command](https://antigravity.google/docs/cli/commands/usage), [headless JSON output](https://antigravity.google/docs/cli/headless/).
- **Z.AI Coding Plan:** existing OpenCode model IDs remain selectable through OpenCode delegation. There is no dedicated Z.AI server-reported quota adapter in this branch, so local task counts are not presented as remaining allowance.
- Every displayed reading retains its source and timestamp, differentiates stale/unavailable/unauthenticated states, and carries the caveat that reported remaining usage does not guarantee the next request.

## Independent review

A separate read-only reviewer inspected the first integration implementation and identified six findings. All six were corrected before this audit:

1. The installed Codex package could not import sibling `bridge-core` files. Fixed through generated package-local shared modules plus a self-contained MCP bundle.
2. Gemini delegation/status searched for `gemini` instead of Antigravity `agy`. Fixed by routing the host alias through the shared CLI locator and `BRIDGE_AGY_BIN`.
3. A forced refresh could label a fresh cached reading stale. Cached successful data remains available while its refresh interval is in force; a real failed refresh still becomes stale.
4. The asynchronous job map could exceed its limit when all entries were active. New work is rejected at a hard eight-job cap; terminal jobs are evicted first.
5. OpenCode readings were cached across workspace directories. Cache keys now include a one-way hash of the resolved workspace path.
6. IPv6 loopback dashboard links lacked bracketed authority syntax. URLs now format `::1` as `[::1]` and have an IPv6 loopback test.

The reviewer verified the original Codex Node suite (16 tests) and inspected loopback dashboard authentication/CSP behavior. A final separate re-review found six follow-up issues; five implementation issues were corrected, and one remaining security boundary is documented below:

1. **Required install artifacts:** the lockfile and generated MCP bundle are required in a clean checkout. They are included, and CI now checks the committed bundle against a fresh build instead of overwriting it before the MCP test.
2. **Fallback reviewer independence:** the reviewer check now compares every reachable provider/account pair across both the implementer and reviewer routes, including fallbacks.
3. **OpenCode project directory:** `bridge_usage` now accepts an absolute workspace directory. Without one, OpenCode is explicitly unavailable instead of querying the MCP plugin directory. The optional dashboard takes `--directory` for the same reason.
4. **Windows ARM64 Codex:** the Claude host searches ARM64 and x64 vendor binaries in architecture-aware order; an ARM64 path test was added.
5. **Verifier process environment:** verification children now receive a small system-variable allowlist; provider/API credentials, database URLs, custom variables and user-profile paths are omitted. This is environment reduction, not an OS sandbox: repository test code still runs under the current user account and can access files allowed by that account.
6. **Planner output bound:** planner notes are capped at 6,000 characters before they enter implementation/review prompts and before they are returned in the report. A test supplies a 100,000-character plan and checks all delegated prompts remain within the worker limit.

The independent reviewer’s earlier suite count was 16 and it did not rerun the latest suite. The final local Codex check now passes 32 tests, including the new fallback, usage-directory and prompt-size cases. The host and live-provider checks remain subject to the limitations below.

## Remaining environment and acceptance blockers

- The Claude CLI is not installed, `.claude-plugin/types/tsconfig.json` is absent, and no Claude host type declarations are available. `claude plugin validate`, `claude plugin test` and the Claude-specific type-check therefore cannot run here.
- The `python`/`python3` commands resolve only to disabled Microsoft Store execution aliases; no Python runtime or `py` launcher is installed, so the Python script suite cannot run locally.
- Codex Desktop marketplace installation/discovery was not attempted because installing into the user's existing production client would change it. The isolated MCP bundle and tool schemas are tested, but live desktop discovery is unverified.
- Authenticated Codex profile reads require the owner to sign in separately to `.codex-profiles/pro-1` and `pro-2`. OpenCode Go telemetry requires a CLI exposing the documented API command or a supported authenticated API host.

## Safe review order

Review this integration PR as a single diff against `main`. Do not merge PRs #1–#4 first: PRs #1–#3 are preserved in the integration history and PR #4 duplicates docs in PR #3. If the owner elects to land the old work independently instead, use #1 → #2 → #3 → #4, with #4 only after its source documentation is settled. Keep all PRs unmerged until external audit accepts the code and the native-runtime blockers are reviewed.
