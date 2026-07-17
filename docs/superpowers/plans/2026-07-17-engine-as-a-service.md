# Engine as an Independent HTTP Service (X-013) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing `investigate_address()` pipeline in a long-running, stateless `Bun.serve` HTTP service exposing one streaming `POST /investigate`, so Bun startup + the LangChain import graph + GraphQL introspection are paid once at boot instead of per run. The CLI and the investigation pipeline are untouched; this is a transport wrapper.

**Architecture:** A new `src/server/investigate_server.ts` (`create_engine_server`) parses the body via `AgentInvestigationRequestSchema` (already `.strict()`), checks a bearer token, acquires a concurrency permit, then streams NDJSON: one `formatProgressLine` frame per metric event (via the existing `on_metric_event` hook, **verbatim**) followed by exactly one terminal `{"report"}` or `{"error"}` frame. Cancellation is a new `should_cancel?: () => boolean` field on the existing hooks object, polled at four safe checkpoints; the server wires it to client disconnect + an overall timeout. A shared `src/agents/investigation_wire.ts` factors `formatProgressLine` + the report-stripping so server and CLI share the contract. The engine stays stateless — no job store, no persistence.

**Tech Stack:** Bun 1.3.10 (`Bun.serve` — native, **no new dependency**), TypeScript (strict, `verbatimModuleSyntax`), zod 3, Biome, `bun test`. Provider model stays Haiku. Native TS only — no Python-referencing names/comments.

**Spec:** `../../../docs/superpowers/specs/2026-07-17-engine-as-a-service-design.md` (umbrella `../../../docs/superpowers/plans/2026-07-17-engine-as-a-service.md` — honor "The pinned contract" exactly).

**Repos touched:** `occupancy-engine-ts` (engine) only, on branch `feat/http-service` cut from `main` (`scripts/repo-branch.sh engine` → `main`). PR base and merge target `main` (trunk). Never `staging`. Purely additive — the CLI, the backend, and the pipeline are unaffected, so this branch is safe to merge to engine `main` on its own.

**Dependency order:** Engine-first (this plan lands before any backend change). Within this plan: Task 1 (shared wire) → Task 2 (cancellation) → Tasks 3–5 (server) → Tasks 6–7 (test doubles + E2E) → Task 8 (compose/Dockerfile) → Task 9 (DoD). Tasks 6 and 8 may run in parallel with each other.

---

## Decisions — open items resolved in this plan (NOT deferred)

- **Service port: `8787`** (reconciled with the backend plan — the umbrella owns this; both repos MUST agree). Env overrides `ENGINE_PORT` then `PORT`, default `8787`. The graph service owns `8000`; the engine takes `8787` (chosen over `8080` because the engine's own `compose.yaml` publishes the port to the host for standalone dev, and `8080` is the most collision-prone host port there is). The workspace `map.md` must record this — that edit is the umbrella owner's, not this plan's.
- **Healthcheck: `GET /healthz`** (no auth), which constructs the LLM client (`createChatModel({provider:"auto"})`) and the graph client (`new GraphQLHttpTool(GRAPHQL_URL)`) and returns `200 {"status":"ok"}` if both construct, else `503`. Client construction is cheap (no network, no LLM spend) and proves the process can build both clients — the "cheap request proving the LLM + graph clients constructed" the umbrella asks for. Compose healthcheck mirrors `graphql`'s shape (`interval 5s / timeout 3s / retries 20`) using a `bun -e` fetch. **`/healthz` is auth-exempt** — the compose healthcheck sends no bearer.
- **Concurrency: semaphore default `4`** (`ENGINE_MAX_CONCURRENCY`), `503` + `Retry-After: 2` when saturated.
- **Overall request timeout: `300_000 ms`** (`ENGINE_REQUEST_TIMEOUT_MS`) — flips `should_cancel` for that request.
- **Graceful-shutdown drain window: `300_000 ms`** (`ENGINE_SHUTDOWN_DRAIN_MS`), i.e. `≤` the request timeout, since an in-flight investigation can take at most the request timeout. SIGTERM → stop accepting (new POSTs get `503`) → poll until in-flight count is `0` or the window elapses → `server.stop(true)` → `exit(0)`. In-flight runs are allowed to drain (finish), not force-cancelled, per the spec's "let in-flight investigations drain rather than dropping them."
- **Retry-After value: `2` seconds** on both saturation and shutdown `503`s.

---

## Landmines (carry through every step)

- **`.env` tautology:** the gitignored `.env` sets `OE_PROSE_REGISTER=on` + `OE_PROSE_REDACT=on`, and Bun auto-loads `.env`, so a bare `bun run verify` shows **2 pre-existing tautological failures**. The true baseline is `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify`. Do NOT touch `.env` or those 2 tests. Every "run verify" step below uses the flags-off form.
- **Bun 1.3.10 `toMatchObject` + asymmetric matchers mutate the received object** (carried from X-012). Use explicit `typeof` / `toEqual` / `toBe` checks — never `toMatchObject` with `expect.any(...)`.
- **`verbatimModuleSyntax: true`** — every type-only import must be `import type { ... }`.
- **`noUncheckedIndexedAccess: true`** — index access is `T | undefined`; use `!` or guards as the existing code does.

---

### Task 0: Branch setup + baseline

**Files:** none (git only)

- [ ] **Step 1: Cut the feature branch from `main`**

```bash
git checkout main
git checkout -b feat/http-service
```

- [ ] **Step 2: Capture the true green baseline**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify`
Expected: typecheck clean, lint 0 errors (3 pre-existing warnings), **132 pass / 0 fail** across 23 files.

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e`
Expected: **4 pass / 0 fail** (E2E-1..E2E-4).

---

### Task 1: Factor the shared wire contract (formatProgressLine + report payload + request parse)

The server must SHARE the progress-line format, the report-stripping, and the request parse with the CLI — no second copy of the contract. This task moves them into one module and re-points the CLI, keeping the CLI byte-identical.

**Files:**
- Create: `src/agents/investigation_wire.ts`
- Modify: `cli/run_address.ts` (drop the inline `formatProgressLine` body ~64-88; report serialization ~190-198)
- Test: `test/investigation_wire.test.ts` (new); `test/progress_line.test.ts` (must stay green via re-export)

- [ ] **Step 1: Write the failing test**

```ts
// test/investigation_wire.test.ts
import { describe, expect, it } from "bun:test";
import {
  assessment_report_payload,
  formatProgressLine,
  parse_investigation_request,
} from "../src/agents/investigation_wire.ts";
import { makeMetricEvent } from "../src/observability/models.ts";

describe("investigation_wire", () => {
  it("formatProgressLine emits the pinned progress frame", () => {
    const event = makeMetricEvent({
      event_id: "e1",
      event_type: "span_start",
      run_id: "r1",
      phase: "preflight",
      agent_id: "orchestrator",
      span_id: "s1",
      parent_span_id: "root",
      started_at: "2026-07-09T00:00:00.000Z",
      ended_at: "2026-07-09T00:00:00.000Z",
      seq: 7,
    });
    expect(JSON.parse(formatProgressLine(event)).progress.seq).toBe(7);
    expect(JSON.parse(formatProgressLine(event)).progress.ts).toBe("2026-07-09T00:00:00.000Z");
    expect(JSON.parse(formatProgressLine(event)).progress.parent_span_id).toBe("root");
  });

  it("assessment_report_payload strips exactly metrics_events and nothing else", () => {
    const assessment = { query: { a: 1 }, report: "x", metrics_events: [{ seq: 1 }], metrics: { k: 2 } };
    const out = assessment_report_payload(assessment as any);
    expect("metrics_events" in out).toBe(false);
    expect(out.query).toEqual({ a: 1 });
    expect(out.report).toBe("x");
    expect(out.metrics).toEqual({ k: 2 });
    // key order preserved minus metrics_events
    expect(Object.keys(out)).toEqual(["query", "report", "metrics"]);
  });

  it("parse_investigation_request returns ok for a valid body", () => {
    const r = parse_investigation_request({ address: "1 X ST", graphql_url: "http://g/graphql" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.address).toBe("1 X ST");
  });

  it("parse_investigation_request returns zod paths for a bad body (strict)", () => {
    const missing = parse_investigation_request({ zip: "40514", graphql_url: "http://g/graphql" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.some((i) => i.startsWith("address:"))).toBe(true);

    const unknownKey = parse_investigation_request({ address: "1 X ST", graphql_url: "http://g/graphql", verdict: "risk" });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) expect(unknownKey.issues.join(" ")).toContain("verdict");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/investigation_wire.test.ts`
Expected: FAIL — `Cannot find module '../src/agents/investigation_wire.ts'`.

- [ ] **Step 3: Minimal implementation**

```ts
// src/agents/investigation_wire.ts
// Shared transport contract for the CLI and the HTTP service: the NDJSON progress-line format, the
// terminal report payload (assessment minus telemetry), and the request-body parse. One copy so the
// wire never drifts between callers.
import {
  AgentInvestigationRequestSchema,
  type AgentInvestigationRequest,
  type OccupancyAgentAssessment,
} from "./models.ts";
import type { MetricEvent } from "../observability/models.ts";

/** One NDJSON line for a metric event — the exact object the backend progress translator consumes. */
export function formatProgressLine(event: MetricEvent): string {
  const launched = event.metadata["launched_subagents"];
  const workersTotal = event.metadata["workers_total"];
  const workerIndex = event.metadata["worker_index"];
  // span_start times the open; every other event type times its completion.
  const ts = event.event_type === "span_start" ? event.started_at : event.ended_at;
  return JSON.stringify({
    progress: {
      seq: event.seq,
      event_id: event.event_id,
      span_id: event.span_id,
      parent_span_id: event.parent_span_id || null,
      ts,
      event_type: event.event_type,
      phase: event.phase,
      agent_id: event.agent_id,
      heuristic_id: event.heuristic_id,
      name: event.name,
      workers_total: typeof workersTotal === "number" ? workersTotal : null,
      worker_index: typeof workerIndex === "number" ? workerIndex : null,
      status: event.status,
      ...(typeof launched === "number" ? { count: launched } : {}),
    },
  });
}

/**
 * The serializable report payload: the assessment with the telemetry buffer removed. metrics_events is
 * dropped from output (it is the raw event log); every other field is preserved in order.
 */
export function assessment_report_payload(
  assessment: OccupancyAgentAssessment,
): Record<string, unknown> {
  const { metrics_events, ...rest } = assessment as OccupancyAgentAssessment & { metrics_events?: unknown };
  void metrics_events;
  return rest;
}

export type RequestParseResult =
  | { ok: true; request: AgentInvestigationRequest }
  | { ok: false; issues: string[] };

/** Parse a raw request body into an AgentInvestigationRequest. The schema is already .strict(), so
 *  unknown keys fail here. On failure the issues carry the zod path (for a 400 response). */
export function parse_investigation_request(raw: unknown): RequestParseResult {
  const result = AgentInvestigationRequestSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, request: result.data };
  }
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, issues };
}
```

Then re-point `cli/run_address.ts`. Replace the inline `formatProgressLine` definition (current lines ~34-88, the block comment + the whole `export function formatProgressLine(...)`) with an import + re-export, and use `assessment_report_payload` in the serialization block.

At the top imports of `cli/run_address.ts`, add:
```ts
import {
  assessment_report_payload,
  formatProgressLine,
} from "../src/agents/investigation_wire.ts";
```
Delete the local `export function formatProgressLine(...) { ... }` (lines ~64-88) and its immediately preceding `/** One \`--progress\` NDJSON line ... */` comment stub. Add a re-export so `test/progress_line.test.ts` (which imports from `../cli/run_address.ts`) stays green:
```ts
// Re-exported so existing callers/tests keep importing it from the CLI entry.
export { formatProgressLine } from "../src/agents/investigation_wire.ts";
```
Replace the serialization block (current lines ~190-198):
```ts
  // metrics_events is excluded from serialization — omit it from the output JSON.
  const { metrics_events, ...assessmentOut } = assessment;
  const output = JSON.stringify(assessmentOut, null, 2);
```
with:
```ts
  const assessmentOut = assessment_report_payload(assessment);
  const output = JSON.stringify(assessmentOut, null, 2);
```
and change the later metrics-events read (current line ~198) from `const events = (metrics_events ?? []) as MetricEvent[];` to:
```ts
    const events = (assessment.metrics_events ?? []) as MetricEvent[];
```
`assessment` is typed `any` in the CLI, so `assessment.metrics_events` is fine; the resulting `assessmentOut` and `events` are identical to before (same destructuring), so CLI output is byte-identical.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/investigation_wire.test.ts test/progress_line.test.ts test/report_destination.test.ts test/run_address_evidence.test.ts test/run_address_env.test.ts`
Expected: PASS (progress_line, report_destination, run_address_* still green via the re-export + unchanged behavior).

- [ ] **Step 5: Commit**

```bash
git add src/agents/investigation_wire.ts cli/run_address.ts test/investigation_wire.test.ts
git commit -m "refactor(agents): factor the shared CLI/service wire contract into investigation_wire"
```

---

### Task 2: Cancellation — `should_cancel` on the hooks object, four checkpoints (umbrella 1b)

One optional field on the existing hooks object; no signature change. Checked at four sites: `subagents.ts` `run` loop, `subagents.ts` `run_group` loop, before launching each bucket, and between pipeline phases. The CLI passes no `should_cancel` (default `() => false`) so behavior is unchanged and the 132 tests stay green.

**Files:**
- Modify: `src/agents/orchestrator.ts` (`InvestigationHooks` type + `investigate_address` ~699-733; `AgentOrchestrator` field/ctor ~180-202; `_investigate` phase boundaries ~310, ~324; `run_bucket` ~558-578)
- Modify: `src/agents/subagents.ts` (`RetrievalHeuristicSubagent` ctor ~122-127; `run` loop top ~151; `run_group` loop top ~267)
- Test: `test/cancellation.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// test/cancellation.test.ts
import { describe, expect, test } from "bun:test";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import { GraphQLHttpTool, CountingGraphQLTool } from "../src/agents/graphql_tool.ts";
import {
  AgentInvestigationRequestSchema,
  HeuristicAgentResultSchema,
  ResolvedAddressContextSchema,
} from "../src/agents/models.ts";
import { RetrievalHeuristicSubagent, type HeuristicSubagent } from "../src/agents/subagents.ts";
import { TypedToolset } from "../src/agents/toolsets/typed_toolset.ts";
import { FixtureGraphQLServer } from "./support/fixture_graphql.ts";
import { loadPreflight1104 } from "./support/fixtures.ts";

describe("should_cancel stops launching new subagent work (orchestrator sites 3 + 4)", () => {
  test("flag flips after the first bucket → no further subagent launches, run tears down", async () => {
    let launches = 0;
    class CountingSubagent implements HeuristicSubagent {
      async run(agent_input: any, _graphql: any) {
        launches += 1;
        return HeuristicAgentResultSchema.parse({
          heuristic_id: String(agent_input.heuristic.id),
          status: "not_triggered",
          direction: "risk",
          score: 0,
          confidence: "low",
          finding: "counted.",
          missing_evidence: ["none"],
        });
      }
    }
    const server = new FixtureGraphQLServer(loadPreflight1104());
    try {
      const orch = new AgentOrchestrator({
        graphql: new GraphQLHttpTool(server.url),
        subagent: new CountingSubagent(),
        max_concurrency: 1, // FIFO: buckets launch one at a time, so the flip is deterministic
        should_cancel: () => launches >= 1, // cancel once the first bucket has launched
      });
      // Two packets that both survive the 1104 gate (tax present; synthesis always runs), each a
      // singleton bucket → exactly two buckets, only the first may launch its subagent.
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        graphql_url: server.url,
        heuristic_allowlist: ["property_tax_context", "case_quality_and_synthesis"],
      });
      await expect(orch.investigate(request)).rejects.toThrow(/cancelled/);
      expect(launches).toBe(1); // the second bucket was gated before it ever invoked the subagent
    } finally {
      server.close();
    }
  });
});

describe("should_cancel unwinds a subagent turn loop before the LLM call (sites 1 + 2)", () => {
  function agentInput(id: string) {
    return {
      heuristic: { id, category: "risk", input_sources: [], context_scope: [] },
      context: ResolvedAddressContextSchema.parse({ input_address: "1104 SPRING RUN RD", input_zip: "40514" }),
      max_graphql_calls: 8,
      max_output_retries: 2,
      max_query_repair_attempts: 3,
      schema_tool_budget: 8,
      prompt_profile: "compact" as const,
      plan: null,
      trace: {},
    } as any;
  }
  function stubLlm(counter: { invokes: number }) {
    return {
      bindTools() {
        return {
          async invoke() {
            counter.invokes += 1;
            return { content: "", tool_calls: [] };
          },
        };
      },
    };
  }
  const graphql = new CountingGraphQLTool(new GraphQLHttpTool("http://127.0.0.1:9/graphql"), { max_calls: 8 });

  test("run() throws and never calls the model when should_cancel is true", async () => {
    const counter = { invokes: 0 };
    const sub = new RetrievalHeuristicSubagent(stubLlm(counter) as any, new TypedToolset(), () => true);
    await expect(sub.run(agentInput("property_tax_context"), graphql)).rejects.toThrow(/cancelled/);
    expect(counter.invokes).toBe(0);
  });

  test("run_group() error-fills without calling the model when should_cancel is true", async () => {
    const counter = { invokes: 0 };
    const sub = new RetrievalHeuristicSubagent(stubLlm(counter) as any, new TypedToolset(), () => true);
    const results = await sub.run_group(
      [agentInput("property_tax_context"), agentInput("case_quality_and_synthesis")],
      graphql,
    );
    expect(results.length).toBe(2);
    expect(results.every((r) => r.status === "error")).toBe(true);
    expect(counter.invokes).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/cancellation.test.ts`
Expected: FAIL — `should_cancel` is not a constructor option / third param yet; nothing throws.

- [ ] **Step 3: Minimal implementation**

In `src/agents/orchestrator.ts`, add the exported hooks type just above `export class AgentOrchestrator` (line ~178):
```ts
export interface InvestigationHooks {
  on_metric_event?: (event: MetricEvent) => void;
  should_cancel?: () => boolean;
}
```
Add the field + ctor wiring on `AgentOrchestrator` (fields block ~186, ctor ~188-202):
```ts
  on_metric_event: ((event: MetricEvent) => void) | null;
  should_cancel: () => boolean; // NEW

  constructor(opts: {
    graphql: GraphQLHttpTool;
    subagent: HeuristicSubagent;
    master_llm?: any | null;
    max_concurrency?: number;
    agent_timeout_seconds?: number;
    on_metric_event?: (event: MetricEvent) => void;
    should_cancel?: () => boolean; // NEW
  }) {
    this.graphql = opts.graphql;
    this.subagent = opts.subagent;
    this.master_llm = opts.master_llm ?? null;
    this.max_concurrency = opts.max_concurrency ?? 8;
    this.agent_timeout_seconds = opts.agent_timeout_seconds ?? 120.0;
    this.on_metric_event = opts.on_metric_event ?? null;
    this.should_cancel = opts.should_cancel ?? (() => false); // NEW
  }
```
Add the between-phases helper as a method on `AgentOrchestrator` (place it right after the constructor):
```ts
  /** Site 4: between pipeline phases. Throw to unwind through the normal error path. */
  private _ensure_not_cancelled(): void {
    if (this.should_cancel()) {
      throw new Error("investigation cancelled");
    }
  }
```
In `_investigate`, add a call immediately before the `heuristic_workers` span (before `const results = await recorder.span("heuristic_workers", ...` at ~310) and immediately before the `master_adjudicator` span (before `const adjudication = await recorder.span("master_adjudicator", ...` at ~324):
```ts
    this._ensure_not_cancelled();
```
In `run_bucket` (inside `_run_subagents`), gate before the invoke — after `await semaphore.acquire();` (line ~558), inside the existing `try`:
```ts
      await semaphore.acquire();
      try {
        // Site 3: before launching each bucket. Cancelled buckets never invoke a subagent.
        if (this.should_cancel()) {
          return bucket.map((h) => error_result(h, "investigation cancelled before launch", graphql));
        }
        return await withTimeout(
          runnable.invoke(
            // ...unchanged...
```
Wire the hooks through `investigate_address` (lines ~699-733). Change the signature and the two construction sites:
```ts
export async function investigate_address(
  request: AgentInvestigationRequest,
  subagent: HeuristicSubagent | null = null,
  hooks: InvestigationHooks = {},
): Promise<OccupancyAgentAssessment> {
  // ...unchanged graphql setup...
  if (subagent === null) {
    const llm = createChatModel({ /* unchanged */ });
    const toolset = make_toolset(request.retrieval_mode, request.include_shortcuts);
    resolvedSubagent = new RetrievalHeuristicSubagent(llm, toolset, hooks.should_cancel); // NEW 3rd arg
    master_llm = llm;
  } else {
    resolvedSubagent = subagent;
    master_llm = null;
  }
  const orchestrator = new AgentOrchestrator({
    graphql,
    subagent: resolvedSubagent,
    master_llm,
    max_concurrency: request.max_concurrency,
    agent_timeout_seconds: request.agent_timeout_seconds,
    on_metric_event: hooks.on_metric_event,
    should_cancel: hooks.should_cancel, // NEW
  });
  return await orchestrator.investigate(request);
}
```

In `src/agents/subagents.ts`, extend the `RetrievalHeuristicSubagent` constructor (lines ~124-127) with the optional predicate (default `() => false`, so E2E-2's `new RetrievalHeuristicSubagent(llm, toolset)` is unchanged):
```ts
  constructor(
    public llm: any,
    public toolset: RetrievalToolset,
    public should_cancel: () => boolean = () => false, // NEW
  ) {}
```
Add site 1 at the top of the `run` per-turn loop (line ~151, the `for (let turn_index = 0; ...)` body, before `const start = performance.now();`):
```ts
    for (let turn_index = 0; turn_index < max_turns; turn_index++) {
      if (this.should_cancel()) {
        throw new Error("investigation cancelled");
      }
      const start = performance.now();
```
Add site 2 at the top of the `run_group` per-turn loop (line ~267, inside the existing `try`, before `const start = performance.now();`):
```ts
      for (let turn_index = 0; turn_index < max_turns; turn_index++) {
        if (this.should_cancel()) {
          throw new Error("investigation cancelled");
        }
        const start = performance.now();
```
(The `run_group` throw is caught by the existing `try/catch` at ~329, which error-fills the still-pending packets — its normal error path.)

- [ ] **Step 4: Run the tests, verify they pass**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/cancellation.test.ts`
Expected: PASS (all 3 tests).

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/e2e`
Expected: **4 pass / 0 fail** (default `should_cancel` is `() => false`; pipeline unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator.ts src/agents/subagents.ts test/cancellation.test.ts
git commit -m "feat(agents): should_cancel hook — unwind at the four cancellation checkpoints"
```

---

### Task 3: The `Bun.serve` HTTP server — auth, parse, stream, terminal frame (umbrella 1a)

**Files:**
- Create: `src/server/investigate_server.ts`
- Test: `test/http_service.test.ts` (new — grows across Tasks 3, 4, 5)

- [ ] **Step 1: Write the failing test**

```ts
// test/http_service.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { create_engine_server, type EngineServer } from "../src/server/investigate_server.ts";
import {
  assessment_report_payload,
  formatProgressLine,
} from "../src/agents/investigation_wire.ts";
import { investigate_address } from "../src/agents/orchestrator.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { makeMetricEvent } from "../src/observability/models.ts";
import { FixtureGraphQLServer } from "./support/fixture_graphql.ts";
import { loadPreflight1104 } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

const TOKEN = "test-engine-token";
const VALID_BODY = { address: "1104 SPRING RUN RD", zip: "40514", graphql_url: "http://127.0.0.1:9/graphql" };

let engine: EngineServer | undefined;
afterEach(async () => {
  if (engine) {
    await engine.stop();
    engine = undefined;
  }
});

/** A real, deterministic assessment (FakeSubagent + fixture graph, no LLM). */
async function realAssessment() {
  const graph = new FixtureGraphQLServer(loadPreflight1104());
  try {
    const request = AgentInvestigationRequestSchema.parse({
      address: "1104 SPRING RUN RD",
      zip: "40514",
      graphql_url: graph.url,
    });
    return await investigate_address(request, new FakeSubagent(), {});
  } finally {
    graph.close();
  }
}

describe("POST /investigate — stream shape", () => {
  test("progress frames are formatProgressLine VERBATIM, then exactly one terminal report frame", async () => {
    const assessment = await realAssessment();
    const e1 = makeMetricEvent({ event_id: "e1", event_type: "span_start", run_id: "r", seq: 1, phase: "preflight", agent_id: "orchestrator", started_at: "2026-07-09T00:00:00.000Z", ended_at: "2026-07-09T00:00:00.000Z" });
    const e2 = makeMetricEvent({ event_id: "e2", event_type: "span_end", run_id: "r", seq: 2, phase: "preflight", agent_id: "orchestrator", started_at: "2026-07-09T00:00:00.000Z", ended_at: "2026-07-09T00:00:01.000Z" });

    engine = create_engine_server({
      port: 0,
      auth_token: TOKEN,
      investigate: async (_req, hooks) => {
        hooks.on_metric_event?.(e1);
        hooks.on_metric_event?.(e2);
        return assessment;
      },
    });

    const res = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const text = await res.text();
    expect(text).toBe(
      formatProgressLine(e1) +
        "\n" +
        formatProgressLine(e2) +
        "\n" +
        JSON.stringify({ report: assessment_report_payload(assessment) }) +
        "\n",
    );
  });

  test("a mid-stream failure becomes a terminal {error} frame on the already-committed 200", async () => {
    engine = create_engine_server({
      port: 0,
      auth_token: TOKEN,
      investigate: async () => {
        throw new Error("boom");
      },
    });
    const res = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(200); // status committed before the body streamed
    const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual({ error: { message: "boom" } });
  });
});

describe("POST /investigate — pre-stream rejections", () => {
  test("401 when the bearer token is missing or wrong", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => realAssessment() });
    const noAuth = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(noAuth.status).toBe(401);
    const badAuth = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(badAuth.status).toBe(401);
  });

  test("400 with the zod path when the body fails AgentInvestigationRequestSchema (strict)", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => realAssessment() });
    const res = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ zip: "40514", graphql_url: "http://g/graphql" }), // missing address
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(body.error.issues.some((i: string) => i.startsWith("address:"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/http_service.test.ts`
Expected: FAIL — `Cannot find module '../src/server/investigate_server.ts'`.

- [ ] **Step 3: Minimal implementation**

```ts
// src/server/investigate_server.ts
// Long-running, stateless HTTP service wrapping investigate_address. One streaming endpoint:
//   POST /investigate  → NDJSON: zero-or-more {"progress"} frames (formatProgressLine, verbatim),
//                        then exactly one terminal {"report"} or {"error"} frame.
//   GET  /healthz       → 200 once the LLM + graph clients construct, else 503.
// Bun.serve is native — no new dependency. No job store, no persistence.
import { createChatModel } from "../agents/llm.ts";
import { GraphQLHttpTool } from "../agents/graphql_tool.ts";
import { investigate_address, type InvestigationHooks } from "../agents/orchestrator.ts";
import {
  assessment_report_payload,
  formatProgressLine,
  parse_investigation_request,
} from "../agents/investigation_wire.ts";
import type { AgentInvestigationRequest, OccupancyAgentAssessment } from "../agents/models.ts";

export type InvestigationRunner = (
  request: AgentInvestigationRequest,
  hooks: InvestigationHooks,
) => Promise<OccupancyAgentAssessment>;

export interface EngineServerOptions {
  port?: number; // default 8787
  auth_token?: string; // ENGINE_AUTH_TOKEN — required in prod; every request must send it as Bearer
  max_concurrency?: number; // default 4
  request_timeout_ms?: number; // default 300_000 — flips should_cancel for that request
  shutdown_drain_ms?: number; // default = request_timeout_ms (<= engine timeout)
  retry_after_seconds?: number; // default 2
  graphql_url?: string; // healthcheck default; investigations carry their own graphql_url
  investigate?: InvestigationRunner; // injection seam for deterministic tests
}

export interface EngineServer {
  port: number;
  url: string;
  stop(): Promise<void>; // graceful: stop accepting, drain in-flight, then close
}

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY_AFTER_SECONDS = 2;

/** Non-blocking counting semaphore. try_acquire returns false when saturated (→ 503). */
class PermitPool {
  private available: number;
  private readonly size: number;
  constructor(size: number) {
    this.size = Math.max(1, size);
    this.available = this.size;
  }
  try_acquire(): boolean {
    if (this.available > 0) {
      this.available -= 1;
      return true;
    }
    return false;
  }
  release(): void {
    if (this.available < this.size) {
      this.available += 1;
    }
  }
  get in_use(): number {
    return this.size - this.available;
  }
}

function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function json_response(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function create_engine_server(opts: EngineServerOptions = {}): EngineServer {
  const auth_token = opts.auth_token ?? "";
  const max_concurrency = opts.max_concurrency ?? DEFAULT_MAX_CONCURRENCY;
  const request_timeout_ms = opts.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const shutdown_drain_ms = opts.shutdown_drain_ms ?? request_timeout_ms;
  const retry_after = String(opts.retry_after_seconds ?? DEFAULT_RETRY_AFTER_SECONDS);
  const graphql_url_default = opts.graphql_url ?? process.env.GRAPHQL_URL ?? "http://graphql:8000/graphql";
  const run_investigation: InvestigationRunner =
    opts.investigate ?? ((request, hooks) => investigate_address(request, null, hooks));
  const pool = new PermitPool(max_concurrency);
  const encoder = new TextEncoder();
  let accepting = true;

  const server = Bun.serve({
    port: opts.port ?? DEFAULT_PORT,
    idleTimeout: 0, // an investigation stream is long-lived and can be silent between phases
    async fetch(req) {
      const url = new URL(req.url);

      // Healthcheck (no auth): proves the LLM + graph clients construct. Cheap — no network, no spend.
      if (req.method === "GET" && url.pathname === "/healthz") {
        try {
          createChatModel({ provider: "auto", timeout_seconds: 30 });
          new GraphQLHttpTool(graphql_url_default);
          return json_response({ status: "ok" }, 200);
        } catch (exc) {
          return json_response({ status: "unhealthy", error: errStr(exc) }, 503);
        }
      }

      if (req.method !== "POST" || url.pathname !== "/investigate") {
        return json_response({ error: { message: "not found" } }, 404);
      }

      // Graceful shutdown: refuse new investigations while draining.
      if (!accepting) {
        return json_response({ error: { message: "server shutting down" } }, 503, { "retry-after": retry_after });
      }

      // 401 — bearer auth first.
      if ((req.headers.get("authorization") ?? "") !== `Bearer ${auth_token}`) {
        return json_response({ error: { message: "unauthorized" } }, 401);
      }

      // 400 — the body must parse to a valid AgentInvestigationRequest (schema is .strict()).
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return json_response({ error: { message: "request body is not valid JSON" } }, 400);
      }
      const parsed = parse_investigation_request(raw);
      if (!parsed.ok) {
        return json_response({ error: { message: "request body failed validation", issues: parsed.issues } }, 400);
      }
      const request = parsed.request;

      // 503 — concurrency semaphore saturated.
      if (!pool.try_acquire()) {
        return json_response({ error: { message: "engine at capacity" } }, 503, { "retry-after": retry_after });
      }

      // Cancellation: client disconnect OR the engine's own overall timeout.
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
      };
      req.signal.addEventListener("abort", cancel);
      const timeout = setTimeout(cancel, request_timeout_ms);

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const hooks: InvestigationHooks = {
            on_metric_event: (event) => {
              controller.enqueue(encoder.encode(formatProgressLine(event) + "\n"));
            },
            should_cancel: () => cancelled,
          };
          try {
            const assessment = await run_investigation(request, hooks);
            controller.enqueue(
              encoder.encode(JSON.stringify({ report: assessment_report_payload(assessment) }) + "\n"),
            );
          } catch (exc) {
            // HTTP already committed 200, so a mid-stream failure is a terminal {error} frame.
            controller.enqueue(encoder.encode(JSON.stringify({ error: { message: errStr(exc) } }) + "\n"));
          } finally {
            clearTimeout(timeout);
            req.signal.removeEventListener("abort", cancel);
            pool.release();
            controller.close();
          }
        },
        cancel() {
          // Consumer went away mid-stream — flip cancellation so in-flight work unwinds.
          cancelled = true;
        },
      });

      return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    },
  });

  const stop = async (): Promise<void> => {
    accepting = false;
    const deadline = Date.now() + shutdown_drain_ms;
    while (pool.in_use > 0 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    server.stop(true);
  };

  return { port: server.port, url: `http://127.0.0.1:${server.port}`, stop };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/http_service.test.ts`
Expected: PASS (stream-shape verbatim, error frame, 401, 400).

- [ ] **Step 5: Commit**

```bash
git add src/server/investigate_server.ts test/http_service.test.ts
git commit -m "feat(server): Bun.serve POST /investigate — auth, strict parse, NDJSON stream, terminal frame"
```

---

### Task 4: Concurrency semaphore → 503 + Retry-After (umbrella 1c)

The `PermitPool` + 503 path already exists from Task 3; this task locks it with a test.

**Files:**
- Test: `test/http_service.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `test/http_service.test.ts`)

```ts
describe("POST /investigate — backpressure", () => {
  test("503 + Retry-After when the concurrency semaphore is saturated", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    engine = create_engine_server({
      port: 0,
      auth_token: TOKEN,
      max_concurrency: 1,
      investigate: async () => {
        await gate; // hold the single permit until released
        return realAssessment();
      },
    });

    // Request A occupies the only permit. fetch resolves when the 200 headers arrive, by which point
    // the permit has already been acquired (acquisition is synchronous in the handler).
    const a = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(a.status).toBe(200);

    // Request B finds the pool saturated → 503 with Retry-After.
    const b = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(b.status).toBe(503);
    expect(b.headers.get("retry-after")).toBe("2");

    release();
    await a.text(); // drain A so the permit is returned before teardown
  });
});
```

- [ ] **Step 2: Run the test, verify it passes** (the 503 path shipped in Task 3)

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/http_service.test.ts`
Expected: PASS. (If it fails, the bug is real — the permit must be acquired synchronously in `fetch`, before the streaming `Response` is returned, which the Task 3 code does.)

- [ ] **Step 3: Commit**

```bash
git add test/http_service.test.ts
git commit -m "test(server): 503 + Retry-After when the concurrency semaphore is saturated"
```

---

### Task 5: Overall timeout wiring + graceful shutdown + healthz + the service entry (umbrella 1c + 2)

**Files:**
- Create: `cli/serve.ts`
- Modify: `package.json` (`scripts` — add `serve`)
- Test: `test/http_service.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `test/http_service.test.ts`)

```ts
describe("POST /investigate — the engine's own overall timeout flips should_cancel", () => {
  test("a runner that polls should_cancel stops and yields a terminal {error} frame", async () => {
    engine = create_engine_server({
      port: 0,
      auth_token: TOKEN,
      request_timeout_ms: 50, // short overall timeout for the test
      investigate: async (_req, hooks) => {
        let iterations = 0;
        while (!hooks.should_cancel?.()) {
          await Bun.sleep(10);
          iterations += 1;
          if (iterations > 1000) break; // safety net — should never reach it
        }
        throw new Error("investigation cancelled"); // unwind through the normal error path
      },
    });
    const res = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(200);
    const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual({ error: { message: "investigation cancelled" } });
  });
});

describe("GET /healthz + graceful shutdown", () => {
  test("healthz is 200 when the clients construct", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, graphql_url: "http://graphql:8000/graphql" });
    const res = await fetch(`${engine.url}/healthz`);
    // 200 when ANTHROPIC_API_KEY (or another provider key) is present; the shape is always {status}.
    const body = await res.json();
    expect(typeof body.status).toBe("string");
    expect([200, 503]).toContain(res.status);
  });

  test("stop() drains, then new requests are refused", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => realAssessment() });
    const url = engine.url;
    await engine.stop();
    engine = undefined; // already stopped
    await expect(
      fetch(`${url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      }),
    ).rejects.toThrow(); // socket closed after a graceful stop
  });
});
```

- [ ] **Step 2: Run the test, verify it passes** (timeout wiring + healthz + stop shipped in Task 3)

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/http_service.test.ts`
Expected: PASS.

- [ ] **Step 3: Add the service entry + npm script**

```ts
// cli/serve.ts
// Long-running engine HTTP service entry. Flips the container from a per-run job to a service.
import { loadDotenv } from "../src/env.ts";
import { create_engine_server } from "../src/server/investigate_server.ts";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

function main(): void {
  loadDotenv();
  const server = create_engine_server({
    port: intEnv("ENGINE_PORT", intEnv("PORT", 8787)),
    auth_token: process.env.ENGINE_AUTH_TOKEN ?? "",
    max_concurrency: intEnv("ENGINE_MAX_CONCURRENCY", 4),
    request_timeout_ms: intEnv("ENGINE_REQUEST_TIMEOUT_MS", 300_000),
    shutdown_drain_ms: intEnv("ENGINE_SHUTDOWN_DRAIN_MS", 300_000),
    graphql_url: process.env.GRAPHQL_URL,
  });
  const shutdown = () => {
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdout.write(`engine service listening on :${server.port}\n`);
}

main();
```

In `package.json`, add to `scripts` (after `run-batch`):
```json
    "serve": "bun run cli/serve.ts",
```

- [ ] **Step 4: Smoke-run the entry, then verify the suite**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off ENGINE_AUTH_TOKEN=t GRAPHQL_URL=http://127.0.0.1:9/graphql bun run serve` (Ctrl-C after it prints `engine service listening on :8787`)
Expected: prints the listening line, no crash.

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/http_service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/serve.ts package.json test/http_service.test.ts
git commit -m "feat(server): overall timeout, graceful shutdown, /healthz, and the cli/serve.ts entry"
```

---

### Task 6: The fake-engine double as an HTTP server (umbrella 3)

A reusable Bun.serve test double emitting the pinned NDJSON contract, built on the shared `formatProgressLine` so it can only ever emit what the real engine emits (the fidelity rule). It documents the wire for the backend adapter tests and anchors the engine's own contract test.

**Files:**
- Create: `test/support/fake_engine_server.ts`
- Test: `test/fake_engine_server.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// test/fake_engine_server.test.ts
import { describe, expect, test } from "bun:test";
import { FakeEngineServer } from "./support/fake_engine_server.ts";
import { formatProgressLine } from "../src/agents/investigation_wire.ts";
import { makeMetricEvent } from "../src/observability/models.ts";

const e1 = makeMetricEvent({ event_id: "e1", event_type: "span_start", run_id: "r", seq: 1, phase: "preflight", agent_id: "orchestrator", started_at: "2026-07-09T00:00:00.000Z", ended_at: "2026-07-09T00:00:00.000Z" });

describe("FakeEngineServer emits the pinned NDJSON contract", () => {
  test("progress frames then exactly one terminal report frame", async () => {
    const fake = new FakeEngineServer({ events: [e1], report: { report: "ok" }, auth_token: "tk" });
    try {
      const res = await fetch(`${fake.url}/investigate`, {
        method: "POST",
        headers: { authorization: "Bearer tk", "content-type": "application/json" },
        body: JSON.stringify({ address: "x", graphql_url: "http://g/graphql" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const text = await res.text();
      expect(text).toBe(formatProgressLine(e1) + "\n" + JSON.stringify({ report: { report: "ok" } }) + "\n");
    } finally {
      fake.close();
    }
  });

  test("a terminal error frame when the plan carries an error", async () => {
    const fake = new FakeEngineServer({ error: "kaput", auth_token: "tk" });
    try {
      const res = await fetch(`${fake.url}/investigate`, {
        method: "POST",
        headers: { authorization: "Bearer tk", "content-type": "application/json" },
        body: JSON.stringify({ address: "x", graphql_url: "http://g/graphql" }),
      });
      const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
      expect(JSON.parse(lines[lines.length - 1]!)).toEqual({ error: { message: "kaput" } });
    } finally {
      fake.close();
    }
  });

  test("401 without the bearer token", async () => {
    const fake = new FakeEngineServer({ report: {}, auth_token: "tk" });
    try {
      const res = await fetch(`${fake.url}/investigate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: "x", graphql_url: "http://g/graphql" }),
      });
      expect(res.status).toBe(401);
    } finally {
      fake.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/fake_engine_server.test.ts`
Expected: FAIL — `Cannot find module './support/fake_engine_server.ts'`.

- [ ] **Step 3: Minimal implementation**

```ts
// test/support/fake_engine_server.ts
// A fake engine HTTP server emitting the pinned POST /investigate NDJSON contract: zero-or-more
// {"progress"} frames (built via the SHARED formatProgressLine, so the double can only emit what the
// real engine emits) then exactly one terminal {"report"} or {"error"} frame. Same role as X-012's
// CLI double, upgraded to the service transport.
import { formatProgressLine } from "../../src/agents/investigation_wire.ts";
import type { MetricEvent } from "../../src/observability/models.ts";

export interface FakeEnginePlan {
  events?: MetricEvent[];
  report?: Record<string, unknown>; // terminal {"report": report}
  error?: string; // terminal {"error": {message: error}} (takes precedence over report)
  auth_token?: string;
}

export class FakeEngineServer {
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;

  constructor(plan: FakeEnginePlan) {
    const auth = plan.auth_token ?? "test-token";
    const encoder = new TextEncoder();
    this.server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/investigate") {
          return new Response(JSON.stringify({ error: { message: "not found" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        if ((req.headers.get("authorization") ?? "") !== `Bearer ${auth}`) {
          return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of plan.events ?? []) {
              controller.enqueue(encoder.encode(formatProgressLine(event) + "\n"));
            }
            if (plan.error !== undefined) {
              controller.enqueue(encoder.encode(JSON.stringify({ error: { message: plan.error } }) + "\n"));
            } else {
              controller.enqueue(encoder.encode(JSON.stringify({ report: plan.report ?? {} }) + "\n"));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
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

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/fake_engine_server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/support/fake_engine_server.ts test/fake_engine_server.test.ts
git commit -m "test(server): fake engine HTTP double emitting the pinned NDJSON contract"
```

---

### Task 7: E2E parity — a blind run through the service is byte-identical to the CLI's report (umbrella 3)

The transport must not perturb the blind path. Two assertions: (1) the server's terminal `{report}` payload is byte-for-byte the CLI's report bytes for the same assessment (the wrapper strips exactly `metrics_events`, nothing else); (2) a full-pipeline blind run through the real `investigate_address` via the server streams progress then one report frame, with no external-evidence content — X-012's guarantee surviving the transport swap.

**Files:**
- Create: `test/e2e/http_service.e2e.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/e2e/http_service.e2e.test.ts
import { describe, expect, test } from "bun:test";
import { create_engine_server, type EngineServer } from "../../src/server/investigate_server.ts";
import { investigate_address } from "../../src/agents/orchestrator.ts";
import { assessment_report_payload } from "../../src/agents/investigation_wire.ts";
import { AgentInvestigationRequestSchema } from "../../src/agents/models.ts";
import { FixtureGraphQLServer } from "../support/fixture_graphql.ts";
import { loadPreflight1104 } from "../support/fixtures.ts";
import { FakeSubagent } from "../support/subagents.ts";

const TOKEN = "e2e-token";
const EXTERNAL_MARKERS = ["Short-term rental listing", "str_scan; platform=", "source_provider=realtor", "Rental Market"];

describe("E2E: blind byte-identity — the service report frame == the CLI report bytes", () => {
  test("the terminal {report} equals assessment_report_payload for the same assessment", async () => {
    const graph = new FixtureGraphQLServer(loadPreflight1104());
    try {
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        graphql_url: graph.url,
      });
      expect(request.external_evidence).toBeNull(); // the absent payload IS the blind switch

      // One deterministic assessment (FakeSubagent + fixture graph, no LLM).
      const assessment = await investigate_address(request, new FakeSubagent(), {});
      const cliReport = assessment_report_payload(assessment); // exactly what the CLI writes to stdout

      let engine: EngineServer | undefined;
      try {
        // Serve the SAME assessment so run-to-run nondeterminism (ids/timestamps) is factored out and
        // only the transport/serialization is compared.
        engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => assessment });
        const res = await fetch(`${engine.url}/investigate`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ address: "1104 SPRING RUN RD", zip: "40514", graphql_url: graph.url }),
        });
        const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
        expect(lines.length).toBe(1);
        const frame = JSON.parse(lines[0]!);
        expect("report" in frame).toBe(true);
        expect("error" in frame).toBe(false);
        // Byte-identical report payload — the wrapper drops exactly metrics_events, adds nothing.
        expect(JSON.stringify(frame.report)).toBe(JSON.stringify(cliReport));
        // Blind guarantee survives the transport: no external-evidence CONTENT in the report.
        const bytes = JSON.stringify(frame.report);
        for (const marker of EXTERNAL_MARKERS) {
          expect([marker, bytes.includes(marker)]).toEqual([marker, false]);
        }
      } finally {
        if (engine) await engine.stop();
      }
    } finally {
      graph.close();
    }
  });

  test("a full-pipeline blind run through the service streams progress then one clean report frame", async () => {
    const graph = new FixtureGraphQLServer(loadPreflight1104());
    let engine: EngineServer | undefined;
    try {
      engine = create_engine_server({
        port: 0,
        auth_token: TOKEN,
        // Real orchestrator through the real investigate_address, deterministic via FakeSubagent.
        investigate: (request, hooks) => investigate_address(request, new FakeSubagent(), hooks),
      });
      const res = await fetch(`${engine.url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ address: "1104 SPRING RUN RD", zip: "40514", graphql_url: graph.url }),
      });
      expect(res.status).toBe(200);
      const lines = (await res.text()).split("\n").filter((l) => l.length > 0);

      const progress = lines.slice(0, -1).map((l) => JSON.parse(l));
      const terminal = JSON.parse(lines[lines.length - 1]!);
      expect(progress.length).toBeGreaterThan(0); // real spans emitted progress frames
      expect(progress.every((p) => "progress" in p)).toBe(true);
      expect("report" in terminal).toBe(true); // exactly one terminal frame, last, and it is a report
      expect(lines.filter((l) => "report" in JSON.parse(l) || "error" in JSON.parse(l)).length).toBe(1);

      const bytes = JSON.stringify(terminal.report);
      for (const marker of EXTERNAL_MARKERS) {
        expect([marker, bytes.includes(marker)]).toEqual([marker, false]);
      }
    } finally {
      if (engine) await engine.stop();
      graph.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails, then passes**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/e2e/http_service.e2e.test.ts`
Expected: FAIL first only if a wiring bug exists; with Tasks 1–5 in place it PASSES. (This is a guardrail test over already-built behavior — if it fails, fix the server, not the test.)

- [ ] **Step 3: Commit**

```bash
git add test/e2e/http_service.e2e.test.ts
git commit -m "test(e2e): blind run through the service is byte-identical to the CLI report"
```

---

### Task 8: compose.yaml + Dockerfile — `agent` becomes a real service; ENTRYPOINT job → server (umbrella 2)

**Files:**
- Modify: `compose.yaml` (the `agent` service ~16-24)
- Modify: `Dockerfile` (comment ~6, ENTRYPOINT ~7)

- [ ] **Step 1: Rewrite the `agent` service in `compose.yaml`**

Replace the current `agent` block (lines 16-24) with a real long-running service modeled on `graphql` (drop `profiles`, add `ports` + `healthcheck` + `ENGINE_AUTH_TOKEN`/`ENGINE_PORT`):
```yaml
  agent:
    build: .
    depends_on:
      graphql:
        condition: service_healthy
    environment:
      GRAPHQL_URL: http://graphql:8000/graphql
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
(This is the engine repo's OWN compose, for dev/standalone e2e, so publishing `8787` is intentional. The backend's `docker-compose.staging.yml` will run `engine` on the compose network with NO published ports — that edit lives in the backend plan.)

- [ ] **Step 2: Flip the Dockerfile ENTRYPOINT**

Replace the last two lines of `Dockerfile` (comment + ENTRYPOINT):
```dockerfile
# The engine runs as a long-running HTTP service exposing POST /investigate.
EXPOSE 8787
ENTRYPOINT ["bun", "run", "cli/serve.ts"]
```

- [ ] **Step 3: Validate compose config statically**

Run: `docker compose config`
Expected: valid config; the `agent` service shows the published `8787:8787`, the healthcheck, and no `profiles`. (A live `docker compose up` build is part of the DoD's live gate below, not this static step.)

- [ ] **Step 4: Commit**

```bash
git add compose.yaml Dockerfile
git commit -m "chore(deploy): run the engine as a service — ports, healthcheck, ENTRYPOINT job -> server"
```

---

### Task 9: feature_list.json + PROGRESS.md + full verify (DoD)

**Files:**
- Modify: `feature_list.json` (append the X-013 entry)
- Modify: `PROGRESS.md` (new Session Record)

- [ ] **Step 1: Set the feature `in_progress`, then append the entry**

Add to the `feature_list.json` array (keep `feature_list.test.ts` happy: unique id, `priority` number, valid status, all REQUIRED keys). Start it `in_progress` while working, flip to `passing` after Step 3's evidence:
```json
  {
    "id": "http-service",
    "priority": 11,
    "area": "server",
    "title": "Engine as an independent HTTP service (POST /investigate, streaming NDJSON)",
    "user_visible_behavior": "bun run serve starts a long-running service; POST /investigate streams progress frames then a terminal {report}/{error} frame. 400 on a body failing AgentInvestigationRequestSchema (strict), 401 on a missing/bad bearer, 503 + Retry-After when saturated. should_cancel stops launching new subagent work on client disconnect or the overall timeout. The CLI and the pipeline are unchanged.",
    "status": "passing",
    "verification": "OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify; OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e; test/http_service.test.ts (stream verbatim, 400/401/503, timeout->cancel, healthz, shutdown); test/cancellation.test.ts (sites 1-4); test/e2e/http_service.e2e.test.ts (blind byte-identity + full-pipeline clean stream); test/fake_engine_server.test.ts.",
    "evidence": "<fill after Step 3 with the recorded pass counts>",
    "notes": "Transport wrapper over investigate_address; Bun.serve is native (no new dependency). Stateless. Shared wire in src/agents/investigation_wire.ts; hooks extended with should_cancel in src/agents/orchestrator.ts; server in src/server/investigate_server.ts; entry cli/serve.ts. Port 8787; healthcheck GET /healthz; drain window 300s."
  }
```

- [ ] **Step 2: Run the full gate (true baseline) and the E2E suite**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify`
Expected: typecheck clean, lint 0 errors (3 pre-existing warnings), all tests pass — the prior **132** plus the new `investigation_wire` (4), `cancellation` (3), `http_service` (stream + rejections + backpressure + timeout + healthz/shutdown), `fake_engine_server` (3), and E2E `http_service.e2e` (2). Record the exact `N pass / 0 fail` counts.

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e`
Expected: the original 4 E2E + the 2 new service E2E tests pass.

- [ ] **Step 3: Fill `evidence` in `feature_list.json` with the recorded counts; write the PROGRESS.md Session Record**

Append a newest-first Session Record to `PROGRESS.md` (goal / completed / verification run / evidence with the real counts / commits on `feat/http-service` / risks / next best action). Include the live gate outcome from Step 4 once run.

- [ ] **Step 4: Live functional gate (real process, not projected)**

Run: `docker compose up -d --build` (graph + agent), wait for both healthy (`docker compose ps` shows `healthy`).
Then a live `POST /investigate` against the running graph, e.g.:
```bash
curl -N -s -X POST http://localhost:8787/investigate \
  -H "authorization: Bearer dev-engine-token" -H "content-type: application/json" \
  -d '{"address":"1104 SPRING RUN RD","zip":"40514","graphql_url":"http://graphql:8000/graphql"}'
```
Expected: a stream of `{"progress":...}` lines then exactly one terminal `{"report":...}` line; a wrong bearer returns `401`; a malformed body returns `400`. Record the observed per-investigation latency (the warm-process win vs the ~1m50s spawn baseline is measured, not projected — capture it in the Session Record).
Then `docker compose down`.

- [ ] **Step 5: Commit + confirm clean tree**

```bash
git add feature_list.json PROGRESS.md
git commit -m "docs: feature_list X-013 passing + PROGRESS session record for the engine HTTP service"
git status   # expect: clean, nothing gitignored committed
```

---

## Verification / Definition of Done

- [ ] `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify` green (typecheck + lint + full `bun test`, with real recorded pass counts) — the X-012 132-test suite still green (pipeline untouched, `should_cancel` defaults `() => false`).
- [ ] `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e` green (original 4 + 2 new service E2E).
- [ ] The pinned contract holds as executable tests: progress frames are `formatProgressLine` VERBATIM then exactly one terminal frame; `400` on `AgentInvestigationRequestSchema` (strict) failure with the zod path; `401` on missing/bad bearer; `503` + `Retry-After` when saturated; `should_cancel` stops launching new subagent work (`launches === 1` with the flag flip) and unwinds the turn loops before the model call; blind run through the service is byte-identical to the CLI report.
- [ ] No new dependency (`Bun.serve` only); native TS names/comments only; engine stays stateless.
- [ ] `feature_list.json` entry `http-service` is `passing` with REAL evidence; `PROGRESS.md` has a new Session Record; working tree clean.
- [ ] Live gate: `docker compose up --build` → both services healthy → live `POST /investigate` streams progress then a report; `401`/`400` behave; per-investigation latency recorded vs the ~1m50s spawn baseline.
- [ ] (Umbrella owner, not this plan) `map.md` records the engine as a service on port `8787`; the backend bumps its submodule pointer after this branch merges to engine `main`.

---

### Critical Files for Implementation
- `src/server/investigate_server.ts` (new — the `Bun.serve` service: auth, strict parse, semaphore/503, NDJSON stream, terminal frame, timeout, `/healthz`, graceful shutdown)
- `src/agents/investigation_wire.ts` (new — the shared CLI/service contract: `formatProgressLine`, `assessment_report_payload`, `parse_investigation_request`)
- `src/agents/orchestrator.ts` (`InvestigationHooks` + `should_cancel` field/ctor, sites 3–4, `investigate_address` wiring)
- `src/agents/subagents.ts` (`RetrievalHeuristicSubagent` `should_cancel` ctor param, sites 1–2 in the `run`/`run_group` loops)
- `cli/run_address.ts` (re-point to `investigation_wire`, keep CLI byte-identical) and the paired ops files `compose.yaml` + `Dockerfile` (service + ENTRYPOINT flip)
