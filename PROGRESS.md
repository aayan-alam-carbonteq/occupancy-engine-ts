# PROGRESS.md

## Current Verified State

- **Repo root:** `occupancy-engine-ts/`
- **Standard startup:** `./init.sh`
- **Standard verification:** `OE_PROSE_REGISTER=off bun run verify` (the gitignored `.env`
  sets that flag `on`, which breaks one tautological test by construction;
  `OE_PROSE_REDACT` must stay `on` or E2E-1 fails). See `AGENTS.md`.
- **Highest-priority unfinished feature:** `batch-cli` (see `feature_list.json`).
- **Current blocker:** none.

Baseline facts: the agent pipeline is a faithful port of `occupancy-engine`,
deterministic-parity-verified vs Python on "1104 SPRING RUN RD"; de-Python cleanup
done; planner-off default mirrored. **The data layer is no longer a port** — X-016
rewrote it off GraphQL onto the occupancy data service's six typed HTTP operations
plus a guarded SQL hatch, reached at `DATA_URL` (default `http://graph:8000`), and it
has no Python counterpart to be faithful to. Pending features (not built): batch CLI,
judge package, observability/summaries.

## Session Record

<!-- newest first; one entry per working session -->

### 2026-07-30 — Typed data service client + SQL hatch (X-016)
- **Goal:** Move the engine off arbitrary GraphQL onto the occupancy data service: six typed HTTP operations (`POST /v1/resolve`, `GET /v1/address/{id}/records|people`, `GET /v1/person/{id}/records`, `GET /v1/people/search`, `GET /v1/source-record/{shape}/{rowid}?address_id=`) plus a guarded SQL hatch (`POST /v1/sql`, `GET /v1/schema`) over a partner Postgres corpus — someone else's production database, 7.6B rows, read-only guest credentials. Breaking, no shim.
- **Completed (branch `feat/typed-data-service`, cut from `main`, Tasks 1-22 in 26 commits):**
  - **Contract A (breaking)** — engine default `http://graphql:8000/graphql` -> `http://graph:8000`; CLI `--graphql-url` -> `--data-url`; env `GRAPHQL_URL` -> `DATA_URL`; compose service `graphql` -> `graph`; body field `graphql_url` -> `data_url`. `AgentInvestigationRequestSchema` is `.strict()`, so a stale key is a 400, not a silent ignore — pinned by `test/models.test.ts` and `test/http_service.test.ts` as an UNKNOWN-KEY error rather than a missing-field one.
  - **Data layer** — `src/agents/data_client.ts` (`DataHttpClient` + `CountingDataClient`, preserving the per-agent call-budget accounting exactly), `src/agents/toolsets/sql_toolset.ts` (`SqlToolset` COMPOSES `TypedToolset`, so the bounded and exploratory surfaces cannot drift), `schema_guide.ts` revived from dead code as a pure formatter over `GET /v1/schema`. `graphql_tool.ts` (972 lines) and the `graphql` dependency are gone.
  - **Shapes** — `voter`, `criminal`, `linkedin` dropped; seven live shapes remain (`base, auto, drive, loan, tax, trace, utility`). `get_records` now DEGRADES on a stale scope token rather than failing the whole call.
  - **Scoring** — `drive` re-weighted 1.15 -> 0.75 and ranked below `loan` (a drive row IS a payday-loan row already counted as loan; the partner corpus has no DMV feed).
  - **Repair channel** — the pre-execution validator is gone; a 422 from the hatch is a RESULT, not an error. It pushes `reason` onto `diagnostics.validation_errors` and increments `query_repair_attempts`, preserving the repair telemetry on the new channel. `DataHttpClient` accepts 422 for `/v1/sql` and nothing else, so a 500 from the same endpoint still raises.
  - **Task 20** — deleted `graphql_tool.ts` + the `graphql` dep (verified a leaf: nothing in `node_modules` reverse-depends on it) and cleared the residual GraphQL vocabulary from `src/`.
  - **Task 21** — `compose.yaml`, `README.md`, `AGENTS.md`, `init.sh` repointed at the data service, every command/env/service/port re-checked against the code.
  - **Task 22** — this record + `feature_list.json`.
- **Verification run:** `OE_PROSE_REGISTER=off bun run verify`; `OE_PROSE_REGISTER=off bun run e2e`; `bun test` under the `.env` defaults; `docker compose config`; `bash -n init.sh`; the two DoD greps.
- **Evidence (verbatim):** `verify` -> exit 0: `tsc --noEmit` clean; `biome check .` -> "Checked 91 files in 304ms. No fixes applied." = **0 warnings** (baseline `8c810d1` had 3, all in files this plan rewrote); `bun test` -> **355 pass / 0 fail / 1348 expect() across 38 files** (baseline 195 / 0 / 765 across 29). `e2e` -> **7 pass / 0 fail / 100 expect() across 2 files** (E2E-1..E2E-5; E2E-5 is the no-GraphQL guard — it asserts no recorded request in the fixture data service has path `/graphql`). Under `.env` (both prose flags on) `bun test` -> **354 pass / 1 fail**, the 1 being the PRE-EXISTING tautological `_prose_register_lines (gated) > is empty by default (flag off) so prompts are byte-identical` — zero real failures in either config. `docker compose config` exit 0 with services `graph` + `agent` and `DATA_URL: http://graph:8000`. `bash -n init.sh` ok.
- **Drive re-weight, before -> after on the fixed 12-case set** (`test/score_benchmark.test.ts`; goldens pinned BEFORE the change in `e12768b` and re-pinned after in `d52460e` — today's run reproduces every "after" value exactly):

  | case | before | after | band |
  |---|---|---|---|
  | no_rows | 0.00 | 0.00 | low_evidence |
  | tax_only_mailing_elsewhere | 2.50 | 2.50 | monitor |
  | drive_only_owner_elsewhere | 5.95 | **4.75** | review -> **monitor** |
  | drive_and_loan_same_row | 7.00 | **5.80** | review |
  | nonowner_loan_renter_at_subject | 5.65 | 5.65 | review |
  | auto_only_owner_elsewhere | 4.30 | 4.30 | monitor |
  | utility_only_nonowner | 4.00 | 4.00 | monitor |
  | trace_only_presence | 2.50 | 2.50 | monitor |
  | full_stack_absentee | 18.25 | **17.05** | high_priority_review |
  | drive_at_subject_nonowner | 9.40 | **7.00** | hpr -> **review** |
  | drive_and_loan_nonowner_at_subject | 16.00 | **13.30** | high_priority_review |
  | loan_only_owner_elsewhere | 3.55 | 3.55 | monitor |

  Five move, seven hold; every case that moved carries a drive row and every case that held carries none. Two cross a band boundary downward: one payday row can no longer reach `review` on its own, and drive alone at the subject no longer reaches `high_priority_review`. `drive_and_loan_nonowner_at_subject` moves by more than the weight change alone (-2.70 vs -2.40) because `repeated_nonowner_cross_source_corroboration` carries both sources and the re-rank now applies loan (3 x 1.05) where it applied drive (3 x 1.15).
- **OPEN ITEM — the drive double-count is halved, not closed:** `_owner_source_elsewhere` scores `drive` at base 3 (`strong`) against `loan`'s base 1, so one physical payday row still contributes 3 x 0.75 = **2.25** on top of loan's 1.05. Measurable as the `drive_and_loan_same_row` minus `loan_only_owner_elsewhere` gap, which goes **3.45 -> 2.25**, not to zero. **The plan's claim that "the duplicate contributes strictly less than the original" is false as stated.** Closing the rest means demoting drive's path STRENGTH in `src/heuristics/atomic_eval.ts` — a semantic claim about the evidence rather than a weight change, and wider than Task 14 specified. Documented in `src/heuristics/policy.ts`. Not a bug; an unfinished calibration, deliberately unbundled.
- **Carry-forward items closed this session:** `include_shortcuts` fully retired (it still had a field on `MetricEvent` + `RunMetricsContext` with a hardcoded `false` caller); `retrieval.ts`'s justification for excluding `utility` from `PERSON_SHAPES` replaced — it claimed "utility is address-linked and has no person scope", which is false (op 4 shares `select_shapes` with op 2, so the service does serve it); the real reason is citability, verified against `services/graph@b9332e7`. `query_cache.ts` no longer documents itself as caching GraphQL. `prose_redaction.ts` dropped the dead `voterrecords`/`criminalrecords` entries and `VOTER|CRIMINAL` from `SOURCE_TAGS`.
- **Plan defects found (in addition to the ~35 the earlier batches found):** (1) the DoD grep `grep -rn "voter|criminal|linkedin" src/` cannot return nothing — five surviving hits are the comments that EXPLAIN why those shapes are absent, and gutting them to satisfy a grep would delete the reason; same for `test/`, whose guard tests must contain the literal strings they search for. Both greps are clean for `src/` in substance: no code, data or prompt string references the dead shapes. (2) `AGENTS.md`'s prose-flag note cited `orchestrator.e2e.test.ts:42`; the assertion that actually depends on `OE_PROSE_REDACT` is line 57. (3) the plan's graph healthcheck used `GET /v1/schema`; the service has a purpose-built `GET /healthz` (`app.py:59`). (4) the README's `docker compose run --rm agent --address …` could not work — the image entrypoint is `cli/serve.ts`, which takes no address arguments.
- **Risks:** the live engine <-> graph-service run has NOT happened; every gate here is offline against `test/support/fixture_data_service.ts`, which serves the pinned Contract B/C routes over real HTTP and 404s everything else. Contract A is breaking with no shim, so the backend's `submodules/occupancy-engine-ts` pointer bump and its `graphql_url` -> `data_url` payload change must land together. `services/graph` shows as modified in this working tree and is deliberately NOT committed from here — the umbrella sequences the submodule pointer.
- **Next best action (coordinator):** merge the graph service, then run the umbrella's cross-repo verification steps 2-4 (live engine -> data service on a real address, the hatch adversarial pass, the backend cross-process probe); then merge `feat/typed-data-service` -> engine `main`, bump the backend's engine submodule pointer, and repoint the backend at `data_url`. Next engine cleanup: `heuristics/atomic_eval.ts` `build_evidence` and `engine.ts` `evaluate_address` are dead at runtime and still carry a SQLite `db_path` option.

### 2026-07-20 — Realtor listing signals -> AI layer (X-014)
- **Goal:** Forward realtor rental-listing history + transaction facts (last_sold_date/price, list_date, flags) to the AI layer by widening the .strict() ExternalEvidence contract and folding the new fields into the existing rental-market + property-facts channels, entirely additively.
- **Completed (branch `feat/realtor-listing-signals`, cut from `main` @2a9a095):** RentalListingSchema + top-level rental_listings (flat most-recent-2) + 4 property_facts transaction fields in external_evidence.ts; rental_listings folded into rental_market_summary_lines (emits "Property listed for rent (realtor history): 2026-05 $2300, 2025-03 $2195 — source AppfolioUnits.", folded regardless of str_listings so the 1104 case surfaces); transaction fields rendered in _facts_summary; shared fixture widened from the real 1104 probe.
- **Verification run:** `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify`; `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e`; scrubber survival under `OE_PROSE_REDACT=on`.
- **Evidence:** verify = typecheck clean, lint 0 errors (3 pre-existing warnings), 169 pass / 0 fail / 706 expect() across 28 files (baseline 152 pass / 0 fail); e2e = 6 pass / 0 fail / 91 expect() across 2 files; prose survival under OE_PROSE_REDACT=on = 5 pass / 0 fail. The X-012 guards stay green and were both observed FAILING when deliberately broken: the critical negative test (owner_identity never sees the rental channel — solo/full/group; str_scan temporarily added to its input_sources + gate.source_scope leaked the rental line and broke packets_exposure_map) and the E2E blind-parity guard (rental_market_summary_lines(null) temporarily returning ["probe"]). Both reverted; green after (git diff --stat packets.ts empty).
- **Known consequences (decisions of record, not bugs):** (1) No new scope token — rental_listings rides the existing str_scan gate; packets.ts unchanged. (2) The BUCKET is the unit of exposure: owner_identity_and_mailing sees the transaction facts via its property_tax_context bucket-mate (same as source_provider=realtor today), but NEVER the rental channel (str_scan excluded from that union). (3) Field-name tokens (last_sold_date) are humanized by the prose scrubber exactly like home_type; the evidence content (AppfolioUnits, foreclosure, dates, prices) survives.
- **Next best action:** merge to `main` (push engine first per the umbrella merge order), then the backend widens the mirror + splits in toExternalEvidence and bumps the submodule pointer.

### 2026-07-17 — Engine as an independent HTTP service (X-013)
- **Coordinator live gates (2026-07-17, real, not projected):** engine server verified end-to-end. `bun run serve` on :8787 + real graph + real LLM: `POST /investigate` streamed 364 progress frames then exactly one terminal `{report}` (verdict review), 107.8s. `docker compose build agent` exit 0; `docker compose up` -> both containers healthy; the dockerized agent served host :8787 (healthz 200 / 401 / 400). Latency ~= the spawn baseline (LLM calls dominate); the win is architectural, not a speedup. The docker live gate the plan deferred to the coordinator is now DONE. Backend cross-process probe (real EngineHttpAdapter -> this engine service) also passed (1 pass, 123s) — recorded in the backend repo.
- **Goal:** Wrap the existing `investigate_address()` pipeline in a long-running, stateless `Bun.serve` HTTP service exposing one streaming `POST /investigate`, so Bun startup + the LangChain import graph + GraphQL introspection are paid once at boot instead of per run. The CLI and the pipeline stay untouched — this is a transport wrapper. Engine-first; lands before any backend change.
- **Completed (branch `feat/http-service`, cut from `main` @849e2af, 9 commits):**
  - **T1** — factored the shared CLI/service wire contract into `src/agents/investigation_wire.ts` (`formatProgressLine`, `assessment_report_payload`, `parse_investigation_request`); re-pointed `cli/run_address.ts` to it and re-exported `formatProgressLine` so `test/progress_line.test.ts` stays green. CLI output is byte-identical (same destructuring).
  - **T2** — `should_cancel` as one optional field on the existing hooks object (`InvestigationHooks`), no signature change, default `() => false`. Polled at the four checkpoints: `subagents.ts` `run` loop (site 1), `run_group` loop (site 2), `orchestrator.ts` `run_bucket` before invoke (site 3), and between phases before `heuristic_workers` and before `master_adjudicator` (site 4). Wired through `investigate_address`.
  - **T3-T5** — `src/server/investigate_server.ts` (`create_engine_server`): bearer auth (401), strict `AgentInvestigationRequestSchema` parse (400 + zod path), non-blocking concurrency semaphore (503 + `Retry-After: 2`), NDJSON stream of `formatProgressLine` frames then exactly one terminal `{report}`/`{error}` frame, overall request timeout that flips `should_cancel`, graceful-shutdown drain, and auth-exempt `GET /healthz`. Entry `cli/serve.ts` + `package.json` `serve` script. Port default 8787; healthcheck `/healthz`.
  - **T6-T7** — `test/support/fake_engine_server.ts` HTTP double built on the SHARED `formatProgressLine` (fidelity rule); `test/e2e/http_service.e2e.test.ts` proving a blind run through the service is byte-identical to the CLI report and that X-012's blind guarantee survives the transport.
  - **T8** — `compose.yaml` `agent` is now a real service (dropped `profiles:["tools"]`, added `8787:8787` + a `/healthz` healthcheck + `ENGINE_AUTH_TOKEN`/`ENGINE_PORT`); `Dockerfile` `EXPOSE 8787` + ENTRYPOINT flipped `cli/run_address.ts` → `cli/serve.ts`.
- **Verification run:** `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify`; `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e`; `bun test` (the .env-default, prose flags on); live smoke `ENGINE_AUTH_TOKEN=t GRAPHQL_URL=... bun run serve` + curl probes.
- **Evidence:** `verify` — typecheck clean, lint 0 errors (3 pre-existing warnings), **152 pass / 0 fail / 619 expect() across 28 files** (pre-change baseline: 132 pass / 0 fail; +20 new: investigation_wire 4, cancellation 3, http_service 8, fake_engine_server 3, e2e/http_service.e2e 2). `e2e` — **6 pass / 0 fail / 71 expect() across 2 files** (original E2E-1..E2E-4 + 2 new service E2E). Under `.env` (both prose flags on) `bun test` → **150 pass / 2 fail**, the 2 being the PRE-EXISTING tautological `proseRedactEnabled > is off by default` and `_prose_register_lines (gated) > is empty by default` (they assert the flags are off, so the .env breaks them by construction) — not from this work. Live smoke: prints `engine service listening on :8787`; `GET /healthz` → 200 (Anthropic key present, LLM + graph clients construct); `POST /investigate` no bearer → 401.
- **Plan correction (real, verified with a standalone Bun probe):** Bun 1.3.10 defers a streaming `Response`'s headers until the first chunk is enqueued. The plan's Task 4 backpressure test held the single permit by blocking `investigate()` BEFORE emitting any frame, so `await fetch(a)` never saw the 200 headers (they only flush on first byte, which only came after `release()`, which only runs after that await) — a deadlock. Fixed faithfully by having request A emit one progress frame before blocking; the server is unchanged (empty diff vs its own commit). Also: two of the plan's exact code snippets needed trivial type fixes under this repo's tsconfig/@types/bun — `server.port` is `number | undefined` (coalesced to the bound port) and `Response.json()` returns `unknown` (cast to `any` in the two tests that read a property). No logic changed.
- **Risks:** the docker live full-stack gate is the only unrun DoD item (see below). Everything else is real, recorded output.
- **DEFERRED — docker live gate:** per the coordinator's handoff, Task 8 Step 3 (`docker compose config`) and Task 9 Step 4 (`docker compose up --build` + the live streaming `POST /investigate` curl + per-investigation latency vs the ~1m50s spawn baseline) were **NOT run here** — the coordinator will run the live full-stack docker gate after both repos are built. No `docker` was invoked in this session.
- **Next best action (coordinator):** run the live docker gate; record the warm-process per-investigation latency vs the ~1m50s spawn baseline; update the workspace `map.md` to record the engine as a service on 8787; then merge `feat/http-service` → engine `main` and bump the backend's engine submodule pointer.

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
