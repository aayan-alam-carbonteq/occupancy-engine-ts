// Fixture payloads for the preflight + E2E harness, as Contract B response bodies.
//
// There is no capture step any more. The old fixture was a frozen real GraphQL response refreshed
// by scripts/capture_preflight_fixture.ts, which duplicated PREFLIGHT_QUERY verbatim — a drift
// hazard with nothing to drift against once the contract is typed. `resolve_1104.json` is instead
// hand-derived from that captured data into the exact shape handlers.resolve_address returns:
// records are RAW VENDOR ROWS stamped with `__rowid` (records.records_block serves `{**row,
// "__rowid": n}` — there is no {table, rowid, data} envelope), `records_by_source` carries all
// seven live shapes in manifest order, and the paging arithmetic is the service's own
// (PREFLIGHT_ROWS = 10, so utility's 15 rows page to 10 with has_more true).
import {
  type ExternalEvidence,
  ExternalEvidenceSchema,
} from "../../src/agents/external_evidence.ts";
import resolve1104Json from "./fixtures/resolve_1104.json";

/** The real 1104 SPRING RUN RD case, as a Contract-B POST /v1/resolve body. */
export function resolve1104(): Record<string, unknown> {
  return resolve1104Json as unknown as Record<string, unknown>;
}

/**
 * The clustered GET /v1/address/3342/people body for the same case, derived by running
 * source/people.py's `people_for_bundle` semantics over resolve_1104.json's own rows: cluster every
 * name-carrying shape on `__norm_name_key` (base, trace, loan, drive, auto, utility, tax — a tax row
 * with an `ownercompany` is skipped), sort by that key, id each cluster `addr:<addressId>:<index>`.
 * Eleven clusters, paged at the service's PREFLIGHT_ROWS-sized limit of 10.
 *
 * `sources` is the set of shapes a cluster was actually drawn from, so it is NOT uniformly "base":
 * the utility-only residents are utility-only, and REBECCA CORRELL is a tax-row cluster. Operation 3
 * carries NO identity_confidence / is_suspicious — handlers._PERSON_KEYS omits both, because an
 * `addr:`-clustered person has no hal identity to score.
 */
export function people1104(): Record<string, unknown> {
  return {
    total_count: 11,
    has_more: true,
    people: [
      { id: "addr:3342:0", firstname: "AMY", middlename: null, lastname: "WILSON", full_name: "AMY WILSON", norm_name_key: "amy|wilson", sources: ["utility"], primary_address_id: 3342 },
      { id: "addr:3342:1", firstname: "BRANDON", middlename: null, lastname: "MORGISON", full_name: "BRANDON MORGISON", norm_name_key: "brandon|morgison", sources: ["auto"], primary_address_id: 3342 },
      { id: "addr:3342:2", firstname: "JENNIFER", middlename: null, lastname: "HOWARD", full_name: "JENNIFER HOWARD", norm_name_key: "jennifer|howard", sources: ["utility"], primary_address_id: 3342 },
      { id: "addr:3342:3", firstname: "JESSICA", middlename: null, lastname: "WHISMAN", full_name: "JESSICA WHISMAN", norm_name_key: "jessica|whisman", sources: ["base", "trace"], primary_address_id: 3342 },
      { id: "addr:3342:4", firstname: "JOHN", middlename: "H", lastname: "PIERCE", full_name: "JOHN H PIERCE", norm_name_key: "john|pierce", sources: ["utility"], primary_address_id: 3342 },
      { id: "addr:3342:5", firstname: "JOSIAH", middlename: null, lastname: "CORRELL", full_name: "JOSIAH CORRELL", norm_name_key: "josiah|correll", sources: ["base", "trace"], primary_address_id: 3342 },
      { id: "addr:3342:6", firstname: "KENNETH", middlename: "S", lastname: "WORTHINGTON", full_name: "KENNETH S WORTHINGTON", norm_name_key: "kenneth|worthington", sources: ["utility"], primary_address_id: 3342 },
      { id: "addr:3342:7", firstname: "PATRICK", middlename: "A", lastname: "WILSON", full_name: "PATRICK A WILSON", norm_name_key: "patrick|wilson", sources: ["utility"], primary_address_id: 3342 },
      { id: "addr:3342:8", firstname: "REBECCA", middlename: null, lastname: "CORRELL", full_name: "REBECCA CORRELL", norm_name_key: "rebecca|correll", sources: ["tax"], primary_address_id: 3342 },
      { id: "addr:3342:9", firstname: "SUSAN", middlename: "R", lastname: "PIERCE", full_name: "SUSAN R PIERCE", norm_name_key: "susan|pierce", sources: ["utility"], primary_address_id: 3342 },
    ],
  };
}

/**
 * The synthetic all-zero case: resolves, but every shape is empty.
 *
 * SYNTHETIC, and deliberately so — this body is not reachable from the real service. handlers.
 * resolve_address sets `resolved = bundle.relation_count > 0` and relation_count is the SUM of
 * source_counts, so an address with no rows at all answers `candidates: [], address_id: null`. This
 * fixture exists to drive the "resolved, but every source is a gap" branch, which the corpus itself
 * cannot produce; do not read it as an example of a real response.
 */
export function sparseResolvePayload(): Record<string, unknown> {
  const empty = { total_count: 0, has_more: false, records: [] };
  return {
    candidates: [
      {
        address_id: 1,
        match_score: 1.0,
        matched_fields: ["address"],
        relation_count: 0,
        norm_address: "123 MAIN ST",
        zip5: "40505",
        street_number: "123",
        street_name: "MAIN",
        unit: null,
        city: "LEXINGTON",
        state: "KY",
        county: "FAYETTE",
      },
    ],
    address_id: 1,
    source_counts: { base: 0, auto: 0, drive: 0, loan: 0, tax: 0, trace: 0, utility: 0 },
    // Only `tax` has a quality gate, so the real service reports that one key and no others.
    dropped_counts: { tax: 0 },
    tax_timed_out: false,
    records_by_source: { base: empty, auto: empty, drive: empty, loan: empty, tax: empty, trace: empty, utility: empty },
  };
}

export function sparsePeoplePayload(): Record<string, unknown> {
  return { total_count: 0, has_more: false, people: [] };
}

/**
 * The external evidence payload for the exposure + E2E suites. Built THROUGH
 * ExternalEvidenceSchema rather than declared as a typed literal, so it can never become a second
 * copy of the contract: a structural change fails loudly here, at the fixture, instead of silently
 * in the tests that consume it.
 */
export function externalEvidenceFixture(): ExternalEvidence {
  return ExternalEvidenceSchema.parse({
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
    // realtor rental history for 1104 (two "Listed for rent" events via a property manager)
    rental_listings: [
      { date: "2026-05-02", price: 2300, source: "AppfolioUnits" },
      { date: "2025-03-20", price: 2195, source: "AppfolioUnits" },
    ],
    property_facts: {
      source_provider: "realtor",
      home_type: "single_family",
      year_built: 1998,
      bedrooms: 3,
      baths: 2,
      area_sqft: 1840,
      lot_sqft: 7200,
      listing_status: "for_rent",
      // X-014 transaction context (from the 1104 probe: sold 2018-10-25 for $195k, listed 2026-05-02)
      last_sold_date: "2018-10-25",
      last_sold_price: 195000,
      list_date: "2026-05-02",
      flags: [],
      property_url: "https://www.realtor.com/realestateandhomes-detail/1104-Spring-Run-Rd",
    },
  });
}
