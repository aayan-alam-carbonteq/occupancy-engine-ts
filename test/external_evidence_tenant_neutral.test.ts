import { describe, expect, test } from "bun:test";
import { ExternalEvidenceSchema } from "../src/agents/external_evidence.ts";
import { external_evidence_refs } from "../src/agents/external_evidence_map.ts";

/**
 * The cross-org guard. A report produced for one organisation is served verbatim to another, so
 * NOTHING the engine emits may name the organisation that paid for the run.
 */
const listing = {
  platform: "vrbo",
  listing_url: "https://www.vrbo.com/1234567",
  bedrooms: 3,
  baths: 2,
  guests: 6,
  address_match_pct: 92,
};
const facts = { source_provider: "realtor", home_type: "single_family", area_sqft: 1840 };

// Same property, same evidence — two different organisations, scanned three days apart.
const orgA = () =>
  ExternalEvidenceSchema.parse({
    scan_id: "scan_aaa",
    scanned_at: "2026-07-17T10:00:00Z",
    str_listings: [listing],
    address_match_confidence: 83,
    property_facts: facts,
  });
const orgB = () =>
  ExternalEvidenceSchema.parse({
    scan_id: "scan_bbb",
    scanned_at: "2026-07-20T22:41:03Z",
    str_listings: [listing],
    address_match_confidence: 83,
    property_facts: facts,
  });

describe("external_evidence_refs is tenant-neutral", () => {
  test("identical evidence yields identical refs across different callers", () => {
    // THE test. Both fields vary together, which is the real-world case — asserting each
    // field's absence separately would pass against an implementation that swapped one leak
    // for the other.
    expect(external_evidence_refs(orgA())).toEqual(external_evidence_refs(orgB()));
  });

  test("no emitted ref carries a scan identifier or a scan timestamp, at any depth", () => {
    const serialized = JSON.stringify(external_evidence_refs(orgA()));
    // Asserted on the SERIALIZED payload, not on named keys: `data` is a jsonRecord, so a
    // key-by-key check cannot prove absence.
    expect(serialized).not.toContain("scan_aaa");
    expect(serialized).not.toContain("2026-07-17T10:00:00Z");
    expect(serialized).not.toContain("scan_id");
    expect(serialized).not.toContain("scanned_at");
  });

  test("the digest still distinguishes genuinely different evidence", () => {
    const different = ExternalEvidenceSchema.parse({
      scan_id: "scan_aaa",
      scanned_at: "2026-07-17T10:00:00Z",
      str_listings: [{ ...listing, bedrooms: 4 }],
      address_match_confidence: 83,
      property_facts: facts,
    });
    expect(external_evidence_refs(different)[0]!.record_id).not.toBe(
      external_evidence_refs(orgA())[0]!.record_id,
    );
  });

  test("record_id stays stable under key reordering within a listing", () => {
    const reordered = ExternalEvidenceSchema.parse({
      str_listings: [
        {
          address_match_pct: 92,
          guests: 6,
          baths: 2,
          bedrooms: 3,
          listing_url: listing.listing_url,
          platform: "vrbo",
        },
      ],
      address_match_confidence: 83,
      property_facts: facts,
    });
    const base = ExternalEvidenceSchema.parse({
      str_listings: [listing],
      address_match_confidence: 83,
      property_facts: facts,
    });
    expect(external_evidence_refs(reordered)[0]!.record_id).toBe(
      external_evidence_refs(base)[0]!.record_id,
    );
  });

  test("two identical listings on one scan stay individually addressable", () => {
    // The digest is per-record, so duplicates collide — the positional index is what keeps
    // refs distinct, and dropping it would make two refs indistinguishable in the audit trail.
    const twins = ExternalEvidenceSchema.parse({
      str_listings: [listing, listing],
      address_match_confidence: 83,
    });
    const refs = external_evidence_refs(twins);
    expect(refs[0]!.record_id).not.toBe(refs[1]!.record_id);
  });
});
