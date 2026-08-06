# AGENTS.md — occupancy-engine-ts

Operating rules for any AI agent (or human) working in this repo. Read this and
`PROGRESS.md` before doing anything.

## Project overview

TypeScript/Bun port of the `occupancy-engine` agent pipeline (agents + heuristics
+ observability). It talks to the existing **Python GraphQL server over HTTP**; the
database/backend stays Python. This repo is a *faithful port* — behavior parity with
the Python source is the correctness bar.

## Tech stack

- Runtime: Bun 1.3.10 (pinned in `.bun-version`)
- LLM: LangChain.js (`@langchain/anthropic|openai|google-genai`, `@langchain/core`, `langchain` 0.3)
- Schemas: zod 3 (the port's stand-in for Python pydantic)
- GraphQL: graphql-js 17 (`graphql`)
- Tests/lint: `bun test`, Biome
- Provider model: `claude-haiku-4-5` (benchmarking/judge use sonnet)

## First run

    ./init.sh

## Verification commands (the feedback loop)

    bun run typecheck   # tsc --noEmit
    bun run lint        # biome check .
    bun test            # unit + deterministic E2E (no API, no live server)
    bun run e2e         # focused: just the E2E suite
    bun run verify      # typecheck + lint + bun test  (bun test already includes E2E)

**True baseline.** The gitignored `.env` sets `OE_PROSE_REGISTER=on` and `OE_PROSE_REDACT=on`, and
Bun AUTO-LOADS `.env` (`env -u` does not clear it). A bare `bun run verify` therefore shows 2
pre-existing failures that assert those flags are off, i.e. fail by construction. Always gate with:

    OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify

**Known-failing on trunk (2026-08-06):** `E2E-1: orchestrator assembly` fails — `_person_name`
cannot name a utility row (expects `/^Owner /`, gets `owner=…`). It reproduces at the pinned
`5e8e15f` in a clean worktree, so it is not yours. X-016's `db706c5` fixed it, but that line is
abandoned; the fix is recoverable from `origin/feat/typed-data-service`.

## Hard constraints

- **Parity first.** Don't change agent logic without a Python-parity reason. The
  deterministic E2E suite (`test/e2e/`) is the guardrail — keep it green.
- **Never swap libraries** for "equivalents." LangChain.js stays; zod is the only
  intentional pydantic substitution.
- **Haiku** is the provider model. Benchmarking/judge stays sonnet.
- **Native TS only** — no Python-referencing names or comments; the code must not
  advertise that a Python version exists.
- **Don't commit** gitignored `experiments/` or `data/cache/`.

## Working rules

1. Read `PROGRESS.md` (Current Verified State) first.
2. Pick the highest-priority `feature_list.json` item; set exactly **one** to
   `in_progress` (never more than one).
3. Do the work. **Evidence before done:** a feature is `passing` only when its
   `verification` steps were actually run and the output recorded in `evidence`.
4. Leave a clean state (see below) and append a `PROGRESS.md` Session Record.

## Definition of done (the most important part)

A change is done only when ALL hold:
- `bun run verify` is green.
- The touched `feature_list.json` entry is `passing` with real `evidence`.
- `PROGRESS.md` has a new Session Record (goal / completed / verification / evidence
  / commits / risks / next best action).
- The working tree is clean — nothing stray, nothing gitignored committed.

## Clean state

Every session ends with: `bun run verify` green, `PROGRESS.md` updated,
`git status` clean.

## Observability (built-in introspection)

`src/observability/` records per-run metrics sidecars (latency, cost, tokens, cache,
errors, per-phase counts). Use them to debug runtime behavior — they are the
harness's introspection surface.

## The fingerprint endpoint (the backend's cache-key surface)

`POST /fingerprint` — bearer auth, same `ENGINE_AUTH_TOKEN` as `/investigate`:

    { "items": [{ "address": "1104 Spring Run Rd", "zip": "40514" }, { "address": "22 Elm St" }] }
      -> 200 { "engine": "<sha256 of src/**, cli/**, package.json, bun.lock>",
               "items": [{ "data": "<sha256 of the normalized record projection>" }, { "data": null }] }

- **One entry per input, SAME ORDER** — callers zip by index. `data: null` is a per-item degradation
  (unresolvable address, or the probe's read failed) and is **never** a whole-request failure.
  401 on a bad/missing bearer; 400 on a malformed body.
- **No model id is reported, by design.** The backend keys on its own `config.investigation.model` —
  the value it already sends in the `/investigate` body — because it owns the model the run actually
  uses. An engine-reported model could drift from it and key a report on a model the run did not use.
  Do not add `ENGINE_MODEL`, a `configured_model_id` helper, or a model field to this response.
- **OPS RULE, load-bearing: `GRAPHQL_URL` on this engine must name the same graph the backend sends
  as `graphql_url` in its `/investigate` body.** `/fingerprint` carries no `graphql_url` — the probe
  reads this process's own configured graph. If the two differ, the fingerprint describes a different
  dataset than the investigation reads, and the cache can serve a report computed over data the run
  never saw. `bun run serve` prints both the engine hash and the graph URL at startup; check them
  against the backend's engine config after any deploy on either side.
- An engine deploy changes `engine` and drains the cache. Intended: over-invalidation costs a rerun,
  under-invalidation serves a wrong report.
- **`services/graph` gets no change, now or ever, for this feature** — the fingerprint is a *read*.
  The hash is taken over the engine's own normalized projection (`src/fingerprint/data_source_probe.ts`),
  not the source's wire format, so swapping in the partner endpoint is one new `DataSourceProbe`.

## Evidence references are tenant-neutral (cross-org report reuse)

Reports are **reused across organizations** (workspace X-015). So nothing this engine emits may name
the organization that paid for the run.

`external_evidence_refs` keys each reference by an **evidence-intrinsic digest**, never the caller's
`scan_id`, and it does **not** echo `scan_id` or `scanned_at` into `data`. Both are still accepted on
the *inbound* `ExternalEvidence` shape — that is the backend telling us what it is scanning, which is
fine. The rule is one-directional: **accept them, never emit them.**

Guarded by `test/external_evidence_tenant_neutral.test.ts` and a canary in
`test/external_evidence_exposure.test.ts`, both asserted on the **serialized** ref set — `data` is a
`jsonRecord`, so a key-by-key check cannot prove absence.

## Refreshing the E2E fixture

The E2E preflight fixture (`test/support/fixtures/preflight_1104.json`) is a frozen
real GraphQL response. To refresh it (needs the Python GraphQL server on :8000):

    bun run scripts/capture_preflight_fixture.ts
