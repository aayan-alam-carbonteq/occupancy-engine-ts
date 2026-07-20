import { describe, expect, test } from "bun:test";
import {
  ExternalEvidenceSchema,
  PropertyFactsSchema,
  RentalListingSchema,
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

describe("X-014: RentalListingSchema + property_facts / rental_listings widening", () => {
  test("RentalListingSchema parses a full event; date is the only required field", () => {
    const parsed = RentalListingSchema.parse({ date: "2026-05-02", price: 2300, source: "AppfolioUnits" });
    expect(parsed.date).toBe("2026-05-02");
    expect(parsed.price).toBe(2300);
    expect(parsed.source).toBe("AppfolioUnits");
    // price/source are nullish
    expect(RentalListingSchema.parse({ date: "2025-03-20" }).price ?? null).toBeNull();
    // date is required
    expect(() => RentalListingSchema.parse({ price: 2300 })).toThrow();
  });

  test("RentalListingSchema is strict — an unknown key is rejected", () => {
    expect(() => RentalListingSchema.parse({ date: "2026-05-02", event_name: "Listed for rent" })).toThrow();
  });

  test("rental_listings is a top-level array defaulting to [] (blind parity)", () => {
    expect(ExternalEvidenceSchema.parse({}).rental_listings).toEqual([]);
    const parsed = ExternalEvidenceSchema.parse({
      rental_listings: [
        { date: "2026-05-02", price: 2300, source: "AppfolioUnits" },
        { date: "2025-03-20", price: 2195, source: "AppfolioUnits" },
      ],
    });
    expect(parsed.rental_listings).toHaveLength(2);
    expect(parsed.rental_listings[0]!.date).toBe("2026-05-02");
  });

  test("property_facts gains the four transaction fields; flags defaults [] when absent", () => {
    const facts = PropertyFactsSchema.parse({
      source_provider: "realtor",
      listing_status: "for_rent",
      last_sold_date: "2018-10-25",
      last_sold_price: 195000,
      list_date: "2026-05-02",
    });
    expect(facts.last_sold_date).toBe("2018-10-25");
    expect(facts.last_sold_price).toBe(195000);
    expect(facts.list_date).toBe("2026-05-02");
    expect(facts.flags).toEqual([]); // the clean case adds nothing
  });

  test("property_facts.flags accepts a string[]; both objects stay strict", () => {
    expect(PropertyFactsSchema.parse({ source_provider: "realtor", flags: ["foreclosure"] }).flags).toEqual([
      "foreclosure",
    ]);
    expect(() => ExternalEvidenceSchema.parse({ rental_listings: [{ date: "x" }], bogus: 1 })).toThrow();
  });
});
