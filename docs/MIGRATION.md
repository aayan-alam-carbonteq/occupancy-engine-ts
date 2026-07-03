# occupancy-engine → TypeScript migration

Port of the **agent application** from `occupancy-engine` (Python). Scope decided with the owner:
**agent app only** — `agents`, `heuristics`, `observability`, `judge`, and the CLI runners. The TS agents
talk to the **existing Python GraphQL server over HTTP** (unchanged `graph.sqlite`). The data backend
(GraphQL server + SQLite + ETL/indexing) stays in Python ("database modelling may remain as is").

Runtime: **Bun** (native TS, test runner, fetch). Source of truth for behavior: the Python repo at
`../occupancy-engine`. Every logical flow of the agents is preserved 1:1.

## Library mapping (ports of the same library, not swaps)

| Python | TypeScript | notes |
|---|---|---|
| `langchain`, `langchain-core` | `langchain`, `@langchain/core` | LangChain.js — same library |
| `langchain-anthropic/openai/google-genai` | `@langchain/anthropic` / `@langchain/openai` / `@langchain/google-genai` | same |
| `langsmith` | `langsmith` | same JS SDK |
| `pydantic` (BaseModel + validators) | `zod` | **no pydantic-js exists**; zod is the idiomatic equivalent |
| `httpx` | native `fetch` | Node/Bun built-in |
| `pytest` | `bun test` | |

### Confirmed API equivalences (live-verified)
- `@tool(args_schema=X)` → `tool(fn, { name, description, schema: zodSchema })`
- `llm.bind_tools(tools, tool_choice="any")` → `llm.bindTools(tools, { tool_choice: "any" })`
- Response `.tool_calls` → `[{ name, args, id, type }]` (identical to `_response_tool_calls` shape)
- `usage_metadata.input_token_details.{cache_read,cache_creation}` present → `extract_usage` + cost model port directly
- SystemMessage/HumanMessage with `cache_control` content blocks work → prompt caching ports directly

## Port order (bottom-up; leaves first so each layer type-checks against real deps)

1. **Foundation** — `env`, `observability/{models,usage,pricing,recorder,tracing}`, `agents/models` (zod),
   `heuristics/types`.
2. **Heuristics data** — `heuristics/{policy,atomic_eval,atomic_heuristics,packets,packet_gates,synthesis,scoring}`.
3. **Agent infra** — `agents/{llm,query_cache,tracing,graphql_tool,schema_guide,catalog,retrieval,typed_tools}`.
4. **Prompts** — `agents/prompts` (817 LOC of prompt builders — behavior-critical, ported verbatim).
5. **Toolsets** — `agents/toolsets/{base,graphql_toolset,typed_toolset}`.
6. **Core loop** — `agents/subagents` (the turn loop, grouped subagent, cache/force-tool flags).
7. **Orchestrator** — `agents/orchestrator` (preflight, gating, planner, bucketing, adjudicator, flatten).
8. **CLI** — `cli/{run_address,run_investigation_batch}`; **judge** — `judge/*`.

## Verification strategy

- `bun test` unit tests ported from the Python `tests/` for pure logic (models, packets, gating,
  grouped-subagent collection, prompt assembly).
- End-to-end: run the TS `run_address` against the live Python GraphQL server on `:8000` and diff the
  structured assessment (packets, statuses, evidence_refs) against the Python output for the same address.
- Env flags preserved: `OE_PROMPT_CACHE`, `OE_FORCE_TOOL_CALL`, `--disable-master-planning`.

## Conventions

- Files mirror the Python module names (`orchestrator.py` → `orchestrator.ts`).
- pydantic `BaseModel` → `zod` schema + inferred type; `model_validator` → `.superRefine`; coercion
  helpers (`_coerce_result_payload`) → explicit build-then-parse functions preserving the same mutations.
- `async def` → `async` functions; `asyncio.gather` → `Promise.all`; `asyncio.Semaphore` → a small
  concurrency limiter.

## Known inherent divergences (JS vs Python)

- **Whole-valued floats in JSON text.** Python serializes `16.0`; JS (no int/float distinction) emits
  `16`. Numerically identical, only the JSON textual form differs. Affects synthesis
  `raw_signal_score`/`weighted_*_score` and any float that lands on an integer. Not fixable without a
  custom serializer and not behavior-affecting; noted for byte-diff expectations.
- **`str()`/`repr()`/`json.dumps` parity.** Where the Python builds prompt/summary TEXT from values, the
  ports reproduce Python's `str()` ("None"/"True"/"False"), `repr()`, and `json.dumps(sort_keys=True,
  ensure_ascii=True)` semantics with small local helpers (`pyStr`, `pyJsonDumps`, etc.) so rendered strings
  and byte/char counts match. Verified byte-for-byte for prompts, payload_metadata, and graphql summaries.
- **GraphQL validation error wording.** graphql-js quotes identifiers with `"double quotes"` vs
  graphql-core's `'single quotes'`; the graphql_tool port normalizes the message line (only) so the
  toolset's substring-based hint/skeleton matching fires identically.

## End-to-end verification (2026-07-03)

Ran the ported TS pipeline (`bun run cli/run_address.ts`) against the live Python GraphQL server on
`1104 SPRING RUN RD` (typed_tools, haiku, --disable-master-planning) and compared to the Python pipeline
on the same address/server:

- **Runs clean end-to-end**: 6 packets, 0 errors; both grouped conversations formed
  (`property_tax+owner_identity`, `subject_occupancy+legal_address`); evidence manifest injected; scored
  (final=15, band=review); adjudicated (calibrated=12, archetype `owner_present_with_rental_indicators`);
  report generated; `metrics_events` correctly excluded from output JSON.
- **Deterministic parity with Python is exact** (code-driven, not LLM): `address_id` 3342, all
  `source_counts`, `ambiguous`, the gated packet set, and owner/people summary counts all match. Only
  LLM-generated content differs (stochastic, expected).

Conclusion: the agent logical flows — preflight, gating, grouped-subagent bucketing/dispatch, turn loop,
evidence manifest, scoring, adjudication — are faithfully preserved.

## Remaining (benchmark/tooling, not the agent pipeline)
- `cli/run_investigation_batch.ts` (batch runner) + `observability/summaries` (batch CSV rollups) — the
  single-address path is fully ported/verified; batch is a thin wrapper over it.
- `judge/` package (offline benchmark judge).
