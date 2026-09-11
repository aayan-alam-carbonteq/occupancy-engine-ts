// test/prompts_same_person.test.ts
import { describe, expect, test } from "bun:test";
import { master_adjudication_user_prompt } from "../src/agents/prompts.ts";

const CONTEXT = { input_address: "1105 CLOVELLY CT", input_zip: "40517", evidence_map: {} };
const RAW = { final_score: 4, band: "review" };
const LINES = [
  "P1 THOMAS RICHARDSON | trace, utility | born 1947",
  "P2 TOM RICHARDSON | trace",
  "O1 FURRY, CATHERINE D | tax owner",
];

const WITHOUT = master_adjudication_user_prompt(CONTEXT, RAW, [], [], true);
const WITH = master_adjudication_user_prompt(CONTEXT, RAW, [], [], true, LINES);
const requirementBlock = (prompt: string) =>
  prompt.slice(prompt.indexOf("- same_person (optional):"), prompt.indexOf("- Submit using submit_case_adjudication"));

describe("X-091 master adjudication prompt: the Identity check", () => {
  test("no list, no change: an empty list renders exactly the prompt without one", () => {
    expect(master_adjudication_user_prompt(CONTEXT, RAW, [], [], true, [])).toBe(WITHOUT);
    expect(WITHOUT).not.toContain("Identity check");
    expect(WITHOUT).not.toContain("same_person");
  });

  test("the list sits between the analyst submissions and the requirements, lines verbatim", () => {
    const section = WITH.indexOf("\nIdentity check:\n");
    expect(section).toBeGreaterThan(WITH.indexOf("Analyst submissions:"));
    expect(section).toBeLessThan(WITH.indexOf("Adjudication requirements:"));
    expect(WITH).toContain(`Identity check:\n${LINES.join("\n")}\n\nAdjudication requirements:`);
  });

  test("the requirement names ids, the fullest spelling, birth years and the owner rule", () => {
    expect(WITH.indexOf("- same_person (optional):")).toBeGreaterThan(WITH.indexOf("Adjudication requirements:"));
    const block = requirementBlock(WITH);
    for (const phrase of [
      "Identity check ids",
      "fullest spelling",
      "birth years differ",
      "not sure",
      "O id only when that person is the tax owner",
      "empty when everyone is distinct",
    ]) {
      expect([phrase, block.includes(phrase)]).toEqual([phrase, true]);
    }
  });

  test("same_person stays optional: it is not in the required key list", () => {
    expect(WITH.slice(WITH.indexOf("Include keys:"))).not.toContain("same_person");
  });

  test("never frames grouping as agreement with an outside claim", () => {
    const identity = WITH.slice(WITH.indexOf("Identity check:"), WITH.indexOf("Adjudication requirements:"));
    const text = `${identity}\n${requirementBlock(WITH)}`;
    for (const forbidden of ["the scan", "the listing", "corroborate", "agree with", "confirm the"]) {
      expect([forbidden, text.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });
});
