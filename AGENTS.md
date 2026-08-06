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

## Refreshing the E2E fixture

The E2E preflight fixture (`test/support/fixtures/preflight_1104.json`) is a frozen
real GraphQL response. To refresh it (needs the Python GraphQL server on :8000):

    bun run scripts/capture_preflight_fixture.ts
