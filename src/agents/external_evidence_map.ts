// Folds an ExternalEvidence payload into the CaseEvidenceMap surfaces the prompt builders read:
// the property type (context only — see the note on property_types_from_external), the
// rental_market_summary listing channel, and str_scan / property_facts evidence refs.
//
// Separate from external_evidence.ts so the contract module stays free of a
// models.ts <-> external_evidence.ts import cycle.
import type { ExternalEvidence, PropertyFacts, StrListing } from "./external_evidence.ts";
import { type EvidenceReference, EvidenceReferenceSchema } from "./models.ts";

// Stated outright rather than left to the model to infer from the field name.
const ADDRESS_MATCH_SEMANTICS =
  "Address-match percentages are the confidence that a listing refers to this property, " +
  "computed from bedroom/bathroom agreement. They are not a probability that the property is a rental.";

// The empty-but-present payload: negative evidence the engine cannot represent without one.
const NO_LISTINGS_LINE =
  "All platforms scanned; no short-term rental listings matched this property.";

/** Trim a number for prose: 92 -> "92", 66.66 -> "66.7". */
function _num(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function _listing_line(listing: StrListing): string {
  const shape: string[] = [];
  if (typeof listing.bedrooms === "number") {
    shape.push(`${_num(listing.bedrooms)} bd`);
  }
  if (typeof listing.baths === "number") {
    shape.push(`${_num(listing.baths)} ba`);
  }
  if (typeof listing.guests === "number") {
    shape.push(`sleeps ${_num(listing.guests)}`);
  }
  const detail = shape.length > 0 ? `: ${shape.join(" / ")}` : "";
  return `Short-term rental listing found on ${listing.platform}${detail}. Address match ${_num(listing.address_match_pct)}%.`;
}

/** The rental_market_summary lines — the listing channel, gated behind str_scan scope. */
export function rental_market_summary_lines(evidence: ExternalEvidence | null): string[] {
  if (evidence === null) {
    return [];
  }
  if (evidence.str_listings.length === 0) {
    return [NO_LISTINGS_LINE];
  }
  const lines = evidence.str_listings.map((listing) => _listing_line(listing));
  lines.push(ADDRESS_MATCH_SEMANTICS);
  if (typeof evidence.address_match_confidence === "number") {
    lines.push(
      `Scan-level address-match confidence ${_num(evidence.address_match_confidence)}% (0-100, same semantics).`,
    );
  }
  return lines;
}

/**
 * The property type, for ResolvedAddressContext.property_types ONLY.
 *
 * It must NOT be written to evidence_map.property_types: adapters.ts copies that field into
 * AddressEvidence and _has_portfolio_hint fires on any type containing "multi" or "portfolio",
 * flipping portfolio_primary_comparison_analysis from skip to run — a packet that SCORES. Writing
 * it there would let enrichment move the calibrated score through a deterministic gate rather than
 * through reasoning. Both prompt builders prefer the context value, so prompts still see it.
 */
export function property_types_from_external(evidence: ExternalEvidence | null): string[] {
  const home_type = evidence?.property_facts?.home_type;
  if (typeof home_type !== "string" || home_type.trim() === "") {
    return [];
  }
  return [home_type.trim()];
}

function _listing_summary(listing: StrListing): string {
  const parts = [
    "str_scan",
    `platform=${listing.platform}`,
    `address_match_pct=${_num(listing.address_match_pct)}`,
  ];
  if (typeof listing.bedrooms === "number") {
    parts.push(`bedrooms=${_num(listing.bedrooms)}`);
  }
  if (typeof listing.baths === "number") {
    parts.push(`baths=${_num(listing.baths)}`);
  }
  if (typeof listing.guests === "number") {
    parts.push(`guests=${_num(listing.guests)}`);
  }
  if (listing.listing_url) {
    parts.push(`listing_url=${listing.listing_url}`);
  }
  return parts.join("; ");
}

function _facts_summary(facts: PropertyFacts): string {
  const parts = ["property_facts", `source_provider=${facts.source_provider}`];
  const fields: Array<readonly [string, unknown]> = [
    ["home_type", facts.home_type],
    ["year_built", facts.year_built],
    ["bedrooms", facts.bedrooms],
    ["baths", facts.baths],
    ["area_sqft", facts.area_sqft],
    ["lot_sqft", facts.lot_sqft],
    ["listing_status", facts.listing_status],
    ["property_url", facts.property_url],
  ];
  for (const [key, value] of fields) {
    if (value !== null && value !== undefined && value !== "") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join("; ");
}

/**
 * The str_scan / property_facts evidence refs. A heuristic firing on a listing must cite one:
 * HeuristicAgentResultSchema requires non-empty evidence_for when status === "triggered".
 * `data` carries the full structured detail into the assessment's audit trail; compact prompt
 * rendering strips it back to `summary`.
 */
export function external_evidence_refs(evidence: ExternalEvidence | null): EvidenceReference[] {
  if (evidence === null) {
    return [];
  }
  const scan_key = evidence.scan_id ?? "scan";
  const refs: EvidenceReference[] = evidence.str_listings.map((listing, index) =>
    EvidenceReferenceSchema.parse({
      source: "str_scan",
      table: "str_listing",
      record_id: `${scan_key}:${index}`,
      summary: _listing_summary(listing),
      data: {
        ...listing,
        scan_id: evidence.scan_id ?? null,
        scanned_at: evidence.scanned_at ?? null,
      },
    }),
  );
  const facts = evidence.property_facts;
  if (facts !== null && facts !== undefined) {
    refs.push(
      EvidenceReferenceSchema.parse({
        source: "property_facts",
        table: "property_facts",
        record_id: `${scan_key}:property_facts`,
        summary: _facts_summary(facts),
        data: { ...facts },
      }),
    );
  }
  return refs;
}
