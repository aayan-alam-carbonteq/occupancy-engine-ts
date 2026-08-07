# X-016 Typed Data Service + SQL Hatch — Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every GraphQL code path in the engine with the six typed HTTP operations plus the guarded SQL hatch, drop the three shapes the partner corpus does not have, and re-weight `drive` so a payday-loan row is no longer counted twice.

**Architecture:** One typed HTTP client (`data_client.ts`) replaces `graphql_tool.ts`, preserving `CountingGraphQLTool`'s per-agent call-budget accounting verbatim (budget check → increment → cache → log → recorder event) under new names. `retrieval.ts` calls endpoints instead of building query strings; its per-shape projection is byte-identical for the seven surviving shapes. The 671-line `graphql_toolset.ts` collapses into a ~190-line `sql_toolset.ts` that **composes** `TypedToolset` and adds `run_sql` / `describe_schema` / `get_source_record` — deleting the four duplicated compaction helpers its own header comment flags as private copies. `heuristics/` loses `voter` end to end, and `drive` drops from 1.15 to 0.75 behind a committed deterministic score benchmark.

**Tech Stack:** TypeScript, Bun 1.3.10, zod 3, LangChain.js 0.3, Biome. The `graphql` npm dependency is removed.

**Spec:** [`docs/superpowers/specs/2026-07-29-typed-data-service-design.md`](../../../../docs/superpowers/specs/2026-07-29-typed-data-service-design.md) (workspace) · **Umbrella:** [`docs/superpowers/plans/2026-07-29-typed-data-service.md`](../../../../docs/superpowers/plans/2026-07-29-typed-data-service.md)

**Branch:** `feat/typed-data-service`, cut from **`main`** (`scripts/repo-branch.sh engine` → `main`; trunk-based, promotion chain is `main` alone). Every `git checkout -b`, PR base and merge targets `main`. Never rewrite `main`.

**Depends on:** the graph-service plan being merged and its surface pinned. This plan is written against **Contract B/C as pinned in the umbrella**, not against a running service — every test drives an in-repo fixture server that implements the contract, so the engine work is verifiable before the service exists.

---

## Gate commands for this repo (established, not assumed)

From `AGENTS.md` + `package.json`, verified in place on `main` today:

| Command | Purpose |
|---|---|
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | `biome check .` |
| `bun test` | unit + deterministic E2E (no API, no live server) |
| `bun run e2e` | `bun test test/e2e` only |
| `bun run verify` | typecheck + lint + bun test |

**The gate command is `OE_PROSE_REGISTER=off bun run verify`.** The gitignored `.env` sets `OE_PROSE_REGISTER=on` and `OE_PROSE_REDACT=on`; the register flag breaks one tautological test (`prompts_register.test.ts > _prose_register_lines (gated) > is empty by default`) by construction. `OE_PROSE_REDACT` must stay **on** — `test/e2e/orchestrator.e2e.test.ts:42` asserts the humanized `resolved_address` copy and fails with the flag off.

**Recorded baseline on `main` (run in place, 2026-07-29):**

```
OE_PROSE_REGISTER=off bun run verify   → exit 0
  tsc --noEmit                          → clean
  biome check .                         → Checked 82 files. Found 3 warnings. (exit 0)
  bun test                              → 195 pass / 0 fail / 765 expect() across 29 files
OE_PROSE_REGISTER=off bun run e2e      → 6 pass / 0 fail / 94 expect() across 2 files
```

The 3 lint warnings are `src/agents/retrieval.ts:168`, `src/agents/toolsets/graphql_toolset.ts:97` (unused `validate_graphql`), `src/agents/typed_tools.ts:156` — all three live in files this plan rewrites, so **the expected end state is 0 warnings**.

---

## Pinned contracts, as the engine consumes them

Copied from the umbrella. Do not paraphrase, do not extend, do not add a seventh operation.

### Contract A — inbound `POST /investigate`

```jsonc
{ "address": "1104 Spring Run Rd", "zip": "40514",
  "data_url": "http://graph:8000",          // was graphql_url
  "model": "claude-opus-5",
  "external_evidence": { /* unchanged */ } }
```

Engine default (`investigate_server.ts:85`): `http://graphql:8000/graphql` → `http://graph:8000`. CLI flag `--graphql-url` → `--data-url`. Env `GRAPHQL_URL` → `DATA_URL`. Compose service `graphql` → `graph`. **Breaking, no shim.**

### Contract B — the six typed operations (base URL = `data_url`)

| # | Operation | Engine caller |
|---|---|---|
| 1 | `POST /v1/resolve` `{address, zip}` | `orchestrator.preflight` |
| 2 | `GET /v1/address/{id}/records?shapes=&limit=&offset=` | `fetch_address_records`, `fetch_address_records_multi` |
| 3 | `GET /v1/address/{id}/people?limit=&offset=` | `fetch_people_at_address`, preflight |
| 4 | `GET /v1/person/{id}/records?shapes=&limit=` | `fetch_person_records` |
| 5 | `GET /v1/people/search?name=&limit=` | `fetch_search_people` |
| 6 | `GET /v1/source-record/{shape}/{rowid}` | `get_source_record` tool (hatch mode) |

Response bodies exactly as pinned in the umbrella. **Record payloads keep raw vendor column names** (`first_name`, `ownername`, `dob_day`); `SOURCE_DATA_FIELDS` already uses exactly these — do not tidy them. `identity_confidence` and `is_suspicious` are present on every `hal:`-sourced person and must reach the model.

### Contract C — the hatch

`POST /v1/sql {query}` → 200 `{columns, rows, row_count, truncated, plan_cost, duration_ms}` **or** 422 `{refused: true, stage: "parse"|"explain", reason, hint}`. `GET /v1/schema` → `{tables, access_paths, caveats}`.

**A 422 is a result, not an error.** It is the agent's repair signal and must not throw.

---

## Decisions of record

**D0 — what the two retrieval modes mean now.** *(the brief asks for this explicitly)*

| `retrieval_mode` | Tool surface | Meaning |
|---|---|---|
| `"tools"` (**default**, `models.ts:191`) | the 10 typed tools **+** `run_sql` + `describe_schema` + `get_source_record` | **Exploratory.** The hatch is the deliberate replacement for arbitrary GraphQL. |
| `"typed_tools"` | the 10 typed tools only | **Bounded.** No ad-hoc query surface at all. |

`SqlToolset` composes `TypedToolset` — it is the typed surface *plus* the hatch, not an alternative to it. Consequence to state in the `typed_tools` system prompt: in that mode, enumerating an owner's *other* properties (spec §7) is **not answerable at all**, because `property_owner` rows are absent from `entity_links` and the only path is a `last_name`-led scan that is an experiment, not an operation.

**D1 — `include_shortcuts` is retired.** Its only purpose was bolting the shortcut tools onto raw-GraphQL mode. Both modes now carry the same typed tools. Removed from `AgentInvestigationRequestSchema`, `make_toolset`, `MetricsRecorder` metadata, `RunMetricsSummary`, the prompt builders and the CLI flag. It is engine-owned — the backend never sends it (Contract A carries five fields).

**D2 — naming.** Rename everything the engine owns end to end. Verified safe downstream: the backend's `InvestigationResultSchema` types `heuristics` as `z.array(z.unknown())` and `query` as `z.unknown()` under `.passthrough()`, and its read DTO is closed, so no engine-internal field name is load-bearing across the boundary.

| Old | New |
|---|---|
| `src/agents/graphql_tool.ts` | `src/agents/data_client.ts` |
| `GraphQLHttpTool` / `CountingGraphQLTool` / `GraphQLToolError` | `DataHttpClient` / `CountingDataClient` / `DataClientError` |
| `src/agents/toolsets/graphql_toolset.ts` | `src/agents/toolsets/sql_toolset.ts` |
| `GraphQLToolset` | `SqlToolset` |
| `GraphQLQueryLogSchema {query_name, variables, …}` | `DataCallLogSchema {operation, params, result_summary, error}` |
| `HeuristicAgentResult.graphql_queries` | `.data_queries` |
| `HeuristicAgentInput.max_graphql_calls` | `.max_data_calls` |
| request `max_graphql_calls_per_agent` / `graphql_timeout_seconds` | `max_data_calls_per_agent` / `data_timeout_seconds` |
| `Diagnostics.graphql_budget_exhausted` | `.data_budget_exhausted` |
| `"GraphQL query budget exceeded: N"` | `"Data call budget exceeded: N"` |
| `record_graphql_call` / event `graphql_call` | `record_data_call` / event `data_call` |
| summary `graphql_query_count` / `graphql_validation_count` / `graphql_schema_tool_call_count` / `graphql_error_count` | `data_call_count` / `sql_refusal_count` / `data_schema_call_count` / `data_error_count` |

Kept: `ResolvedAddressContext.preflight_queries` and `.schema_guide` (already neutral). The backend's progress translator reads only span phases (`preflight`, `heuristic_workers`, `scoring`) — verified — so the `data_call` event rename cannot break it.

**D3 — the validate/repair loop moves to the 422 channel.** There is no pre-execution validator any more. A `run_sql` refusal pushes `reason` onto `diagnostics.validation_errors` and increments `query_repair_attempts`, preserving the existing repair telemetry contract on the new channel. `CountingDataClient.refusal_logs` replaces `validation_logs`; `subagents.ts:930/934` read it unchanged in shape.

**D4 — preflight is two calls, not one.** `POST /v1/resolve` then `GET /v1/address/{id}/people?limit=10` (skipped when `address_id` is null). Op 1 does not return the clustered people list; op 3 does. This preserves `_people_at_address_summaries`'s `residents → base` entry with **clustered** names rather than raw `base` rows, which is what keeps `_evidence_map` a minimal change as the brief requires. Both are bundle-backed (memory, per spec §3).

**D5 — `schema_guide.ts` is currently dead code and this feature revives it.** `orchestrator.preflight` hardcodes `const schema_guide = "";` (line 409) and nothing in `src/` ever calls `SCHEMA_GUIDE_QUERY` or `summarizeSchemaGuide`. After this change it becomes a pure formatter over the `/v1/schema` payload, fetched once in preflight **only when `retrieval_mode === "tools"`**, so the hatch gets its primer without spending a per-agent schema-tool call and `typed_tools` prompts stay unchanged in that respect.

**D6 — `dropped_counts` and `tax_timed_out` are new signal and must reach the model.** They land in `evidence_map.data_gaps`, a field both prompt profiles already render. Silently discarding "the quality gate refused N rows" would let the model read an absence as a fact.

---

## What the engine can no longer answer (grounding for the prompt task)

Every prompt change in Task 15 traces to a line here. Do not guess beyond it.

**Lost with arbitrary GraphQL (`execute_graphql`):**

1. **The property/owner association graph.** `Address.propertyAssociations`, `Property.people(role: OWNER)`, `PropertyPersonAssociation.provenance` — spec §5 discards `Property`/`Organization`/`Vehicle`/`Contact` and every `*Association` type. "Who owns the property object at this address" is now answerable **only** from the tax row's `ownername` / `ownercompany`.
2. **`Person.addressAssociations`** — "every address linked to this person" as a first-class edge list. Op 4 returns a person's *records*; addresses must be read off row fields (`address`, `zip`). Answerable, indirectly, and only for the seven shapes.
3. **`Person.organizationAssociations` / employer traversal** — gone, and unbounded on this corpus anyway (no index on `employer`).
4. **Filtered address search** — `searchAddresses(query, zip, limit)` with arbitrary `where:` filters. Op 1 takes `{address, zip}` and nothing else.
5. **Role-faceted source records** — `Address.sourceRecords(source: UTILITY, role: SERVICE_ADDRESS)`. Ops 2/4 have no `role` argument. Utility rows still arrive (they are address-linked); the facet does not.
6. **Type-level schema introspection** — `describe_schema("TaxRecordWhereInput")`. Replaced by `GET /v1/schema`: tables, columns, **indexed access paths with measured costs**, and data-quality caveats. The model asks "which predicates are fast", not "which fields does this input type have".
7. **Pre-execution validation** — `validate_graphql` had a dry run. `run_sql` refuses at 422 *after* the parse+EXPLAIN gate, which is strictly more informative (it returns the planner's own reason) but arrives per-attempt, not per-draft.

**Lost with the three dropped shapes** (`source/manifest.py:305` already ships seven shapes — `base, auto, drive, loan, tax, trace, utility`):

8. **`voter`** — no rows exist in the partner corpus. Costs **2 of 25 atomic heuristics** (`voter_address_subject_analysis` with its three paths `owner_voter_at_subject` / `owner_voter_elsewhere` / `nonowner_voter_at_subject`, and `drive_voter_conflict_same_person`). `legal_address_presence` drops from 7 atomics to 5 and now leans on `drive` + `auto`; with `drive` demoted (D7 below) that packet's independent legal-address evidence is effectively `auto` alone. `synthesis._has_clear_absentee_context`'s `legal_pair` branch dies with those paths.
9. **`criminal`, `linkedin`** — referenced by **zero** heuristics (grep-verified across `src/heuristics/`). Dropping them costs nothing analytically; only two tools and two prompt one-liners disappear.

**Still not answerable, and now honestly labelled (spec §7):**

10. **Enumerating an owner's other properties.** `property_owner` rows have `ssn`/`dob`/`house_number` at 0% — no blocking key — so they are absent from `entity_links` entirely. No typed operation reaches them. It is the SQL hatch's first concrete job, and in `typed_tools` mode it is unreachable.

**New, and requiring a prompt instruction:**

11. **SQL rows carry no provenance.** `_harvest_evidence_rows` (`subagents.ts:66`) walks results for `{rowid, source|table}`; `run_sql` returns `{columns, rows: [[…]]}` — arrays, not records — so **nothing from a SQL result becomes an evidence ref automatically**. The model must call `get_source_record(shape, rowid)` (op 6) to turn a SQL hit into a citable row. This is exactly why op 6 gets a tool.

---

## File structure

**Create**
- `src/agents/data_client.ts` — `DataHttpClient` + `CountingDataClient`
- `src/agents/toolsets/sql_toolset.ts` — `SqlToolset`
- `test/support/fixture_data_service.ts` — in-process Contract-B/C fixture server
- `test/support/score_cases.ts` — the fixed deterministic case set
- `test/data_client.test.ts`, `test/sql_toolset.test.ts`, `test/score_benchmark.test.ts`, `test/schema_guide.test.ts`

**Delete**
- `src/agents/graphql_tool.ts`, `src/agents/toolsets/graphql_toolset.ts`
- `test/support/fixture_graphql.ts`, `scripts/capture_preflight_fixture.ts`
- `test/support/fixtures/preflight_1104.json` → replaced by `resolve_1104.json`

**Modify** — `src/agents/{models,retrieval,typed_tools,orchestrator,schema_guide,prompts,subagents}.ts`, `src/agents/toolsets/{base,typed_toolset,index}.ts`, `src/heuristics/{policy,atomic,atomic_eval,packets,packet_gates,synthesis}.ts`, `src/observability/{models,recorder}.ts`, `src/server/investigate_server.ts`, `cli/{run_address,serve}.ts`, `compose.yaml`, `README.md`, `AGENTS.md`, `init.sh`, `package.json`, `feature_list.json`, `PROGRESS.md`, and the 12 test files listed per task.

---

## Contract B addenda — pinned by the umbrella after per-repo planning

The graph-service plan extended Contract B while this plan was being drafted. These three fields are
**additive** — every pinned key keeps its name and meaning. This plan's tasks must honour them.

1. **`GET /v1/source-record/{shape}/{rowid}` takes a required `?address_id=<id>` query param.**
   `rowid` is the row's index within its shape *in a specific bundle*, so it is meaningless without
   the address that scopes it. Any engine call to operation 6 must pass it — the `data_client`
   method signature and every call site need the address id threaded through.

2. **Bundle-sourced records carry a `__rowid` field.** A `run_sql` result has no provenance, and the
   engine's evidence references require a citable row. `__rowid` is what turns a record the model is
   looking at into a `get_source_record` call it can cite. The SQL toolset's guidance and the
   evidence-reference plumbing both depend on it.

3. **`GET /v1/person/{id}/records` returns `records_timed_out: bool`.** The `hal:` traversal fetches
   rows by `(source_table, record_id)`, and no index covers `record_id` — it is the one unindexed hop
   in the typed surface. It runs under the statement timeout, so an empty result must be
   distinguishable from a timed-out one, exactly as `tax_timed_out` already is on the address path.
   The engine must surface this rather than silently reading a timeout as "this person has no
   records elsewhere" — that failure mode would quietly break owner-elsewhere detection, which is
   the strongest signal this whole corpus supports.

---

## Task 1: Branch + record the baseline

**Files:** none (ops).

- [ ] **Step 1: Confirm the base branch from config, never hardcoded**

Run: `cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace && ./scripts/repo-branch.sh engine`
Expected: `main`

- [ ] **Step 2: Cut the branch**

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts
git fetch origin
git checkout main && git pull --ff-only
git checkout -b feat/typed-data-service
```
Expected: `Switched to a new branch 'feat/typed-data-service'`

- [ ] **Step 3: Record the pre-change gate output**

Run: `OE_PROSE_REGISTER=off bun run verify`
Expected: exit 0; `195 pass, 0 fail, 765 expect() across 29 files`; biome `Found 3 warnings`.

- [ ] **Step 4: Flip `feature_list.json` to `in_progress`**

Append one entry (and confirm no other entry is `in_progress` — `test/feature_list.test.ts` enforces at most one):

```json
{
  "id": "typed-data-service",
  "priority": 12,
  "area": "agents",
  "title": "Typed data service client + SQL hatch (X-016)",
  "user_visible_behavior": "The engine reaches the graph service over six typed HTTP operations plus a guarded SQL hatch instead of GraphQL. POST /investigate takes data_url (was graphql_url). voter/criminal/linkedin shapes are gone; drive is re-weighted from 1.15 to 0.75 because a drive row is a payday-loan row already counted as loan.",
  "status": "in_progress",
  "verification": "OE_PROSE_REGISTER=off bun run verify; OE_PROSE_REGISTER=off bun run e2e; test/data_client.test.ts; test/sql_toolset.test.ts; test/score_benchmark.test.ts; grep -r 'graphql' src/ returns nothing.",
  "evidence": "",
  "notes": "Plan: docs/superpowers/plans/2026-07-29-typed-data-service.md. Contracts pinned by the workspace umbrella."
}
```

- [ ] **Step 5: Commit**

```bash
git add feature_list.json
git commit -m "chore: open X-016 typed data service in feature_list"
```

---

## Task 2: `DataCallLogSchema` + request/result schema renames

**Files:**
- Modify: `src/agents/models.ts:49-57` (log schema), `:141` (`preflight_queries`), `:174` (`graphql_url`), `:181-182`, `:192`, `:208`, `:232`
- Test: `test/models.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the body of `test/models.test.ts`'s request test and append:

```ts
import { describe, expect, test } from "bun:test";
import {
  AgentInvestigationRequestSchema,
  DataCallLogSchema,
  HeuristicAgentResultSchema,
} from "../src/agents/models.ts";

describe("X-016 request contract", () => {
  test("accepts data_url and applies the new defaults", () => {
    const req = AgentInvestigationRequestSchema.parse({
      address: "1104 SPRING RUN RD",
      data_url: "http://graph:8000",
    });
    expect(req.data_url).toBe("http://graph:8000");
    expect(req.max_data_calls_per_agent).toBe(8);
    expect(req.data_timeout_seconds).toBe(30.0);
    expect(req.retrieval_mode).toBe("tools");
  });

  test("rejects the retired graphql_url and include_shortcuts keys (schema is strict)", () => {
    expect(
      AgentInvestigationRequestSchema.safeParse({ address: "a", graphql_url: "http://g" }).success,
    ).toBe(false);
    expect(
      AgentInvestigationRequestSchema.safeParse({
        address: "a",
        data_url: "http://g",
        include_shortcuts: true,
      }).success,
    ).toBe(false);
  });
});

describe("DataCallLogSchema", () => {
  test("carries operation/params and defaults the rest", () => {
    const log = DataCallLogSchema.parse({ operation: "resolve", params: { zip: "40514" } });
    expect(log.operation).toBe("resolve");
    expect(log.params).toEqual({ zip: "40514" });
    expect(log.result_summary).toBe("");
    expect(log.error).toBeNull();
  });
});

describe("HeuristicAgentResult", () => {
  test("exposes data_queries, not graphql_queries", () => {
    const r = HeuristicAgentResultSchema.parse({
      heuristic_id: "h",
      status: "not_triggered",
      direction: "risk",
      score: 0,
      confidence: "low",
      finding: "f",
      missing_evidence: ["none"],
      data_queries: [{ operation: "address_records", params: { shapes: ["tax"] } }],
    });
    expect(r.data_queries.length).toBe(1);
    expect((r as Record<string, unknown>)["graphql_queries"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/models.test.ts`
Expected: FAIL — `Export named 'DataCallLogSchema' not found in module '.../models.ts'`

- [ ] **Step 3: Apply the schema changes**

In `src/agents/models.ts`, replace lines 49–57:

```ts
export const DataCallLogSchema = z
  .object({
    operation: z.string(),
    params: jsonRecord.default({}),
    result_summary: z.string().default(""),
    error: z.string().nullish().default(null),
  })
  .strict();
export type DataCallLog = z.infer<typeof DataCallLogSchema>;
```

Line 141 → `preflight_queries: z.array(DataCallLogSchema).default([]),`
Line 174 → `data_url: z.string(),`
Line 181 → `max_data_calls_per_agent: z.number().int().min(1).default(8),`
Line 182 → `data_timeout_seconds: z.number().gt(0).default(30.0),`
Line 192 → **delete** `include_shortcuts: z.boolean().default(false),`
Line 208 → `max_data_calls: z.number().int(),`
Line 232 → `data_queries: z.array(DataCallLogSchema).default([]),`

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/models.test.ts`
Expected: PASS (typecheck across the repo is still red — later tasks close it)

- [ ] **Step 5: Commit**

```bash
git add src/agents/models.ts test/models.test.ts
git commit -m "feat(models): data_url + DataCallLog; retire graphql_url and include_shortcuts"
```

---

## Task 3: The Contract-B/C fixture server

**Files:**
- Create: `test/support/fixture_data_service.ts`
- Test: `test/support/support.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the `FixtureGraphQLServer` describe block in `test/support/support.test.ts` with:

```ts
import { FixtureDataService } from "./fixture_data_service.ts";

describe("FixtureDataService", () => {
  test("serves POST /v1/resolve and records the request", async () => {
    const s = new FixtureDataService({
      resolve: { address_id: 7, candidates: [], source_counts: { tax: 1 }, dropped_counts: {}, tax_timed_out: false, records_by_source: {} },
    });
    try {
      const r = await fetch(`${s.url}/v1/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: "1104 SPRING RUN RD", zip: "40514" }),
      });
      expect(await r.json()).toMatchObject({ address_id: 7 });
      expect(s.requests).toEqual([{ method: "POST", path: "/v1/resolve", body: { address: "1104 SPRING RUN RD", zip: "40514" } }]);
    } finally {
      s.close();
    }
  });

  test("serves a 422 SQL refusal with the pinned refusal body", async () => {
    const s = new FixtureDataService({
      sql: { refused: true, stage: "explain", reason: "Seq Scan on records_legacy (cost=0.00..184000000.00)", hint: "Indexed paths: zip; ssn; phone; email." },
    });
    try {
      const r = await fetch(`${s.url}/v1/sql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "SELECT * FROM records_legacy" }),
      });
      expect(r.status).toBe(422);
      expect((await r.json()) as Record<string, unknown>).toMatchObject({ refused: true, stage: "explain" });
    } finally {
      s.close();
    }
  });

  test("404s an unknown path", async () => {
    const s = new FixtureDataService({});
    try {
      expect((await fetch(`${s.url}/graphql`, { method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      s.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/support/support.test.ts`
Expected: FAIL — `Cannot find module './fixture_data_service.ts'`

- [ ] **Step 3: Create the fixture server**

`test/support/fixture_data_service.ts`:

```ts
// In-process fixture for the typed data service (real HTTP via Bun.serve). Implements exactly the
// pinned Contract B/C routes so the real DataHttpClient(base_url) drives it unchanged. Any route the
// plan did not pin 404s — that is the point: a fixture that answers everything cannot catch a client
// that calls something the service does not offer.

export interface FixtureDataPlan {
  resolve?: Record<string, unknown>;
  address_records?: Record<string, unknown>;
  address_people?: Record<string, unknown>;
  person_records?: Record<string, unknown>;
  people_search?: Record<string, unknown>;
  source_record?: Record<string, unknown>;
  sql?: Record<string, unknown>; // a body with refused:true is served as 422
  schema?: Record<string, unknown>;
  status?: number; // force this status on every matched route (for error-path tests)
  delay_ms?: number; // hold the response open (for timeout tests)
}

export interface FixtureRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export class FixtureDataService {
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;
  readonly requests: FixtureRequest[] = [];

  constructor(plan: FixtureDataPlan) {
    const requests = this.requests;
    this.server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const query = Object.fromEntries(url.searchParams.entries());
        const entry: FixtureRequest = { method: req.method, path };
        if (Object.keys(query).length > 0) entry.query = query;
        if (req.method === "POST") {
          try {
            entry.body = await req.json();
          } catch {
            entry.body = null;
          }
        }
        requests.push(entry);
        if (plan.delay_ms) await Bun.sleep(plan.delay_ms);

        const send = (body: Record<string, unknown> | undefined, fallback = 200): Response => {
          if (body === undefined) {
            return Response.json({ error: "no fixture for this route" }, { status: 404 });
          }
          const status = plan.status ?? (body["refused"] === true ? 422 : fallback);
          return Response.json(body, { status });
        };

        if (req.method === "POST" && path === "/v1/resolve") return send(plan.resolve);
        if (req.method === "POST" && path === "/v1/sql") return send(plan.sql);
        if (req.method === "GET" && path === "/v1/schema") return send(plan.schema);
        if (req.method === "GET" && path === "/v1/people/search") return send(plan.people_search);
        if (req.method === "GET" && /^\/v1\/address\/\d+\/records$/.test(path)) return send(plan.address_records);
        if (req.method === "GET" && /^\/v1\/address\/\d+\/people$/.test(path)) return send(plan.address_people);
        if (req.method === "GET" && /^\/v1\/person\/.+\/records$/.test(path)) return send(plan.person_records);
        if (req.method === "GET" && /^\/v1\/source-record\/[^/]+\/\d+$/.test(path)) return send(plan.source_record);
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  close(): void {
    this.server.stop(true);
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/support/support.test.ts`
Expected: PASS (the `fixtures` describe block still passes — it is untouched until Task 12)

- [ ] **Step 5: Commit**

```bash
git add test/support/fixture_data_service.ts test/support/support.test.ts
git commit -m "test(support): Contract B/C fixture data service"
```

---

## Task 4: `DataHttpClient` — the six typed operations

**Files:**
- Create: `src/agents/data_client.ts`
- Test: `test/data_client.test.ts`

- [ ] **Step 1: Write the failing test**

`test/data_client.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DataClientError, DataHttpClient } from "../src/agents/data_client.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";

describe("DataHttpClient — the six typed operations", () => {
  test("resolve posts {address, zip} to /v1/resolve", async () => {
    const s = new FixtureDataService({
      resolve: { candidates: [], address_id: 1, source_counts: { tax: 1 }, dropped_counts: { tax: 0 }, tax_timed_out: false, records_by_source: {} },
    });
    try {
      const out = await new DataHttpClient(s.url).resolve("1104 SPRING RUN RD", "40514");
      expect(out.address_id).toBe(1);
      expect(out.source_counts).toEqual({ tax: 1 });
      expect(s.requests[0]).toEqual({ method: "POST", path: "/v1/resolve", body: { address: "1104 SPRING RUN RD", zip: "40514" } });
    } finally {
      s.close();
    }
  });

  test("address_records builds the shapes/limit/offset query string", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: {}, unsupported_shapes: [] } });
    try {
      await new DataHttpClient(s.url).address_records(3342, { shapes: ["tax", "base"], limit: 25, offset: 10 });
      expect(s.requests[0]!.path).toBe("/v1/address/3342/records");
      expect(s.requests[0]!.query).toEqual({ shapes: "tax,base", limit: "25", offset: "10" });
    } finally {
      s.close();
    }
  });

  test("person_records url-encodes a hal: person id", async () => {
    const s = new FixtureDataService({ person_records: { person: { id: "hal:HAL0001" }, records_by_source: {}, unsupported_shapes: [] } });
    try {
      const out = await new DataHttpClient(s.url).person_records("hal:HAL0001", { shapes: ["tax"], limit: 20 });
      expect(out.person.id).toBe("hal:HAL0001");
      expect(s.requests[0]!.path).toBe("/v1/person/hal%3AHAL0001/records");
    } finally {
      s.close();
    }
  });

  test("search_people, address_people and source_record hit their pinned paths", async () => {
    const s = new FixtureDataService({
      people_search: { total_count: 0, has_more: false, results: [] },
      address_people: { total_count: 0, has_more: false, people: [] },
      source_record: { source: "tax", table: "tax", rowid: 0, record_id: "4001", summary: "tax; ownername=DOE", data: {} },
    });
    try {
      const c = new DataHttpClient(s.url);
      await c.search_people("Jane Doe", { limit: 10 });
      await c.address_people(3342, { limit: 25, offset: 0 });
      const rec = await c.source_record("tax", 0);
      expect(rec.record_id).toBe("4001");
      expect(s.requests.map((r) => r.path)).toEqual(["/v1/people/search", "/v1/address/3342/people", "/v1/source-record/tax/0"]);
      expect(s.requests[0]!.query).toEqual({ name: "Jane Doe", limit: "10" });
    } finally {
      s.close();
    }
  });

  test("a base_url with a trailing slash does not produce a double slash", async () => {
    const s = new FixtureDataService({ schema: { tables: [], access_paths: [], caveats: [] } });
    try {
      await new DataHttpClient(`${s.url}/`).schema();
      expect(s.requests[0]!.path).toBe("/v1/schema");
    } finally {
      s.close();
    }
  });

  test("a non-2xx status raises DataClientError naming the operation and status", async () => {
    const s = new FixtureDataService({ resolve: {}, status: 500 });
    try {
      await expect(new DataHttpClient(s.url).resolve("a", "")).rejects.toThrow(/resolve failed: HTTP 500/);
    } finally {
      s.close();
    }
  });

  test("an oversize response is refused before parsing", async () => {
    const s = new FixtureDataService({ resolve: { candidates: [], address_id: 1, source_counts: {}, dropped_counts: {}, tax_timed_out: false, records_by_source: { pad: "x".repeat(5000) } } });
    try {
      await expect(
        new DataHttpClient(s.url, { max_response_bytes: 1000 }).resolve("a", ""),
      ).rejects.toThrow(/exceeded 1000 bytes/);
    } finally {
      s.close();
    }
  });
});

describe("DataHttpClient — the SQL hatch", () => {
  test("a 200 returns the result rows", async () => {
    const s = new FixtureDataService({ sql: { columns: ["record_id"], rows: [[4001]], row_count: 1, truncated: false, plan_cost: 8.14, duration_ms: 173 } });
    try {
      const out = await new DataHttpClient(s.url).run_sql("SELECT record_id FROM tax LIMIT 1");
      expect("refused" in out).toBe(false);
      expect(out).toMatchObject({ row_count: 1, plan_cost: 8.14 });
      expect(s.requests[0]).toEqual({ method: "POST", path: "/v1/sql", body: { query: "SELECT record_id FROM tax LIMIT 1" } });
    } finally {
      s.close();
    }
  });

  test("a 422 refusal is RETURNED, not thrown — it is the agent's repair signal", async () => {
    const s = new FixtureDataService({ sql: { refused: true, stage: "explain", reason: "Seq Scan on records_legacy", hint: "Indexed paths: zip; ssn; phone; email." } });
    try {
      const out = await new DataHttpClient(s.url).run_sql("SELECT * FROM records_legacy");
      expect(out).toEqual({ refused: true, stage: "explain", reason: "Seq Scan on records_legacy", hint: "Indexed paths: zip; ssn; phone; email." });
    } finally {
      s.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/data_client.test.ts`
Expected: FAIL — `Cannot find module '../src/agents/data_client.ts'`

- [ ] **Step 3: Create `src/agents/data_client.ts` (client half)**

```ts
// The agent's data-access layer: a typed HTTP client for the occupancy data service — the six typed
// operations of Contract B, the guarded SQL hatch and the curated schema of Contract C — plus the
// per-agent call-budget accounting the subagent loop depends on (CountingDataClient, below).
//
// A 422 from /v1/sql is a RESULT, not an error: it carries the planner's own reason and is what the
// agent repairs against. Every other non-2xx is a DataClientError.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { currentRecorder } from "../observability/index.ts";
import { DataCallLogSchema, type DataCallLog } from "./models.ts";
import type { QueryCache } from "./query_cache.ts";

/** Raised when a data-service call fails or violates a tool guardrail. */
export class DataClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataClientError";
  }
}

/** The seven shapes the partner corpus actually has (source/manifest.py SHAPES). */
export const SHAPES: readonly string[] = ["base", "tax", "utility", "trace", "auto", "loan", "drive"];

export interface SourceRow {
  table?: string | null;
  rowid?: number | null;
  record_id?: string | null;
  summary?: string;
  data: Record<string, unknown>;
}

export interface RecordBlock {
  total_count: number;
  has_more: boolean;
  records: SourceRow[];
}

export interface ResolveCandidate {
  address_id: number;
  match_score: number;
  matched_fields: string[];
  relation_count: number;
  norm_address: string;
  zip5: string;
  street_number: string | null;
  street_name: string | null;
  unit: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
}

export interface ResolveResponse {
  candidates: ResolveCandidate[];
  address_id: number | null;
  source_counts: Record<string, number>;
  dropped_counts: Record<string, number>;
  tax_timed_out: boolean;
  records_by_source: Record<string, RecordBlock>;
}

export interface PersonSummary {
  id: string;
  firstname?: string | null;
  middlename?: string | null;
  lastname?: string | null;
  full_name?: string | null;
  norm_name_key?: string | null;
  sources?: string[];
  primary_address_id?: number | null;
  // Present on every hal:-sourced person. The partner ER graph is 17.9% suspicious and peaks at
  // confidence 40.50, so the model must be able to discount it.
  identity_confidence?: number | null;
  is_suspicious?: boolean | null;
}

export interface AddressRecordsResponse {
  records_by_source: Record<string, RecordBlock>;
  unsupported_shapes: string[];
}

export interface AddressPeopleResponse {
  total_count: number;
  has_more: boolean;
  people: PersonSummary[];
}

export interface PersonRecordsResponse {
  person: PersonSummary;
  records_by_source: Record<string, RecordBlock>;
  unsupported_shapes: string[];
}

export interface PeopleSearchHit extends PersonSummary {
  match_score: number;
  record_count: number;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface PeopleSearchResponse {
  total_count: number;
  has_more: boolean;
  results: PeopleSearchHit[];
}

export interface SourceRecordResponse {
  source: string;
  table: string;
  rowid: number;
  record_id: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  plan_cost: number;
  duration_ms: number;
}

export interface SqlRefusal {
  refused: true;
  stage: "parse" | "explain";
  reason: string;
  hint: string;
}

export type SqlResponse = SqlResult | SqlRefusal;

export function isSqlRefusal(value: SqlResponse): value is SqlRefusal {
  return (value as SqlRefusal).refused === true;
}

export interface DataSchemaTable {
  name: string;
  purpose: string;
  key_columns: string[];
}

export interface DataSchemaAccessPath {
  predicate: string;
  index: string;
  measured_cost: string;
}

export interface DataSchema {
  tables: DataSchemaTable[];
  access_paths: DataSchemaAccessPath[];
  caveats: string[];
}

// See "Contract B addenda" above — operation 6 takes address_id; person records carry
// records_timed_out; bundle records carry __rowid.
export class DataHttpClient {
  readonly base_url: string;
  timeout_seconds: number;
  max_response_bytes: number;

  constructor(base_url: string, opts: { timeout_seconds?: number; max_response_bytes?: number } = {}) {
    this.base_url = String(base_url ?? "").replace(/\/+$/, "");
    this.timeout_seconds = opts.timeout_seconds ?? 30.0;
    this.max_response_bytes = opts.max_response_bytes ?? 1_000_000;
  }

  async resolve(address: string, zip: string): Promise<ResolveResponse> {
    return (await this._json("resolve", "POST", "/v1/resolve", { body: { address, zip: zip ?? "" } })) as ResolveResponse;
  }

  async address_records(
    address_id: number,
    opts: { shapes?: string[]; limit?: number; offset?: number } = {},
  ): Promise<AddressRecordsResponse> {
    const query: Record<string, string> = {};
    if (opts.shapes && opts.shapes.length > 0) query["shapes"] = opts.shapes.join(",");
    if (opts.limit !== undefined) query["limit"] = String(opts.limit);
    if (opts.offset !== undefined) query["offset"] = String(opts.offset);
    return (await this._json("address_records", "GET", `/v1/address/${address_id}/records`, { query })) as AddressRecordsResponse;
  }

  async address_people(
    address_id: number,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<AddressPeopleResponse> {
    const query: Record<string, string> = {};
    if (opts.limit !== undefined) query["limit"] = String(opts.limit);
    if (opts.offset !== undefined) query["offset"] = String(opts.offset);
    return (await this._json("address_people", "GET", `/v1/address/${address_id}/people`, { query })) as AddressPeopleResponse;
  }

  async person_records(
    person_id: string,
    opts: { shapes?: string[]; limit?: number } = {},
  ): Promise<PersonRecordsResponse> {
    const query: Record<string, string> = {};
    if (opts.shapes && opts.shapes.length > 0) query["shapes"] = opts.shapes.join(",");
    if (opts.limit !== undefined) query["limit"] = String(opts.limit);
    // Person ids are discriminated and contain ':' — addr:<addressId>:<n> or hal:<hal_id>.
    const path = `/v1/person/${encodeURIComponent(person_id)}/records`;
    return (await this._json("person_records", "GET", path, { query })) as PersonRecordsResponse;
  }

  async search_people(name: string, opts: { limit?: number } = {}): Promise<PeopleSearchResponse> {
    const query: Record<string, string> = { name };
    if (opts.limit !== undefined) query["limit"] = String(opts.limit);
    return (await this._json("search_people", "GET", "/v1/people/search", { query })) as PeopleSearchResponse;
  }

  async source_record(shape: string, rowid: number): Promise<SourceRecordResponse> {
    const path = `/v1/source-record/${encodeURIComponent(shape)}/${rowid}`;
    return (await this._json("source_record", "GET", path, {})) as SourceRecordResponse;
  }

  /** 200 => rows; 422 => the structured refusal, RETURNED not thrown. */
  async run_sql(query: string): Promise<SqlResponse> {
    return (await this._json("run_sql", "POST", "/v1/sql", {
      body: { query },
      accept_statuses: [422],
    })) as SqlResponse;
  }

  async schema(): Promise<DataSchema> {
    return (await this._json("schema", "GET", "/v1/schema", {})) as DataSchema;
  }

  private async _json(
    operation: string,
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; accept_statuses?: number[] },
  ): Promise<unknown> {
    const search = new URLSearchParams(opts.query ?? {}).toString();
    const url = `${this.base_url}${path}${search ? `?${search}` : ""}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}),
        signal: AbortSignal.timeout(this.timeout_seconds * 1000),
      });
    } catch (exc) {
      throw new DataClientError(`${operation} failed: ${errStr(exc)}`);
    }
    const accepted = response.ok || (opts.accept_statuses ?? []).includes(response.status);
    if (!accepted) {
      // fetch does not throw on non-2xx, so surface it before reading the body.
      throw new DataClientError(`${operation} failed: HTTP ${response.status} ${response.statusText}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (exc) {
      throw new DataClientError(`${operation} failed: ${errStr(exc)}`);
    }
    if (Buffer.byteLength(text, "utf8") > this.max_response_bytes) {
      throw new DataClientError(`${operation} response exceeded ${this.max_response_bytes} bytes.`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new DataClientError(`${operation} response was not valid JSON.`);
    }
    if (!isRecord(payload)) {
      throw new DataClientError(`${operation} response was not an object.`);
    }
    return payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Message text of an error value (no "Error: " prefix). */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/data_client.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/agents/data_client.ts test/data_client.test.ts
git commit -m "feat(data_client): typed HTTP client for the six operations + SQL hatch"
```

---

## Task 5: `CountingDataClient` — the call-budget accounting

This is the load-bearing half. `CountingGraphQLTool` provides five things the pipeline depends on and every one must survive: (a) `max_calls`/`calls` with a budget-exceeded throw whose message the toolset string-matches; (b) `logs`, read by `error_result()` and merged into the result; (c) a separate `schema_tool_calls` counter against `schema_tool_budget`; (d) `QueryCache` single-flight; (e) a `record_data_call` telemetry event per call.

**Files:**
- Modify: `src/agents/data_client.ts` (append), `src/observability/{models,recorder}.ts`
- Test: `test/data_client.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/data_client.test.ts`:

```ts
import { CountingDataClient, isSqlRefusal } from "../src/agents/data_client.ts";
import { QueryCache } from "../src/agents/query_cache.ts";

function counted(s: FixtureDataService, max_calls: number, cache: QueryCache | null = null) {
  return new CountingDataClient(new DataHttpClient(s.url), { max_calls, agent_id: "w1", heuristic_id: "h1", cache });
}

describe("CountingDataClient — budget accounting", () => {
  test("counts every typed call and throws the pinned budget message on overrun", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: {}, unsupported_shapes: [] } });
    try {
      const c = counted(s, 2);
      await c.address_records(1, { shapes: ["tax"] });
      await c.address_records(1, { shapes: ["base"] });
      expect(c.calls).toBe(2);
      await expect(c.address_records(1, { shapes: ["loan"] })).rejects.toThrow("Data call budget exceeded: 2");
      // The refused call is NOT counted and NOT sent.
      expect(c.calls).toBe(2);
      expect(s.requests.length).toBe(2);
    } finally {
      s.close();
    }
  });

  test("logs one DataCallLog per call, with the operation and a result summary", async () => {
    const s = new FixtureDataService({ resolve: { candidates: [], address_id: 9, source_counts: { tax: 1 }, dropped_counts: {}, tax_timed_out: false, records_by_source: {} } });
    try {
      const c = counted(s, 4);
      await c.resolve("1104 SPRING RUN RD", "40514");
      expect(c.logs.length).toBe(1);
      expect(c.logs[0]!.operation).toBe("resolve");
      expect(c.logs[0]!.params).toEqual({ address: "1104 SPRING RUN RD", zip: "40514" });
      expect(c.logs[0]!.error).toBeNull();
    } finally {
      s.close();
    }
  });

  test("a failed call is logged with its error and still consumes budget", async () => {
    const s = new FixtureDataService({ resolve: {}, status: 500 });
    try {
      const c = counted(s, 4);
      await expect(c.resolve("a", "")).rejects.toThrow(/HTTP 500/);
      expect(c.calls).toBe(1);
      expect(c.logs[0]!.error).toMatch(/HTTP 500/);
    } finally {
      s.close();
    }
  });

  test("schema() spends the SEPARATE schema budget, never the data budget", async () => {
    const s = new FixtureDataService({ schema: { tables: [], access_paths: [], caveats: [] } });
    try {
      const c = counted(s, 1);
      await c.schema({ max_calls: 1 });
      expect(c.schema_tool_calls).toBe(1);
      expect(c.calls).toBe(0);
      await expect(c.schema({ max_calls: 1 })).rejects.toThrow("Schema description tool budget exceeded: 1");
    } finally {
      s.close();
    }
  });

  test("a SQL refusal is recorded on refusal_logs, counts against the budget, and does not throw", async () => {
    const s = new FixtureDataService({ sql: { refused: true, stage: "parse", reason: "only one SELECT is allowed", hint: "Remove the ';'." } });
    try {
      const c = counted(s, 4);
      const out = await c.run_sql("SELECT 1; DROP TABLE tax");
      expect(isSqlRefusal(out)).toBe(true);
      expect(c.refusal_logs.length).toBe(1);
      expect(c.refusal_logs[0]!.stage).toBe("parse");
      expect(c.calls).toBe(1);
    } finally {
      s.close();
    }
  });

  test("the shared QueryCache coalesces identical calls and spends budget only once per execution", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: {}, unsupported_shapes: [] } });
    try {
      const cache = new QueryCache();
      const c = counted(s, 4, cache);
      await c.address_records(1, { shapes: ["tax"], limit: 25 });
      await c.address_records(1, { shapes: ["tax"], limit: 25 });
      expect(cache.executed).toBe(1);
      expect(cache.hits).toBe(1);
      expect(s.requests.length).toBe(1);
    } finally {
      s.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/data_client.test.ts`
Expected: FAIL — `Export named 'CountingDataClient' not found`

- [ ] **Step 3: Rename the telemetry surface, then append the counter**

In `src/observability/models.ts`: line 10 `| "graphql_call"` → `| "data_call"`; lines 156–159 → `data_call_count`, `sql_refusal_count`, `data_schema_call_count`, `data_error_count`; lines 189–192 likewise; and delete `include_shortcuts` from `RunMetricsSummary` + `makeRunMetricsSummary` (D1).

In `src/observability/recorder.ts` replace `record_graphql_call` (line 235) with:

```ts
  record_data_call(opts: RecordDataCallOptions): void {
    this.record_event("data_call", {
      phase: `data_${opts.call_type}`,
      name: opts.operation_name,
      agent_id: opts.agent_id ?? "data",
      heuristic_id: opts.heuristic_id ?? "",
      latency_ms: opts.latency_ms ?? null,
      status: opts.status ?? "ok",
      error_message: opts.error ?? "",
      metadata: opts.metadata ?? {},
    });
  }
```

Rename `RecordGraphqlCallOptions` → `RecordDataCallOptions` with `call_type: "op" | "sql" | "schema"`; update the no-op recorder at line 401; and in the summary rollup (lines 354–363) map `data_op` → `data_call_count`, `data_sql` → `data_call_count`, `data_schema` → `data_schema_call_count`, `status === "refused"` → `sql_refusal_count`, `status === "error"` → `data_error_count`.

Append to `src/agents/data_client.ts`:

```ts
/**
 * Per-agent budget accounting over DataHttpClient. Preserves, exactly, what CountingGraphQLTool
 * provided: a hard `max_calls` ceiling with a string-matched error, a `logs` array that
 * error_result() reads, a SEPARATE schema-tool counter, QueryCache single-flight, and one telemetry
 * event per call. This is cost control, not bookkeeping — do not simplify it away.
 */
export class CountingDataClient {
  client: DataHttpClient;
  max_calls: number;
  agent_id: string;
  heuristic_id: string;
  logs: DataCallLog[] = [];
  refusal_logs: SqlRefusal[] = [];
  schema_tool_calls = 0;
  calls = 0;
  cache: QueryCache | null;

  constructor(
    client: DataHttpClient,
    opts: { max_calls: number; agent_id?: string; heuristic_id?: string; cache?: QueryCache | null },
  ) {
    this.client = client;
    this.max_calls = opts.max_calls;
    this.agent_id = opts.agent_id ?? "data";
    this.heuristic_id = opts.heuristic_id ?? "";
    this.cache = opts.cache ?? null;
  }

  resolve(address: string, zip: string): Promise<ResolveResponse> {
    return this._budgeted("resolve", { address, zip: zip ?? "" }, () => this.client.resolve(address, zip));
  }

  address_records(address_id: number, opts: { shapes?: string[]; limit?: number; offset?: number } = {}) {
    return this._budgeted<AddressRecordsResponse>(
      "address_records",
      { address_id, ...opts },
      () => this.client.address_records(address_id, opts),
    );
  }

  address_people(address_id: number, opts: { limit?: number; offset?: number } = {}) {
    return this._budgeted<AddressPeopleResponse>(
      "address_people",
      { address_id, ...opts },
      () => this.client.address_people(address_id, opts),
    );
  }

  person_records(person_id: string, opts: { shapes?: string[]; limit?: number } = {}) {
    return this._budgeted<PersonRecordsResponse>(
      "person_records",
      { person_id, ...opts },
      () => this.client.person_records(person_id, opts),
    );
  }

  search_people(name: string, opts: { limit?: number } = {}) {
    return this._budgeted<PeopleSearchResponse>("search_people", { name, ...opts }, () =>
      this.client.search_people(name, opts),
    );
  }

  source_record(shape: string, rowid: number) {
    return this._budgeted<SourceRecordResponse>("source_record", { shape, rowid }, () =>
      this.client.source_record(shape, rowid),
    );
  }

  async run_sql(query: string): Promise<SqlResponse> {
    const result = await this._budgeted<SqlResponse>(
      "run_sql",
      { query_sha256: sha256(query), query_chars: Array.from(query).length },
      () => this.client.run_sql(query),
      (value) => (isSqlRefusal(value) ? `refused at ${value.stage}: ${value.reason}` : `${value.row_count} rows`),
    );
    if (isSqlRefusal(result)) {
      this.refusal_logs.push(result);
    }
    return result;
  }

  /** The curated schema. Spends `schema_tool_budget`, never the data-call budget. */
  async schema(opts: { max_calls?: number | null } = {}): Promise<DataSchema> {
    const max_calls = opts.max_calls ?? null;
    const recorder = currentRecorder();
    const start = performance.now();
    if (max_calls !== null && this.schema_tool_calls >= max_calls) {
      recorder.record_data_call({
        call_type: "schema",
        operation_name: "schema",
        latency_ms: elapsedMs(start),
        status: "error",
        error: `Schema description tool budget exceeded: ${max_calls}`,
        metadata: { max_calls, schema_tool_calls: this.schema_tool_calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw new DataClientError(`Schema description tool budget exceeded: ${max_calls}`);
    }
    this.schema_tool_calls += 1;
    try {
      const data = await this.client.schema();
      recorder.record_data_call({
        call_type: "schema",
        operation_name: "schema",
        latency_ms: elapsedMs(start),
        metadata: {
          schema_tool_calls: this.schema_tool_calls,
          response_bytes: Buffer.byteLength(JSON.stringify(data), "utf8"),
        },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      return data;
    } catch (exc) {
      if (!(exc instanceof DataClientError)) throw exc;
      recorder.record_data_call({
        call_type: "schema",
        operation_name: "schema",
        latency_ms: elapsedMs(start),
        status: "error",
        error: errStr(exc),
        metadata: { schema_tool_calls: this.schema_tool_calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw exc;
    }
  }

  private async _budgeted<T>(
    operation: string,
    params: Record<string, unknown>,
    run: () => Promise<T>,
    summarize: (value: T) => string = (value) => summarizeResponse(value),
  ): Promise<T> {
    const recorder = currentRecorder();
    const start = performance.now();
    const call_type = operation === "run_sql" ? "sql" : "op";
    if (this.calls >= this.max_calls) {
      recorder.record_data_call({
        call_type,
        operation_name: operation,
        latency_ms: elapsedMs(start),
        status: "error",
        error: `Data call budget exceeded: ${this.max_calls}`,
        metadata: { ...params, max_calls: this.max_calls, calls: this.calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw new DataClientError(`Data call budget exceeded: ${this.max_calls}`);
    }
    this.calls += 1;
    let value: T;
    try {
      value =
        this.cache !== null
          ? ((await this.cache.get_or_execute(operation, params, run)) as T)
          : await run();
    } catch (exc) {
      if (!(exc instanceof DataClientError)) throw exc;
      this.logs.push(
        DataCallLogSchema.parse({
          operation,
          params,
          result_summary: `${operation} failed: ${errStr(exc)}`,
          error: errStr(exc),
        }),
      );
      recorder.record_data_call({
        call_type,
        operation_name: operation,
        latency_ms: elapsedMs(start),
        status: "error",
        error: errStr(exc),
        metadata: { ...params, calls: this.calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw exc;
    }
    const response_bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const summary = summarize(value);
    this.logs.push(DataCallLogSchema.parse({ operation, params, result_summary: summary }));
    recorder.record_data_call({
      call_type,
      operation_name: operation,
      latency_ms: elapsedMs(start),
      status: operation === "run_sql" && isSqlRefusal(value as unknown as SqlResponse) ? "refused" : "ok",
      metadata: { ...params, calls: this.calls, response_bytes },
      agent_id: this.agent_id,
      heuristic_id: this.heuristic_id,
    });
    return value;
  }
}

function summarizeResponse(value: unknown): string {
  if (!isRecord(value)) return "";
  const keys = Object.keys(value).sort().join(", ");
  return keys ? `keys: ${keys}` : "empty response";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Milliseconds since `startMs`, rounded to 3 decimals (matches the recorder). */
function elapsedMs(startMs: number): number {
  return Math.round((performance.now() - startMs) * 1000) / 1000;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `OE_PROSE_REGISTER=off bun test test/data_client.test.ts test/observability.test.ts test/recorder_seq.test.ts test/recorder_sink.test.ts`
Expected: PASS — the 6 new counting tests plus the observability suites (update `include_shortcuts` assertions in `recorder_seq.test.ts:*` / `recorder_sink.test.ts:*` by deleting the field from the expected metadata object).

- [ ] **Step 5: Commit**

```bash
git add src/agents/data_client.ts src/observability test/data_client.test.ts test/recorder_seq.test.ts test/recorder_sink.test.ts
git commit -m "feat(data_client): CountingDataClient preserves per-agent call-budget accounting"
```

---

## Task 6: `retrieval.ts` — endpoints instead of query strings

`SOURCE_DATA_FIELDS` survives untouched for the seven live shapes (the service returns raw vendor column names — `first_name`, `ownername`, `dob_day` — which is exactly what these lists already select). The three dead entries go. The return envelopes keep their existing camelCase keys (`totalCount`, `hasMore`) because `typed_tools._envelope` reads them; the wire's snake_case is mapped at the seam.

**Files:**
- Modify: `src/agents/retrieval.ts` (whole file)
- Test: `test/retrieval.test.ts` (create)

- [ ] **Step 1: Write the failing test**

`test/retrieval.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { CountingDataClient, DataHttpClient } from "../src/agents/data_client.ts";
import {
  ADDRESS_SHAPES,
  PERSON_SHAPES,
  SOURCE_DATA_FIELDS,
  fetch_address_records,
  fetch_address_records_multi,
  fetch_people_at_address,
  fetch_person_records,
  fetch_search_people,
} from "../src/agents/retrieval.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";

function counted(s: FixtureDataService) {
  return new CountingDataClient(new DataHttpClient(s.url), { max_calls: 8 });
}

const TAX_BLOCK = {
  total_count: 1,
  has_more: false,
  records: [
    {
      table: "tax",
      rowid: 12,
      data: { id: "4001", ownername: "DOE, JANE", owneraddressline1: "3360 RAVINIA CIR", ownerstate: "IL", junk: "drop me" },
    },
  ],
};

describe("shape catalogue", () => {
  test("only the seven live shapes remain; voter/criminal/linkedin are gone", () => {
    expect([...ADDRESS_SHAPES].sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
    expect([...PERSON_SHAPES].sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace"]);
    expect(Object.keys(SOURCE_DATA_FIELDS).sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
  });

  test("the surviving per-shape projections are unchanged (raw vendor column names)", () => {
    expect(SOURCE_DATA_FIELDS["utility"]).toEqual(["first_name", "last_name", "middle_name", "dob", "dod", "address", "city", "state", "zip", "phone"]);
    expect(SOURCE_DATA_FIELDS["trace"]).toContain("dob_day");
    expect(SOURCE_DATA_FIELDS["tax"]).toContain("ownername");
  });
});

describe("fetch_address_records", () => {
  test("calls op 2 for one shape and projects with SOURCE_DATA_FIELDS", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: { tax: TAX_BLOCK }, unsupported_shapes: [] } });
    try {
      const out = await fetch_address_records(counted(s), 3342, "tax", { limit: 20, offset: 0 });
      expect(out["ok"]).toBe(true);
      expect(out["totalCount"]).toBe(1);
      expect(out["hasMore"]).toBe(false);
      const row = (out["records"] as Record<string, any>[])[0]!;
      expect(row["source"]).toBe("tax");
      expect(row["rowid"]).toBe(12);
      expect(row["data"]).toEqual({ id: "4001", ownername: "DOE, JANE", owneraddressline1: "3360 RAVINIA CIR", ownerstate: "IL" });
      expect(row["summary"]).toContain("ownername=DOE, JANE");
      expect(s.requests[0]!.query).toEqual({ shapes: "tax", limit: "20", offset: "0" });
    } finally {
      s.close();
    }
  });

  test("rejects a shape the corpus does not have, naming the live shapes", async () => {
    const s = new FixtureDataService({});
    try {
      const out = await fetch_address_records(counted(s), 1, "voter");
      expect(out["ok"]).toBe(false);
      expect(out["error"]).toBe("Unsupported address shape: voter");
      expect(out["supported_shapes"]).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
      expect(s.requests.length).toBe(0);
    } finally {
      s.close();
    }
  });
});

describe("fetch_address_records_multi / people / person / search", () => {
  test("multi passes every requested shape in one call and forwards unsupported_shapes", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: { tax: TAX_BLOCK }, unsupported_shapes: ["voter"] } });
    try {
      const out = await fetch_address_records_multi(counted(s), 3342, { sources: ["tax", "voter"], limit: 25 });
      expect(out["ok"]).toBe(true);
      expect(Object.keys(out["records_by_source"] as object)).toEqual(["tax"]);
      expect(out["unsupported_sources"]).toEqual(["voter"]);
      expect(s.requests.length).toBe(1);
    } finally {
      s.close();
    }
  });

  test("people surfaces identity_confidence and is_suspicious", async () => {
    const s = new FixtureDataService({
      address_people: {
        total_count: 1,
        has_more: false,
        people: [{ id: "hal:HAL0001", firstname: "JANE", lastname: "DOE", full_name: "JANE DOE", identity_confidence: 40.5, is_suspicious: false }],
      },
    });
    try {
      const out = await fetch_people_at_address(counted(s), 3342, { limit: 25 });
      const p = (out["people"] as Record<string, any>[])[0]!;
      expect(p["identity_confidence"]).toBe(40.5);
      expect(p["is_suspicious"]).toBe(false);
    } finally {
      s.close();
    }
  });

  test("person_records requires an id and calls op 4", async () => {
    const s = new FixtureDataService({ person_records: { person: { id: "addr:1:0", firstname: "JANE" }, records_by_source: { tax: TAX_BLOCK }, unsupported_shapes: [] } });
    try {
      expect((await fetch_person_records(counted(s), "  ")) ["ok"]).toBe(false);
      const out = await fetch_person_records(counted(s), "addr:1:0", { sources: ["tax"], limit: 20 });
      expect(out["ok"]).toBe(true);
      expect((out["person"] as Record<string, any>)["id"]).toBe("addr:1:0");
    } finally {
      s.close();
    }
  });

  test("search_people maps op 5 results into the record envelope", async () => {
    const s = new FixtureDataService({
      people_search: { total_count: 1, has_more: false, results: [{ id: "hal:HAL0001", firstname: "JANE", lastname: "DOE", full_name: "JANE DOE", match_score: 1.0, record_count: 3, identity_confidence: 40.5, is_suspicious: false }] },
    });
    try {
      const out = await fetch_search_people(counted(s), "Jane Doe", { limit: 10 });
      expect(out["count"]).toBe(1);
      expect((out["records"] as Record<string, any>[])[0]).toMatchObject({ id: "hal:HAL0001", match_score: 1.0, identity_confidence: 40.5, is_suspicious: false });
    } finally {
      s.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/retrieval.test.ts`
Expected: FAIL — `Export named 'ADDRESS_SHAPES' not found in module '.../retrieval.ts'`

- [ ] **Step 3: Rewrite `src/agents/retrieval.ts`**

Replace lines 1–31 (header + the two `*_SOURCE_FIELDS` maps) with:

```ts
// Retrieval helpers over CountingDataClient: fetch compact source rows / people for the resolved
// subject address or a specific person id, via the typed operations of Contract B.
//
// The limit/offset/sources options default only when omitted (undefined); an explicitly-passed 0 is
// kept, then the max/min clamping runs.
import { CountingDataClient, DataClientError, SHAPES, type PersonSummary, type RecordBlock } from "./data_client.ts";
import type { ResolvedAddressContext } from "./models.ts";

/** Shapes servable at an address. utility is address-linked and has no person scope. */
export const ADDRESS_SHAPES: readonly string[] = [...SHAPES];
/** Shapes servable for a person id. */
export const PERSON_SHAPES: readonly string[] = SHAPES.filter((s) => s !== "utility");
```

Replace `_compact_person_node` (lines 33–42) with:

```ts
const PERSON_KEYS = [
  "id",
  "firstname",
  "middlename",
  "lastname",
  "full_name",
  "norm_name_key",
  "sources",
  "primary_address_id",
  // Load-bearing: the partner ER graph is 17.9% suspicious and peaks at confidence 40.50. The model
  // must be able to discount a hal:-sourced identity, so these are never dropped.
  "identity_confidence",
  "is_suspicious",
] as const;

function _compact_person(node: Partial<PersonSummary> & Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of PERSON_KEYS) {
    const value = node[key];
    if (value !== null && value !== undefined && value !== "") {
      out[key] = value;
    }
  }
  return out;
}
```

Delete the `voter`, `criminal` and `linkedin` entries from `SOURCE_DATA_FIELDS` (lines 93–95). **Leave the other seven lists byte-identical.**

Replace `_compact_source_node` and the five `fetch_*` functions (lines 125–360) with:

```ts
function _compact_source_row(shape: string, node: Record<string, any>): Record<string, any> {
  const data = isDict(node["data"]) ? node["data"] : {};
  const compact_data = _compact_record_data(shape, data);
  return {
    source: shape,
    table: node["table"] || shape,
    rowid: node["rowid"] ?? null,
    record_id: node["record_id"] ?? null,
    summary: _record_summary(shape, compact_data),
    data: compact_data,
  };
}

/** Map a Contract-B RecordBlock into the internal envelope the typed tools already consume. */
function _block(shape: string, block: Partial<RecordBlock> | undefined): Record<string, any> {
  const b = block ?? {};
  return {
    totalCount: Math.trunc(Number(b.total_count ?? 0)),
    hasMore: Boolean(b.has_more),
    records: asArray(b.records).map((row) => _compact_source_row(shape, row)),
  };
}

function _normalize_shapes(requested: string[] | null | undefined, allowed: readonly string[]): [string[], string[]] {
  const raw = Array.isArray(requested) ? requested : [];
  const normalized = raw.filter((s) => String(s).trim() !== "").map((s) => String(s).trim().toLowerCase());
  const wanted = normalized.length > 0 ? normalized : [...allowed];
  const supported = wanted.filter((s) => allowed.includes(s));
  return [supported, setDifferenceSorted(wanted, supported)];
}

export async function fetch_address_records(
  data: CountingDataClient,
  address_id: number,
  source: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<Record<string, any>> {
  const shape = String(source ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.limit ?? 20)), 100));
  const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0)));
  if (!ADDRESS_SHAPES.includes(shape)) {
    return { ok: false, error: `Unsupported address shape: ${shape}`, supported_shapes: [...ADDRESS_SHAPES].sort() };
  }
  try {
    const res = await data.address_records(address_id, { shapes: [shape], limit, offset });
    return { ok: true, source: shape, ..._block(shape, res.records_by_source[shape]) };
  } catch (exc) {
    if (!(exc instanceof DataClientError)) throw exc;
    return { ok: false, error: errStr(exc) };
  }
}

export async function fetch_address_records_multi(
  data: CountingDataClient,
  address_id: number,
  opts: { sources?: string[] | null; limit?: number; offset?: number } = {},
): Promise<Record<string, any>> {
  const [supported, unsupported] = _normalize_shapes(opts.sources, ADDRESS_SHAPES);
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.limit ?? 25)), 100));
  const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0)));
  if (supported.length === 0) {
    return { ok: false, error: "No supported address shapes requested.", supported_shapes: [...ADDRESS_SHAPES].sort(), unsupported_sources: unsupported };
  }
  try {
    const res = await data.address_records(address_id, { shapes: supported, limit, offset });
    const records: Record<string, any> = {};
    for (const shape of supported) {
      records[shape] = _block(shape, res.records_by_source[shape]);
    }
    return {
      ok: true,
      records_by_source: records,
      unsupported_sources: [...new Set([...unsupported, ...(res.unsupported_shapes ?? [])])].sort(),
    };
  } catch (exc) {
    if (!(exc instanceof DataClientError)) throw exc;
    return { ok: false, error: errStr(exc), unsupported_sources: unsupported };
  }
}

export async function fetch_people_at_address(
  data: CountingDataClient,
  address_id: number,
  opts: { limit?: number; offset?: number } = {},
): Promise<Record<string, any>> {
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.limit ?? 25)), 100));
  const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0)));
  try {
    const res = await data.address_people(address_id, { limit, offset });
    return {
      ok: true,
      address_id,
      totalCount: Math.trunc(Number(res.total_count ?? 0)),
      hasMore: Boolean(res.has_more),
      people: asArray(res.people).map((p) => _compact_person(p)),
    };
  } catch (exc) {
    if (!(exc instanceof DataClientError)) throw exc;
    return { ok: false, error: errStr(exc) };
  }
}

export async function fetch_person_records(
  data: CountingDataClient,
  person_id: string,
  opts: { sources?: string[] | null; limit?: number } = {},
): Promise<Record<string, any>> {
  const id = String(person_id ?? "").trim();
  if (!id) {
    return { ok: false, error: "person_id is required." };
  }
  const [supported, unsupported] = _normalize_shapes(opts.sources, PERSON_SHAPES);
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.limit ?? 20)), 100));
  if (supported.length === 0) {
    return { ok: false, error: "No supported person shapes requested.", supported_shapes: [...PERSON_SHAPES].sort(), unsupported_sources: unsupported };
  }
  try {
    const res = await data.person_records(id, { shapes: supported, limit });
    const records: Record<string, any> = {};
    for (const shape of supported) {
      records[shape] = _block(shape, res.records_by_source[shape]);
    }
    return {
      ok: true,
      person: _compact_person(res.person ?? { id }),
      records_by_source: records,
      unsupported_sources: [...new Set([...unsupported, ...(res.unsupported_shapes ?? [])])].sort(),
    };
  } catch (exc) {
    if (!(exc instanceof DataClientError)) throw exc;
    return { ok: false, error: errStr(exc), unsupported_sources: unsupported };
  }
}

export async function fetch_search_people(
  data: CountingDataClient,
  name: string,
  opts: { limit?: number } = {},
): Promise<Record<string, any>> {
  const q = String(name ?? "").trim();
  if (!q) {
    return { ok: false, error: "name is required." };
  }
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.limit ?? 10)), 50));
  try {
    const res = await data.search_people(q, { limit });
    return {
      ok: true,
      source: "people_search",
      count: Math.trunc(Number(res.total_count ?? 0)),
      has_more: Boolean(res.has_more),
      records: asArray(res.results).map((hit) => ({
        ..._compact_person(hit),
        match_score: hit.match_score ?? null,
        record_count: hit.record_count ?? null,
      })),
    };
  } catch (exc) {
    if (!(exc instanceof DataClientError)) throw exc;
    return { ok: false, error: errStr(exc) };
  }
}
```

Finally, fix the lint warning at old line 168 by deleting the now-gone GraphQL connection unwrap, and change `asArray` to `function asArray(value: any): any[] { return Array.isArray(value) ? value : []; }`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/retrieval.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/agents/retrieval.ts test/retrieval.test.ts
git commit -m "feat(retrieval): call the typed operations; drop voter/criminal/linkedin shapes"
```

---

## Task 7: `typed_tools.ts` — drop three shapes, three tools, three one-liners

**Files:**
- Modify: `src/agents/typed_tools.ts:10,13-21,24-35,62,68,207,257-261,269-273,281-285,288-299,305-318`
- Test: `test/typed_tools.test.ts` (create)

- [ ] **Step 1: Write the failing test**

`test/typed_tools.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ALL_SHAPES, SHAPE_TOOLS, _typed_tool_definitions, run_typed_tool, typed_tools_guide } from "../src/agents/typed_tools.ts";
import { CountingDataClient, DataHttpClient } from "../src/agents/data_client.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";

describe("SHAPE_TOOLS after the shrink", () => {
  test("the three dead shapes and their tools are gone", () => {
    expect(Object.keys(SHAPE_TOOLS).sort()).toEqual([
      "get_base", "get_drivers_licenses", "get_loans", "get_tax", "get_trace_records", "get_utility", "get_vehicles",
    ]);
    expect([...ALL_SHAPES].sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
    const names = _typed_tool_definitions().map((t: any) => t.name).sort();
    expect(names).toEqual([
      "get_base", "get_drivers_licenses", "get_loans", "get_people", "get_records",
      "get_tax", "get_trace_records", "get_utility", "get_vehicles", "search_people",
    ]);
    expect(names).not.toContain("get_voter_records");
    expect(names).not.toContain("get_criminal_records");
    expect(names).not.toContain("get_linkedin");
  });

  test("no tool description or guide mentions a dead shape", () => {
    const text = _typed_tool_definitions().map((t: any) => `${t.name} ${t.description}`).join("\n") + typed_tools_guide({});
    for (const dead of ["voter", "criminal", "linkedin", "LinkedIn"]) {
      expect(text).not.toContain(dead);
    }
  });

  test("a packet scope naming a dead shape does not poison get_records", async () => {
    // legal_address_presence's scope used to be ["drive","voter","auto","tax"]. A stale scope must
    // degrade, never produce {ok:false, "Unknown shape(s)"} for the whole call.
    const s = new FixtureDataService({ address_records: { records_by_source: { drive: { total_count: 0, has_more: false, records: [] } }, unsupported_shapes: [] } });
    try {
      const data = new CountingDataClient(new DataHttpClient(s.url), { max_calls: 4 });
      const agent_input = { heuristic: { context_scope: ["drive", "voter"] }, context: { selected: { id: 3342 }, evidence_map: { address_id: 3342 } } } as any;
      const out = await run_typed_tool("get_records", {}, agent_input, data);
      expect(out["ok"]).toBe(true);
      expect(out["unsupported_sources"]).toContain("voter");
    } finally {
      s.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/typed_tools.test.ts`
Expected: FAIL — `expect(received).toEqual(expected)`, received includes `get_criminal_records`, `get_linkedin`, `get_voter_records`

- [ ] **Step 3: Apply the edits**

- Line 10: `import type { CountingDataClient } from "./data_client.ts";` and replace every `graphql: CountingGraphQLTool` parameter with `data: CountingDataClient` (lines 116, 149, 171, 181, 186, 191) and every `graphql` argument at the call sites (125, 139, 154, 166, 176, 182).
- Lines 13–21: import `ADDRESS_SHAPES`, `PERSON_SHAPES` instead of `ADDRESS_SOURCE_FIELDS`, `PERSON_SOURCE_FIELDS`.
- Lines 24–35:

```ts
export const SHAPE_TOOLS: Record<string, [string, string]> = {
  get_base: ["base", "both"],
  get_tax: ["tax", "both"],
  get_loans: ["loan", "both"],
  get_vehicles: ["auto", "both"],
  get_drivers_licenses: ["drive", "both"],
  get_trace_records: ["trace", "both"],
  get_utility: ["utility", "address"],
};
```

- Line 62: `export const ALL_SHAPES: Set<string> = new Set([...ADDRESS_SHAPES, ...PERSON_SHAPES]);`
- Line 68 describe: `"Shapes to fetch together in ONE call: base, tax, loan, auto, drive, trace, utility (address-only)."`
- Line 207 `get_records` description: same shape list.
- Delete `get_voter_records` (257–261), `get_criminal_records` (269–273), `get_linkedin` (281–285), `PersonOnlyArgs` (52–55, now unused), and their `_DATA_TOOLS` entries (294, 296, 298) and `_TOOL_ONE_LINERS` entries (314–317).
- **Make `_run_get_records` degrade instead of failing the call** (this is the poison-scope fix). Replace lines 118–121:

```ts
  const unknown = shapes.filter((s) => !ALL_SHAPES.has(s));
  const known = shapes.filter((s) => ALL_SHAPES.has(s));
  if (known.length === 0) {
    return { ok: false, error: `No live shape(s) in ${JSON.stringify(shapes)}`, valid_shapes: [...ALL_SHAPES].sort() };
  }
```
…and thread `known` through in place of `shapes`, merging `unknown` into the returned `unsupported_sources`.
- Fix the lint warning at line 156: `const block = res["records_by_source"]?.[shape] ?? { totalCount: 0, hasMore: false, records: [] };`

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/typed_tools.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/agents/typed_tools.ts test/typed_tools.test.ts
git commit -m "feat(typed_tools): drop voter/criminal/linkedin; degrade on a stale scope shape"
```

---

## Task 8: `schema_guide.ts` — format the curated `/v1/schema`

**Files:**
- Modify: `src/agents/schema_guide.ts` (whole file)
- Test: `test/schema_guide.test.ts` (create)

- [ ] **Step 1: Write the failing test**

`test/schema_guide.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { fallbackSchemaGuide, summarizeDataSchema } from "../src/agents/schema_guide.ts";
import type { DataSchema } from "../src/agents/data_client.ts";

const SCHEMA: DataSchema = {
  tables: [
    { name: "records_legacy", purpose: "person/address rows across the seven feeds", key_columns: ["last_name", "zip", "house_number", "ssn", "phone", "email"] },
    { name: "property_owner", purpose: "tax/property rows with owner mailing address", key_columns: ["ownername", "owneraddressline1", "ownerstate", "ownerrescount"] },
    { name: "entity_master", purpose: "resolved person entities", key_columns: ["hal_id", "first_name", "last_name", "identity_confidence"] },
    { name: "entity_links", purpose: "person<->record edges", key_columns: ["hal_id", "record_id"] },
  ],
  access_paths: [
    { predicate: "zip = $1 AND address LIKE $2", index: "zip btree + free-text prefix", measured_cost: "173 ms – 32 s" },
    { predicate: "upper(state) = $1 AND upper(city) = $2 AND address LIKE $3", index: "(upper(state), upper(city))", measured_cost: "613 ms – 53 s" },
    { predicate: "last_name = $1 AND zip = $2 AND house_number = $3", index: "(last_name, zip, house_number)", measured_cost: "41 s cold on property_owner" },
  ],
  caveats: [
    "house_number and zip are 0% populated on property_owner rows",
    "~17.5% of property_owner rows are column-shifted",
    "imported_at is a load date, not an observation date",
  ],
};

describe("summarizeDataSchema", () => {
  test("leads with the access paths, because unindexed predicates are refused", () => {
    const out = summarizeDataSchema(SCHEMA);
    const pathsAt = out.indexOf("Indexed access paths");
    const tablesAt = out.indexOf("Tables");
    expect(pathsAt).toBeGreaterThan(-1);
    expect(pathsAt).toBeLessThan(tablesAt);
    expect(out).toContain("zip = $1 AND address LIKE $2");
    expect(out).toContain("173 ms – 32 s");
  });

  test("names the guard and the refusal contract so a refusal is repairable", () => {
    const out = summarizeDataSchema(SCHEMA);
    expect(out).toContain("exactly one SELECT");
    expect(out).toContain("EXPLAIN");
    expect(out).toContain("refused");
  });

  test("renders every caveat verbatim", () => {
    const out = summarizeDataSchema(SCHEMA);
    for (const c of SCHEMA.caveats) expect(out).toContain(c);
  });

  test("no GraphQL vocabulary survives anywhere in the guide", () => {
    const text = summarizeDataSchema(SCHEMA) + fallbackSchemaGuide("boom");
    for (const dead of ["GraphQL", "resolveAddress", "personAssociations", "addressAssociations", "totalCount", "sourceRecord", "WhereInput"]) {
      expect(text).not.toContain(dead);
    }
  });

  test("an empty schema falls back rather than emitting an empty guide", () => {
    expect(summarizeDataSchema({ tables: [], access_paths: [], caveats: [] })).toBe(
      fallbackSchemaGuide("the data service returned no tables or access paths"),
    );
  });
});

describe("fallbackSchemaGuide", () => {
  test("still names the six typed operations when the schema fetch fails", () => {
    const out = fallbackSchemaGuide("connection refused");
    expect(out).toContain("connection refused");
    for (const op of ["/v1/resolve", "/v1/address/{id}/records", "/v1/address/{id}/people", "/v1/person/{id}/records", "/v1/people/search", "/v1/source-record/{shape}/{rowid}"]) {
      expect(out).toContain(op);
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/schema_guide.test.ts`
Expected: FAIL — `Export named 'summarizeDataSchema' not found`

- [ ] **Step 3: Replace `src/agents/schema_guide.ts` entirely**

```ts
// Formats the curated GET /v1/schema payload into the guide the agent reads before writing SQL.
//
// The access paths lead, deliberately: this corpus has no index on the free-text address, on
// lat/long, on source_file or on raw_data, so a predicate off an indexed path is refused by the
// EXPLAIN gate before it ever runs. Dumping columns without saying which predicates are fast would
// guarantee refused queries.
import type { DataSchema } from "./data_client.ts";

const GUARD_LINES = [
  "Hatch guard, applied in this order to every run_sql call:",
  "1. Parse — exactly one SELECT. ';'-chaining, DML inside a CTE, and BEGIN/COMMIT/SET/COPY/DO/CALL/GRANT/ALTER are rejected.",
  "2. A LIMIT is injected if you omit one, and any limit you supply is capped.",
  "3. EXPLAIN (no ANALYZE) — a sequential scan on a records table, or a plan cost above the ceiling, is refused BEFORE execution.",
  "4. Execution runs under a statement timeout with a row cap.",
  "A refused query returns {refused, stage, reason, hint} carrying the planner's own reason. Read the",
  "hint and move the predicate onto an indexed access path; do not retry the same shape.",
];

export function summarizeDataSchema(schema: DataSchema | null | undefined): string {
  const tables = schema?.tables ?? [];
  const access_paths = schema?.access_paths ?? [];
  if (tables.length === 0 && access_paths.length === 0) {
    return fallbackSchemaGuide("the data service returned no tables or access paths");
  }
  const lines: string[] = [
    "Data surface for run_sql. Only the predicates listed here are servable; everything else is refused.",
    "",
    "Indexed access paths (the only fast predicates):",
  ];
  for (const path of access_paths) {
    lines.push(`- ${path.predicate}  [${path.index}]  measured: ${path.measured_cost}`);
  }
  if (access_paths.length === 0) {
    lines.push("- (none advertised — treat every predicate as unindexed and expect a refusal)");
  }
  lines.push("", "Tables:");
  for (const table of tables) {
    lines.push(`- ${table.name}: ${table.purpose}. Key columns: ${(table.key_columns ?? []).join(", ")}.`);
  }
  lines.push("", ...GUARD_LINES);
  const caveats = schema?.caveats ?? [];
  if (caveats.length > 0) {
    lines.push("", "Data-quality caveats — these are facts about the corpus, not hypotheses:");
    for (const caveat of caveats) {
      lines.push(`- ${caveat}`);
    }
  }
  return lines.join("\n");
}

export function fallbackSchemaGuide(message = ""): string {
  const suffix = message ? ` Schema fetch failed: ${message}` : "";
  return [
    `Curated data schema unavailable.${suffix} Use the typed operations only; do not guess at SQL.`,
    "Typed operations:",
    "- POST /v1/resolve {address, zip} — candidates, the resolved address_id, source_counts and the first rows per shape.",
    "- GET /v1/address/{id}/records?shapes=&limit=&offset= — rows at an address, per shape.",
    "- GET /v1/address/{id}/people?limit=&offset= — people linked to an address.",
    "- GET /v1/person/{id}/records?shapes=&limit= — a person's rows; id is addr:<addressId>:<n> or hal:<hal_id>.",
    "- GET /v1/people/search?name=&limit= — person entities by name.",
    "- GET /v1/source-record/{shape}/{rowid} — one raw row, for provenance.",
    "Live shapes: base, tax, utility, trace, auto, loan, drive.",
  ].join("\n");
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/schema_guide.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/agents/schema_guide.ts test/schema_guide.test.ts
git commit -m "feat(schema_guide): format the curated /v1/schema; drop introspection"
```

---

## Task 9: `sql_toolset.ts` replaces `graphql_toolset.ts`

**Files:**
- Create: `src/agents/toolsets/sql_toolset.ts`
- Delete: `src/agents/toolsets/graphql_toolset.ts`
- Modify: `src/agents/toolsets/{base,typed_toolset,index}.ts`
- Test: `test/sql_toolset.test.ts` (create)

- [ ] **Step 1: Write the failing test**

`test/sql_toolset.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { CountingDataClient, DataHttpClient } from "../src/agents/data_client.ts";
import { Diagnostics } from "../src/agents/toolsets/base.ts";
import { SqlToolset } from "../src/agents/toolsets/sql_toolset.ts";
import { make_toolset } from "../src/agents/toolsets/index.ts";
import { TypedToolset } from "../src/agents/toolsets/typed_toolset.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";

const AGENT_INPUT = {
  heuristic: { id: "h", packet: true, context_scope: ["tax"] },
  context: { selected: { id: 3342 }, evidence_map: { address_id: 3342 } },
  schema_tool_budget: 2,
  prompt_profile: "compact",
} as any;

function counted(s: FixtureDataService, max_calls = 8) {
  return new CountingDataClient(new DataHttpClient(s.url), { max_calls });
}

describe("mode semantics (D0)", () => {
  test('"tools" is the typed surface PLUS the hatch; "typed_tools" is typed only', () => {
    const tools = make_toolset("tools").tool_definitions().map((t: any) => t.name);
    const typed = make_toolset("typed_tools").tool_definitions().map((t: any) => t.name);
    expect(tools).toEqual([...typed, "run_sql", "describe_schema", "get_source_record"]);
    expect(typed).not.toContain("run_sql");
    expect(make_toolset("tools").name).toBe("tools");
    expect(make_toolset("typed_tools") instanceof TypedToolset).toBe(true);
  });

  test("no GraphQL tool exists in either mode", () => {
    const all = [...make_toolset("tools").tool_definitions(), ...make_toolset("typed_tools").tool_definitions()].map((t: any) => t.name);
    for (const dead of ["execute_graphql", "validate_graphql", "get_address_records", "get_people_at_address", "get_person_records"]) {
      expect(all).not.toContain(dead);
    }
  });

  test("SqlToolset owns both its own tools and every typed tool", () => {
    const ts = new SqlToolset();
    expect(ts.owns_tool("run_sql")).toBe(true);
    expect(ts.owns_tool("describe_schema")).toBe(true);
    expect(ts.owns_tool("get_source_record")).toBe(true);
    expect(ts.owns_tool("get_records")).toBe(true);
    expect(ts.owns_tool("get_tax")).toBe(true);
    expect(ts.owns_tool("execute_graphql")).toBe(false);
  });
});

describe("run_sql dispatch", () => {
  test("a successful query returns rows and does not touch the repair counters", async () => {
    const s = new FixtureDataService({ sql: { columns: ["record_id"], rows: [[4001]], row_count: 1, truncated: false, plan_cost: 8.14, duration_ms: 173 } });
    try {
      const d = new Diagnostics();
      const out = await new SqlToolset().dispatch("run_sql", { query: "SELECT record_id FROM tax LIMIT 1" }, AGENT_INPUT, counted(s), d);
      expect(out).toMatchObject({ ok: true, row_count: 1, plan_cost: 8.14 });
      expect(d.validation_errors).toEqual([]);
      expect(d.query_repair_attempts).toBe(0);
    } finally {
      s.close();
    }
  });

  test("a 422 refusal becomes an ok:false repair payload and drives the repair counters (D3)", async () => {
    const s = new FixtureDataService({ sql: { refused: true, stage: "explain", reason: "Seq Scan on records_legacy (cost=0.00..184000000.00)", hint: "Indexed paths: zip; ssn; phone; email." } });
    try {
      const d = new Diagnostics();
      const out = await new SqlToolset().dispatch("run_sql", { query: "SELECT * FROM records_legacy" }, AGENT_INPUT, counted(s), d);
      expect(out).toEqual({
        ok: false,
        stage: "explain",
        error: "Seq Scan on records_legacy (cost=0.00..184000000.00)",
        hint: "Indexed paths: zip; ssn; phone; email.",
      });
      expect(d.validation_errors).toEqual(["Seq Scan on records_legacy (cost=0.00..184000000.00)"]);
      expect(d.query_repair_attempts).toBe(1);
    } finally {
      s.close();
    }
  });

  test("budget exhaustion flips the terminal envelope and blocks every later data tool", async () => {
    const s = new FixtureDataService({ sql: { columns: [], rows: [], row_count: 0, truncated: false, plan_cost: 1, duration_ms: 1 } });
    try {
      const ts = new SqlToolset();
      const d = new Diagnostics();
      const data = counted(s, 1);
      await ts.dispatch("run_sql", { query: "SELECT 1" }, AGENT_INPUT, data, d);
      const second = await ts.dispatch("run_sql", { query: "SELECT 2" }, AGENT_INPUT, data, d);
      expect(second["stage"]).toBe("budget_exhausted");
      expect(d.data_budget_exhausted).toBe(true);
      const typed = await ts.dispatch("get_tax", { limit: 5 }, AGENT_INPUT, data, d);
      expect(typed["stage"]).toBe("budget_exhausted");
      expect(String(typed["instruction"])).toContain("submit_heuristic_result");
    } finally {
      s.close();
    }
  });
});

describe("describe_schema + get_source_record", () => {
  test("describe_schema returns the formatted curated guide and spends the schema budget", async () => {
    const s = new FixtureDataService({ schema: { tables: [{ name: "property_owner", purpose: "tax rows", key_columns: ["ownername"] }], access_paths: [], caveats: ["imported_at is a load date, not an observation date"] } });
    try {
      const data = counted(s);
      const out = await new SqlToolset().dispatch("describe_schema", {}, AGENT_INPUT, data, new Diagnostics());
      expect(out["ok"]).toBe(true);
      expect(String(out["schema"])).toContain("property_owner");
      expect(String(out["schema"])).toContain("imported_at is a load date");
      expect(data.schema_tool_calls).toBe(1);
      expect(data.calls).toBe(0);
    } finally {
      s.close();
    }
  });

  test("get_source_record turns a SQL rowid into a citable evidence row", async () => {
    const s = new FixtureDataService({ source_record: { source: "tax", table: "tax", rowid: 12, record_id: "4001", summary: "tax; ownername=DOE, JANE", data: { ownername: "DOE, JANE" } } });
    try {
      const out = await new SqlToolset().dispatch("get_source_record", { shape: "tax", rowid: 12 }, AGENT_INPUT, counted(s), new Diagnostics());
      expect(out).toMatchObject({ ok: true, source: "tax", rowid: 12, record_id: "4001" });
    } finally {
      s.close();
    }
  });

  test("an unknown tool name reports the available tools", async () => {
    const s = new FixtureDataService({});
    try {
      const d = new Diagnostics();
      const out = await new SqlToolset().dispatch("execute_graphql", {}, AGENT_INPUT, counted(s), d);
      expect(out["ok"]).toBe(false);
      expect(String(out["error"])).toBe("Unknown tool: execute_graphql");
      expect(out["available_tools"]).toContain("run_sql");
      expect(d.tool_errors).toEqual(["Unknown tool: execute_graphql"]);
    } finally {
      s.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/sql_toolset.test.ts`
Expected: FAIL — `Cannot find module '../src/agents/toolsets/sql_toolset.ts'`

- [ ] **Step 3a: `base.ts`**

```ts
// Diagnostics container and the RetrievalToolset interface for subagent runs.
import type { CountingDataClient } from "../data_client.ts";
import type { HeuristicAgentInput } from "../models.ts";

/** Mutable per-subagent run diagnostics shared by the loop and toolset dispatch. */
export class Diagnostics {
  tool_errors: string[] = [];
  /** SQL refusal reasons — the hatch's repair channel (was GraphQL validation errors). */
  validation_errors: string[] = [];
  query_repair_attempts = 0;
  raw_model_failures: string[] = [];
  output_validation_failures: string[] = [];
  data_budget_exhausted = false;
  fetched_rows: Record<string, any>[] = [];
}
```
…and change the `dispatch` signature's `graphql: CountingGraphQLTool` to `data: CountingDataClient`.

- [ ] **Step 3b: move `_union_source_scope` into `typed_toolset.ts`**

Cut `_union_source_scope` out of `graphql_toolset.ts:515-529` and paste it into `typed_toolset.ts` as an `export`, deleting the `import { _union_source_scope } from "./graphql_toolset.ts";` at line 22 (the dependency was inverted). Rename `TypedToolset`'s dispatch parameter to `data`.

- [ ] **Step 3c: create `src/agents/toolsets/sql_toolset.ts`**

```ts
// The "tools" retrieval surface: the typed tools (delegated to TypedToolset) PLUS the guarded SQL
// hatch — run_sql, describe_schema and get_source_record. This is the exploratory mode; typed_tools
// is the bounded one.
//
// A 422 refusal from the hatch is NOT an error: it is the repair signal, carrying the planner's own
// reason and a hint naming the indexed access paths. It lands on diagnostics.validation_errors and
// increments query_repair_attempts, which is exactly what the GraphQL validate loop used to do.
import { createHash } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { DataClientError, SHAPES, isSqlRefusal, type CountingDataClient } from "../data_client.ts";
import type { HeuristicAgentInput } from "../models.ts";
import { HEURISTIC_SYSTEM_PROMPT, grouped_heuristic_user_prompt, heuristic_user_prompt, prompt_context } from "../prompts.ts";
import { summarizeDataSchema } from "../schema_guide.ts";
import { sql_tools_guide } from "../typed_tools.ts";
import type { Diagnostics, RetrievalToolset } from "./base.ts";
import { TypedToolset, _union_source_scope } from "./typed_toolset.ts";

const RunSqlArgs = z
  .object({
    query: z
      .string()
      .describe(
        "One read-only SELECT. A LIMIT is injected if you omit one. Unindexed predicates are refused before execution; describe_schema lists the indexed access paths.",
      ),
  })
  .describe("Run one exploratory read-only SELECT against the partner corpus.");

const DescribeSchemaArgs = z
  .object({})
  .describe("The curated data schema: tables, the indexed access paths that are actually fast, and the known data-quality caveats.");

const GetSourceRecordArgs = z
  .object({
    shape: z.string().describe(`One of: ${SHAPES.join(", ")}.`),
    rowid: z.number().int().min(0).describe("Row id, e.g. from a run_sql result."),
  })
  .describe("Fetch one raw source row by shape and rowid, so a SQL hit becomes a citable evidence reference.");

const run_sql = tool(async () => ({}), {
  name: "run_sql",
  description:
    "Run one read-only SELECT against the partner corpus. Use it for questions the typed tools cannot answer — above all, enumerating an owner's other properties. Refused queries return the planner's reason plus a hint naming the indexed paths.",
  schema: RunSqlArgs,
});

const describe_schema = tool(async () => ({}), {
  name: "describe_schema",
  description: "The curated data schema: tables, the indexed access paths that are fast, and the known data-quality caveats. Read it before writing SQL.",
  schema: DescribeSchemaArgs,
});

const get_source_record = tool(async () => ({}), {
  name: "get_source_record",
  description: "Fetch one raw source row by shape and rowid. run_sql results carry no provenance — use this to turn a SQL hit into a citable evidence reference.",
  schema: GetSourceRecordArgs,
});

const _HATCH_TOOLS = new Set<string>(["run_sql", "describe_schema", "get_source_record"]);

function _is_budget_error(exc: unknown): boolean {
  return errStr(exc).includes("Data call budget exceeded");
}

function _budget_terminal_response(error: string | null = null): Record<string, any> {
  const message = error || "Data call budget is exhausted.";
  return {
    ok: false,
    stage: "budget_exhausted",
    error: message,
    instruction:
      "Do not call run_sql, describe_schema, get_source_record, or any retrieval tool again. " +
      "Submit the best available partial or inconclusive result now with submit_heuristic_result.",
  };
}

export class SqlToolset implements RetrievalToolset {
  name = "tools";
  private readonly typed = new TypedToolset();

  tool_definitions(): any[] {
    return [...this.typed.tool_definitions(), run_sql, describe_schema, get_source_record];
  }

  owns_tool(name: string): boolean {
    return _HATCH_TOOLS.has(name) || this.typed.owns_tool(name);
  }

  system_prompt(): string {
    return HEURISTIC_SYSTEM_PROMPT;
  }

  build_context(agent_input: HeuristicAgentInput): Record<string, any> {
    const heuristic = agent_input.heuristic as Record<string, any>;
    const scope = heuristic["context_scope"]?.length
      ? heuristic["context_scope"]
      : heuristic["input_sources"]?.length
        ? heuristic["input_sources"]
        : [];
    // Unlike TypedToolset, the hatch mode KEEPS schema_mini_guide: it is the data-surface primer.
    return prompt_context(agent_input.context, agent_input.prompt_profile, scope);
  }

  user_prompt(agent_input: HeuristicAgentInput, context: Record<string, any>): string {
    return heuristic_user_prompt(agent_input.heuristic, context, sql_tools_guide(agent_input.heuristic));
  }

  group_user_prompt(agent_inputs: HeuristicAgentInput[]): string {
    const base = agent_inputs[0]!;
    const union_scope = _union_source_scope(agent_inputs);
    const context = prompt_context(base.context, base.prompt_profile, union_scope);
    return grouped_heuristic_user_prompt(
      agent_inputs.map((ai) => ai.heuristic),
      context,
      agent_inputs.map((ai) => ai.plan ?? {}),
      sql_tools_guide({ context_scope: union_scope }),
    );
  }

  async dispatch(
    name: string,
    args: Record<string, any>,
    agent_input: HeuristicAgentInput,
    data: CountingDataClient,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>> {
    if (diagnostics.data_budget_exhausted && this.owns_tool(name)) {
      return _budget_terminal_response();
    }
    if (name === "run_sql") {
      return await this._run_sql(args, data, diagnostics);
    }
    if (name === "describe_schema") {
      return await this._describe_schema(agent_input, data, diagnostics);
    }
    if (name === "get_source_record") {
      return await this._get_source_record(args, data, diagnostics);
    }
    if (this.typed.owns_tool(name)) {
      const content = await this.typed.dispatch(name, args, agent_input, data, diagnostics);
      if (!content["ok"] && _is_budget_error(content["error"])) {
        diagnostics.data_budget_exhausted = true;
        return _budget_terminal_response(String(content["error"]));
      }
      return content;
    }
    const content: Record<string, any> = {
      ok: false,
      error: `Unknown tool: ${name}`,
      available_tools: this.tool_definitions().map((t) => t.name),
    };
    diagnostics.tool_errors.push(String(content["error"]));
    return content;
  }

  describe_call(name: string, args: Record<string, any>, result: Record<string, any>): Record<string, any> {
    if (name === "run_sql") {
      const query = String(args["query"] ?? "");
      return {
        query_sha256: createHash("sha256").update(query, "utf8").digest("hex"),
        query_chars: Array.from(query).length,
        refused_stage: result["stage"] ?? null,
      };
    }
    if (name === "describe_schema") {
      return { target: "schema" };
    }
    if (name === "get_source_record") {
      return { shape: args["shape"] ?? null, rowid: args["rowid"] ?? null };
    }
    return this.typed.describe_call(name, args, result);
  }

  private async _run_sql(
    args: Record<string, any>,
    data: CountingDataClient,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>> {
    const query = String(args["query"] ?? "").trim();
    if (!query) {
      diagnostics.tool_errors.push("run_sql requires a query.");
      return { ok: false, error: "run_sql requires a query." };
    }
    let result: Awaited<ReturnType<CountingDataClient["run_sql"]>>;
    try {
      result = await data.run_sql(query);
    } catch (exc) {
      if (!(exc instanceof DataClientError)) throw exc;
      diagnostics.tool_errors.push(errStr(exc));
      if (_is_budget_error(exc)) {
        diagnostics.data_budget_exhausted = true;
        return _budget_terminal_response(errStr(exc));
      }
      return { ok: false, stage: "execution", error: errStr(exc) };
    }
    if (isSqlRefusal(result)) {
      diagnostics.validation_errors.push(result.reason);
      diagnostics.query_repair_attempts += 1;
      return { ok: false, stage: result.stage, error: result.reason, hint: result.hint };
    }
    return { ok: true, ...result };
  }

  private async _describe_schema(
    agent_input: HeuristicAgentInput,
    data: CountingDataClient,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>> {
    try {
      const schema = await data.schema({ max_calls: agent_input.schema_tool_budget });
      return { ok: true, schema: summarizeDataSchema(schema) };
    } catch (exc) {
      if (!(exc instanceof DataClientError)) throw exc;
      diagnostics.tool_errors.push(errStr(exc));
      return { ok: false, error: errStr(exc) };
    }
  }

  private async _get_source_record(
    args: Record<string, any>,
    data: CountingDataClient,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>> {
    const shape = String(args["shape"] ?? "").trim().toLowerCase();
    const rowid = Math.trunc(Number(args["rowid"]));
    if (!SHAPES.includes(shape)) {
      return { ok: false, error: `Unsupported shape: ${shape}`, supported_shapes: [...SHAPES].sort() };
    }
    if (!Number.isFinite(rowid) || rowid < 0) {
      return { ok: false, error: "rowid must be a non-negative integer." };
    }
    try {
      const row = await data.source_record(shape, rowid);
      return { ok: true, ...row };
    } catch (exc) {
      if (!(exc instanceof DataClientError)) throw exc;
      diagnostics.tool_errors.push(errStr(exc));
      if (_is_budget_error(exc)) {
        diagnostics.data_budget_exhausted = true;
        return _budget_terminal_response(errStr(exc));
      }
      return { ok: false, error: errStr(exc) };
    }
  }
}

/** Error message text with no "Error: " prefix. */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
```

- [ ] **Step 3d: `index.ts`**

```ts
// The retrieval-mode factory the orchestrator uses to build the subagent toolset.
//   "tools"       — the typed operations PLUS the guarded SQL hatch (exploratory; the default).
//   "typed_tools" — the typed operations only (bounded; no ad-hoc query surface at all).
import { SqlToolset } from "./sql_toolset.ts";
import { TypedToolset } from "./typed_toolset.ts";
import type { RetrievalToolset } from "./base.ts";

export { Diagnostics } from "./base.ts";
export type { RetrievalToolset } from "./base.ts";
export { SqlToolset } from "./sql_toolset.ts";
export { TypedToolset } from "./typed_toolset.ts";

export function make_toolset(retrieval_mode: string): RetrievalToolset {
  if (retrieval_mode === "typed_tools") {
    return new TypedToolset();
  }
  return new SqlToolset();
}
```

- [ ] **Step 3e: delete the old toolset**

```bash
git rm src/agents/toolsets/graphql_toolset.ts
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/sql_toolset.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add -A src/agents/toolsets test/sql_toolset.test.ts
git commit -m "feat(toolsets): sql_toolset composes the typed surface and adds the guarded hatch"
```

---

## Task 10: `subagents.ts` — rename the client and read the refusal channel

**Files:**
- Modify: `src/agents/subagents.ts:11,119,130,146,214,261,313,358,379,408,418,433,450,465,625,659,674-675,680,692-694,739,869-891,905-935`

- [ ] **Step 1: Write the failing test**

Append to `test/sql_toolset.test.ts`:

```ts
import { error_result } from "../src/agents/subagents.ts";

describe("error_result carries the data-call log, not a GraphQL log", () => {
  test("logs and refusals are surfaced on the structured result", async () => {
    const s = new FixtureDataService({ resolve: {}, status: 500 });
    try {
      const data = counted(s);
      await data.resolve("a", "").catch(() => {});
      const r = error_result({ id: "h1" }, "boom", data) as Record<string, any>;
      expect(r["heuristic_id"]).toBe("h1");
      expect(r["data_queries"].length).toBe(1);
      expect(r["data_queries"][0]["operation"]).toBe("resolve");
      expect(r["tool_errors"][0]).toMatch(/HTTP 500/);
      expect(r["graphql_queries"]).toBeUndefined();
    } finally {
      s.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/sql_toolset.test.ts -t "error_result"`
Expected: FAIL — `Cannot find name 'CountingDataClient'` from `subagents.ts` typecheck, or `r["data_queries"]` undefined

- [ ] **Step 3: Apply the renames**

- Line 11 → `import type { CountingDataClient } from "./data_client.ts";`
- Every `graphql: CountingGraphQLTool` parameter → `data: CountingDataClient`; every `graphql` argument → `data` (lines 119, 130, 187, 214, 313, 358, 379, 408, 418, 433, 450, 465, 625, 629, 659, 869, 875–891, 905, 930, 934).
- Line 146/261: `agent_input.max_graphql_calls` → `agent_input.max_data_calls`; `base.max_graphql_calls` → `base.max_data_calls`.
- Line 674–675: `_validation_errors_from_logs(data)` now reads `data.refusal_logs.map((r) => r.reason)`; `result["graphql_queries"]` → `result["data_queries"]` via `_merge_data_logs(null, data)`.
- Line 680: `_query_repair_attempts_from_logs(data)` → `data.refusal_logs.length`.
- Line 692–694: `diagnostics.graphql_budget_exhausted` → `diagnostics.data_budget_exhausted`; caveat text → `"Data call budget was exhausted; result is based on evidence collected before budget exhaustion."`
- Line 739: `"No local GraphQL evidence was found that supports this heuristic."` → `"No local records were found that support this heuristic."`
- Lines 869–891 (`error_result`): `validation_errors = data.refusal_logs.map((r) => r.reason)`; `graphql_queries:` → `data_queries:`; `query_repair_attempts: data.refusal_logs.length`.
- Rename `_merge_graphql_logs` → `_merge_data_logs` and drop `_validation_errors_from_logs` / `_query_repair_attempts_from_logs` in favour of direct `refusal_logs` reads.
- Line 63/77 comment: replace the `execute_graphql` reference with "run_sql returns column/row arrays and carries NO provenance — rows are harvested only from the typed tools' record payloads."

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/sql_toolset.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/agents/subagents.ts test/sql_toolset.test.ts
git commit -m "refactor(subagents): drive CountingDataClient and the SQL refusal repair channel"
```

---

## Task 11: `orchestrator.ts` — preflight over `POST /v1/resolve`

`_evidence_map` and its helpers read the same fields and change minimally: the field-name → shape mapping moves from GraphQL connection names to `records_by_source` keys, and `_source_counts` disappears (the service returns it).

**Files:**
- Modify: `src/agents/orchestrator.ts:14,73-130,187-211,382,407-452,561,734,1242-1252,1263-1279,1291-1310,1311-1360,1404-1420`
- Test: `test/preflight.test.ts` (create), `test/preflight_external.test.ts` (repoint)

- [ ] **Step 1: Write the failing test**

`test/preflight.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DataHttpClient } from "../src/agents/data_client.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";
import { FakeSubagent } from "./support/subagents.ts";
import { resolve1104, people1104 } from "./support/fixtures.ts";

async function preflight(plan: Record<string, unknown>, retrieval_mode = "typed_tools") {
  const s = new FixtureDataService({ resolve: resolve1104(), address_people: people1104(), ...plan });
  try {
    const orch = new AgentOrchestrator({ data: new DataHttpClient(s.url), subagent: new FakeSubagent() });
    const context = await orch.preflight(
      AgentInvestigationRequestSchema.parse({ address: "1104 SPRING RUN RD", zip: "40514", data_url: s.url, retrieval_mode }),
    );
    return { context, requests: s.requests };
  } finally {
    s.close();
  }
}

describe("preflight over POST /v1/resolve", () => {
  test("is exactly two calls: resolve then people (D4)", async () => {
    const { requests } = await preflight({});
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/resolve",
      "GET /v1/address/3342/people",
    ]);
  });

  test("maps candidates, the selection and source_counts straight off the resolve payload", async () => {
    const { context } = await preflight({});
    expect(context.selected?.id).toBe(3342);
    expect(context.selected?.norm_address).toBe("1104 SPRING RUN RD");
    expect(context.candidates[0]?.match_score).toBe(1);
    expect(context.candidates[0]?.relation_count).toBe(22);
    expect(context.ambiguous).toBe(false);
    expect(Object.keys(context.source_counts).sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
    expect(context.source_counts["voter"]).toBeUndefined();
  });

  test("skips the people call and reports ambiguity when nothing resolves", async () => {
    const { context, requests } = await preflight({
      resolve: { candidates: [], address_id: null, source_counts: {}, dropped_counts: {}, tax_timed_out: false, records_by_source: {} },
    });
    expect(requests.length).toBe(1);
    expect(context.selected).toBeNull();
    expect(context.ambiguous).toBe(true);
  });

  test("dropped_counts and tax_timed_out reach the model as data gaps (D6)", async () => {
    const { context } = await preflight({
      resolve: { ...(resolve1104() as Record<string, unknown>), dropped_counts: { tax: 3 }, tax_timed_out: true },
    });
    expect(context.evidence_map.data_gaps).toContain("3 tax rows were refused by the data-quality gate and are not counted.");
    expect(context.evidence_map.data_gaps).toContain("The tax lookup timed out; tax rows may be incomplete.");
  });

  test("owner + people summaries survive unchanged off the new payload", async () => {
    const { context } = await preflight({});
    const owner = context.evidence_map.owner_summaries[0]!;
    expect(owner.owner_name).toBe("CORRELL, REBECCA CHRISTINE; CORRELL, JOSIAH STEEL");
    expect(owner.mailing_address).toBe("3360 RAVINIA CIR AURORA IL 60504");
    expect(owner.mailing_matches_subject).toBe(false);
    expect(context.evidence_map.owner_elsewhere_hints[0]).toContain("3360 RAVINIA CIR");
    expect(context.evidence_map.people_at_address.some((p) => p.sources.includes("base"))).toBe(true);
    expect(context.evidence_map.evidence_refs.every((r) => r.source === "tax")).toBe(true);
  });

  test('the curated schema is fetched only in "tools" mode (D5)', async () => {
    const schema = { tables: [{ name: "property_owner", purpose: "tax rows", key_columns: ["ownername"] }], access_paths: [], caveats: [] };
    const typed = await preflight({ schema }, "typed_tools");
    expect(typed.context.schema_guide).toBe("");
    expect(typed.requests.some((r) => r.path === "/v1/schema")).toBe(false);

    const tools = await preflight({ schema }, "tools");
    expect(tools.context.schema_guide).toContain("property_owner");
    expect(tools.requests.some((r) => r.path === "/v1/schema")).toBe(true);
  });

  test("a schema fetch failure degrades to the fallback and never fails the investigation", async () => {
    const { context } = await preflight({ schema: undefined }, "tools");
    expect(context.schema_guide).toContain("Curated data schema unavailable.");
    expect(context.selected?.id).toBe(3342);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/preflight.test.ts`
Expected: FAIL — `Export named 'resolve1104' not found in module './support/fixtures.ts'` (Task 12 supplies it; run this task's step 3 first, then Task 12, then re-run — or land Task 12's fixture step before step 4 here)

- [ ] **Step 3: Rewrite the orchestrator's data path**

- Line 14 → `import { CountingDataClient, DataHttpClient, type ResolveResponse } from "./data_client.ts";`
- **Delete** `PREFLIGHT_QUERY` (73–105) and `ADDRESS_BY_ID_QUERY` (107–130). The by-id fallback is gone: op 1 returns the resolved selection and its rows in one round-trip, so there is nothing to fall back to.
- Class field/ctor (187, 196, 204): `graphql: GraphQLHttpTool` → `data: DataHttpClient`.
- Line 382: `graphql_url: request.graphql_url` → `data_url: request.data_url`.
- Line 561: `new CountingGraphQLTool(this.graphql, { max_calls: request.max_graphql_calls_per_agent * bucket.length, … })` → `new CountingDataClient(this.data, { max_calls: request.max_data_calls_per_agent * bucket.length, … })`.
- Line 734: `new GraphQLHttpTool(request.graphql_url, { timeout_seconds: request.graphql_timeout_seconds, … })` → `new DataHttpClient(request.data_url, { timeout_seconds: request.data_timeout_seconds, … })`; `make_toolset(request.retrieval_mode, request.include_shortcuts)` → `make_toolset(request.retrieval_mode)`.
- Replace `preflight` (407–452):

```ts
  async preflight(request: AgentInvestigationRequest): Promise<ResolvedAddressContext> {
    // Budget 3: resolve + people + (tools mode only) the curated schema.
    const data = new CountingDataClient(this.data, { max_calls: 3, agent_id: "orchestrator" });
    const resolved = await data.resolve(request.address, request.zip);
    const candidates = (resolved.candidates ?? []).map((node) => _candidate(node));
    const selected = _selected_candidate(resolved, candidates);
    let people: Record<string, any>[] = [];
    if (selected !== null) {
      // Op 1 returns rows but not the clustered people list; op 3 does, and the clustering is what
      // the evidence map's `base` person entries have always been built from.
      try {
        const res = await data.address_people(selected.id, { limit: 10 });
        people = (res.people ?? []) as Record<string, any>[];
      } catch {
        people = [];
      }
    }
    let schema_guide = "";
    if (request.retrieval_mode === "tools") {
      // Fetched once here so every hatch worker starts with the access paths without spending its
      // own schema-tool budget. Never fatal: a missing schema degrades to the fallback text.
      try {
        schema_guide = summarizeDataSchema(await data.schema());
      } catch (exc) {
        schema_guide = fallbackSchemaGuide(errStr(exc));
      }
    }
    const source_counts = { ...(resolved.source_counts ?? {}) };
    const external_evidence = request.external_evidence ?? null;
    // CONTEXT-level only. evidence_map.property_types stays [] — see _evidence_map below.
    const property_types = property_types_from_external(external_evidence);
    const evidence_map = _evidence_map(resolved, people, selected, source_counts, external_evidence);
    const ambiguous = selected === null || _is_ambiguous(candidates);
    return ResolvedAddressContextSchema.parse({
      input_address: request.address,
      input_zip: request.zip,
      selected,
      candidates,
      ambiguous,
      source_counts,
      property_types,
      evidence_map,
      schema_guide,
      preflight_queries: data.logs,
    });
  }
```
…with `import { fallbackSchemaGuide, summarizeDataSchema } from "./schema_guide.ts";` added at the top.

- Replace `_candidate` (1242–1252) and `_selected_candidate` (1263–1279):

```ts
function _candidate(node: Record<string, any>): AddressCandidate {
  return AddressCandidateSchema.parse({
    id: Math.trunc(Number(node["address_id"])) || 0,
    norm_address: node["norm_address"] || "",
    zip5: node["zip5"] || "",
    match_score: Number(node["match_score"] || 0),
    relation_count: Math.trunc(Number(node["relation_count"])) || 0,
    matched_fields: [...(Array.isArray(node["matched_fields"]) ? node["matched_fields"] : [])],
  });
}

function _selected_candidate(resolved: ResolveResponse, candidates: AddressCandidate[]): AddressCandidate | null {
  const id = resolved.address_id;
  if (id === null || id === undefined) {
    return null;
  }
  // The service already chose; prefer its own candidate row so match/relation counts survive.
  const chosen = candidates.find((c) => c.id === id);
  return chosen ?? AddressCandidateSchema.parse({ id: Math.trunc(Number(id)) || 0, norm_address: "", zip5: "", match_score: 1.0, relation_count: 0, matched_fields: ["address"] });
}
```

- **Delete `_source_counts`** (1291–1310) — the service supplies it.
- `_evidence_map` (1311) takes `(resolved, people, selected, source_counts, external_evidence)`. Inside, replace `address_data["normAddress"]` / `["zip5"]` with `selected?.norm_address` / `selected?.zip5`; replace `_source_nodes(address_data, "taxProperties")` with `_rows_of(resolved, "tax")`; append the D6 gaps:

```ts
function _rows_of(resolved: ResolveResponse, shape: string): Record<string, any>[] {
  const block = resolved.records_by_source?.[shape];
  return Array.isArray(block?.records) ? (block.records as Record<string, any>[]) : [];
}

function _quality_gaps(resolved: ResolveResponse): string[] {
  const gaps: string[] = [];
  for (const [shape, count] of Object.entries(resolved.dropped_counts ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (Math.trunc(Number(count)) > 0) {
      gaps.push(`${count} ${shape} rows were refused by the data-quality gate and are not counted.`);
    }
  }
  if (resolved.tax_timed_out) {
    gaps.push("The tax lookup timed out; tax rows may be incomplete.");
  }
  return gaps;
}
```
…and set `data_gaps: [...zeroCountGaps, ..._quality_gaps(resolved)]`.

- `_people_at_address_summaries(resolved, people, owners)` (1404): iterate the clustered `people` list first (source `base`, name from `full_name`/`firstname`+`lastname`), then the record shapes:

```ts
  const fields: [string, string][] = [
    ["drive", "drive"],
    ["auto", "auto"],
    ["loan", "loan"],
    ["trace", "trace"],
    ["utility", "utility"],
  ];
```
…reading `_rows_of(resolved, shape)[].data` in place of `_source_nodes(address_data, field)`. `_person_name` handles `full_name`/`firstname`/`lastname` unchanged; add `full_name` to its first branch alongside `fullName`.

- `_freshness_hints` and `_source_refs` take `resolved` and use `_rows_of(resolved, "tax")`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/preflight.test.ts test/preflight_external.test.ts`
Expected: PASS — 7 + 3 tests (repoint `preflight_external.test.ts` to `FixtureDataService`/`DataHttpClient`/`data_url` in the same edit)

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator.ts test/preflight.test.ts test/preflight_external.test.ts
git commit -m "feat(orchestrator): preflight over POST /v1/resolve + GET /v1/address/{id}/people"
```

---

## Task 12: Fixtures — capture-free `resolve_1104.json`

The old fixture was a frozen real GraphQL response refreshed by `scripts/capture_preflight_fixture.ts`, which duplicated `PREFLIGHT_QUERY` verbatim (a drift hazard `test/support/fixtures.ts:18` already flags). With a typed contract there is nothing to duplicate: the fixture is a Contract-B response body, hand-derived from the existing captured data. The capture script is deleted rather than ported.

**Files:**
- Create: `test/support/fixtures/resolve_1104.json`
- Delete: `test/support/fixtures/preflight_1104.json`, `scripts/capture_preflight_fixture.ts`, `test/support/fixture_graphql.ts`
- Modify: `test/support/fixtures.ts`

- [ ] **Step 1: Build the new fixture from the old one**

Translate `test/support/fixtures/preflight_1104.json` into Contract-B shape by hand (it is 1 tax row, 15 utility / 4 trace / 1 auto rows, 2 residents, 0 loan / drive):

```jsonc
{
  "candidates": [
    { "address_id": 3342, "match_score": 1.0, "matched_fields": ["address"], "relation_count": 22,
      "norm_address": "1104 SPRING RUN RD", "zip5": "40514",
      "street_number": "1104", "street_name": "SPRING RUN RD", "unit": null,
      "city": "Lexington", "state": "KY", "county": null }
  ],
  "address_id": 3342,
  "source_counts": { "utility": 15, "trace": 4, "base": 2, "loan": 0, "drive": 0, "auto": 1, "tax": 1 },
  "dropped_counts": {},
  "tax_timed_out": false,
  "records_by_source": {
    "tax": { "total_count": 1, "has_more": false, "records": [
      { "table": "tax", "rowid": 68344, "record_id": "68344",
        "summary": "tax; ownername=CORRELL, REBECCA CHRISTINE; CORRELL, JOSIAH STEEL",
        "data": { /* the `data` object of preflight_1104.json addressByText.taxProperties.nodes[0], verbatim */ } }
    ]},
    "utility": { "total_count": 15, "has_more": true, "records": [ /* the 10 utility nodes, each {table,rowid,data} verbatim */ ]},
    "trace":   { "total_count": 4,  "has_more": false, "records": [ /* the 4 trace nodes verbatim */ ]},
    "auto":    { "total_count": 1,  "has_more": false, "records": [ /* the 1 auto node verbatim */ ]},
    "base":    { "total_count": 2,  "has_more": false, "records": [] },
    "loan":    { "total_count": 0,  "has_more": false, "records": [] },
    "drive":   { "total_count": 0,  "has_more": false, "records": [] }
  }
}
```

The `data` blobs are copied byte-for-byte — they already carry raw vendor column names (`first_name`, `ownername`, `dob_day`, plus the `__norm_*` derived keys), which is exactly what `SOURCE_DATA_FIELDS` projects and what the service still returns.

- [ ] **Step 2: Rewrite `test/support/fixtures.ts`'s loaders**

```ts
import resolve1104Json from "./fixtures/resolve_1104.json";

/** The real 1104 SPRING RUN RD case, as a Contract-B POST /v1/resolve body. */
export function resolve1104(): Record<string, unknown> {
  return resolve1104Json as unknown as Record<string, unknown>;
}

/** The clustered GET /v1/address/3342/people body for the same case. */
export function people1104(): Record<string, unknown> {
  return {
    total_count: 2,
    has_more: false,
    people: [
      { id: "addr:3342:0", firstname: "JESSICA", lastname: "WHISMAN", full_name: "JESSICA WHISMAN", norm_name_key: "jessica|whisman", sources: ["base"], primary_address_id: 3342 },
      { id: "addr:3342:1", firstname: "JOSIAH", lastname: "CORRELL", full_name: "JOSIAH CORRELL", norm_name_key: "josiah|correll", sources: ["base"], primary_address_id: 3342 },
    ],
  };
}

/** The synthetic all-zero case: resolves, but every shape is empty. */
export function sparseResolvePayload(): Record<string, unknown> {
  const empty = { total_count: 0, has_more: false, records: [] };
  return {
    candidates: [{ address_id: 1, match_score: 1.0, matched_fields: ["address"], relation_count: 0, norm_address: "123 MAIN ST", zip5: "40505", street_number: "123", street_name: "MAIN", unit: null, city: "LEXINGTON", state: "KY", county: "FAYETTE" }],
    address_id: 1,
    source_counts: { base: 0, tax: 0, utility: 0, trace: 0, auto: 0, loan: 0, drive: 0 },
    dropped_counts: {},
    tax_timed_out: false,
    records_by_source: { base: empty, tax: empty, utility: empty, trace: empty, auto: empty, loan: empty, drive: empty },
  };
}

export function sparsePeoplePayload(): Record<string, unknown> {
  return { total_count: 0, has_more: false, people: [] };
}
```
`externalEvidenceFixture()` is unchanged. Delete `loadPreflight1104`, `sparseAddress`, `sparsePreflightPayload`, and the stale header note about the capture script.

- [ ] **Step 3: Remove the dead files**

```bash
git rm test/support/fixtures/preflight_1104.json test/support/fixture_graphql.ts scripts/capture_preflight_fixture.ts
```
Then update `test/support/support.test.ts`'s `fixtures` describe to assert `resolve1104().address_id === 3342` and `sparseResolvePayload().source_counts.tax === 0`.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `OE_PROSE_REGISTER=off bun test test/support/support.test.ts test/preflight.test.ts`
Expected: PASS — 5 + 7 tests

- [ ] **Step 5: Commit**

```bash
git add -A test/support scripts
git commit -m "test(fixtures): Contract B resolve fixture; drop the GraphQL capture script"
```

---

## Task 13: `policy.ts` — the deterministic score benchmark (before)

The benchmark lands **before** the weight change so the "before" is a committed artifact and the weight change's diff *is* the measurement.

**Files:**
- Create: `test/support/score_cases.ts`, `test/score_benchmark.test.ts`

- [ ] **Step 1: Write the case set**

`test/support/score_cases.ts`:

```ts
// A fixed, deterministic case set for the source-weight benchmark. Each case is an evidence dict
// accepted by evaluate_evidence() — no LLM, no network, no clock. The set spans exactly the space
// the drive re-weighting moves: drive alone, drive co-occurring with the loan row it IS, and the
// neighbours whose relative ranking must not silently change with it.
export interface ScoreCase {
  id: string;
  why: string;
  evidence: Record<string, unknown>;
}

const SUBJECT = "1104 SPRING RUN RD";
const ELSEWHERE = "3360 RAVINIA CIR";

function taxRow(owner = "CORRELL, JOSIAH", mailing = ELSEWHERE, extra: Record<string, unknown> = {}) {
  return { id: "t1", ownername: owner, address: SUBJECT, zip: "40514", owneraddressline1: mailing, ownercity: "AURORA", ownerstate: "IL", ownerzipcode: "60504", residential: "True", ownerrescount: 1, ...extra };
}
function personRow(id: string, first: string, last: string, address: string, extra: Record<string, unknown> = {}) {
  return { id, firstname: first, lastname: last, address, zip: "40514", ...extra };
}
const EMPTY = { tax: [], base: [], loan: [], drive: [], auto: [], trace: [], utility: [] };

function make(id: string, why: string, rows: Partial<typeof EMPTY>): ScoreCase {
  const merged = { ...EMPTY, ...rows } as Record<string, Record<string, unknown>[]>;
  const source_counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(merged)) source_counts[k] = v.length;
  return {
    id,
    why,
    evidence: {
      address: SUBJECT,
      normalized_address: SUBJECT,
      zip: "40514",
      rows: merged,
      owner_ids: merged["tax"]!.map((r) => String(r["id"])),
      owner_name_keys: merged["tax"]!.length ? [["josiah", "correll"]] : [],
      source_counts,
      owner_summaries: merged["tax"]!.map((r) => ({ owner_name: r["ownername"], mailing_address: r["owneraddressline1"], mailing_matches_subject: false })),
      people_at_address: [],
      owner_presence_hints: [],
      owner_elsewhere_hints: merged["tax"]!.length ? [`Owner mailing differs from selected address: ${r0(merged)} -> ${ELSEWHERE}.`] : [],
      nonowner_occupancy_hints: [],
      freshness_hints: [],
      data_gaps: [],
      property_types: [],
      evidence_refs: [],
    },
  };
}
function r0(rows: Record<string, Record<string, unknown>[]>): string {
  return String(rows["tax"]![0]!["ownername"]);
}

export const SCORE_CASES: readonly ScoreCase[] = [
  make("no_rows", "empty corpus — must land on insufficient_ownership_data", {}),
  make("tax_only_mailing_elsewhere", "absentee mailing with no occupancy evidence at all", { tax: [taxRow()] }),
  make("drive_only_owner_elsewhere", "the pure-drive case: the ONLY thing the weight change moves in isolation", {
    tax: [taxRow()],
    drive: [personRow("d1", "JOSIAH", "CORRELL", ELSEWHERE, { dl_num: "K1234", dl_state: "IL" })],
  }),
  make("drive_and_loan_same_row", "THE double-count: one physical payday row read as both drive and loan", {
    tax: [taxRow()],
    drive: [personRow("d1", "JOSIAH", "CORRELL", ELSEWHERE, { dl_num: "K1234", dl_state: "IL" })],
    loan: [personRow("l1", "JOSIAH", "CORRELL", ELSEWHERE, { own_rent: "OWN", loan_amount: 500, employer: "ACME" })],
  }),
  make("nonowner_loan_renter_at_subject", "loan-only renter claim — the reference the drive tier must sit below", {
    tax: [taxRow()],
    loan: [personRow("l1", "JENNIFER", "HOWARD", SUBJECT, { own_rent: "RENT", loan_amount: 500 })],
  }),
  make("auto_only_owner_elsewhere", "auto-only, which the auto_only discount is supposed to mute", {
    tax: [taxRow()],
    auto: [personRow("a1", "JOSIAH", "CORRELL", ELSEWHERE, { vin: "1X", year: 2015, make: "FORD", model: "F150" })],
  }),
  make("utility_only_nonowner", "utility-only non-owner: the lower-tier cap case", {
    tax: [taxRow()],
    utility: [{ first_name: "JENNIFER", last_name: "HOWARD", address: SUBJECT, city: "LEXINGTON", state: "KY", zip: "40514" }],
  }),
  make("trace_only_presence", "trace-only, the unranked corroboration case", {
    tax: [taxRow()],
    trace: [personRow("tr1", "AMY", "WILSON", SUBJECT, { phone: "8034786758" })],
  }),
  make("full_stack_absentee", "every live shape populated — the maximum-score case", {
    tax: [taxRow()],
    base: [{ id: "b1", firstname: "JOSIAH", lastname: "CORRELL", primaryaddress: ELSEWHERE, zip: "60504", homeownerprobabilitymodel: 9 }],
    drive: [personRow("d1", "JOSIAH", "CORRELL", ELSEWHERE, { dl_num: "K1234", dl_state: "IL" })],
    loan: [personRow("l1", "JENNIFER", "HOWARD", SUBJECT, { own_rent: "RENT", loan_amount: 500 })],
    auto: [personRow("a1", "JENNIFER", "HOWARD", SUBJECT, { vin: "1X", year: 2015, make: "FORD", model: "F150" })],
    trace: [personRow("tr1", "JENNIFER", "HOWARD", SUBJECT, {})],
    utility: [{ first_name: "JENNIFER", last_name: "HOWARD", address: SUBJECT, city: "LEXINGTON", state: "KY", zip: "40514" }],
  }),
];
```

- [ ] **Step 2: Write the benchmark test against the CURRENT weights**

`test/score_benchmark.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { evaluate_evidence } from "../src/heuristics/index.ts";
import { SOURCE_RELIABILITY_WEIGHTS, RANKED_SOURCE_ORDER, SUBSTANTIVE_SOURCES } from "../src/heuristics/policy.ts";
import { SCORE_CASES } from "./support/score_cases.ts";

/**
 * The deterministic score benchmark. Every number below was produced by running this file, not
 * derived by hand. It is the BEFORE/AFTER artifact for the drive re-weighting: changing a weight in
 * policy.ts must change this table, and the diff is the measurement.
 *
 * Regenerate with: OE_PROSE_REGISTER=off bun test test/score_benchmark.test.ts 2>&1 | grep BENCH
 */
const GOLDEN: Record<string, { score: number; band: string; archetype: string }> = {
  // FILLED IN AT STEP 4 FROM THE PRINTED BENCH LINES — do not hand-write these.
};

describe("deterministic score benchmark", () => {
  test("prints the current table (BENCH lines) for the golden file", () => {
    for (const c of SCORE_CASES) {
      const s = evaluate_evidence(c.evidence).synthesis as Record<string, any>;
      // biome-ignore lint/suspicious/noConsole: the benchmark's whole job is to emit this table.
      console.log(`BENCH ${c.id} score=${s["weighted_signal_score"]} band=${s["verdict_band_candidate"]} archetype=${s["case_archetype_candidate"]}`);
    }
    expect(SCORE_CASES.length).toBe(9);
  });

  for (const c of SCORE_CASES) {
    test(`${c.id} — ${c.why}`, () => {
      const s = evaluate_evidence(c.evidence).synthesis as Record<string, any>;
      const expected = GOLDEN[c.id];
      expect(expected).toBeDefined();
      expect({ score: s["weighted_signal_score"], band: s["verdict_band_candidate"], archetype: s["case_archetype_candidate"] }).toEqual(expected);
    });
  }
});

describe("source policy invariants", () => {
  test("drive never out-ranks loan, and the ladder covers exactly the live sources", () => {
    expect(RANKED_SOURCE_ORDER.indexOf("drive")).toBeGreaterThan(RANKED_SOURCE_ORDER.indexOf("loan"));
    expect(SOURCE_RELIABILITY_WEIGHTS["drive"]!).toBeLessThanOrEqual(SOURCE_RELIABILITY_WEIGHTS["loan"]!);
    expect([...RANKED_SOURCE_ORDER].sort()).toEqual(["auto", "drive", "loan", "tax", "utility"]);
    expect([...SUBSTANTIVE_SOURCES].sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
  });
});
```

- [ ] **Step 3: Run it, harvest the BEFORE table**

Run: `OE_PROSE_REGISTER=off bun test test/score_benchmark.test.ts 2>&1 | grep BENCH`
Expected: nine `BENCH <id> score=… band=… archetype=…` lines. The `source policy invariants` test **fails** (`drive` currently ranks above `loan` at 1.15 vs 1.05, and `voter` is still in both lists) — that is the point; it is the failing test for Task 14.

- [ ] **Step 4: Paste the harvested table into `GOLDEN`, re-run**

Run: `OE_PROSE_REGISTER=off bun test test/score_benchmark.test.ts`
Expected: 10 pass, 1 fail (`source policy invariants`)

- [ ] **Step 5: Commit the BEFORE artifact**

```bash
git add test/support/score_cases.ts test/score_benchmark.test.ts
git commit -m "test(policy): deterministic score benchmark, pinned to the CURRENT weights (before)"
```

---

## Task 14: `policy.ts` — remove `voter`, re-weight `drive`, record the delta

`drive` sits at 1.15, second only to `tax`, on the assumption a DMV record is an independent address-bearing legal event. `services/graph/src/occupancy_graph/source/manifest.py:221-238` says otherwise, in the manifest itself: *"There is no DMV feed in the partner corpus. These are payday-loan rows that happen to carry a licence number — the SAME physical rows the loan shape reads."* Because `_source_weight_adjustment` applies one source per **path**, the duplication compounds across paths: `owner_drive_elsewhere` (3 × 1.15) and `owner_loan_elsewhere` (3 × 1.05) fire off one physical row for 6.60 — clearing the `>= 5 → review` threshold on a single record.

**New policy:** `drive` drops to `0.75` and moves **below** `loan` in `RANKED_SOURCE_ORDER`. Rationale, stated so it can be argued with: the row is not independent evidence, so it must never out-weigh the original; but its projection carries `dl_num`/`dl_state`, which `loan`'s does not, so it is not worthless either. Same tier as `utility` — corroborating, never load-bearing. The rank change makes a path carrying both sources apply `loan`, so the duplicate contributes strictly less than the original.

**Files:**
- Modify: `src/heuristics/policy.ts`, `src/heuristics/synthesis.ts:64,297-299,443,463`, `src/heuristics/packets.ts:333`
- Test: `test/score_benchmark.test.ts` (golden update), `test/policy_external_sources.test.ts`

- [ ] **Step 1: The failing test already exists**

Run: `OE_PROSE_REGISTER=off bun test test/score_benchmark.test.ts -t "source policy invariants"`
Expected: FAIL — `expect(received).toBeGreaterThan(expected)` — `RANKED_SOURCE_ORDER.indexOf("drive")` is 1, `indexOf("loan")` is 2

- [ ] **Step 2: Apply the policy change**

`src/heuristics/policy.ts`:

```ts
export const SUBSTANTIVE_SOURCES: readonly string[] = [
  "tax",
  "base",
  "loan",
  "drive",
  "auto",
  "trace",
  "utility",
];

// `drive` sits at 0.75, NOT the 1.15 it carried when we believed it was a DMV feed. The partner
// corpus has no DMV feed: a `drive` row is a payday-loan row that happens to carry a licence number
// — the same physical row the `loan` shape reads (source/manifest.py). Weighting it above `loan`
// counted one record as two independent sources. It stays ranked BELOW loan so a path carrying both
// applies loan, and the duplicate can only ever contribute less than the original.
export const SOURCE_RELIABILITY_WEIGHTS: Record<string, number> = {
  tax: 1.25,
  loan: 1.05,
  auto: 0.9,
  drive: 0.75,
  utility: 0.75,
};

export const CANONICAL_CONTEXT_SOURCES: readonly string[] = ["base"];
export const UNRANKED_CONTEXT_SOURCES: readonly string[] = ["trace"];
export const RANKED_SOURCE_ORDER: readonly string[] = ["tax", "loan", "auto", "drive", "utility"];

export const _SOURCE_TOKEN_BY_PATH: ReadonlyArray<readonly [string, string]> = [
  ["drive", "drive"],
  ["loan", "loan"],
  ["auto", "auto"],
  ["utility", "utility"],
  ["trace", "trace"],
  ["tax", "tax"],
  ["base", "base"],
];
```
(`_SOURCE_ALIASES` unchanged.)

`src/heuristics/synthesis.ts`:
- line 64 → `const discountFilter = new Set([...UNRANKED_CONTEXT_SOURCES, "drive", "utility"]);`
- lines 297–299 → **delete** the `legal_pair` const and its term in the `return` (the voter paths it names no longer exist).
- lines 302–308 / 341–351 / 383–393 / 396–410 / 416–424 → remove `"owner_voter_elsewhere"`, `"nonowner_voter_at_subject"`, `"owner_voter_at_subject"` from every `_intersects` list.
- line 443 → `return [...sources].every((source) => source === "drive" || source === "utility");`
- line 463 → `reasons.push("Non-owner evidence is limited to lower-tier drive/utility sources.");`

`src/heuristics/packets.ts:333` → `"tax > loan > auto > drive == utility; base is canonical context; trace is unranked corroboration"`.

- [ ] **Step 3: Re-harvest the AFTER table**

Run: `OE_PROSE_REGISTER=off bun test test/score_benchmark.test.ts 2>&1 | grep BENCH`
Expected: nine `BENCH` lines. Record the before/after delta in the commit message; the expected direction is `drive_only_owner_elsewhere` and `drive_and_loan_same_row` dropping (the latter furthest, since it is the double-count), `nonowner_loan_renter_at_subject`, `auto_only_owner_elsewhere` and `trace_only_presence` unchanged, and `utility_only_nonowner` unchanged.

- [ ] **Step 4: Update `GOLDEN` to the AFTER table and verify**

Run: `OE_PROSE_REGISTER=off bun test test/score_benchmark.test.ts test/policy_external_sources.test.ts`
Expected: PASS — 11 + existing tests (`policy_external_sources.test.ts` needs `voter` removed from any expected list it asserts).

- [ ] **Step 5: Commit — the diff IS the benchmark**

```bash
git add src/heuristics/policy.ts src/heuristics/synthesis.ts src/heuristics/packets.ts test/score_benchmark.test.ts test/policy_external_sources.test.ts
git commit -m "fix(policy): drive 1.15 -> 0.75 and below loan; drop voter

A drive row IS a payday-loan row already counted as loan (no DMV feed in the
partner corpus, per source/manifest.py). At 1.15 it out-ranked loan and one
physical record scored as two independent sources.

Score deltas on the fixed case set (test/score_benchmark.test.ts):
  <paste the before -> after table from steps 3/4 here, per case>"
```

---

## Task 15: `heuristics/` — remove the two unimplementable heuristics

**Files:**
- Modify: `src/heuristics/atomic.ts:1022-1091,1445-1471` and the five optional `field("voter", …)` refs at `:380,530,678,1179,1208`; `src/heuristics/atomic_eval.ts:330-360,448-452,459-461,465-467,489-491,495-497,505,635,952,973`; `src/heuristics/packets.ts:67,83,108,119,124,137,140,144,147,152,156,159-160,202,212`; `src/heuristics/packet_gates.ts:227,342,351-352,356,366,374,379,453`
- Test: `test/heuristics_catalogue.test.ts` (create)

- [ ] **Step 1: Write the failing test**

`test/heuristics_catalogue.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { get_heuristic_catalog, get_packet_catalog } from "../src/heuristics/index.ts";
import { heuristic_ids, reasoning_path_ids } from "../src/heuristics/atomic_eval.ts";

describe("catalogue after the voter removal", () => {
  test("23 atomic heuristics remain; the two voter-dependent ones are gone", () => {
    expect(heuristic_ids().length).toBe(23);
    expect(heuristic_ids()).not.toContain("voter_address_subject_analysis");
    expect(heuristic_ids()).not.toContain("drive_voter_conflict_same_person");
  });

  test("their three reasoning paths are gone with them", () => {
    for (const p of ["owner_voter_at_subject", "owner_voter_elsewhere", "nonowner_voter_at_subject"]) {
      expect(reasoning_path_ids()).not.toContain(p);
    }
  });

  test("legal_address_presence keeps 5 atomics and no longer claims voter", () => {
    const packet = get_packet_catalog().find((p: any) => p.id === "legal_address_presence") as any;
    expect(packet.atomic_heuristic_ids).toEqual([
      "drive_address_subject_analysis",
      "auto_address_subject_analysis",
      "owner_legal_records_conflict",
      "auto_only_owner_elsewhere_discount",
      "auto_at_subject_but_stronger_legal_elsewhere",
    ]);
    expect(packet.input_sources).toEqual(["drive", "auto", "tax"]);
  });

  test('no packet scope, gate, guidance or field ref mentions a dead source', () => {
    const text = JSON.stringify(get_packet_catalog()) + JSON.stringify(get_heuristic_catalog());
    for (const dead of ["voter", "criminal", "linkedin"]) {
      expect(text).not.toContain(dead);
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/heuristics_catalogue.test.ts`
Expected: FAIL — `expect(25).toBe(23)`

- [ ] **Step 3: Apply the removals**

`atomic.ts` — delete the `voter_address_subject_analysis` family (1022–1091) and the `drive_voter_conflict_same_person` heuristic (1445–1471). Delete the five optional `field("voter", …)` refs and rewrite the two prose strings that name voter: line 728 `"owner drive/voter/auto address differs from subject"` → `"owner drive/auto address differs from subject"`; line 1215 `"no owner drive/voter elsewhere corroboration"` → `"no owner drive elsewhere corroboration"`.

`atomic_eval.ts` — the local source families (330–360) become `SUBSTANTIVE_SOURCES = [tax, base, loan, drive, auto, trace, utility]`, `STRONG_OCCUPANCY_SOURCES = [drive, auto, loan, trace, utility]`, `STRONGER_THAN_UTILITY = [drive, auto, loan, trace]`, `STRONGER_THAN_TRACE = [drive, auto, loan, utility]`. Delete the `voter_address_subject_analysis` and `drive_voter_conflict_same_person` gate entries; drop `"voter"` from `owner_legal_records_conflict.required_sources` (now `["drive","auto"]`, viability `"Run when both drive and auto have rows."`), from `auto_only_owner_elsewhere_discount.optional_sources` and its viability text, from `auto_at_subject_but_stronger_legal_elsewhere` (now `optional_sources: ["drive"]`), from `portfolio_primary_comparison_analysis.optional_sources`, from line 635's ID-row backfill loop, and from the `owner_legal_records_conflict` / `auto_only_owner_elsewhere_discount` runtime predicates at 952/973.

`packets.ts` — drop `"voter"` from `owner_identity_and_mailing` (67, 83), `occupancy_signals` (108, 119, 124), `legal_address_presence` (147, 156, 159–160) and `portfolio_and_primary_comparison` (202, 212); drop the two atomic ids from `legal_address_presence.atomic_heuristic_ids` (140, 144) and `"drive_voter_conflicts"` from its `output_fields` (152). Rewrite its description/guidance around what survives: *"Review drive and auto address evidence for owner/non-owner presence and auto-only caveats. Treat drive as corroborating rather than independent: in this corpus a drive row is the same physical record as a loan row."*

`packet_gates.ts` — remove `"voter"` from the comparable-rows loops (227, 453) and from `_field_gate_legal_address_presence` (342, 351–352, 356, 366, 374, 379) so its `field_presence` diagnostics stop reporting a permanently-zero `voter_rows`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/heuristics_catalogue.test.ts test/score_benchmark.test.ts test/packets_exposure_map.test.ts`
Expected: PASS. If the golden table moved (removing the two heuristics can retire an active path), re-harvest per Task 13 Step 3 and amend `GOLDEN` **in this commit**, noting the second delta in the message.

- [ ] **Step 5: Commit**

```bash
git add src/heuristics test/heuristics_catalogue.test.ts test/score_benchmark.test.ts
git commit -m "feat(heuristics): drop voter_address_subject_analysis and drive_voter_conflict_same_person"
```

---

## Task 16: `prompts.ts` — re-calibrate for the hatch and the reduced surface

Every change traces to the "can no longer answer" list. Nothing is invented.

**Files:**
- Modify: `src/agents/prompts.ts:70,74,138-165,194,198,232,238,247,257,284,300,376-380,436-500,657,1060,1065`
- Modify: `src/agents/typed_tools.ts` (add `sql_tools_guide`)
- Test: `test/prompts_data_surface.test.ts` (create); update `test/prompts_register.test.ts`

- [ ] **Step 1: Write the failing test**

`test/prompts_data_surface.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  DATA_SURFACE_PRIMER,
  HEURISTIC_SYSTEM_PROMPT,
  MINI_SCHEMA_GUIDE,
  SOURCE_HUMAN_PHRASES,
  TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT,
  heuristic_user_prompt,
  schema_context_for_heuristic,
} from "../src/agents/prompts.ts";
import { sql_tools_guide, typed_tools_guide } from "../src/agents/typed_tools.ts";

const ALL = [
  DATA_SURFACE_PRIMER,
  MINI_SCHEMA_GUIDE,
  HEURISTIC_SYSTEM_PROMPT,
  TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT,
  schema_context_for_heuristic({ input_sources: ["tax", "drive"] }),
  typed_tools_guide({ context_scope: ["tax"] }),
  sql_tools_guide({ context_scope: ["tax"] }),
  heuristic_user_prompt({ id: "h", packet: true, input_sources: ["tax"] }, { evidence_map: {} }, null),
].join("\n");

describe("no prompt advertises a surface that no longer exists", () => {
  test("GraphQL vocabulary is gone everywhere", () => {
    for (const dead of [
      "GraphQL", "graphql", "execute_graphql", "validate_graphql", "resolveAddress",
      "personAssociations", "propertyAssociations", "addressAssociations", "sourceRecord",
      "totalCount", "hasMore", "WhereInput", "mutation", "subscription", "```graphql",
      "get_address_records", "get_people_at_address", "get_person_records",
    ]) {
      expect(ALL).not.toContain(dead);
    }
  });

  test("the three dead shapes are gone everywhere, including the register glossary", () => {
    for (const dead of ["voter", "criminal", "linkedin"]) {
      expect(ALL).not.toContain(dead);
      expect(Object.keys(SOURCE_HUMAN_PHRASES)).not.toContain(dead);
    }
  });
});

describe("the primer describes the real access paths", () => {
  test("it names the six typed operations and the seven live shapes", () => {
    for (const op of ["resolve", "records", "people", "search", "source record"]) {
      expect(DATA_SURFACE_PRIMER.toLowerCase()).toContain(op);
    }
    expect(DATA_SURFACE_PRIMER).toContain("base, tax, utility, trace, auto, loan, drive");
  });

  test("it names the owner-elsewhere pattern, which is the corpus's strongest use case", () => {
    // Grounded in spec §7: the signal is on the subject's own tax row; the pattern is
    // resolve subject -> read tax -> take the owner mailing address -> resolve THAT.
    expect(DATA_SURFACE_PRIMER).toContain("owneraddressline1");
    expect(DATA_SURFACE_PRIMER).toContain("resolve that mailing address as a second address");
  });

  test("it warns that a drive row is not independent of the loan row", () => {
    expect(DATA_SURFACE_PRIMER).toContain("the same physical record as a loan row");
  });
});

describe("hatch guidance (tools mode)", () => {
  test("names run_sql, the refusal contract, and the provenance rule", () => {
    const g = sql_tools_guide({ context_scope: ["tax"] });
    expect(g).toContain("run_sql");
    expect(g).toContain("describe_schema");
    expect(g).toContain("get_source_record");
    // Grounded: run_sql returns column/row arrays with no rowid, so nothing is auto-harvested.
    expect(g).toContain("carries no provenance");
  });

  test("names the one question only the hatch can answer", () => {
    expect(sql_tools_guide({})).toContain("other properties");
  });
});

describe("bounded guidance (typed_tools mode)", () => {
  test("says plainly what that mode cannot reach", () => {
    expect(TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT).toContain("cannot enumerate an owner's other properties");
    expect(TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT).not.toContain("run_sql");
  });
});

describe("identity confidence", () => {
  test("the primer tells the model to discount a low-confidence or suspicious identity", () => {
    expect(DATA_SURFACE_PRIMER).toContain("identity_confidence");
    expect(DATA_SURFACE_PRIMER).toContain("is_suspicious");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/prompts_data_surface.test.ts`
Expected: FAIL — `Export named 'DATA_SURFACE_PRIMER' not found`

- [ ] **Step 3: Rewrite the prompt surface**

Replace `GRAPHQL_PRIMER` / `MINI_SCHEMA_GUIDE` (138–141):

```ts
export const DATA_SURFACE_PRIMER = [
  "You read one local occupancy dataset through a fixed set of typed operations. Live record shapes:",
  "base, tax, utility, trace, auto, loan, drive. There are no other shapes — do not ask for records",
  "the dataset does not hold.",
  "Owner-elsewhere is the strongest signal this dataset supports, and it is already on the subject's",
  "own tax row: owneraddressline1 / ownercity / ownerstate / ownerzipcode. To follow it, read the tax",
  "row, then resolve that mailing address as a second address and read its records.",
  "A drive row is NOT independent evidence: this dataset has no motor-vehicle feed, so a drive row is",
  "the same physical record as a loan row. Never count them as two corroborating sources.",
  "Person entities carry identity_confidence and is_suspicious. The identity graph is noisy — peak",
  "confidence is ~40 and roughly one identity in six is flagged suspicious. Discount a low-confidence",
  "or suspicious identity in your reasoning and say so.",
].join("\n");

export const MINI_SCHEMA_GUIDE = DATA_SURFACE_PRIMER;
```

Delete `ADDRESS_SOURCE_FIELDS` / `PERSON_SOURCE_FIELDS` (143–165) — they were GraphQL field maps used only by `_heuristic_sources` for validity filtering. Replace that filter with a check against `ADDRESS_SHAPES` imported from `retrieval.ts`, so there is exactly one shape catalogue in the repo.

`HEURISTIC_SYSTEM_PROMPT` (194, 198): replace *"Work only from the local GraphQL database … Follow the schema guide exactly; if a query fails, revise it using the schema guide rather than inventing fields or types."* with:

```
Work only from the local occupancy dataset. No external lookups — your value is in rigorous local-evidence analysis, not in reaching beyond your dataset. Use the typed tools first; reach for run_sql only for a question they cannot answer. If a query is refused, read the refusal's reason and hint and move the predicate onto an indexed access path — do not retry the same shape.
```
…and line 198's *"inspect the local GraphQL database"* → *"inspect the local occupancy dataset"*.

`TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT` (205–214): after *"You cannot write raw queries — use the tools provided."* add:

```
In this mode you cannot enumerate an owner's other properties: the property rows carry no identifier that reaches the person graph. If a heuristic needs that, say so in missing_evidence rather than inferring it.
```

`heuristic_user_prompt` (232, 238, 247, 257, 284, 300) and `grouped_heuristic_user_prompt` (376–380): `query_requirements` becomes `[\`- ${DATA_SURFACE_PRIMER}\`, "- If run_sql is refused, use the returned reason and hint; do not repeat a refused predicate."]`; the `include_shortcuts` splice at 236–242 and 379–381 is deleted with the parameter (D1); the section headings `"GraphQL Query Requirements"` / `"GraphQL query requirements:"` → `"Data Access Requirements"` / `"Data access requirements:"`; and the two `"using the local GraphQL database and submit your findings."` lines → `"using the local occupancy dataset and submit your findings."`.

`schema_context_for_heuristic` (436–500): delete every `lines.push("```graphql")` block and the four GraphQL skeletons. Replace the whole body with:

```ts
export function schema_context_for_heuristic(heuristic: Dict): string {
  const shapes = _heuristic_sources(heuristic);
  const lines = [
    "- Start from the resolved subject address; the typed tools default to it.",
    "- get_records(shapes=[...]) fetches several shapes for one entity in ONE call. Prefer it.",
    "- To follow a person: get_people or search_people for an id, then get_records(person_id=...).",
    "- Person ids are addr:<addressId>:<n> (bundle) or hal:<hal_id> (identity graph). hal: ids carry",
    "  identity_confidence and is_suspicious — read them before trusting a traversal.",
    "- run_sql is for questions the typed tools cannot answer. Its results carry no provenance:",
    "  call get_source_record(shape, rowid) to turn a SQL hit into a citable evidence reference.",
  ];
  if (shapes.length > 0) {
    lines.push(`- Shapes relevant to this heuristic: ${[...new Set(shapes)].join(", ")}.`);
  }
  return lines.join("\n");
}
```

`SOURCE_HUMAN_PHRASES` (65–77): delete the `voter` and `criminal` entries. Change `drive` from `"driver's-license record"` to `"licence-bearing loan record"` so the glossary stops implying an independent DMV source.

Line 657: `schema_mini_guide: MINI_SCHEMA_GUIDE` stays (it is now the data-surface primer; `TypedToolset.build_context` still deletes it, `SqlToolset.build_context` keeps it).

Lines 1060 and 1065: `"local GraphQL evidence"` → `"local record evidence"`; `"cite concrete source rows or GraphQL result summaries"` → `"cite concrete source rows or tool result summaries"`.

- [ ] **Step 4: Add `sql_tools_guide` to `typed_tools.ts`**

Append, beside `typed_tools_guide` (which is unchanged apart from the dropped tools):

```ts
/** The typed-tools guide plus the hatch. Used only by SqlToolset ("tools" mode). */
export function sql_tools_guide(heuristic: Record<string, any>): string {
  return [
    typed_tools_guide(heuristic),
    "Exploratory SQL (use only when the typed tools cannot answer the question):",
    "- describe_schema: the tables, the indexed access paths that are actually fast, and the known data-quality caveats. Read it BEFORE writing SQL.",
    "- run_sql(query): one read-only SELECT. A LIMIT is injected if you omit one. A predicate off an indexed path is refused before execution and returns the planner's reason plus a hint — repair against the hint, do not retry the same shape.",
    "- get_source_record(shape, rowid): a run_sql result carries no provenance, so a SQL hit is not citable evidence until you fetch the row this way.",
    "The concrete job for SQL here: enumerating an owner's other properties. The property rows carry no identifier that reaches the person graph, so no typed tool can reach them; last_name is the only fully-populated key.",
  ].join("\n");
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `OE_PROSE_REGISTER=off bun test test/prompts_data_surface.test.ts test/prompts_register.test.ts test/prompts_external_scope.test.ts test/prompts_rental_market.test.ts`
Expected: PASS. `prompts_register.test.ts` asserts the glossary string verbatim — update its expected line to the new one (no `voter`, no `criminal`, `drive → licence-bearing loan record`).

- [ ] **Step 6: Commit**

```bash
git add src/agents/prompts.ts src/agents/typed_tools.ts test/prompts_data_surface.test.ts test/prompts_register.test.ts test/prompts_external_scope.test.ts test/prompts_rental_market.test.ts
git commit -m "feat(prompts): re-calibrate for the typed surface, the SQL hatch and the seven live shapes"
```

---

## Task 17: `investigate_server.ts` — the Contract A default

**Files:**
- Modify: `src/server/investigate_server.ts:7,28,85,98,102`
- Test: `test/http_service.test.ts`

- [ ] **Step 1: Write the failing test**

Replace `VALID_BODY` (line 15) and the healthz test (line 201) in `test/http_service.test.ts`, and append:

```ts
const VALID_BODY = { address: "1104 SPRING RUN RD", zip: "40514", data_url: "http://127.0.0.1:9" };

describe("Contract A", () => {
  test("400s a body still sending graphql_url (strict schema, no shim)", async () => {
    const engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => ({}) as any });
    try {
      const r = await fetch(`${engine.url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ address: "a", graphql_url: "http://graphql:8000/graphql" }),
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as any;
      expect(JSON.stringify(body.error.issues)).toContain("data_url");
    } finally {
      await engine.stop();
    }
  });

  test("healthz constructs the data client from the http://graph:8000 default", async () => {
    const engine = create_engine_server({ port: 0, auth_token: TOKEN });
    try {
      expect((await fetch(`${engine.url}/healthz`)).status).toBe(200);
    } finally {
      await engine.stop();
    }
  });
});
```
…replacing the three other `graphql_url` sites (32, 117, 201) with `data_url`.

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/http_service.test.ts`
Expected: FAIL — `Cannot find module '../agents/graphql_tool.ts'` from `investigate_server.ts`

- [ ] **Step 3: Apply the edits**

- Line 7 → `import { DataHttpClient } from "../agents/data_client.ts";`
- Line 28 → `data_url?: string; // healthcheck default; investigations carry their own data_url`
- Line 85 → `const data_url_default = opts.data_url ?? process.env.DATA_URL ?? "http://graph:8000";`
- Line 98 comment → `"proves the LLM + data clients construct"`
- Line 102 → `new DataHttpClient(data_url_default);`

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REGISTER=off bun test test/http_service.test.ts test/investigation_wire.test.ts test/fake_engine_server.test.ts`
Expected: PASS (replace `graphql_url` with `data_url` in the latter two — 3 sites each)

- [ ] **Step 5: Commit**

```bash
git add src/server/investigate_server.ts test/http_service.test.ts test/investigation_wire.test.ts test/fake_engine_server.test.ts
git commit -m "feat(server): data_url with the http://graph:8000 default (Contract A)"
```

---

## Task 18: CLI flags + env

**Files:**
- Modify: `cli/run_address.ts:19-21,74,79-80,104-105,113-115,124-126`, `cli/serve.ts:22`
- Test: `test/run_address_env.test.ts`

- [ ] **Step 1: Write the failing test**

Replace `test/run_address_env.test.ts` entirely:

```ts
import { describe, expect, test } from "bun:test";
import { resolveDataUrl } from "../cli/run_address.ts";

describe("resolveDataUrl", () => {
  test("prefers the flag, falls back to DATA_URL, else undefined", () => {
    expect(resolveDataUrl("http://flag", "http://env")).toBe("http://flag");
    expect(resolveDataUrl(undefined, "http://env")).toBe("http://env");
    expect(resolveDataUrl(undefined, undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REGISTER=off bun test test/run_address_env.test.ts`
Expected: FAIL — `Export named 'resolveDataUrl' not found`

- [ ] **Step 3: Apply the edits**

`cli/run_address.ts`:
- Lines 19–21 → `export function resolveDataUrl(flag: string | undefined, env: string | undefined): string | undefined { return flag ?? env ?? undefined; }`
- Line 76 option key `"graphql-url"` → `"data-url"`; `"max-graphql-calls-per-agent"` → `"max-data-calls-per-agent"`; `"graphql-timeout-seconds"` → `"data-timeout-seconds"`; delete `"include-shortcuts"` (D1).
- Line 104 → `const dataUrl = resolveDataUrl(values["data-url"], process.env.DATA_URL);`
- Line 112 → `process.stderr.write("--data-url is required (or set DATA_URL)\n");`
- Lines 129/134/135 → `data_url: dataUrl`, `max_data_calls_per_agent: …["max-data-calls-per-agent"]`, `data_timeout_seconds: …["data-timeout-seconds"]`; delete the `include_shortcuts` line.

`cli/serve.ts:22` → `data_url: process.env.DATA_URL,`

- [ ] **Step 4: Run the tests, verify they pass**

Run: `OE_PROSE_REGISTER=off bun test test/run_address_env.test.ts test/run_address_evidence.test.ts test/report_destination.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli test/run_address_env.test.ts test/run_address_evidence.test.ts
git commit -m "feat(cli): --data-url / DATA_URL; retire --include-shortcuts"
```

---

## Task 19: E2E + cancellation suites onto the fixture data service

**Files:**
- Modify: `test/e2e/orchestrator.e2e.test.ts`, `test/e2e/http_service.e2e.test.ts`, `test/cancellation.test.ts`, `test/external_evidence_exposure.test.ts`, `test/support/subagents.ts`

- [ ] **Step 1: Repoint E2E-1..E2E-4**

In `test/e2e/orchestrator.e2e.test.ts` replace, at all 14 sites:
- `import { GraphQLHttpTool }` → `import { DataHttpClient } from "../../src/agents/data_client.ts";`
- `import { FixtureGraphQLServer }` → `import { FixtureDataService } from "../support/fixture_data_service.ts";`
- `loadPreflight1104()` → `{ resolve: resolve1104(), address_people: people1104(), address_records: { records_by_source: (resolve1104() as any).records_by_source, unsupported_shapes: [] } }`
- `new FixtureGraphQLServer(payload)` → `new FixtureDataService(plan)`
- `graphql: new GraphQLHttpTool(server.url)` → `data: new DataHttpClient(server.url)`
- `graphql_url: server.url` → `data_url: server.url`
- `expect(server.requests.length).toBeGreaterThanOrEqual(1)` → `expect(server.requests.map((r) => r.path)).toContain("/v1/resolve")`

The two prose guards at lines 41–48 (`ownerSummary` starts with `Owner `, contains `Josiah`, contains no `=`) are unchanged and must stay green — they are the wiring regression guard for `resolved_address: displayContext`.

- [ ] **Step 2: Add the no-GraphQL E2E guard**

Append to `test/e2e/orchestrator.e2e.test.ts`:

```ts
describe("E2E-5: no code path attempts GraphQL", () => {
  test("a full investigation touches only Contract B/C paths", async () => {
    const server = new FixtureDataService({
      resolve: resolve1104(),
      address_people: people1104(),
      address_records: { records_by_source: (resolve1104() as any).records_by_source, unsupported_shapes: [] },
      schema: { tables: [], access_paths: [], caveats: [] },
    });
    try {
      const orch = new AgentOrchestrator({ data: new DataHttpClient(server.url), subagent: new FakeSubagent() });
      await orch.investigate(
        AgentInvestigationRequestSchema.parse({ address: "1104 SPRING RUN RD", zip: "40514", data_url: server.url }),
      );
      for (const r of server.requests) {
        expect(r.path.startsWith("/v1/")).toBe(true);
      }
      expect(server.requests.some((r) => r.path === "/graphql")).toBe(false);
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 3: Repoint the remaining suites**

`test/e2e/http_service.e2e.test.ts` (6 sites), `test/cancellation.test.ts` (6 sites, incl. line 81's `new CountingGraphQLTool(new GraphQLHttpTool("http://127.0.0.1:9/graphql"), { max_calls: 8 })` → `new CountingDataClient(new DataHttpClient("http://127.0.0.1:9"), { max_calls: 8 })`), `test/external_evidence_exposure.test.ts`, and `test/support/subagents.ts` (`run(agent_input, graphql)` → `run(agent_input, data)`).

- [ ] **Step 4: Run the suites, verify they pass**

Run: `OE_PROSE_REGISTER=off bun run e2e && OE_PROSE_REGISTER=off bun test test/cancellation.test.ts test/external_evidence_exposure.test.ts`
Expected: e2e `7 pass / 0 fail`; the other two green

- [ ] **Step 5: Commit**

```bash
git add test/e2e test/cancellation.test.ts test/external_evidence_exposure.test.ts test/support/subagents.ts
git commit -m "test(e2e): drive the fixture data service; guard that no path attempts GraphQL"
```

---

## Task 20: Delete `graphql_tool.ts` and the `graphql` dependency

**Files:**
- Delete: `src/agents/graphql_tool.ts`
- Modify: `package.json`, `bun.lock`

- [ ] **Step 1: Prove nothing imports it**

Run: `grep -rn "graphql_tool\|GraphQLHttpTool\|CountingGraphQLTool\|GraphQLToolError\|from \"graphql\"" src cli test scripts`
Expected: no output

- [ ] **Step 2: Delete and drop the dependency**

```bash
git rm src/agents/graphql_tool.ts
bun remove graphql
```
Expected: `package.json` loses `"graphql": "^17.0.2"`; `bun.lock` updates.

- [ ] **Step 3: Full gate**

Run: `OE_PROSE_REGISTER=off bun run verify`
Expected: exit 0; `Found 0 warnings` (all three pre-existing warnings lived in rewritten files); test count ≥ 195.

- [ ] **Step 4: Prove the word is gone from `src/`**

Run: `grep -rni "graphql" src/ | grep -v "^src/observability/pricing.ts"`
Expected: no output

- [ ] **Step 5: Commit**

```bash
git add -A src package.json bun.lock
git commit -m "chore: delete graphql_tool.ts and the graphql dependency"
```

---

## Task 21: compose, Dockerfile, README, AGENTS.md, init.sh

**Files:** `compose.yaml`, `README.md`, `AGENTS.md`, `init.sh`

- [ ] **Step 1: `compose.yaml` — service `graphql` → `graph`**

```yaml
services:
  graph:
    build: ./services/graph
    environment:
      PARTNER_DSN: ${PARTNER_DSN}
      PARTNER_STATEMENT_TIMEOUT_MS: ${PARTNER_STATEMENT_TIMEOUT_MS:-20000}
      PARTNER_POOL_MIN: ${PARTNER_POOL_MIN:-1}
      PARTNER_POOL_MAX: ${PARTNER_POOL_MAX:-8}
    ports:
      - "8000:8000"
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/v1/schema')"]
      interval: 5s
      timeout: 3s
      retries: 20

  agent:
    build: .
    depends_on:
      graph:
        condition: service_healthy
    environment:
      DATA_URL: http://graph:8000
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      ENGINE_AUTH_TOKEN: ${ENGINE_AUTH_TOKEN:-dev-engine-token}
      ENGINE_PORT: "8787"
    ports:
      - "8787:8787"
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:8787/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 20
```
The SQLite bind mount goes with the storage migration that already landed in the service; the DSN is supplied by the environment.

Run: `docker compose config >/dev/null && echo ok`
Expected: `ok`

- [ ] **Step 2: `README.md`**

Replace the intro (`talks to the existing Python GraphQL server over HTTP`) with *"talks to the occupancy data service over six typed HTTP operations plus a guarded SQL hatch"*, and the compose block:

```
    git submodule update --init --recursive          # fetch services/graph
    export PARTNER_DSN=postgres://…                  # partner corpus
    docker compose up -d graph                       # data service on :8000
    docker compose up -d agent                       # engine service on :8787
    docker compose down
```
plus *"The data boundary is the six typed operations of `POST /v1/resolve`, `GET /v1/address/{id}/records|people`, `GET /v1/person/{id}/records`, `GET /v1/people/search`, `GET /v1/source-record/{shape}/{rowid}`, and the hatch at `POST /v1/sql` / `GET /v1/schema`. The agent reads `DATA_URL`."*

- [ ] **Step 3: `AGENTS.md`**

- Project overview: *"It talks to the occupancy data service over typed HTTP; the database/backend stays Python."*
- Tech stack: delete the `GraphQL: graphql-js 17 (graphql)` line.
- Verification commands: change to `OE_PROSE_REGISTER=off bun run verify` and note that `OE_PROSE_REDACT` must stay on.
- Replace the whole "Refreshing the E2E fixture" section with:

```
## The E2E fixture

`test/support/fixtures/resolve_1104.json` is a hand-maintained `POST /v1/resolve` body for
1104 SPRING RUN RD / 40514. There is no capture script: the contract is typed, so the fixture is
edited directly against it rather than re-scraped. `test/support/fixture_data_service.ts` serves it
over real HTTP and 404s any route the contract does not pin.
```

- [ ] **Step 4: `init.sh`**

`START_HINT` → `bun run run-address --address '1104 SPRING RUN RD' --zip 40514 --data-url http://127.0.0.1:8000`; both comments referencing "the Python GraphQL server" → "the occupancy data service".

Run: `bash -n init.sh && echo ok`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add compose.yaml README.md AGENTS.md init.sh
git commit -m "docs: repoint compose, README, AGENTS and init at the data service"
```

---

## Task 22: Close the harness loop

**Files:** `feature_list.json`, `PROGRESS.md`

- [ ] **Step 1: Run the full gate and capture the real output**

```bash
OE_PROSE_REGISTER=off bun run verify
OE_PROSE_REGISTER=off bun run e2e
bun test   # under the .env defaults, to record the known 1 tautological failure
```
Expected: verify exit 0 with 0 lint warnings; e2e `7 pass / 0 fail`; the `.env` run showing `N pass / 1 fail` with the failure being `_prose_register_lines (gated) > is empty by default`.

- [ ] **Step 2: Flip `feature_list.json` to `passing`** with the captured counts pasted verbatim into `evidence` (never projected numbers).

- [ ] **Step 3: Append a `PROGRESS.md` Session Record** with goal / completed (branch + task list) / verification / evidence / **the before→after score table from Task 14** / risks / next best action.

- [ ] **Step 4: Confirm a clean tree**

Run: `git status --short`
Expected: no output (`services/graph` must not show as modified — do not commit a submodule pointer bump from this repo; the umbrella sequences it)

- [ ] **Step 5: Commit and open the PR against `main`**

```bash
git add feature_list.json PROGRESS.md
git commit -m "docs(harness): record X-016 evidence and the drive re-weight benchmark"
git push -u origin feat/typed-data-service
gh pr create --base main --title "X-016: typed data service client + SQL hatch" --body "…"
```

---

## Verification / Definition of Done

- [ ] `OE_PROSE_REGISTER=off bun run verify` green, run in place (`occupancy-engine-ts/`) — 0 lint warnings
- [ ] `OE_PROSE_REGISTER=off bun run e2e` green, including the E2E-5 no-GraphQL guard
- [ ] `grep -rni "graphql" src/ cli/ test/` returns nothing outside `src/observability/pricing.ts`
- [ ] `grep -rn "voter\|criminal\|linkedin" src/` returns nothing
- [ ] The score benchmark's before→after delta is recorded in the Task 14 commit message **and** in `PROGRESS.md` — the umbrella's item 5 ("the `drive` re-weighting moves the deterministic score for every case; compare before/after on a fixed case set") is satisfied by `test/score_benchmark.test.ts` and its two golden revisions, not by an assertion that it was checked
- [ ] `docker compose config` exits 0 with services `graph` + `agent` and `DATA_URL: http://graph:8000`
- [ ] `feature_list.json` entry `passing` with real `evidence`; `PROGRESS.md` Session Record appended; `git status` clean; **no `services/graph` pointer bump in this repo's commits**
- [ ] Umbrella `docs/harness/progress.md` updated; `scripts/harness-doctor.sh` green
- [ ] Cross-repo steps 2–4 of the umbrella's end-to-end verification are the **coordinator's**, run after the graph service merges — this plan's own gates do not depend on a live service

### Deferred, deliberately
- **Live engine ↔ graph-service run** (umbrella verification item 2) needs the service's typed surface deployed. Not runnable here; not faked.
- **Hatch adversarial pass** (item 3) belongs to the graph-service plan — the guard is server-side. The engine's obligation is only that a 422 is returned, not thrown, which `test/data_client.test.ts` and `test/sql_toolset.test.ts` prove.
- **`heuristics/atomic_eval.ts` `build_evidence` / `engine.ts` `evaluate_address`** are dead at runtime (called from nothing outside their own export chain — grep-verified) and still carry a SQLite `db_path` option. Out of scope; flagged in `PROGRESS.md` as the next cleanup.
- **`heuristics[].graphql_queries` → `data_queries` in the backend's `investigation-report.dto.ts` doc comment.** The field itself is safe to rename (the VO is `.passthrough()`, `heuristics` is `z.array(z.unknown())`, the read DTO is closed), but the stale comment is the backend's to fix.

---

### Critical Files for Implementation
- `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/src/agents/graphql_tool.ts` (→ `data_client.ts`; `CountingGraphQLTool:221-399` is the budget accounting that must survive)
- `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/src/agents/orchestrator.ts` (`PREFLIGHT_QUERY:73`, `ADDRESS_BY_ID_QUERY:107`, `preflight:407`, `_evidence_map:1311`)
- `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/src/agents/toolsets/graphql_toolset.ts` (→ `sql_toolset.ts`; `_union_source_scope:515` moves to `typed_toolset.ts`)
- `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/src/heuristics/policy.ts` (the `drive: 1.15` weight and `RANKED_SOURCE_ORDER`)
- `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/src/agents/prompts.ts` (`GRAPHQL_PRIMER:138`, `schema_context_for_heuristic:436`, `SOURCE_HUMAN_PHRASES:65`)

Two findings worth surfacing to the coordinator, both discovered while tracing and neither in the brief:

1. **`schema_guide.ts` is currently dead code** — `orchestrator.ts:409` hardcodes `const schema_guide = "";` and nothing in `src/` calls `SCHEMA_GUIDE_QUERY` or `summarizeSchemaGuide`. The brief's "fetches `GET /v1/schema` instead of GraphQL introspection" therefore *revives* a module rather than converting a live one. The plan wires it into preflight for `"tools"` mode only (D5).

2. **The `voter` blast radius is wider than the two heuristics.** `packets.ts` sets `context_scope: packet.input_sources`, and `typed_tools._normalize_shapes` feeds that scope straight into `get_records` without filtering against `ALL_SHAPES` — so leaving `"voter"` in four packets' `input_sources` would make `get_records` return `{ok: false, "Unknown shape(s)"}` for the *whole call*, silently starving those packets. `atomic_eval.ts:330` also keeps a **second, local** `SUBSTANTIVE_SOURCES` list (commented "declared locally here, not via policy") that must be edited alongside `policy.ts`, and `synthesis.ts:443` / `packet_gates.ts:342` carry voter-specific branches. Tasks 7 and 15 cover all of it; Task 7 additionally makes `get_records` degrade rather than fail, so a future stale scape token cannot reproduce this failure mode.