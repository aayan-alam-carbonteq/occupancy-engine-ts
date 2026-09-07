// test/adjudication_records_read.test.ts
import { describe, expect, test } from "bun:test";
import { fallback_adjudication } from "../src/agents/orchestrator.ts";
import { CaseAdjudicationSchema } from "../src/agents/models.ts";

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
