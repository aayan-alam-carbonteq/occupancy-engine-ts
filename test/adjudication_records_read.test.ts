// test/adjudication_records_read.test.ts
import { describe, expect, test } from "bun:test";
import { fallback_adjudication, submit_case_adjudication } from "../src/agents/orchestrator.ts";
import { CaseAdjudicationSchema, EVIDENCE_STRENGTH, OCCUPANCY_SIGNAL } from "../src/agents/models.ts";

describe("X-078 fallback_adjudication.records_read", () => {
  test("emits the honest 'could not tell' default for a scored run", () => {
    const adj = fallback_adjudication({ final_score: 6, band: "review" }, "Master adjudication failed.");
    expect(adj.records_read.occupancy_signal).toBe("no_signal");
    expect(adj.records_read.strength).toBe("weak");
    expect(adj.records_read.driving_heuristic_ids).toEqual([]);
  });

  test("the reasoning names the absent adjudication rather than claiming a records finding", () => {
    const adj = fallback_adjudication({ final_score: 0, band: "low_evidence" }, "No master LLM configured.");
    // It must not read as "the records were silent" — no adjudicator ever read them.
    expect(adj.records_read.reasoning).toContain("No case-level adjudication");
    expect(adj.records_read.reasoning.length).toBeGreaterThan(0);
  });

  test("the fallback bypasses zod, so assert it would have validated", () => {
    // orchestrator.ts:1082 builds this literally; nothing re-parses it before it reaches the wire.
    for (const raw of [{ final_score: 0, band: "low_evidence" }, { final_score: 14, band: "high_priority_review" }, undefined]) {
      expect(CaseAdjudicationSchema.safeParse(fallback_adjudication(raw, "reason")).success).toBe(true);
    }
  });

  test("no_signal is the default for EVERY scan verdict the backend might compare against", () => {
    // Backend contract: no_signal -> "no_independent_support" -> agreement 50, regardless of
    // strength and regardless of the scan's verdict. That is the only defensible default for a run
    // whose adjudicator never ran.
    const adj = fallback_adjudication({ final_score: 18, band: "high_priority_review" }, "Retry budget exhausted.");
    expect(adj.records_read.occupancy_signal).toBe("no_signal");
    // ...even though the raw heuristics scored high. The heuristics are not a records READ.
    expect(adj.calibrated_score).toBe(10);
  });
});

describe("X-078 submit_case_adjudication tool args", () => {
  const schema = submit_case_adjudication.schema as any;

  test("the tool exposes records_read, so the model can actually emit it", () => {
    expect(Object.keys(schema.shape)).toContain("records_read");
  });

  test("the tool args and the model schema agree field-for-field", () => {
    // orchestrator.ts:1033 parses the tool args through CaseAdjudicationSchema. A field the tool
    // does not offer can never be supplied, and every run would fall back.
    expect(Object.keys(schema.shape).sort()).toEqual(Object.keys(CaseAdjudicationSchema.shape).sort());
  });

  test("the tool accepts a full block and applies the same default", () => {
    const parsed = schema.parse({
      raw_score: 4,
      calibrated_score: 4,
      clarity_score: 6,
      verdict_band: "review",
      case_archetype: "mixed_evidence",
      reasoning_summary: "s",
      records_read: { occupancy_signal: "owner_occupancy", strength: "moderate", reasoning: "r" },
    });
    expect(parsed.records_read.driving_heuristic_ids).toEqual([]);
  });

  test("every enum value is named in a describe() string the provider will see", () => {
    const described = JSON.stringify(schema.shape.records_read);
    for (const value of [...OCCUPANCY_SIGNAL, ...EVIDENCE_STRENGTH]) {
      expect([value, described.includes(value)]).toEqual([value, true]);
    }
  });
});
