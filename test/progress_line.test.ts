import { describe, expect, it } from "bun:test";
import { formatProgressLine } from "../cli/run_address.ts";
import { makeMetricEvent } from "../src/observability/models.ts";

describe("formatProgressLine", () => {
  it("serializes the streaming fields of a metric event", () => {
    const event = makeMetricEvent({
      event_id: "e1",
      event_type: "span_start",
      run_id: "r1",
      phase: "preflight",
      agent_id: "orchestrator",
    });
    expect(JSON.parse(formatProgressLine(event))).toEqual({
      progress: {
        event_type: "span_start",
        phase: "preflight",
        agent_id: "orchestrator",
        heuristic_id: "",
        name: "",
        status: "ok",
      },
    });
  });

  it("carries launched_subagents metadata as count", () => {
    const event = makeMetricEvent({
      event_id: "e2",
      event_type: "span_start",
      run_id: "r1",
      phase: "heuristic_workers",
      agent_id: "orchestrator",
      metadata: { launched_subagents: 4 },
    });
    const parsed = JSON.parse(formatProgressLine(event)) as { progress: { count?: number } };
    expect(parsed.progress.count).toBe(4);
  });
});
