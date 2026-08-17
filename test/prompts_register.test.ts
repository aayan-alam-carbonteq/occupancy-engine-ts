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

describe("writing register glossary", () => {
  test("names plain-language phrases for the external sources too", () => {
    const glossary = buildProseRegisterLines("finding, caveats").join("\n");
    expect(glossary).toContain("str_scan → short-term-rental listing match");
    expect(glossary).toContain("property_facts → property listing record");
    expect(glossary).toContain("tax → property-tax record"); // existing entries untouched
  });

  test("carries no phrase for a shape this corpus does not hold", () => {
    // voter/criminal have zero rows in the partner corpus. A glossary entry is prompt context:
    // naming a record type the model can never fetch invites it to claim one.
    const glossary = buildProseRegisterLines("finding, caveats").join("\n");
    expect(glossary).not.toContain("voter");
    expect(glossary).not.toContain("criminal");
  });

  test("drive is a licence-bearing loan record, not an independent DMV source", () => {
    // There is no motor-vehicle feed: a drive row IS the loan row. The old phrase invited
    // double-counting drive + loan as two corroborating sources.
    const glossary = buildProseRegisterLines("finding, caveats").join("\n");
    expect(glossary).toContain("drive → licence-bearing loan record");
    expect(glossary).not.toContain("driver's-license record");
  });
});
