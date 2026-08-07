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

describe("assessment_report_payload is tenant-neutral (cross-org reuse)", () => {
  it("strips the CALLER's identifiers out of metrics", () => {
    // Reports are reused across organizations, so nothing the engine emits may name the org that
    // paid for the run. metrics.batch_id is request.batch_id verbatim, and run_id /
    // investigation_id derive from request.trace_id — all caller-supplied. Only metrics_events was
    // being stripped, so these three crossed the wire into a report served to someone else.
    const assessment = {
      verdict: "review",
      metrics: {
        run_id: "TRACE-LEAKCANARY",
        batch_id: "BATCH-LEAKCANARY",
        investigation_id: "TRACE-LEAKCANARY",
        address_key: "1104-spring-run-rd",
        model: "claude-haiku-4-5",
        total_cost_usd: 0.42,
        total_tokens: 1234,
      },
      metrics_events: [{ run_id: "TRACE-LEAKCANARY" }],
    } as unknown as Parameters<typeof assessment_report_payload>[0];

    const serialized = JSON.stringify(assessment_report_payload(assessment));
    // Asserted on the SERIALIZED payload — metrics is a loose record, so a key-by-key check on a
    // type cannot prove absence.
    expect(serialized).not.toContain("LEAKCANARY");
    expect(serialized).not.toContain("batch_id");
    expect(serialized).not.toContain("run_id");
    expect(serialized).not.toContain("investigation_id");
  });

  it("keeps the tenant-neutral metrics that make the report useful", () => {
    const assessment = {
      metrics: { batch_id: "b", run_id: "r", investigation_id: "i", total_cost_usd: 0.42, total_tokens: 1234 },
    } as unknown as Parameters<typeof assessment_report_payload>[0];
    const out = assessment_report_payload(assessment) as { metrics: Record<string, unknown> };
    // Cost and token accounting are not caller identity — dropping them would be over-correction.
    expect(out.metrics["total_cost_usd"]).toBe(0.42);
    expect(out.metrics["total_tokens"]).toBe(1234);
  });

  it("an assessment with no metrics survives untouched", () => {
    const out = assessment_report_payload({ verdict: "clean" } as never);
    expect(out["verdict"]).toBe("clean");
  });
});
