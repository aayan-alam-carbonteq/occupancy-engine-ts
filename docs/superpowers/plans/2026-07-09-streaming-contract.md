# Investigation Streaming Contract (Engine) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the engine's `--progress` NDJSON stream ordered, deduplicable, and correctly-counted at its source — every `MetricEvent` on the wire carries a monotonic `seq`, stable identity (`event_id`/`span_id`/`parent_span_id`), a timestamp, an explicit `span_start`/`span_end` type, and a **bucket-scaled** `workers_total`/`worker_index` — and the progress stream never shares stdout with the final report JSON.

**Architecture:** Add a `seq: number` field to `MetricEvent` and a monotonic counter assigned in `MetricsRecorder._emit` (the single choke point every emitted/persisted event passes through). Widen `formatProgressLine` to project the identity/ordering fields (already present internally) plus a derived `ts` and the metadata-carried `workers_total`/`worker_index` onto the wire. Rename the span-close `event_type` `"span"`→`"span_end"`. Compute `workers_total = buckets.length` up front (buckets are the streamed worker unit) and stamp `workers_total`+0-based `worker_index` on every `heuristic_worker` span; standardize the same total on `agent_metrics`. Route the report JSON to `--out` (or stderr when `--progress` and no `--out`) so stdout is progress-only.

**Tech Stack:** TypeScript on Bun; `AsyncLocalStorage`-based span recorder (`src/observability/`); LangChain agents (`src/agents/`); test runner `bun test`; typecheck `tsc --noEmit` (`bun run typecheck`).

**Spec:** `docs/superpowers/plans/2026-07-09-investigation-streaming-overhaul.md` (umbrella plan — full pinned contract + audit rationale). This plan implements PINNED CONTRACT §1 (engine `--progress` line) and engine findings F1–F6.

**Repos touched:** **engine only** — `occupancy-engine-ts`, branch `feat/streaming-contract` (create from `feat/progress-span-start`, **not** `main` — the `--progress` `formatProgressLine`/span_start code this plan modifies lives on `feat/progress-span-start` and is absent from `main`). Owner-approved to touch the engine `main` lineage. Do **not** touch the backend or frontend repos; their per-repo plans consume this contract downstream. Do not modify `services/graph` (submodule).

**Dependency order:** Engine is **first** in the contract-first chain (engine → backend → frontend). The wire schema defined here is the upstream half of the coupling; backend/frontend cannot key on `seq`/`workers_total` until this ships. Within this plan, Tasks 1–5 are sequential (Task 3 reads the `seq` field from Task 1 and the `span_end` type from Task 2; Task 5 populates the metadata Task 3 projects). Base this branch on `feat/progress-span-start` so the span_start bracket code is present before Task 1.

---

### Task 1: Monotonic `seq` on every emitted/persisted event

Wire finding **F1 (part 1)**. `MetricEvent` gains a `seq` field; `MetricsRecorder._emit` (the single method every span-open and every `record_event` passes through) assigns a strictly increasing counter — assigned **before** the sink guard so persisted events carry it even with no live sink.

**Files:**
- Modify: `src/observability/models.ts:62-92` (interface) and `:100-130` (factory defaults)
- Modify: `src/observability/recorder.ts:127-129` (field), `:290-299` (`_emit`)
- Test: `test/recorder_seq.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/recorder_seq.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { MetricsRecorder } from "../src/observability/recorder.ts";
import type { MetricEvent } from "../src/observability/models.ts";

function makeRecorder(on_event?: (e: MetricEvent) => void): MetricsRecorder {
  return new MetricsRecorder(
    {
      run_id: "run-1",
      batch_id: "",
      investigation_id: "run-1",
      address_key: "k",
      address: "1 TEST ST",
      zip: "",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      prompt_profile: "compact",
      include_shortcuts: false,
    },
    { enabled: true, on_event },
  );
}

describe("MetricsRecorder seq", () => {
  it("assigns a strictly increasing seq to every emitted event", async () => {
    const seen: MetricEvent[] = [];
    const recorder = makeRecorder((e) => seen.push(e));

    await recorder.span("investigation", { agent_id: "a" }, async () => {
      recorder.record_counter("packets", {});
      return "ok";
    });

    // emit order: span_start, counter, span end
    const seqs = seen.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(seen[0]!.seq).toBeLessThan(seen[seen.length - 1]!.seq);
  });

  it("stamps seq on persisted events even with no sink", async () => {
    const recorder = makeRecorder();
    await recorder.span("investigation", { agent_id: "a" }, async () => {
      recorder.record_counter("packets", {});
      return "ok";
    });

    const persisted = recorder.events(); // span end + counter (span_start is sink-only)
    expect(persisted.length).toBe(2);
    expect(persisted.every((e) => e.seq > 0)).toBe(true);
    const seqs = persisted.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/recorder_seq.test.ts`
Expected: FAIL — first `expect(seqs).toEqual([1, 2, 3])` fails with received `[undefined, undefined, undefined]` (no `seq` field yet); the type also has no `seq`.

- [ ] **Step 3: Minimal implementation**

In `src/observability/models.ts`, add `seq` to the `MetricEvent` interface (right after `event_id`):

```ts
export interface MetricEvent {
  event_id: string;
  seq: number;
  event_type: MetricEventType;
```

And add its default in `makeMetricEvent` (in the returned object, alongside the other defaults):

```ts
  return {
    seq: 0,
    batch_id: "",
    investigation_id: "",
```

In `src/observability/recorder.ts`, add the counter field (with the other private fields near line 127):

```ts
  private readonly _events: MetricEvent[] = [];
  private _seq = 0;
  private readonly _seen_llm_run_ids = new Set<string>();
```

And assign it at the top of `_emit` (before the sink guard), replacing the current method body:

```ts
  /** Notify the live sink; a faulty sink must never break the investigation. */
  private _emit(event: MetricEvent): void {
    // Monotonic per-run ordering key. Assigned here — the one method every span-open
    // and every record_event passes through — before the sink guard, so persisted
    // events carry seq even when no live sink is attached.
    event.seq = ++this._seq;
    if (!this._on_event) {
      return;
    }
    try {
      this._on_event(event);
    } catch {
      // swallow sink errors
    }
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/recorder_seq.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/observability/models.ts src/observability/recorder.ts test/recorder_seq.test.ts
git commit -m "feat(observability): monotonic seq assigned in recorder._emit"
```

---

### Task 2: Rename span-close `event_type` `"span"` → `"span_end"`

Wire finding **F3**. The span open (`span_start`) and span close currently differ only by `event_type` `"span"`; rename the close to the explicit `"span_end"`. Only three source references exist (`models.ts` union, `recorder.ts:175` emit, `recorder.ts:329` summary) plus one test file — confirmed by grep.

**Files:**
- Modify: `src/observability/models.ts:5-12` (union)
- Modify: `src/observability/recorder.ts:175` (emit), `:329` (summary)
- Modify: `test/recorder_sink.test.ts:31,34` (existing expectations)

- [ ] **Step 1: Write the failing test**

Edit `test/recorder_sink.test.ts` — change the two expectations from `"span"` to `"span_end"`:

Line 31:
```ts
    expect(seen.map((e) => e.event_type)).toEqual(["span_start", "span_end", "counter"]);
```
Line 34:
```ts
    expect(recorder.events().map((e) => e.event_type)).toEqual(["span_end", "counter"]);
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/recorder_sink.test.ts`
Expected: FAIL — received `["span_start", "span", "counter"]` (impl still emits `"span"`).

- [ ] **Step 3: Minimal implementation**

In `src/observability/models.ts`, rename in the union:

```ts
export type MetricEventType =
  | "span_end"
  | "span_start"
  | "llm_call"
  | "tool_call"
  | "graphql_call"
  | "error"
  | "counter";
```

In `src/observability/recorder.ts`, the span-close emit (line 175):

```ts
      this.record_event("span_end", {
```

And the summary latency check (line 329):

```ts
      if (event.event_type === "span_end" && event.phase === "investigation") {
        summary.latency_ms = event.latency_ms;
      }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/recorder_sink.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/observability/models.ts src/observability/recorder.ts test/recorder_sink.test.ts
git commit -m "feat(observability): rename span-close event_type span -> span_end"
```

---

### Task 3: Widen `formatProgressLine` to carry ordering + identity + worker total

Wire findings **F1 (part 2)** and **F4** (span pairing/nesting on the wire). Project `seq`, `event_id`, `span_id`, `parent_span_id` (root `""`→`null`), a derived `ts` (started_at for `span_start`, else ended_at), and the metadata-carried `workers_total`/`worker_index` (null when absent) onto each NDJSON line. Existing `heuristic_id`/`name`/`count` fields are preserved (backward-compatible; the contract adds fields, it does not remove them).

**Files:**
- Modify: `cli/run_address.ts:16-29` (`formatProgressLine`)
- Test: `test/progress_line.test.ts` (rewrite existing)

- [ ] **Step 1: Write the failing test**

Replace the contents of `test/progress_line.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { formatProgressLine } from "../cli/run_address.ts";
import { makeMetricEvent } from "../src/observability/models.ts";

describe("formatProgressLine", () => {
  it("carries seq + identity + timestamp for a span_start", () => {
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
    expect(JSON.parse(formatProgressLine(event))).toEqual({
      progress: {
        seq: 7,
        event_id: "e1",
        span_id: "s1",
        parent_span_id: "root",
        ts: "2026-07-09T00:00:00.000Z",
        event_type: "span_start",
        phase: "preflight",
        agent_id: "orchestrator",
        heuristic_id: "",
        name: "",
        workers_total: null,
        worker_index: null,
        status: "ok",
      },
    });
  });

  it("maps a root (empty) parent_span_id to null and uses ended_at for span_end ts", () => {
    const event = makeMetricEvent({
      event_id: "e2",
      event_type: "span_end",
      run_id: "r1",
      phase: "investigation",
      agent_id: "orchestrator",
      span_id: "s0",
      parent_span_id: "",
      started_at: "2026-07-09T00:00:00.000Z",
      ended_at: "2026-07-09T00:00:05.000Z",
      seq: 42,
    });
    const p = JSON.parse(formatProgressLine(event)).progress;
    expect(p.parent_span_id).toBeNull();
    expect(p.ts).toBe("2026-07-09T00:00:05.000Z");
    expect(p.event_type).toBe("span_end");
    expect(p.seq).toBe(42);
  });

  it("lifts workers_total + worker_index from metadata and keeps launched count", () => {
    const bracket = makeMetricEvent({
      event_id: "e3",
      event_type: "span_start",
      run_id: "r1",
      phase: "heuristic_workers",
      agent_id: "orchestrator",
      seq: 3,
      metadata: { launched_subagents: 7, workers_total: 5 },
    });
    const bp = JSON.parse(formatProgressLine(bracket)).progress;
    expect(bp.workers_total).toBe(5);
    expect(bp.worker_index).toBeNull();
    expect(bp.count).toBe(7);

    const worker = makeMetricEvent({
      event_id: "e4",
      event_type: "span_start",
      run_id: "r1",
      phase: "heuristic_worker",
      agent_id: "group:a+b",
      seq: 4,
      metadata: { workers_total: 5, worker_index: 2, group_size: 2, heuristic_ids: ["a", "b"] },
    });
    const wp = JSON.parse(formatProgressLine(worker)).progress;
    expect(wp.workers_total).toBe(5);
    expect(wp.worker_index).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/progress_line.test.ts`
Expected: FAIL — the first `toEqual` fails (current output lacks `seq`/`event_id`/`span_id`/`parent_span_id`/`ts`/`workers_total`/`worker_index`).

- [ ] **Step 3: Minimal implementation**

In `cli/run_address.ts`, replace `formatProgressLine` (lines 16-29):

```ts
/** One `--progress` NDJSON line for a metric event (consumed by the backend's --progress translator). */
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/progress_line.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add cli/run_address.ts test/progress_line.test.ts
git commit -m "feat(cli): widen --progress line with seq/identity/ts/worker total"
```

---

### Task 4: Separate progress NDJSON from report JSON on stdout

Wire finding **F5**. Today the report JSON goes to stdout when `--out` is omitted (`run_address.ts:131`), interleaving multi-line report text with the `--progress` NDJSON on the same stream. Route the report to `--out` when given; when `--progress` is set and `--out` is omitted, route the report to **stderr** so stdout stays progress-only. Behavior with `--progress` off is unchanged (report → stdout).

**Files:**
- Modify: `cli/run_address.ts:122-132` (report sink) + add exported helper
- Test: `test/report_destination.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/report_destination.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { reportDestination } from "../cli/run_address.ts";

describe("reportDestination", () => {
  it("routes the report to the --out file whenever --out is given", () => {
    expect(reportDestination(true, "/x/out.json")).toBe("file");
    expect(reportDestination(false, "/x/out.json")).toBe("file");
  });

  it("keeps stdout progress-only: report to stderr when --progress and no --out", () => {
    expect(reportDestination(true, undefined)).toBe("stderr");
  });

  it("without --progress and no --out, report stays on stdout", () => {
    expect(reportDestination(false, undefined)).toBe("stdout");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/report_destination.test.ts`
Expected: FAIL — `reportDestination` is not exported (`SyntaxError`/undefined import).

- [ ] **Step 3: Minimal implementation**

In `cli/run_address.ts`, add the exported helper below `resolveGraphqlUrl` (after line 13):

```ts
/**
 * Where the final report JSON goes. When --progress is on, stdout is reserved for the
 * NDJSON stream, so the report goes to --out (file) or, if absent, to stderr — never stdout.
 */
export function reportDestination(
  progress: boolean,
  out: string | undefined,
): "file" | "stdout" | "stderr" {
  if (out) {
    return "file";
  }
  return progress ? "stderr" : "stdout";
}
```

Replace the report-writing block in `main` (current lines 122-132):

```ts
  const out = values.out;
  const dest = reportDestination(values.progress, out);
  if (dest === "file") {
    mkdirSync(dirname(out!), { recursive: true });
    writeFileSync(out!, output + "\n", { encoding: "utf-8" });
    const events = (metrics_events ?? []) as MetricEvent[];
    if (events.length > 0) {
      writeRunMetrics(out!, events, assessment.metrics as RunMetricsSummary);
    }
  } else if (dest === "stderr") {
    process.stderr.write(output + "\n");
  } else {
    process.stdout.write(output + "\n");
  }
  return 0;
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/report_destination.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/run_address.ts test/report_destination.test.ts
git commit -m "feat(cli): keep --progress stdout NDJSON-only, route report to --out/stderr"
```

---

### Task 5: Bucket-scaled `workers_total` up front + per-worker `worker_index`

Wire findings **F2**, **F4**, **F6**. The streamed worker unit is the **bucket** (one `heuristic_worker` span per bucket), but the only total is `heuristics.length` on the `heuristic_workers` bracket — mis-scaled whenever heuristics are grouped (`#buckets < #heuristics`). Compute `workers_total = buckets.length` **before** opening the bracket span, stamp it on the bracket `span_start` and on every `heuristic_worker` span along with a 0-based `worker_index`, and expose the same total on `agent_metrics` (F6). `span_id`/`parent_span_id` on the wire (Task 3) already let consumers pair the concurrently-interleaved worker spans (F4).

**Files:**
- Modify: `src/agents/orchestrator.ts:293-299` (bracket span + buckets), `:317-323` (agent_metrics call), `:463-469` (`_run_subagents` signature), `:489` (`run_bucket` signature), `:506-514` (worker span metadata), `:547-548` (buckets/index), `:1105-1125` (`_agent_metrics`), add `_worker_span_metadata` near `:848`
- Test: `test/worker_count.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/worker_count.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { _bucket_by_group, _worker_span_metadata } from "../src/agents/orchestrator.ts";
import { get_heuristic_catalog } from "../src/heuristics/packets.ts";

describe("worker count = bucket count", () => {
  it("collapses grouped heuristics so buckets < heuristics for the real catalog", () => {
    const heuristics = get_heuristic_catalog();
    const buckets = _bucket_by_group(heuristics);

    // 7 packets: two groups (owner_property_context, occupancy_presence) each collapse
    // 2 heuristics into 1 bucket; the other 3 ungrouped packets stay singleton => 5 buckets.
    expect(heuristics.length).toBe(7);
    expect(buckets.length).toBe(5);
    expect(buckets.length).toBeLessThan(heuristics.length);
    // buckets partition the heuristics with no loss
    expect(buckets.flat().length).toBe(heuristics.length);
  });

  it("stamps workers_total and a 0-based worker_index on each worker span", () => {
    const grouped = [{ id: "a" }, { id: "b" }];
    const solo = [{ id: "c" }];
    const workers_total = 2;

    expect(_worker_span_metadata(grouped, 0, workers_total)).toEqual({
      group_size: 2,
      heuristic_ids: ["a", "b"],
      workers_total: 2,
      worker_index: 0,
    });
    expect(_worker_span_metadata(solo, 1, workers_total)).toEqual({
      group_size: 1,
      heuristic_ids: ["c"],
      workers_total: 2,
      worker_index: 1,
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/worker_count.test.ts`
Expected: FAIL — `_worker_span_metadata` is not exported (import error). (The `_bucket_by_group` assertions would pass; the file fails to load without the missing export.)

- [ ] **Step 3: Minimal implementation**

In `src/agents/orchestrator.ts`, add the exported helper directly above `_bucket_by_group` (near line 848):

```ts
/**
 * Span metadata for one heuristic_worker (bucket): its ids/size plus the fixed bucket total
 * and this worker's 0-based index. workers_total + worker_index reach the --progress wire.
 */
export function _worker_span_metadata(
  bucket: Record<string, any>[],
  worker_index: number,
  workers_total: number,
): Record<string, unknown> {
  return {
    group_size: bucket.length,
    heuristic_ids: bucket.map((h) => String(h["id"])),
    workers_total,
    worker_index,
  };
}
```

In `_investigate`, compute buckets up front and stamp the bracket total (replace lines 293-299):

```ts
    const heuristics = run_plans.map((plan) => heuristic_by_id.get(plan.heuristic_id)!);
    context.selected_heuristic_ids = run_plans.map((plan) => plan.heuristic_id);
    // The streamed worker unit is the bucket (one heuristic_worker span per bucket), so the
    // up-front total the UI counts against is buckets.length, not heuristics.length.
    const buckets = _bucket_by_group(heuristics);
    const results = await recorder.span(
      "heuristic_workers",
      {
        agent_id: "orchestrator",
        metadata: { launched_subagents: heuristics.length, workers_total: buckets.length },
      },
      async () => await this._run_subagents(heuristics, context, request, trace, run_plans, buckets),
    );
```

Pass the bucket total into `agent_metrics` (F6) — update the call (lines 317-323):

```ts
    const agent_metrics = _agent_metrics({
      candidate_count,
      gated_count: candidate_heuristics.length,
      workers_total: buckets.length,
      plan: investigation_plan,
      results,
      report,
    });
```

Widen `_run_subagents` to accept the precomputed buckets (signature at lines 463-469):

```ts
  async _run_subagents(
    heuristics: Record<string, any>[],
    context: ResolvedAddressContext,
    request: AgentInvestigationRequest,
    trace: InvestigationTrace,
    plans: HeuristicPlan[] | null = null,
    buckets: Record<string, any>[][] | null = null,
  ): Promise<HeuristicAgentResult[]> {
```

Thread `worker_index`/`workers_total` through `run_bucket` (change its signature at line 489):

```ts
    const run_bucket = async (
      bucket: Record<string, any>[],
      worker_index: number,
      workers_total: number,
    ): Promise<HeuristicAgentResult[]> => {
```

Inside `run_bucket`, use the helper for the worker span metadata (replace the metadata line at 511):

```ts
        return await rec.span(
          "heuristic_worker",
          {
            agent_id: worker_id,
            heuristic_id: solo ? firstId : ids.join("+"),
            metadata: _worker_span_metadata(bucket, worker_index, workers_total),
          },
          async () => await _dispatch_bucket(this.subagent, agent_inputs, graphql),
        );
```

Use the precomputed buckets and map with the index (replace lines 547-548):

```ts
    const resolved_buckets = buckets ?? _bucket_by_group(heuristics);
    const workers_total = resolved_buckets.length;
    const bucket_results = await Promise.all(
      resolved_buckets.map((bucket, worker_index) => run_bucket(bucket, worker_index, workers_total)),
    );
```

Add `workers_total` to `_agent_metrics` (opts + output, lines 1105-1125):

```ts
function _agent_metrics(opts: {
  candidate_count: number;
  gated_count: number;
  workers_total: number;
  plan: CaseInvestigationPlan;
  results: HeuristicAgentResult[];
  report: string;
}): Record<string, any> {
  const { candidate_count, gated_count, workers_total, plan, results, report } = opts;
  return {
    candidate_packets: candidate_count,
    gated_packets: gated_count,
    skipped_packets: plan.skipped.length,
    launched_subagents: results.length,
    workers_total,
    graphql_query_count: results.reduce((acc, result) => acc + result.graphql_queries.length, 0),
    tool_error_count: results.reduce((acc, result) => acc + result.tool_errors.length, 0),
    validation_error_count: results.reduce((acc, result) => acc + result.validation_errors.length, 0),
    query_repair_attempts: results.reduce((acc, result) => acc + result.query_repair_attempts, 0),
    evidence_refs_count: results.reduce((acc, result) => acc + result.evidence_refs.length, 0),
    report_bytes_estimate: Buffer.byteLength(report, "utf8"),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/worker_count.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator.ts test/worker_count.test.ts
git commit -m "feat(agents): bucket-scaled workers_total + worker_index on heuristic_worker spans"
```

---

## Verification / Definition of Done

- [ ] **Full engine test suite green** (run in place):

  Run: `bun test`
  Expected: PASS — all files, including the four new/updated ones (`recorder_seq`, `recorder_sink`, `progress_line`, `report_destination`, `worker_count`).

- [ ] **Typecheck green:**

  Run: `bun run typecheck`
  Expected: no errors (the new `seq` field, `span_end` union member, `reportDestination`/`_worker_span_metadata` exports, and the widened `_run_subagents` signature all typecheck).

- [ ] **Live CLI assertion — strictly increasing `seq`, paired worker spans, bucket-scaled `workers_total`, uncorrupted stdout.** Bring up the graph service and run one investigation with `--progress`, capturing progress on stdout and the report via `--out`:

```bash
git submodule update --init --recursive
export GRAPH_DB=/abs/path/to/graph.sqlite
docker compose up -d graphql   # graph service on :8000

bun run cli/run_address.ts \
  --address "1600 PENNSYLVANIA AVE" --zip 20500 \
  --graphql-url http://localhost:8000/graphql \
  --progress --out /tmp/report.json \
  > /tmp/progress.ndjson 2> /tmp/run.err
```

  Then assert the wire contract holds (`seq` monotonic, worker spans paired, `workers_total` fixed and equal to the bracket total and every worker's stamp):

```bash
bun run - <<'EOF'
import { readFileSync } from "node:fs";
const events = readFileSync("/tmp/progress.ndjson", "utf8")
  .trim().split("\n").filter(Boolean)
  .map((l) => JSON.parse(l).progress);

// (a) seq strictly increasing across the whole stream
let prev = -Infinity;
for (const e of events) {
  if (!(e.seq > prev)) throw new Error(`seq not increasing: ${e.seq} after ${prev}`);
  prev = e.seq;
}

// (b) workers_total present up front and identical on every heuristic_worker event
const bracket = events.find((e) => e.phase === "heuristic_workers" && e.event_type === "span_start");
if (!bracket || typeof bracket.workers_total !== "number") throw new Error("bracket workers_total missing");
const total = bracket.workers_total;
const workers = events.filter((e) => e.phase === "heuristic_worker");
for (const w of workers) {
  if (w.workers_total !== total) throw new Error(`worker workers_total ${w.workers_total} != ${total}`);
}

// (c) worker_index is a 0-based dense set of size workers_total
const idx = new Set(workers.filter((w) => w.event_type === "span_start").map((w) => w.worker_index));
if (idx.size !== total) throw new Error(`distinct worker starts ${idx.size} != workers_total ${total}`);
for (let i = 0; i < total; i++) if (!idx.has(i)) throw new Error(`missing worker_index ${i}`);

// (d) every heuristic_worker span_start pairs with a span_end by span_id
const starts = new Map(workers.filter((w) => w.event_type === "span_start").map((w) => [w.span_id, w]));
for (const end of workers.filter((w) => w.event_type === "span_end")) {
  if (!starts.has(end.span_id)) throw new Error(`unpaired span_end ${end.span_id}`);
}

console.log(`OK: ${events.length} events; seq strictly increasing; workers_total=${total}; ${idx.size} worker spans paired`);
EOF
```

  Then assert stdout carried **only** progress NDJSON (no report JSON corruption):

```bash
bun run - <<'EOF'
import { readFileSync } from "node:fs";
for (const line of readFileSync("/tmp/progress.ndjson", "utf8").trim().split("\n").filter(Boolean)) {
  const o = JSON.parse(line);
  if (!o.progress) throw new Error("non-progress line on stdout: " + line.slice(0, 80));
}
console.log("OK: stdout carried only progress NDJSON; report is at /tmp/report.json");
EOF
```

  Expected: both scripts print `OK:` and exit 0; `/tmp/report.json` exists and contains the report JSON. Tear down: `docker compose down`.

- [ ] **Handoff note for the coordinator (out of engine-repo scope):** the umbrella `docs/harness/progress.md` and `docs/harness/feature_list.json` are updated in coordinator mode once the backend/frontend halves of the contract land. This engine plan's boundary is: engine gates green + the live wire assertion above.

<!--
Type/name consistency check: `seq` (models.ts field + factory default + recorder counter + formatProgressLine + progress_line test) ; `span_end` (models.ts union + recorder emit + summary + recorder_sink test) ; `workers_total`/`worker_index` (orchestrator bracket metadata + _worker_span_metadata + _agent_metrics + formatProgressLine + worker_count test + live DoD) ; `reportDestination` (run_address export + report_destination test + main) ; `_worker_span_metadata`/`_bucket_by_group`/`buckets` param on `_run_subagents` (orchestrator + worker_count test). No "span" event_type consumers remain outside the three renamed sites. No placeholders.
-->

---

## Notes for the executor

- **Branch:** create `feat/streaming-contract` from `feat/progress-span-start` (**not** `main`) before Task 1. Verified: engine `main` does not contain `cli/run_address.ts` `formatProgressLine` / the `--progress` span_start code this plan modifies — that code lives only on `feat/progress-span-start`.
- **Test/verify commands** (confirmed from `package.json` + `README.md`): `bun test` (whole suite), `bun test test/<file>.test.ts` (single file), `bun run typecheck` (`tsc --noEmit`). No `docs/harness/` exists in this repo — these three are the gates.
- **Backward-compat kept on purpose:** `formatProgressLine` retains `heuristic_id`/`name`/`count`; `agent_metrics` retains `launched_subagents` (adds `workers_total` alongside). The contract *adds* fields — nothing the current backend reads is removed.
- **Why `seq` is assigned in `_emit` (not `_build_event`):** `_build_event` has no side effects and is also used for the sink-only `span_start`; `_emit` is the single point every emitted and every persisted event passes through exactly once, so it is the correct choke point for a monotonic, emission-ordered counter. It is assigned *before* the sink guard so persisted JSONL events carry it even when no live sink is attached.
- **Why buckets are computed in `_investigate` (not left inside `_run_subagents`):** the `workers_total` must be on the bracket `span_start` emitted *before* `_run_subagents` runs; `_bucket_by_group` is deterministic on the same `heuristics` array, so passing the precomputed buckets down avoids recompute/drift while keeping a `?? _bucket_by_group(heuristics)` fallback.
