import { describe, expect, test } from "bun:test";
import { CaseEvidenceMapSchema } from "../src/agents/models.ts";
import {
  humanize_evidence_map_for_display,
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

function sampleMap() {
  return CaseEvidenceMapSchema.parse({
    normalized_address: "1552 SAMARA GLEN WAY",
    owner_summaries: [
      {
        owner_name: "WINKFIELD, JERAHMY S",
        mailing_address: "209 FALCON DR VERSAILLES KY 40383",
        mailing_matches_subject: false,
        summaries: ["owner=WINKFIELD, JERAHMY S; residential=True; totalliencount=1; totallienbalance=83000.0; ownerrescount=1"],
      },
    ],
    people_at_address: [
      { name: "DONALD CAIN", relationship_to_owner: "unrelated", sources: ["loan"], summaries: ["loan; own_rent=0; address=X"] },
    ],
    nonowner_occupancy_hints: ["unrelated person at address via loan: DONALD CAIN."],
    evidence_refs: [{ source: "tax", table: "taxProperties", rowid: 5, summary: "tax; own_rent=0" }],
  });
}

describe("humanize_evidence_map_for_display", () => {
  test("humanizes the three human-facing arrays", () => {
    const out = humanize_evidence_map_for_display(sampleMap());
    expect(out.owner_summaries[0]!.summaries[0]).toBe(
      "Owner Winkfield, Jerahmy S; residential property; 1 lien totaling $83,000; owner linked to 1 property",
    );
    expect(out.people_at_address[0]!.summaries[0]).toBe("Mortgage/loan application record; listed as a renter");
    expect(out.nonowner_occupancy_hints[0]).toBe("Unrelated person, in mortgage/loan application records: Donald Cain.");
  });

  test("leaves evidence_refs (machine anchors) untouched", () => {
    const input = sampleMap();
    const out = humanize_evidence_map_for_display(input);
    expect(out.evidence_refs).toBe(input.evidence_refs);
    expect(out.evidence_refs[0]!.summary).toBe("tax; own_rent=0");
  });

  test("GROUNDING INTEGRITY: does not mutate the input map", () => {
    const input = sampleMap();
    const snapshot = structuredClone(input);
    humanize_evidence_map_for_display(input);
    expect(input).toEqual(snapshot);
  });
});
