// Folds an ExternalEvidence payload into the CaseEvidenceMap surfaces the prompt builders read:
// the property type (context only — see the note on property_types_from_external), the
// rental_market_summary listing channel, and str_scan / property_facts evidence refs.
//
// Separate from external_evidence.ts so the contract module stays free of a
// models.ts <-> external_evidence.ts import cycle.
import { canonicalJson, sha256Hex } from "../fingerprint/canonical.ts";
import type { ExternalEvidence, PropertyFacts, RentalListing, StrListing } from "./external_evidence.ts";
import { type EvidenceReference, EvidenceReferenceSchema } from "./models.ts";

/**
 * A short, evidence-intrinsic key for one record.
 *
 * Replaces the caller's scan_id as the record_id prefix. Identical evidence MUST produce an
 * identical digest no matter which organisation paid for the run — reports are reused across
 * organisations, so anything caller-derived here becomes a cross-tenant leak in a served report.
 *
 * 12 hex chars: an audit-trail discriminator among a handful of refs on one property, not a
 * collision-resistant identity. `canonicalJson` sorts keys at every depth, so a re-ordered record
 * yields the same digest.
 */
function evidenceDigest(record: unknown): string {
  return sha256Hex(canonicalJson(record)).slice(0, 12);
}

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

/** Trim a realtor event date to year-month for the summary line: "2026-05-02" -> "2026-05". */
function _year_month(date: string): string {
  return date.slice(0, 7);
}

/** One realtor rental event: "2026-05 $2300", or "2026-05" when no price is present. */
function _rental_event(listing: RentalListing): string {
  const ym = _year_month(listing.date);
  return typeof listing.price === "number" ? `${ym} $${listing.price}` : ym;
}

/**
 * The realtor rental-history line, folded into rental_market_summary beside the STR-scan listings:
 * both are rental-market signals gated behind the SAME str_scan token, so a realtor "Listed for
 * rent" event lands next to the Airbnb/Vrbo line as a second, independent source corroborating
 * "rented". The source is the property-manager name (e.g. AppfolioUnits); when several events share
 * it, it is cited once.
 */
function _rental_history_line(listings: RentalListing[]): string {
  const events = listings.map((listing) => _rental_event(listing)).join(", ");
  const sources: string[] = [];
  for (const listing of listings) {
    if (typeof listing.source === "string" && listing.source !== "" && !sources.includes(listing.source)) {
      sources.push(listing.source);
    }
  }
  const suffix = sources.length > 0 ? ` — source ${sources.join(", ")}` : "";
  return `Property listed for rent (realtor history): ${events}${suffix}.`;
}

/** The rental_market_summary lines — the listing channel, gated behind str_scan scope. */
export function rental_market_summary_lines(evidence: ExternalEvidence | null): string[] {
  if (evidence === null) {
    return [];
  }
  const lines: string[] =
    evidence.str_listings.length === 0
      ? [NO_LISTINGS_LINE]
      : evidence.str_listings.map((listing) => _listing_line(listing));
  if (evidence.str_listings.length > 0) {
    lines.push(ADDRESS_MATCH_SEMANTICS);
    if (typeof evidence.address_match_confidence === "number") {
      lines.push(
        `Scan-level address-match confidence ${_num(evidence.address_match_confidence)}% (0-100, same semantics).`,
      );
    }
  }
  // Realtor rental history: an INDEPENDENT rental-market source, folded regardless of str_listings
  // (the 1104 case has realtor history but no matched STR listing). Rides the same str_scan gate.
  if (evidence.rental_listings.length > 0) {
    lines.push(_rental_history_line(evidence.rental_listings));
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
    ["last_sold_date", facts.last_sold_date],
    ["last_sold_price", facts.last_sold_price],
    ["list_date", facts.list_date],
    ["property_url", facts.property_url],
  ];
  for (const [key, value] of fields) {
    if (value !== null && value !== undefined && value !== "") {
      parts.push(`${key}=${value}`);
    }
  }
  // flags is an array (default []); render only when non-empty so the clean case adds nothing.
  if (facts.flags.length > 0) {
    parts.push(`flags=${facts.flags.join(",")}`);
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
  const refs: EvidenceReference[] = evidence.str_listings.map((listing, index) =>
    EvidenceReferenceSchema.parse({
      source: "str_scan",
      table: "str_listing",
      // Digest, not the caller's scan_id — see evidenceDigest. The index keeps two identical
      // listings on one scan individually addressable.
      record_id: `${evidenceDigest(listing)}:${index}`,
      summary: _listing_summary(listing),
      // scan_id / scanned_at deliberately NOT carried: they name the organisation that paid for
      // the run, and this report may be served to a different one.
      data: { ...listing },
    }),
  );
  const facts = evidence.property_facts;
  if (facts !== null && facts !== undefined) {
    refs.push(
      EvidenceReferenceSchema.parse({
        source: "property_facts",
        table: "property_facts",
        record_id: `${evidenceDigest(facts)}:property_facts`,
        summary: _facts_summary(facts),
        data: { ...facts },
      }),
    );
  }
  return refs;
}
