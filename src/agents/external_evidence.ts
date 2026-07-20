// The external evidence contract: STR scan results + scraped property facts, injected per-run via
// cli/run_address.ts --evidence-file. The engine owns this shape; callers map into it.
//
// Imports nothing but zod, deliberately: models.ts imports ExternalEvidenceSchema, so anything this
// module imported from models.ts would be a cycle. The builders that turn a payload into
// CaseEvidenceMap fields live in external_evidence_map.ts.
import { z } from "zod";

export const StrListingSchema = z
  .object({
    // Open string, not an enum: value drift is tolerated (a new platform must not fail the whole
    // investigation), structural drift is not — hence .strict().
    platform: z.string(),
    listing_url: z.string().nullish(),
    bedrooms: z.number().nullish(),
    baths: z.number().nullish(),
    guests: z.number().nullish(),
    description: z.string().nullish(),
    // 0-100. The confidence that this listing refers to THIS property, computed from bedroom and
    // bathroom agreement — not a probability that the property is a rental. The name carries the
    // semantics structurally rather than relying on prompt prose a model may skim.
    address_match_pct: z.number(),
  })
  .strict();
export type StrListing = z.infer<typeof StrListingSchema>;

export const RentalListingSchema = z
  .object({
    // A realtor property_history "Listed for rent" event. Flat + .strict(), structurally parallel
    // to StrListingSchema: the most-recent-2 events cross the contract as a flat array (NOT
    // {count, recent[]}); the total count stays a backend-internal derivation value and never
    // crosses. Introduces (with property_facts.flags) the first array shapes into this contract.
    date: z.string(), // realtor event date, ISO-ish as returned, e.g. "2026-05-02"
    price: z.number().nullish(), // monthly rent when present
    source: z.string().nullish(), // event source_name, e.g. "AppfolioUnits" (a property manager)
  })
  .strict();
export type RentalListing = z.infer<typeof RentalListingSchema>;

export const PropertyFactsSchema = z
  .object({
    // "realtor" | "redfin" — which provider won the property-details waterfall. Not an enum, and
    // not named realtor_*: a successful scan's facts may be Redfin-sourced, and this carries the truth.
    source_provider: z.string(),
    home_type: z.string().nullish(),
    year_built: z.number().nullish(),
    bedrooms: z.number().nullish(),
    baths: z.number().nullish(),
    area_sqft: z.number().nullish(),
    lot_sqft: z.number().nullish(),
    listing_status: z.string().nullish(),
    // X-014 transaction context (additive; the original 9 fields are unchanged): ownership-change
    // recency, on-market recency, and distress state. flags is truthy labels only and defaults []
    // so the clean case is 0 tokens and an absent payload stays byte-identical.
    last_sold_date: z.string().nullish(),
    last_sold_price: z.number().nullish(),
    list_date: z.string().nullish(),
    flags: z.array(z.string()).default([]),
    property_url: z.string().nullish(),
  })
  .strict();
export type PropertyFacts = z.infer<typeof PropertyFactsSchema>;

export const ExternalEvidenceSchema = z
  .object({
    scan_id: z.string().nullish(),
    scanned_at: z.string().nullish(),
    str_listings: z.array(StrListingSchema).default([]),
    // X-014: realtor rental-listing history, sibling to str_listings and riding the same
    // rental_market channel to the occupancy packets. Flat array of the most-recent-2 events.
    // .default([]) preserves blind parity — an absent payload yields [].
    rental_listings: z.array(RentalListingSchema).default([]),
    address_match_confidence: z.number().nullish(),
    property_facts: PropertyFactsSchema.nullish(),
  })
  .strict();
export type ExternalEvidence = z.infer<typeof ExternalEvidenceSchema>;
