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
- **Post-build fix (b0e3ef8): the register glossary was broadcasting the new source tokens.**
  Task 8 added `str_scan`/`property_facts` to `SOURCE_HUMAN_PHRASES`, and `buildProseRegisterLines`
  rendered the whole glossary **unscoped** into every prompt — so with `OE_PROSE_REGISTER` on (which
  the gitignored `.env` sets, making it the default dev environment) the bare tokens reached
  `owner_identity_and_mailing` and the critical negative test failed on 5 markers. Same bug class as
  the full-profile hole this feature already fixed: a channel ignoring scope. Now gated by the
  packet's own scope, or the bucket's union where packets share a prompt. **Only the external
  sources are gated** — graph-source entries stay unconditional, so the in-flight register A/B's
  prompts are byte-identical to before. Only vocabulary ever leaked, never evidence content; the
  selective-exposure design held. Flags off: 132/0 unchanged. register on: 125/7 → 131/1. Both on:
  125/7 → 130/2, where the residual 1-2 are tautological (they assert the flags are off, so enabling
  one breaks them by construction) and predate this work.
- **LIVE FUNCTIONAL VERIFICATION (2026-07-17) — actually run, not projected.** Graph service on
  `:8000` over the prebuilt `graph.sqlite`; real Anthropic calls; address "1104 SPRING RUN RD".
  **Enriched** (`--evidence-file`): exit 0, 1m46s, 133 KB report, 48 LLM calls / 45 GraphQL —
  verdict `review`, raw 23, calibrated 18, archetype `ambiguous_nonowner_occupancy`.
  **Blind control** (no flag): exit 0, 1m40s — verdict `review`, raw 16, calibrated 14, archetype
  `owner_present_with_rental_indicators`.
  - **Zero exposure leaks** across all 6 packets that ran. `case_quality_and_synthesis` cited BOTH
    `str_scan` and `property_facts` — the packet argued hardest for, and the only one that used them.
  - **Correction 2 proven live:** context `property_types` = `['single_family']` while
    `evidence_map.property_types` = `[]`. The deterministic portfolio gate stayed blind; the
    enrichment moved the score through reasoning, not a gate flip.
  - **External refs led the list** (`str_scan`, `property_facts`, `tax`) — they survived `slice(0, 8)`.
  - **Blind was genuinely blind:** empty `property_types` / `rental_market_summary`, no external
    source in any `evidence_ref` or the `evidence_pack`.
  - **Blind vs enriched** (same code, same address, same model — the payload is the only variable):
    raw 16 → 23, calibrated 14 → 18, archetype `owner_present_with_rental_indicators` →
    `ambiguous_nonowner_occupancy`, band `review` both. Notable: **the blind run reached "rental
    indicators" from public records alone** — the original experiment's question, answered
    affirmatively at n=1.
  - **Known consequence confirmed:** the blind report carries the `str_scan`/`property_facts` tokens
    in exactly 11 places, ALL in `investigation_plan.expected_sources` / `known_data_gaps` — the
    fallback planner reading static `input_sources`, honestly recording "expected this source, got
    nothing". Vocabulary, never evidence; the blind `evidence_map` and `evidence_pack` are clean. It
    cannot reach the browser: X-011's `InvestigationReportDTO` drops `investigation_plan`.
  - **Worth watching (n=1):** enrichment *raised* the score (+7) but made the archetype *less*
    committal, and synthesis went `inconclusive` citing evidence ambiguity. A confirmed listing
    intuitively argues toward `clear_absentee_rental`. One run proves nothing; if it repeats, the
    synthesis packet's archetype rules deserve a look.
- **Landmine for anyone running gates here:** the gitignored `.env` sets `OE_PROSE_REGISTER=on` and
  `OE_PROSE_REDACT=on`. Bun AUTO-LOADS `.env`, so `env -u` does not clear them. `bun run verify`
  therefore shows 2 pre-existing failures out of the box on this branch. Use
  `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify` for a true baseline.

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
