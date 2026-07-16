import { describe, expect, test } from "bun:test";
import { _prose_register_lines, buildProseRegisterLines } from "../src/agents/prompts.ts";

describe("buildProseRegisterLines (pure content)", () => {
  test("includes the register heading, the named fields, glossary, and a coverage guard", () => {
    const lines = buildProseRegisterLines("finding, caveats, missing_evidence");
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(text).toContain("Writing register");
    expect(text).toContain("finding, caveats, missing_evidence");
    expect(text).toContain("property-tax record");
    expect(text.toLowerCase()).toContain("dimension");
  });
});

describe("_prose_register_lines (gated)", () => {
  test("is empty by default (flag off) so prompts are byte-identical", () => {
    expect(_prose_register_lines("finding, caveats, missing_evidence")).toEqual([]);
  });
});
