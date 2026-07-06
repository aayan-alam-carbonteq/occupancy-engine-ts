// Fixture payloads for the E2E harness. The real preflight is captured
// (scripts/capture_preflight_fixture.ts); the sparse payload is synthetic.
import preflight1104 from "./fixtures/preflight_1104.json";

export function loadPreflight1104(): Record<string, unknown> {
  return preflight1104 as unknown as Record<string, unknown>;
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
