// test/adjudication_records_read.test.ts
import { describe, expect, test } from "bun:test";
import { fallback_adjudication, submit_case_adjudication } from "../src/agents/orchestrator.ts";
import { CaseAdjudicationSchema, OCCUPANCY_SIGNAL } from "../src/agents/models.ts";

describe("X-078 fallback_adjudication.records_read", () => {
  test("emits the honest 'could not tell' default for a scored run", () => {
    const adj = fallback_adjudication({ final_score: 6, band: "review" }, "Master adjudication failed.");
    expect(adj.records_read.occupancy_signal).toBe("no_signal");
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

  test("the fallback reports no_signal at the MIDPOINT, never a strength derived from the raw score", () => {
    // A run whose adjudicator never produced anything has no case-level read of the records, so the
    // only honest report is `no_signal` — which derive_corroboration gates to a NULL corroboration
    // (not agreement 50), for every scan verdict.
    const adj = fallback_adjudication({ final_score: 18, band: "high_priority_review" }, "Retry budget exhausted.");
    expect(adj.records_read.occupancy_signal).toBe("no_signal");
    // 5, NOT 10 — even though the raw heuristics scored high. The heuristics are a RISK score, not
    // a records READ, so mapping the sum here would claim "the records overwhelmingly point away
    // from owner occupancy" about a run where nobody read the records at all.
    expect(adj.records_read.nonowner_occupancy_strength).toBe(5);
    // And it stays the midpoint no matter how the raw score moves.
    for (const final_score of [0, 7, 18, 40]) {
      const a = fallback_adjudication({ final_score, band: "low_evidence" }, "r");
      expect([final_score, a.records_read.nonowner_occupancy_strength]).toEqual([final_score, 5]);
    }
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
      verdict_band: "review",
      case_archetype: "mixed_evidence",
      reasoning_summary: "s",
      records_read: { occupancy_signal: "owner_occupancy", nonowner_occupancy_strength: 5, reasoning: "r" },
    });
    expect(parsed.records_read.driving_heuristic_ids).toEqual([]);
  });

  test("every enum value is named in a describe() string the provider will see", () => {
    const described = JSON.stringify(schema.shape.records_read);
    for (const value of [...OCCUPANCY_SIGNAL]) {
      expect([value, described.includes(value)]).toEqual([value, true]);
    }
  });
});
