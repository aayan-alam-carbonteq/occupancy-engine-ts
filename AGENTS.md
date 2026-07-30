# AGENTS.md — occupancy-engine-ts

Operating rules for any AI agent (or human) working in this repo. Read this and
`PROGRESS.md` before doing anything.

## Project overview

TypeScript/Bun port of the `occupancy-engine` agent pipeline (agents + heuristics
+ observability). It talks to the **occupancy data service over typed HTTP**; the
database/backend stays Python. This repo is a *faithful port* — behavior parity with
the Python source is the correctness bar, **except for the data layer** (see Hard
constraints).

The data boundary is six typed operations plus a guarded SQL hatch, served by
`services/graph` (submodule) and reached at `DATA_URL` (default `http://graph:8000`):

| # | Operation |
|---|---|
| 1 | `POST /v1/resolve` |
| 2 | `GET /v1/address/{id}/records` |
| 3 | `GET /v1/address/{id}/people` |
| 4 | `GET /v1/person/{id}/records` |
| 5 | `GET /v1/people/search` |
| 6 | `GET /v1/source-record/{shape}/{rowid}?address_id=` |

Hatch: `POST /v1/sql` (a **422 is a result, not an error** — it is the agent's repair
signal) and `GET /v1/schema`.

## Tech stack

- Runtime: Bun 1.3.10 (pinned in `.bun-version`)
- LLM: LangChain.js (`@langchain/anthropic|openai|google-genai`, `@langchain/core`, `langchain` 0.3)
- Schemas: zod 3 (the port's stand-in for Python pydantic)
- HTTP: `fetch` + `Bun.serve` — no client or server HTTP dependency
- Tests/lint: `bun test`, Biome
- Provider model: `claude-haiku-4-5` (benchmarking/judge use sonnet)

## First run

    ./init.sh

## Verification commands (the feedback loop)

    bun run typecheck                     # tsc --noEmit
    bun run lint                          # biome check .
    OE_PROSE_REGISTER=off bun test        # unit + deterministic E2E (no API, no live server)
    OE_PROSE_REGISTER=off bun run e2e     # focused: just the E2E suite
    OE_PROSE_REGISTER=off bun run verify  # typecheck + lint + bun test  (bun test includes E2E)

**The gate is `OE_PROSE_REGISTER=off bun run verify`.** Two prose flags, both set `on`
by the gitignored `.env`, and they pull in opposite directions:

- `OE_PROSE_REGISTER` must be **off** to run the suite. It is a debug register of
  emitted prose lines; with it on, `prompts_register.test.ts > _prose_register_lines
  (gated) > is empty by default (flag off) so prompts are byte-identical` fails by
  construction — the register is not empty because the flag filled it.
- `OE_PROSE_REDACT` must stay **on**. `test/e2e/orchestrator.e2e.test.ts:57` asserts
  the humanized `resolved_address.evidence_map.owner_summaries` copy (`/^Owner /`,
  no `=`), which only the redactor produces; with the flag off E2E-1 fails.

## Hard constraints

- **Parity first, with one carve-out.** Don't change heuristics, scoring, prompt
  assembly or report shape without a Python-parity reason. The **data layer is
  exempt**: the typed client, toolsets and retrieval helpers were rewritten off
  GraphQL onto the typed service (X-016) and have no Python counterpart to match.
  The deterministic E2E suite (`test/e2e/`) is the guardrail — keep it green.
- **Never swap libraries** for "equivalents." LangChain.js stays; zod is the only
  intentional pydantic substitution.
- **Haiku** is the provider model. Benchmarking/judge stays sonnet.
- **Native TS only** — no Python-referencing names or comments; the code must not
  advertise that a Python version exists.
- **Don't commit** gitignored artefacts — `.env`, `experiments/`, `runs/`, `dist/`,
  `.claude/worktrees/`. Never a credential, ever, including in a commit message.

## Working rules

1. Read `PROGRESS.md` (Current Verified State) first.
2. Pick the highest-priority `feature_list.json` item; set exactly **one** to
   `in_progress` (never more than one).
3. Do the work. **Evidence before done:** a feature is `passing` only when its
   `verification` steps were actually run and the output recorded in `evidence`.
4. Leave a clean state (see below) and append a `PROGRESS.md` Session Record.

## Definition of done (the most important part)

A change is done only when ALL hold:
- `OE_PROSE_REGISTER=off bun run verify` is green.
- The touched `feature_list.json` entry is `passing` with real `evidence`.
- `PROGRESS.md` has a new Session Record (goal / completed / verification / evidence
  / commits / risks / next best action).
- The working tree is clean — nothing stray, nothing gitignored committed.

## Clean state

Every session ends with: `OE_PROSE_REGISTER=off bun run verify` green, `PROGRESS.md`
updated, `git status` clean. `services/graph` showing as modified is **not** clean
drift to commit from here — the submodule pointer is the umbrella's to sequence.

## Observability (built-in introspection)

`src/observability/` records per-run metrics sidecars (latency, cost, tokens, cache,
errors, per-phase counts). Use them to debug runtime behavior — they are the
harness's introspection surface.

## The E2E fixture

`test/support/fixtures/resolve_1104.json` is a hand-maintained `POST /v1/resolve` body for
1104 SPRING RUN RD / 40514. There is no capture script: the contract is typed, so the fixture is
edited directly against it rather than re-scraped. `test/support/fixture_data_service.ts` serves it
over real HTTP and 404s any route the contract does not pin — a fixture that answers everything
cannot catch a client calling something the service does not offer.
