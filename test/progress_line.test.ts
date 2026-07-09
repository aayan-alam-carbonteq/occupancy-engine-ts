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
