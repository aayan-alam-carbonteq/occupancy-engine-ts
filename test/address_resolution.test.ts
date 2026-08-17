import { describe, expect, test } from "bun:test";
import { DataHttpClient } from "../src/agents/data_client.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import { _resolve_bundle_address_id } from "../src/agents/retrieval.ts";
import { TypedDataSourceProbe } from "../src/fingerprint/typed_probe.ts";
import { FixtureDataService, type FixtureDataPlan } from "./support/fixture_data_service.ts";
import { people1104, resolve1104 } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

const ADDRESS = "1104 SPRING RUN RD";
const ZIP = "40514";

/**
 * Drives BOTH the real preflight and the probe over the same fixture data. Under the typed contract
 * both paths read address_id off the exact same field of the exact same POST /v1/resolve response
 * (orchestrator.ts's `_selected_candidate`: "The service resolves, not the engine: address_id IS the
 * selection") — so unlike the retired GraphQL-era search+by-id-fallback dance, there is no longer a
 * SEPARATE resolver implementation to drift out of sync. This still guards the one way that could
 * regress: an implementation reading `candidates[0]` instead of the service's own `address_id`.
 */
async function bothPaths(plan: FixtureDataPlan) {
  const s = new FixtureDataService({
    // A trivial always-ok body: this file's concern is address resolution, not the person hop, but
    // the probe reads people1104()'s 10 clustered people and fetches records for the default-capped
    // window of them, so op 4 needs SOME fixture or the probe degrades to null for an unrelated
    // reason (a 404 on a route this file does not care about).
    person_records: { person: { id: "addr:3342:0" }, records_by_source: {}, records_timed_out: false, unsupported_shapes: [] },
    ...plan,
  });
  try {
    const request = AgentInvestigationRequestSchema.parse({ address: ADDRESS, zip: ZIP, data_url: s.url });
    const context = await new AgentOrchestrator({ data: new DataHttpClient(s.url), subagent: new FakeSubagent() }).preflight(
      request,
    );
    const records = await new TypedDataSourceProbe(new DataHttpClient(s.url)).probe(ADDRESS, ZIP);
    return { context, records };
  } finally {
    s.close();
  }
}

describe("the probe's address resolution is the SAME resolution AgentOrchestrator.preflight performs", () => {
  test("real 1104 fixture: same address id, on every address-scoped record", async () => {
    const payload = resolve1104() as Record<string, any>;
    const { context, records } = await bothPaths({
      resolve: payload,
      address_people: people1104(),
      address_records: { records_by_source: payload["records_by_source"], unsupported_shapes: [] },
    });
    expect(context.selected?.id).toBe(3342);
    expect(_resolve_bundle_address_id(context)).toBe(3342);
    expect(records).not.toBeNull();
    const addressRows = records!.filter((r) => r.scope === "address");
    expect(addressRows.length).toBeGreaterThan(0);
    expect([...new Set(addressRows.map((r) => r.subject_id))]).toEqual([String(_resolve_bundle_address_id(context))]);
  });

  test("both paths follow the service's OWN resolved address id, never candidates[0] — regression guard", async () => {
    // Mirrors preflight.test.ts's own decoy test: candidates[0] names a DIFFERENT address than the
    // service actually resolved (`address_id` at the payload's top level, unchanged at 3342).
    const payload = resolve1104() as Record<string, any>;
    const decoy = { ...payload.candidates[0], address_id: 9999, match_score: 0.4, norm_address: "1104 SPRING RUN RD APT 2" };
    const { context, records } = await bothPaths({
      resolve: { ...payload, candidates: [decoy, payload.candidates[0]] },
      address_people: people1104(),
      address_records: { records_by_source: payload["records_by_source"], unsupported_shapes: [] },
    });
    expect(context.selected?.id).toBe(3342);
    expect(_resolve_bundle_address_id(context)).toBe(3342);
    expect(records).not.toBeNull();
    const addressRows = records!.filter((r) => r.scope === "address");
    expect(addressRows.length).toBeGreaterThan(0);
    expect(addressRows.every((r) => r.subject_id === "3342")).toBe(true);
  });

  test("unresolvable address: both paths agree — no selection, no records", async () => {
    const { context, records } = await bothPaths({
      resolve: { candidates: [], address_id: null, source_counts: {}, dropped_counts: {}, tax_timed_out: false, records_by_source: {} },
    });
    expect(context.selected).toBeNull();
    expect(_resolve_bundle_address_id(context)).toBeNull();
    expect(records).toBeNull();
  });
});
