import { describe, expect, test } from "bun:test";
import { ExternalEvidenceSchema } from "../src/agents/external_evidence.ts";
import {
  external_evidence_refs,
  property_types_from_external,
  rental_market_summary_lines,
} from "../src/agents/external_evidence_map.ts";

const payload = () =>
  ExternalEvidenceSchema.parse({
    scan_id: "scan_123",
    scanned_at: "2026-07-17T10:00:00Z",
    str_listings: [
      {
        platform: "vrbo",
        listing_url: "https://www.vrbo.com/1234567",
        bedrooms: 3,
        baths: 2,
        guests: 6,
        address_match_pct: 92,
      },
    ],
    address_match_confidence: 83,
    property_facts: {
      source_provider: "realtor",
      home_type: "single_family",
      year_built: 1998,
      area_sqft: 1840,
      listing_status: "for_rent",
    },
  });

describe("rental_market_summary_lines", () => {
  test("states the listing and the address-match semantics outright", () => {
    const lines = rental_market_summary_lines(payload());
    expect(lines[0]).toBe(
      "Short-term rental listing found on vrbo: 3 bd / 2 ba / sleeps 6. Address match 92%.",
    );
    expect(lines.some((l) => l.includes("not a probability that the property is a rental"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("Scan-level address-match confidence 83%"))).toBe(true);
  });

  test("an empty-but-present payload is negative evidence, not silence", () => {
    expect(rental_market_summary_lines(ExternalEvidenceSchema.parse({ scan_id: "scan_9" }))).toEqual(
      ["All platforms scanned; no short-term rental listings matched this property."],
    );
  });

  test("an absent payload produces nothing at all — the blind default", () => {
    expect(rental_market_summary_lines(null)).toEqual([]);
  });

  test("a listing with no bed/bath/guest detail still renders its match", () => {
    const evidence = ExternalEvidenceSchema.parse({
      str_listings: [{ platform: "facebook", address_match_pct: 66.66 }],
    });
    expect(rental_market_summary_lines(evidence)[0]).toBe(
      "Short-term rental listing found on facebook. Address match 66.7%.",
    );
  });
});

describe("property_types_from_external", () => {
  test("derives the type from property_facts.home_type", () => {
    expect(property_types_from_external(payload())).toEqual(["single_family"]);
  });

  test("empty with no payload and with no home_type", () => {
    expect(property_types_from_external(null)).toEqual([]);
    expect(
      property_types_from_external(
        ExternalEvidenceSchema.parse({ property_facts: { source_provider: "redfin" } }),
      ),
    ).toEqual([]);
  });
});

describe("external_evidence_refs", () => {
  test("one str_scan ref per listing plus one property_facts ref; detail survives in data", () => {
    const refs = external_evidence_refs(payload());
    expect(refs.map((r) => r.source)).toEqual(["str_scan", "property_facts"]);
    expect(refs[0]!.record_id).toBe("scan_123:0");
    expect(refs[0]!.summary).toContain("platform=vrbo");
    // data is preserved in the assessment's evidence map for audit; compact rendering strips it.
    expect(refs[0]!.data["listing_url"]).toBe("https://www.vrbo.com/1234567");
    expect(refs[1]!.summary).toContain("source_provider=realtor");
    expect(refs[1]!.summary).toContain("listing_status=for_rent");
    expect(refs[1]!.data["area_sqft"]).toBe(1840);
  });

  test("no payload and an empty payload yield no refs", () => {
    expect(external_evidence_refs(null)).toEqual([]);
    expect(external_evidence_refs(ExternalEvidenceSchema.parse({ scan_id: "scan_9" }))).toEqual([]);
  });
});
