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
  test("names the field and all three signals", () => {
    expect(PROMPT).toContain("records_read");
    for (const signal of ["non_owner_occupancy", "owner_occupancy", "no_signal"]) {
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
    // The single most damaging error this feature could make is collapsing "the records are silent"
    // into "the records say owner-occupied". They map to different backend states.
    expect(PROMPT).toContain("silent");
    expect(PROMPT).toContain("no_signal is not a weak owner_occupancy");
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
