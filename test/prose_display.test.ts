import { describe, expect, test } from "bun:test";
import {
  humanizeNonownerHint,
  humanizeOwnerSummary,
  humanizePersonSummary,
} from "../src/agents/prose_display.ts";

describe("humanizePersonSummary", () => {
  test("renders a loan record with renter tenure, dropping address/dob", () => {
    expect(humanizePersonSummary("loan; own_rent=0; address=1552 SAMARA GLEN WAY; zip=40515")).toBe(
      "Mortgage/loan application record; listed as a renter",
    );
  });
  test("renders unknown tenure as 'tenure not stated'", () => {
    expect(humanizePersonSummary("loan; own_rent=U; address=1552 SAMARA GLEN WAY; dob_year=1975")).toBe(
      "Mortgage/loan application record; tenure not stated",
    );
  });
  test("renders a bare trace record with no extra bits", () => {
    expect(humanizePersonSummary("trace; address=1552 SAMARA GLEN WAY; zip=40515; dob_year=0")).toBe(
      "Address-history record",
    );
  });
});

describe("humanizeOwnerSummary", () => {
  test("renders owner, mailing, residential, lien math, and property count", () => {
    const raw =
      "owner=WINKFIELD, JERAHMY S; mailing=209 FALCON DR VERSAILLES KY 40383; residential=True; condo=False; lendername=NOT AVAILABLE; totalliencount=1; totallienbalance=83000.0; ownerrescount=1";
    expect(humanizeOwnerSummary(raw)).toBe(
      "Owner Winkfield, Jerahmy S; mailing address 209 FALCON DR VERSAILLES KY 40383; residential property; 1 lien totaling $83,000; owner linked to 1 property",
    );
  });
});

describe("humanizeNonownerHint", () => {
  test("maps the relationship enum and the source list, title-casing the name", () => {
    expect(humanizeNonownerHint("likely_family person at address via trace: JEREHMY WINKFIELD.")).toBe(
      "Likely a family member, in address-history records: Jerehmy Winkfield.",
    );
    expect(humanizeNonownerHint("unrelated person at address via base: DONALD R CAIN.")).toBe(
      "Unrelated person, in identity/residence records: Donald R Cain.",
    );
  });
  test("passes a string that does not match the template through unchanged", () => {
    expect(humanizeNonownerHint("Some other hint.")).toBe("Some other hint.");
  });
});
