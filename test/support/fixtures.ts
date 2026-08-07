// Fixture payloads for the E2E harness. The real preflight is captured
// (scripts/capture_preflight_fixture.ts); the sparse payload is synthetic.
import {
  type ExternalEvidence,
  ExternalEvidenceSchema,
} from "../../src/agents/external_evidence.ts";
import preflight1104 from "./fixtures/preflight_1104.json";

export function loadPreflight1104(): Record<string, unknown> {
  return preflight1104 as unknown as Record<string, unknown>;
}

/**
 * The external evidence payload for the exposure + E2E suites. Built THROUGH
 * ExternalEvidenceSchema rather than declared as a typed literal, so it can never become a second
 * copy of the contract: a structural change fails loudly here, at the fixture, instead of silently
 * in the tests that consume it. (scripts/capture_preflight_fixture.ts already duplicates
 * PREFLIGHT_QUERY verbatim — do not repeat that drift hazard.)
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

function sparseAddress(): Record<string, unknown> {
  return {
    id: 1,
    normAddress: "123 MAIN ST",
    zip5: "40505",
    streetNumber: "123",
    streetName: "MAIN",
    unit: null,
    city: "LEXINGTON",
    state: "KY",
    county: "FAYETTE",
    residents: { totalCount: 0, nodes: [] },
    utilityRecords: { totalCount: 0, nodes: [] },
    taxProperties: { totalCount: 0, nodes: [] },
    traceRecords: { totalCount: 0, nodes: [] },
    autoRecords: { totalCount: 0, nodes: [] },
    loanRecords: { totalCount: 0, nodes: [] },
    driveRecords: { totalCount: 0, nodes: [] },
    voterRecords: { totalCount: 0, nodes: [] },
    criminalRecords: { totalCount: 0 },
  };
}

export function sparsePreflightPayload(): Record<string, unknown> {
  const address = sparseAddress();
  return {
    searchAddresses: {
      totalCount: 1,
      nodes: [{ matchScore: 1.0, matchedFields: ["address"], relationCount: 0, address }],
    },
    addressByText: address,
  };
}

/**
 * The graph payload the fingerprint probe reads. FixtureGraphQLServer answers EVERY query with the
 * same `data` object, so this carries the UNION of the keys the probe's query shapes select: the real
 * 1104 preflight (`searchAddresses` / `addressByText`) plus `address` (per-source shortcut rows),
 * `peopleAtAddress`, and `person` (one person's rows, returned for whichever person is asked for).
 * Sources not listed under `address` come back empty, exactly as a sparse address would.
 */
export function probeGraphPayload(): Record<string, unknown> {
  const sourceRows = (table: string, rows: Record<string, unknown>[]) => ({
    totalCount: rows.length,
    hasMore: false,
    nodes: rows.map((data, index) => ({ table, rowid: index + 1, data })),
  });
  return {
    ...loadPreflight1104(),
    address: {
      baseRecords: sourceRows("base", [
        {
          id: "cd146804",
          firstname: "JESSICA",
          lastname: "WHISMAN",
          primaryaddress: "1104 SPRING RUN RD",
          zip: "40514",
          lengthofresidence: 6,
        },
      ]),
      taxProperties: sourceRows("tax", [
        {
          id: "tx-1",
          tax_id: "TX1",
          address: "1104 SPRING RUN RD",
          zip: "40514",
          ownername: "WHISMAN JESSICA",
          owneraddressline1: "1104 SPRING RUN RD",
          residential: "Y",
          ownerrescount: 1,
        },
      ]),
      utilityRecords: sourceRows("utility", [
        {
          first_name: "JOSIAH",
          last_name: "CORRELL",
          address: "1104 SPRING RUN RD",
          city: "LEXINGTON",
          state: "KY",
          zip: "40514",
        },
      ]),
    },
    // Deliberately NOT in id order — the probe must sort, so the hash cannot depend on arrival order.
    peopleAtAddress: {
      totalCount: 2,
      hasMore: false,
      nodes: [
        {
          id: "cd146889",
          firstname: "JOSIAH",
          lastname: "CORRELL",
          fullName: "JOSIAH  CORRELL",
          normNameKey: "correll|josiah",
          primaryAddressId: 3342,
        },
        {
          id: "cd146804",
          firstname: "JESSICA",
          lastname: "WHISMAN",
          fullName: "JESSICA  WHISMAN",
          normNameKey: "whisman|jessica",
          primaryAddressId: 3342,
        },
      ],
    },
    person: {
      id: "cd146804",
      firstname: "JESSICA",
      middlename: null,
      lastname: "WHISMAN",
      fullName: "JESSICA  WHISMAN",
      baseRecords: sourceRows("base", [
        { id: "cd146804", firstname: "JESSICA", lastname: "WHISMAN", zip: "40514" },
      ]),
      voterRecords: sourceRows("voter", [
        {
          id: "v-1",
          voter_id: "V1",
          firstname: "JESSICA",
          lastname: "WHISMAN",
          address: "1104 SPRING RUN RD",
          zip: "40514",
        },
      ]),
    },
  };
}
