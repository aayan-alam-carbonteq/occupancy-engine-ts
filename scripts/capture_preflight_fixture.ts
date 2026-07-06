// One-time capture of a real GraphQL preflight response, frozen as the E2E fixture.
// Run with the Python GraphQL server up on :8000. GraphQL-only (no LLM, no cost).
import { mkdirSync, writeFileSync } from "node:fs";

const URL = process.env.OE_GRAPHQL_URL ?? "http://127.0.0.1:8000/graphql";
const ADDRESS = "1104 SPRING RUN RD";
const ZIP = "40514";
const OUT = "test/support/fixtures/preflight_1104.json";

const PREFLIGHT_QUERY = `query AgentAddressPreflight($query: String!, $zip: String) {
  searchAddresses(query: $query, zip: $zip, limit: 5) {
    totalCount
    nodes {
      matchScore matchedFields relationCount
      address { id normAddress zip5 streetNumber streetName unit city state county }
    }
  }
  addressByText(query: $query, zip: $zip) {
    id normAddress zip5 streetNumber streetName unit city state county
    residents(limit: 10) { totalCount nodes { id firstname lastname fullName } }
    utilityRecords(limit: 10) { totalCount nodes { table rowid data } }
    taxProperties(limit: 5) { totalCount nodes { table rowid data } }
    traceRecords(limit: 10) { totalCount nodes { table rowid data } }
    autoRecords(limit: 10) { totalCount nodes { table rowid data } }
    loanRecords(limit: 10) { totalCount nodes { table rowid data } }
    driveRecords(limit: 10) { totalCount nodes { table rowid data } }
    voterRecords(limit: 10) { totalCount nodes { table rowid data } }
    criminalRecords { totalCount }
  }
}`;

const resp = await fetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: PREFLIGHT_QUERY, variables: { query: ADDRESS, zip: ZIP } }),
});
const body = (await resp.json()) as { data?: unknown; errors?: unknown };
if (!body.data || (body.errors && (body.errors as unknown[]).length)) {
  console.error("capture failed:", JSON.stringify(body.errors ?? body));
  process.exit(1);
}
mkdirSync("test/support/fixtures", { recursive: true });
writeFileSync(OUT, JSON.stringify(body.data, null, 2) + "\n", "utf-8");
console.log(`wrote ${OUT}`);
