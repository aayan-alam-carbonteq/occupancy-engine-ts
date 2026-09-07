// test/prompts_records_read.test.ts
import { describe, expect, test } from "bun:test";
import { master_adjudication_user_prompt } from "../src/agents/prompts.ts";

const PROMPT = master_adjudication_user_prompt(
  { input_address: "1104 SPRING RUN RD", input_zip: "40514", evidence_map: {} },
  { final_score: 4, band: "review" },
  [],
  [],
);

describe("X-078 master adjudication prompt: records_read", () => {
  test("names the field and all four signals", () => {
    expect(PROMPT).toContain("records_read");
    for (const signal of ["non_owner_occupancy", "owner_occupancy", "conflicting", "no_signal"]) {
      expect([signal, PROMPT.includes(signal)]).toEqual([signal, true]);
    }
  });

  test("defines strength as the weight of the RECORDS, not model self-confidence", () => {
    expect(PROMPT).toContain("how much weight the records carry");
    expect(PROMPT).toContain("not how confident you feel");
    for (const strength of ["weak", "moderate", "strong"]) {
      expect([strength, PROMPT.includes(strength)]).toEqual([strength, true]);
    }
  });

  test("distinguishes no_signal from owner_occupancy in as many words", () => {
    // Collapsing "the records say nothing" into "the records say owner-occupied" would map two
    // different findings onto one backend state.
    expect(PROMPT).toContain("nothing to read");
    expect(PROMPT).toContain("never a weak");
  });

  test("no_signal is scoped to ABSENCE OF ROWS, and conflicting is the both-ways case", () => {
    // The Task 10 measurement (2026-09-07): with no `conflicting` value, the model chose no_signal
    // 4 times in 6 and NOT ONCE for silence — every case was a record-rich address (25-61 rows)
    // with owner and non-owner evidence it could not order in time. That made "61 records
    // disagreeing" score identically to "no records at all". The prompt must now say which is which.
    expect(PROMPT).toContain("ABSENCE OF ROWS ONLY");
    expect(PROMPT).toContain("substantive rows on both sides, that is conflicting, not");
    expect(PROMPT).toContain("SUBSTANTIVE evidence BOTH ways");
  });

  test("strength is breadth of corroboration, NOT recency — else `strong` never fires", () => {
    // Same run: `strong` was emitted zero times in six, including at an address with 18+ non-owners
    // corroborated across trace, utility, driver-licence and loan records. The model was folding
    // undated-ness into strength. Recency belongs to clarity_score.
    expect(PROMPT).toContain("Undated or stale rows do NOT cap");
    expect(PROMPT).toContain("independent source families");
  });

  test("never frames the field as agreement with an outside claim", () => {
    // The engine is blind. There is no scan, listing or verdict in its context, and inviting the
    // model to reason about one would have it invent the claim it is supposedly checking.
    const recordsBlock = PROMPT.slice(PROMPT.indexOf("records_read"));
    for (const forbidden of ["the scan", "the listing", "corroborate", "agree with", "confirm the"]) {
      expect([forbidden, recordsBlock.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  test("records_read is in the submit key list", () => {
    const keyLine = PROMPT.slice(PROMPT.indexOf("Include keys:"));
    expect(keyLine).toContain("records_read");
  });

  test("keeps the output budget honest with an explicit length cap", () => {
    expect(PROMPT).toContain("at most 2 sentences");
  });
});
