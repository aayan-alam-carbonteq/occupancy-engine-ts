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
    property_facts: {
      source_provider: "realtor",
      home_type: "single_family",
      year_built: 1998,
      bedrooms: 3,
      baths: 2,
      area_sqft: 1840,
      lot_sqft: 7200,
      listing_status: "for_rent",
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
