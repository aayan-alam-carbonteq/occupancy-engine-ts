# Agent Harness for occupancy-engine-ts — Design

**Date:** 2026-07-06
**Status:** approved (design), pending spec review → implementation plan
**Reference:** Harness Engineering — https://walkinglabs.github.io/learn-harness-engineering/en/

## 1. Goal

Make `occupancy-engine-ts` a **well-harnessed repository for AI-agent development**: give any coding
agent (or human) working on this repo an explicit control system — rules, a machine-readable feature
list, cross-session continuity, a one-command bootstrap, and a **real closed feedback loop** — so work
is constrained, verifiable, and resumable.

This is *not* about the agent runtime (the orchestrator/subagents loop already exists and is parity-verified
against the Python source). It is the **development harness** the reference material teaches.

## 2. Background — the five-subsystem model

A harness is a closed loop of five interdependent subsystems (reference, Lecture 2):

| # | Subsystem | Canonical artifact | occupancy-engine-ts today |
|---|---|---|---|
| 1 | Instruction | `AGENTS.md` / `CLAUDE.md` | ✗ missing |
| 2 | Tool | shell / CLI (least-privilege) | ✓ Bun shell present |
| 3 | Environment | `package.json`, version pins | ⚠️ `package.json` present, no version pin |
| 4 | State | `PROGRESS.md` | ✗ missing |
| 5 | Feedback (highest ROI) | verification commands + tests | ⚠️ `typecheck`+`test` scripts exist, but **109 LOC of tests over ~14K LOC**, **no agent-level or E2E tests** |

Loop: agent reads instructions → runs tools in the environment → updates state → gets feedback → adjusts.
Missing any subsystem breaks the loop. Here, subsystems 1, 4 are absent and 5 is barely present — those are
the build.

## 3. Design

All harness artifacts live at the **TS repo root** (`occupancy-engine-ts/`) unless noted.

### 3.1 Instruction — `AGENTS.md` (+ `CLAUDE.md` pointer)

`AGENTS.md`, ~120 lines, sections:

- **Project overview** — TS port of the occupancy-engine agent pipeline (agents + heuristics +
  observability); talks to the existing **Python GraphQL server over HTTP**; the DB/backend stays Python.
- **Tech stack + versions** — Bun 1.3.10, LangChain.js (`@langchain/*` 0.3), zod 3, graphql-js 17, TypeScript 5.6.
- **First run** — `./init.sh` (see §3.5).
- **Hard constraints** (the guardrails):
  - Faithful port: **deterministic/behavior parity with the Python source is the correctness bar.** Don't
    change agent logic without a parity reason.
  - **Never swap libraries** for equivalents (LangChain.js stays; zod is the only unavoidable pydantic
    substitution).
  - **Haiku** (`claude-haiku-4-5`) is the provider model; benchmarking/judge stays sonnet.
  - Don't commit gitignored `experiments/` or `data/cache/`.
  - The codebase must read as native TS — no Python-referencing names/comments (already enforced).
- **Verification commands** (the feedback loop):
  ```
  bun run typecheck   # tsc --noEmit
  bun run lint        # biome check
  bun test            # unit + E2E (Bun discovers all *.test.ts, incl. test/e2e; deterministic, no API/server)
  bun run e2e         # focused convenience: bun test test/e2e
  bun run verify      # typecheck + lint + bun test  (test already includes E2E — no double run)
  ```
- **Working rules** — read `PROGRESS.md` first; exactly one `feature_list.json` item `in_progress` at a
  time; **evidence required before marking a feature `passing`**; leave a clean state every session (§3.6).
- **Definition of done** (per the guide, "the most important part") — a change is done only when: `bun run
  verify` is green, the touched `feature_list.json` entry is `passing` with recorded `evidence`,
  `PROGRESS.md` has a new Session Record, and the working tree is clean (no stray/uncommitted artifacts).

`CLAUDE.md` — one line: `See [AGENTS.md](./AGENTS.md).` (so Claude Code auto-loads the same rules).

### 3.2 State — `PROGRESS.md`

Two sections (reference template):

- **Current Verified State** — repo root; standard startup path (`./init.sh`); standard verification path
  (`bun run verify`); highest-priority unfinished feature (from `feature_list.json`); current blocker.
- **Session Record** (append-only, newest first) — per session: Goal · Completed · Verification run ·
  Evidence recorded · Commits · Known risks · Next best action.

Seeded with today's true state: port complete + deterministic-parity-verified vs Python; de-Python cleanup
done (commits `65e2b15`, `3ee5dbf`); planner-off default mirrored (`49185c0`); pending: batch CLI, judge
package, observability/summaries.

### 3.3 Feature list — `feature_list.json`

Machine-readable system-of-record. Schema per feature (reference): `id`, `priority` (int, lower =
higher), `area`, `title`, `user_visible_behavior`, `status` (`not_started` | `in_progress` | `blocked` |
`passing`), `verification` (steps), `evidence` (proof verification passed), `notes`. **Invariant: at most
one `in_progress`.**

Seed entries (illustrative, not exhaustive):
- `agents-orchestrator`, `heuristics-engine`, `agent-toolsets`, `observability`, `single-address-cli` →
  `status: passing`, `evidence:` byte-identical deterministic parity vs Python on "1104 SPRING RUN RD" +
  `bun run verify` green + the new E2E tests.
- `batch-cli`, `judge-package`, `observability-summaries` → `status: not_started` (registered, not built).

### 3.4 Feedback — deterministic E2E harness (the bulk of the work)

Port the Python repo's deterministic test harness (`ScriptedLlmE2E`, `JsonGraphQLServer`, `FakeSubagent`,
`_preflight_payload`) into TS. **No live API, no live server, no cost.** Injection points already exist:
`AgentOrchestrator` (`src/agents/orchestrator.ts:167`) is constructed with `{ graphql, subagent?,
master_llm? }`, and the scripted model only needs `bindTools(tools, opts?)` + `invoke(messages) →
{ tool_calls, usage_metadata, content }`.

Components (under `test/support/` and `test/e2e/`):

- **`test/support/scripted_llm.ts`** — `ScriptedChatModel`: constructed with ordered batches of tool calls
  (`Array<Array<{ name, args }>>`); `bindTools()` returns a bound view; `invoke()` returns the next batch as
  an AI-message-shaped object (`tool_calls: [{ name, args, id, type: "tool_call" }]`, `usage_metadata`,
  `content: ""`); **throws when exhausted** (mirrors `ScriptedLlmE2E`). Deterministic, API-free.
- **`test/support/fixture_graphql.ts`** — `FixtureGraphQL`: duck-types the `GraphQLHttpTool` surface the
  orchestrator uses (`query(queryString, variables?) → Promise<data>`, `logs: []`). Routes by inspecting the
  query (address preflight → frozen payload; person/id sub-queries → subsets/empty). In-process, no HTTP
  (mirrors `JsonGraphQLServer`).
- **`test/support/fixtures/preflight_1104.json`** — **Approach A**: one real GraphQL preflight response for
  "1104 SPRING RUN RD", captured once from the live Python server (GraphQL only — free, no LLM), frozen as a
  fixture so E2E asserts against real-shaped data.
- **`test/support/fixtures.ts`** — loaders for the frozen fixture + a small synthetic **sparse** payload
  builder (mirror `_sparse_preflight_payload`) for the low-evidence path.
- **`test/e2e/orchestrator.e2e.test.ts`** — two deterministic E2E tests:
  - **E2E-1 (assembly):** `AgentOrchestrator` + `FixtureGraphQL` + `FakeSubagent` (canned submits) + scripted
    master LLM → asserts the orchestrator's assembly: `address_id`, `source_counts`, gated packet set,
    grouped-conversation formation, adjudication band, report presence.
  - **E2E-2 (full stack):** `FixtureGraphQL` + the **real** subagent driven by a scripted LLM covering the
    full sequence (master plan → per-subagent fetch calls → per-subagent submit → adjudication) → asserts a
    subagent actually fetches through the real toolsets and submits a scored result. This is the anti-early-
    victory gate: it exercises retrieval + toolsets + scoring + synthesis end-to-end without an API.

### 3.5 Environment + bootstrap — `init.sh`, version pin, scripts, linter

- **`init.sh`** — reference three-variable shape: `INSTALL_CMD="bun install"`,
  `VERIFY_CMD="bun run typecheck && bun test"`, and a `START_CMD`/note documenting that the E2E harness is
  self-contained but *live* runs (`bun run run-address`) need the Python GraphQL server on `:8000`.
  Confirms directory → installs → verifies → prints next step.
- **Version pin** — add `.bun-version` (`1.3.10`) and a `packageManager` field, so the runtime is explicit
  (Environment subsystem).
- **`package.json` scripts** — add `lint` (`biome check .`), `lint:fix`, `e2e` (`bun test test/e2e`),
  `verify` (`bun run typecheck && bun run lint && bun test`). `bun test` already runs the E2E tests, so
  `verify` does not call `e2e` separately (the `e2e` script is just a focused convenience).
- **Linter** — add **Biome** (Bun-native, fast, near-zero config) as `devDependency` + `biome.json`. First
  pass may need light auto-fixes; no behavior changes.

### 3.6 Clean-state + observability conventions (documented in `AGENTS.md`)

- **Clean state** — every session ends with: `bun run verify` green, `PROGRESS.md` updated, working tree
  clean, no gitignored `experiments/` committed.
- **Observability** — document that `src/observability/` (metrics sidecars: latency/cost/tokens/errors per
  run) *is* the harness's built-in introspection; point agents at it for debugging runtime behavior.

## 4. File structure (new/changed)

```
occupancy-engine-ts/
  AGENTS.md              # new — instruction subsystem
  CLAUDE.md              # new — one-line pointer to AGENTS.md
  PROGRESS.md            # new — state subsystem
  feature_list.json      # new — feature system-of-record
  init.sh                # new — bootstrap
  .bun-version           # new — env pin
  biome.json             # new — linter config
  package.json           # changed — scripts (lint/e2e/verify) + packageManager + biome devDep
  test/
    support/
      scripted_llm.ts    # new
      fixture_graphql.ts # new
      fixtures.ts        # new
      fixtures/preflight_1104.json  # new — captured real preflight
    e2e/
      orchestrator.e2e.test.ts      # new — E2E-1 + E2E-2
  docs/superpowers/specs/2026-07-06-agent-harness-design.md  # this file
```

No `src/` changes required — the orchestrator already exposes the injection seams. If a seam turns out
to need widening (e.g. a type on the graphql/subagent constructor params), that is an in-scope, minimal
touch documented in the plan.

## 5. Verification — definition of done for the harness itself

- `bun run verify` is green (typecheck + lint + unit + E2E).
- E2E-1 and E2E-2 run deterministically with **no network and no API key**, and fail loudly if the
  scripted LLM is over-/under-called (mirrors the Python `fail-loud on over-call` behavior).
- `./init.sh` runs clean from a fresh `bun install`.
- Every verification command named in `AGENTS.md` actually exists and passes.
- `feature_list.json` validates against its schema and has ≤1 `in_progress`.
- `PROGRESS.md` seeded with an accurate Current Verified State.

## 6. Out of scope (YAGNI)

- Building the pending features themselves (batch CLI / judge / summaries) — only *registered* in
  `feature_list.json`.
- CI configuration (GitHub Actions) — can be added later; the harness is CI-ready via `bun run verify`.
- Any change to the Python repo.
- Live-LLM E2E in the default loop (rejected in scoping; the deterministic E2E is the gate).

## 7. Risks / mitigations

- **E2E-2 scripting fidelity** — scripting the exact subagent tool-call sequence is the fiddly part
  (as in Python's `ScriptedLlmE2E`). Mitigation: port the Python scripted batches; start with E2E-1
  (simpler, `FakeSubagent`) as the must-have, then E2E-2. If E2E-2 proves brittle, keep it but mark the
  feature `passing` on E2E-1 + E2E-2-smoke and note the risk.
- **Fixture drift** — the frozen preflight could drift from the live schema. Mitigation: capture the whole
  real response once; document the capture command in `AGENTS.md` so it can be refreshed.
- **Biome first-pass churn** — may flag existing style. Mitigation: adopt a conservative `biome.json`
  (errors off for stylistic-only rules initially), auto-fix trivially, no behavior changes.
