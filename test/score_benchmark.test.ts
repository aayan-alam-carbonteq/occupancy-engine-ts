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
// AFTER the drive re-weighting (1.15 -> 0.75, ranked below loan). The `was` column is the
// committed BEFORE table from the previous commit — the diff of this block IS the measurement.
//
//   case                                before -> after   band
//   no_rows                              0.00     0.00    low_evidence          (unchanged)
//   tax_only_mailing_elsewhere           2.50     2.50    monitor               (unchanged)
//   drive_only_owner_elsewhere           5.95  -> 4.75    review  -> MONITOR    (-1.20)
//   drive_and_loan_same_row              7.00  -> 5.80    review                (-1.20)
//   nonowner_loan_renter_at_subject      5.65     5.65    review                (unchanged)
//   auto_only_owner_elsewhere            4.30     4.30    monitor               (unchanged)
//   utility_only_nonowner                4.00     4.00    monitor               (unchanged)
//   trace_only_presence                  2.50     2.50    monitor               (unchanged)
//   full_stack_absentee                 18.25  -> 17.05   high_priority_review  (-1.20)
//   drive_at_subject_nonowner            9.40  ->  7.00   hpr     -> REVIEW     (-2.40)
//   drive_and_loan_nonowner_at_subject  16.00  -> 13.30   high_priority_review  (-2.70)
//   loan_only_owner_elsewhere            3.55     3.55    monitor               (unchanged)
//
// Every case that moved carries a drive row; every case that held carries none. Two cases cross a
// band boundary downward, which is the practical effect: a single payday row can no longer push a
// case to `review` on its own (drive_only_owner_elsewhere), and drive alone at the subject no
// longer reaches `high_priority_review` (drive_at_subject_nonowner).
//
// drive_and_loan_nonowner_at_subject is the only case that moves by more than the weight change
// alone (-2.70 vs -2.40 for two drive paths). The extra -0.30 is the RE-RANK:
// `repeated_nonowner_cross_source_corroboration` carries both sources, and now applies loan
// (3 x 1.05) where it applied drive (3 x 1.15). Nothing in the plan's own nine cases exercises it.
const GOLDEN: Record<string, { score: number; band: string; archetype: string }> = {
  no_rows: { score: 0, band: "low_evidence", archetype: "insufficient_ownership_data" },
  tax_only_mailing_elsewhere: { score: 2.5, band: "monitor", archetype: "non_rental_absentee_owner" },
  drive_only_owner_elsewhere: { score: 4.75, band: "monitor", archetype: "low_evidence_owner_occupied" },
  drive_and_loan_same_row: { score: 5.8, band: "review", archetype: "low_evidence_owner_occupied" },
  nonowner_loan_renter_at_subject: { score: 5.65, band: "review", archetype: "clear_absentee_rental" },
  auto_only_owner_elsewhere: { score: 4.3, band: "monitor", archetype: "low_evidence_owner_occupied" },
  utility_only_nonowner: { score: 4, band: "monitor", archetype: "non_rental_absentee_owner" },
  trace_only_presence: { score: 2.5, band: "monitor", archetype: "non_rental_absentee_owner" },
  full_stack_absentee: { score: 17.05, band: "high_priority_review", archetype: "clear_absentee_rental" },
  drive_at_subject_nonowner: { score: 7, band: "review", archetype: "clear_absentee_rental" },
  drive_and_loan_nonowner_at_subject: { score: 13.3, band: "high_priority_review", archetype: "clear_absentee_rental" },
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
