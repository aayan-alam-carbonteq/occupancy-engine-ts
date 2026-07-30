import { describe, expect, test } from "bun:test";
import { evaluate_evidence } from "../src/heuristics/index.ts";
import { RANKED_SOURCE_ORDER, SOURCE_RELIABILITY_WEIGHTS, SUBSTANTIVE_SOURCES } from "../src/heuristics/policy.ts";
import { SCORE_CASES } from "./support/score_cases.ts";

/**
 * The deterministic score benchmark. Every number below was produced by running this file, not
 * derived by hand. It is the BEFORE/AFTER artifact for the drive re-weighting: changing a weight in
 * policy.ts must change this table, and the diff is the measurement.
 *
 * Regenerate with: OE_PROSE_REGISTER=off bun test test/score_benchmark.test.ts 2>&1 | grep BENCH
 */
const GOLDEN: Record<string, { score: number; band: string; archetype: string }> = {
  no_rows: { score: 0, band: "low_evidence", archetype: "insufficient_ownership_data" },
  tax_only_mailing_elsewhere: { score: 2.5, band: "monitor", archetype: "non_rental_absentee_owner" },
  drive_only_owner_elsewhere: { score: 5.95, band: "review", archetype: "low_evidence_owner_occupied" },
  drive_and_loan_same_row: { score: 7, band: "review", archetype: "low_evidence_owner_occupied" },
  nonowner_loan_renter_at_subject: { score: 5.65, band: "review", archetype: "clear_absentee_rental" },
  auto_only_owner_elsewhere: { score: 4.3, band: "monitor", archetype: "low_evidence_owner_occupied" },
  utility_only_nonowner: { score: 4, band: "monitor", archetype: "non_rental_absentee_owner" },
  trace_only_presence: { score: 2.5, band: "monitor", archetype: "non_rental_absentee_owner" },
  full_stack_absentee: { score: 18.25, band: "high_priority_review", archetype: "clear_absentee_rental" },
  drive_at_subject_nonowner: { score: 9.4, band: "high_priority_review", archetype: "clear_absentee_rental" },
  drive_and_loan_nonowner_at_subject: { score: 16, band: "high_priority_review", archetype: "clear_absentee_rental" },
  loan_only_owner_elsewhere: { score: 3.55, band: "monitor", archetype: "low_evidence_owner_occupied" },
};

describe("deterministic score benchmark", () => {
  test("prints the current table (BENCH lines) for the golden file", () => {
    for (const c of SCORE_CASES) {
      const s = evaluate_evidence(c.evidence).synthesis as Record<string, any>;
      console.log(`BENCH ${c.id} score=${s["weighted_signal_score"]} band=${s["verdict_band_candidate"]} archetype=${s["case_archetype_candidate"]}`);
    }
    expect(SCORE_CASES.length).toBe(12);
  });

  for (const c of SCORE_CASES) {
    test(`${c.id} — ${c.why}`, () => {
      const s = evaluate_evidence(c.evidence).synthesis as Record<string, any>;
      const expected = GOLDEN[c.id];
      if (expected === undefined) {
        throw new Error(`No GOLDEN row for case "${c.id}" — re-harvest the BENCH table and paste it in.`);
      }
      expect({ score: s["weighted_signal_score"], band: s["verdict_band_candidate"], archetype: s["case_archetype_candidate"] }).toEqual(expected);
    });
  }
});

describe("source policy invariants", () => {
  test("drive never out-ranks loan, and the ladder covers exactly the live sources", () => {
    expect(RANKED_SOURCE_ORDER.indexOf("drive")).toBeGreaterThan(RANKED_SOURCE_ORDER.indexOf("loan"));
    expect(SOURCE_RELIABILITY_WEIGHTS["drive"]!).toBeLessThanOrEqual(SOURCE_RELIABILITY_WEIGHTS["loan"]!);
    expect([...RANKED_SOURCE_ORDER].sort()).toEqual(["auto", "drive", "loan", "tax", "utility"]);
    expect([...SUBSTANTIVE_SOURCES].sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
  });
});
