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
