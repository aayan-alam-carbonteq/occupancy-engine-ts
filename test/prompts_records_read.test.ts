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
  test("the prompt no longer mentions records_read.strength — the field is gone", () => {
    // Removed 2026-09-08: `moderate` in 21 of 24 live cases, perfectly correlated with the signal,
    // and consumed by nothing. A prompt that still asks for it would make the model emit a field
    // the .strict() schema now rejects.
    expect(PROMPT).not.toContain("records_read.strength");
  });

  test("names the field and all four signals", () => {
    expect(PROMPT).toContain("records_read");
    for (const signal of ["non_owner_occupancy", "owner_occupancy", "conflicting", "no_signal"]) {
      expect([signal, PROMPT.includes(signal)]).toEqual([signal, true]);
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
