import { describe, expect, test } from "bun:test";
import { detect_leaks, redact_prose } from "../src/agents/prose_redaction.ts";

describe("redact_prose", () => {
  test("rewrites a camelCase schema field to a human phrase", () => {
    const out = redact_prose("The utilityRecords show recent activity.");
    expect(out).not.toContain("utilityRecords");
    expect(out).toContain("utility service record");
  });

  test("drops a column=value pair, keeping a human phrase", () => {
    const out = redact_prose("own_rent=0 for the occupant.");
    expect(out).not.toContain("own_rent");
    expect(out).not.toContain("=0");
    expect(out).toContain("tenure (owner or renter)");
  });

  test("collapses an unknown snake_case identifier via the catch-all", () => {
    const out = redact_prose("The some_unknown_field was present.");
    expect(out).not.toContain("some_unknown_field");
    expect(out).toContain("an internal record field");
  });

  test("leaves clean human prose untouched (no false positives)", () => {
    const clean = "The property tax record lists the owner as a renter.";
    expect(redact_prose(clean)).toBe(clean);
    const clean2 = "The residential condominium appears owner-occupied.";
    expect(redact_prose(clean2)).toBe(clean2);
  });

  test("empty input returns empty", () => {
    expect(redact_prose("")).toBe("");
  });
});

describe("detect_leaks", () => {
  test("finds distinct identifier tokens", () => {
    expect(detect_leaks("utilityRecords and own_rent appear here")).toEqual([
      "utilityRecords",
      "own_rent",
    ]);
  });

  test("returns nothing for clean prose", () => {
    expect(detect_leaks("a plain english sentence about a house")).toEqual([]);
  });
});

describe("redact_prose / detect_leaks — hardening", () => {
  test("does not treat Object.prototype members as identifiers", () => {
    const clean = "The original constructor finished the build.";
    expect(redact_prose(clean)).toBe(clean);
    expect(detect_leaks("Review the toString output before filing.")).toEqual([]);
    expect(detect_leaks("The lender will hasOwnProperty this account.")).toEqual([]);
  });

  test("catches singular / PascalCase GraphQL type names shown to the model", () => {
    const out = redact_prose("The LoanRecord shows a recent origination.");
    expect(out).not.toContain("LoanRecord");
    expect(out).toContain("mortgage/loan application record");
    expect(detect_leaks("SourceRecordConnection returned zero nodes.")).toEqual([
      "SourceRecordConnection",
    ]);
  });

  test("catches unmapped snake_case regardless of case", () => {
    expect(detect_leaks("The Some_Unknown_Field was present.")).toEqual(["Some_Unknown_Field"]);
    expect(detect_leaks("SOME_UNKNOWN_FIELD was present.")).toEqual(["SOME_UNKNOWN_FIELD"]);
  });

  test("never mangles owner names or bare type words", () => {
    const clean = "The owner is John McDonald and the person at the property is a renter.";
    expect(redact_prose(clean)).toBe(clean);
  });
});
