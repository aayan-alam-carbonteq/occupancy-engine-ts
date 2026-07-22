import { describe, expect, test } from "bun:test";
import {
  humanize_nonowner_hint,
  humanize_owner_summary,
  humanize_person_summary,
} from "../src/agents/prose_display.ts";

describe("humanize_person_summary", () => {
  test("renders a loan record with renter tenure, dropping address/dob", () => {
    expect(humanize_person_summary("loan; own_rent=0; address=1552 SAMARA GLEN WAY; zip=40515")).toBe(
      "Mortgage/loan application record; listed as a renter",
    );
  });
  test("renders unknown tenure as 'tenure not stated'", () => {
    expect(humanize_person_summary("loan; own_rent=U; address=1552 SAMARA GLEN WAY; dob_year=1975")).toBe(
      "Mortgage/loan application record; tenure not stated",
    );
  });
  test("renders a bare trace record with no extra bits", () => {
    expect(humanize_person_summary("trace; address=1552 SAMARA GLEN WAY; zip=40515; dob_year=0")).toBe(
      "Address-history record",
    );
  });
  test("maps full-word tenure codes", () => {
    expect(humanize_person_summary("loan; own_rent=owner")).toBe("Mortgage/loan application record; listed as owner-occupant");
    expect(humanize_person_summary("loan; own_rent=renter")).toBe("Mortgage/loan application record; listed as a renter");
  });
});

describe("humanize_owner_summary", () => {
  test("renders owner, mailing, residential, lien math, and property count", () => {
    const raw =
      "owner=WINKFIELD, JERAHMY S; mailing=209 FALCON DR VERSAILLES KY 40383; residential=True; condo=False; lendername=NOT AVAILABLE; totalliencount=1; totallienbalance=83000.0; ownerrescount=1";
    expect(humanize_owner_summary(raw)).toBe(
      "Owner Winkfield, Jerahmy S; mailing address 209 FALCON DR VERSAILLES KY 40383; residential property; 1 lien totaling $83,000; owner linked to 1 property",
    );
  });
  test("drops a non-numeric ownerrescount instead of emitting NaN", () => {
    expect(humanize_owner_summary("owner=X; ownerrescount=abc")).toBe("Owner X");
  });
  test("renders condo, plural liens, and recording date", () => {
    expect(humanize_owner_summary("owner=X; condo=True; totalliencount=2; totallienbalance=150000.0; recordingdate=2020-05-01")).toBe(
      "Owner X; condominium; 2 liens totaling $150,000; recorded 2020-05-01",
    );
  });
});

describe("humanize_nonowner_hint", () => {
  test("maps the relationship enum and the source list, title-casing the name", () => {
    expect(humanize_nonowner_hint("likely_family person at address via trace: JEREHMY WINKFIELD.")).toBe(
      "Likely a family member, in address-history records: Jerehmy Winkfield.",
    );
    expect(humanize_nonowner_hint("unrelated person at address via base: DONALD R CAIN.")).toBe(
      "Unrelated person, in identity/residence records: Donald R Cain.",
    );
  });
  test("passes a string that does not match the template through unchanged", () => {
    expect(humanize_nonowner_hint("Some other hint.")).toBe("Some other hint.");
  });
  test("joins a multi-source non-owner hint", () => {
    expect(humanize_nonowner_hint("unrelated person at address via base, loan: JOHN DOE.")).toBe(
      "Unrelated person, in identity/residence records, mortgage/loan application records: John Doe.",
    );
  });
});
