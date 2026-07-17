# PROGRESS.md

## Current Verified State

- **Repo root:** `occupancy-engine-ts/`
- **Standard startup:** `./init.sh`
- **Standard verification:** `bun run verify`
- **Highest-priority unfinished feature:** `batch-cli` (see `feature_list.json`).
- **Current blocker:** none.

Baseline facts: the agent pipeline is a faithful port of `occupancy-engine`,
deterministic-parity-verified vs Python on "1104 SPRING RUN RD"; de-Python cleanup
done; planner-off default mirrored. Pending features (not built): batch CLI, judge
package, observability/summaries.

## Session Record

<!-- newest first; one entry per working session -->

### 2026-07-17 — External evidence wiring
- **Goal:** Feed STR scan results + property facts to the packets that can reason with them, without disturbing the blind (benchmarking) configuration.
- **Completed:** `ExternalEvidenceSchema` contract + `--evidence-file` (exit 2 on any failure); payload folded into the resolved context (`rental_market_summary` gated, external refs first, `property_types` context-only); scope gating closed in BOTH prompt profiles; `render_context_sections` renders the gated channel (it never read the slot before — the last mile was missing); exposure map on 4 of 7 packets; `EXTERNAL_EVIDENCE_SOURCES` + note in `policy.ts`, stale `WITHHELD_EXTERNAL_EVIDENCE_NOTE` deleted; external evidence vocabulary excluded from the prose scrubber.
- **Verification run:** `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify`; `bun run e2e`; `env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY bun test test/e2e` (also with `.env` moved aside, then restored); `OE_PROSE_REDACT=1 OE_PROSE_REGISTER=off bun test`.
- **Evidence:** `verify` green — typecheck clean, lint clean (3 pre-existing warnings, 0 errors), **132 pass / 0 fail / 544 expect() across 23 files** (pre-change baseline: 56 pass / 0 fail). `bun run e2e`: **4 pass / 0 fail**. E2E with no key and no `.env`: **4 pass / 0 fail**. `OE_PROSE_REDACT=1`: **131 pass / 1 fail**, the 1 being `proseRedactEnabled > is off by default`, which fails by construction when the flag is on. The critical negative test (owner_identity_and_mailing never sees str_scan — solo, grouped, both profiles) and the E2E parity guard (no payload => blind unchanged) both green; **both verified to FAIL when deliberately broken**, then reverted.
- **Commits:** branch `feat/external-evidence` (base `main`), 15 commits, Tasks 1-15.
- **Known consequences (decisions of record, not bugs):** (1) `input_sources` is static, so exposed packets' prompts name `str_scan` in "Context scope"/"Expected sources" even blind — no evidence content leaks (E2E-3 asserts it). (2) The BUCKET is the unit of exposure: `_union_source_scope` means `owner_identity_and_mailing` sees `property_facts` and `legal_address_presence` sees `str_scan` via their bucket-mates; the collapse-critical exclusions (owner_identity <- str_scan, portfolio <- both) survive and are asserted. (3) `evidence_map.property_types` is deliberately empty — filling it would flip `_has_portfolio_hint` and move the score through a gate rather than through reasoning.
- **Risks / OPEN ISSUE:** `OE_PROSE_REGISTER=on` **conflicts with the critical negative test**. Task 8 adds `str_scan`/`property_facts` to `SOURCE_HUMAN_PHRASES`, and `buildProseRegisterLines` renders that glossary — unscoped — into *every* prompt, so the bare tokens reach `owner_identity_and_mailing`. Verified that **only the tokens leak, never evidence content** (`vrbo`, `Short-term rental listing`, `1234567`, `source_provider=realtor` all absent), which is the same class as consequence (1) above, but broadcast to unexposed packets rather than just exposed ones. Under the flag: `OE_PROSE_REDACT=on OE_PROSE_REGISTER=on bun test` → 125 pass / 7 fail (5 exposure-marker failures + the 2 flag-is-off-by-default tests). The plan pins neither the glossary's scope-awareness nor an `OE_PROSE_REGISTER=1` gate, so this was **left unresolved rather than improvised**: fixing it means either scoping the glossary per packet or narrowing the guard's markers — an exposure-map/register decision that belongs upstream in the umbrella.
- **Next best action:** resolve the `OE_PROSE_REGISTER` glossary-scope question upstream; then merge to `main`, bump the backend's engine submodule pointer and land backend B2-B4.

### 2026-07-06 — E2E harness complete
- **Goal:** Close the feedback loop with a deterministic E2E suite.
- **Completed:** captured real preflight fixture; scripted LLM + fixture GraphQL server; E2E-1 (assembly) + E2E-2 (real subagent).
- **Verification run:** `bun run verify` and `env -u ANTHROPIC_API_KEY bun test test/e2e`.
- **Evidence:** 19 pass, 0 fail; E2E runs with no API key / no live server.
- **Commits:** branch `feat/agent-harness`.
- **Known risks:** E2E-2 asserts one packet path; broaden coverage later if needed.
- **Next best action:** merge `feat/agent-harness`; then start `batch-cli`.

### 2026-07-06 — Harness bootstrap
- **Goal:** Build the dev/control harness (five subsystems).
- **Completed:** version pin + init.sh + scripts; Biome; AGENTS.md/CLAUDE.md; this file.
- **Verification run:** `bun run verify`
- **Evidence:** typecheck clean, lint clean, unit tests pass (E2E added in later tasks).
- **Commits:** see branch `feat/agent-harness`.
- **Known risks:** E2E-2 (real subagent + scripted LLM) scripting fidelity.
- **Next best action:** capture the preflight fixture (Task 6), then build the E2E harness.
