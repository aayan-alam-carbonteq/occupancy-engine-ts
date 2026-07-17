import { describe, expect, test } from "bun:test";
import {
  ExternalEvidenceSchema,
  PropertyFactsSchema,
  StrListingSchema,
} from "../src/agents/external_evidence.ts";

describe("ExternalEvidenceSchema", () => {
  test("parses a full payload", () => {
    const parsed = ExternalEvidenceSchema.parse({
      scan_id: "scan_123",
      scanned_at: "2026-07-17T10:00:00Z",
      str_listings: [
        {
          platform: "vrbo",
          listing_url: "https://www.vrbo.com/1234567",
          bedrooms: 3,
          baths: 2,
          guests: 6,
          description: "Charming home minutes from downtown.",
          address_match_pct: 92,
        },
      ],
      address_match_confidence: 83,
      property_facts: {
        source_provider: "realtor",
        home_type: "single_family",
        year_built: 1998,
        bedrooms: 3,
        baths: 2,
        area_sqft: 1840,
        lot_sqft: 7200,
        listing_status: "for_rent",
        property_url: "https://www.realtor.com/realestateandhomes-detail/1104",
      },
    });
    expect(parsed.str_listings[0]!.platform).toBe("vrbo");
    expect(parsed.str_listings[0]!.address_match_pct).toBe(92);
    expect(parsed.property_facts?.listing_status).toBe("for_rent");
    expect(parsed.property_facts?.source_provider).toBe("realtor");
  });

  test("str_listings defaults to empty; everything else is optional", () => {
    const parsed = ExternalEvidenceSchema.parse({});
    expect(parsed.str_listings).toEqual([]);
    expect(parsed.property_facts ?? null).toBeNull();
    expect(parsed.address_match_confidence ?? null).toBeNull();
  });

  test("platform is an open string: a new platform is accepted, not rejected", () => {
    // An enum would fail the whole investigation the day the backend adds a platform.
    expect(StrListingSchema.parse({ platform: "booking", address_match_pct: 51 }).platform).toBe(
      "booking",
    );
  });

  test("the two required fields are required", () => {
    expect(() => StrListingSchema.parse({ platform: "airbnb" })).toThrow();
    expect(() => PropertyFactsSchema.parse({ home_type: "condo" })).toThrow();
  });

  test("strict(): unknown keys are rejected at every level — structural drift is loud", () => {
    expect(() =>
      StrListingSchema.parse({ platform: "airbnb", address_match_pct: 90, lat: 38.0 }),
    ).toThrow();
    expect(() => PropertyFactsSchema.parse({ source_provider: "redfin", price: 100 })).toThrow();
    expect(() => ExternalEvidenceSchema.parse({ scan_id: "s1", verdict: "risk" })).toThrow();
  });

  test("a wrong-typed field is rejected", () => {
    expect(() =>
      ExternalEvidenceSchema.parse({
        str_listings: [{ platform: "airbnb", address_match_pct: "92" }],
      }),
    ).toThrow();
  });
});
