// Preflight over the typed surface: POST /v1/resolve, then GET /v1/address/{id}/people (D4).
//
// Every "X is skipped / X is absent" test here pins the CALL SEQUENCE, not just a count: an
// implementation that resolved the address id wrongly (candidates[0] instead of the service's own
// selection) or that called operation 3 for an unresolved address would still make "one more
// request", so a bare `requests.length` assertion could not fail for its stated reason.
import { describe, expect, test } from "bun:test";
import { DataHttpClient } from "../src/agents/data_client.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import { FixtureDataService, type FixtureDataPlan } from "./support/fixture_data_service.ts";
import { people1104, resolve1104 } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

async function preflight(plan: FixtureDataPlan, retrieval_mode = "typed_tools") {
  const s = new FixtureDataService({ resolve: resolve1104(), address_people: people1104(), ...plan });
  try {
    const orch = new AgentOrchestrator({ data: new DataHttpClient(s.url), subagent: new FakeSubagent() });
    const context = await orch.preflight(
      AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        retrieval_mode,
      }),
    );
    return { context, requests: s.requests };
  } finally {
    s.close();
  }
}

const CURATED_SCHEMA = {
  tables: [{ name: "property_owner", purpose: "tax rows", key_columns: ["ownername"] }],
  access_paths: [],
  caveats: [],
};

describe("preflight over POST /v1/resolve", () => {
  test("is exactly two calls: resolve then people (D4)", async () => {
    const { requests, context } = await preflight({});
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/resolve",
      "GET /v1/address/3342/people",
    ]);
    expect(requests[0]!.body).toEqual({ address: "1104 SPRING RUN RD", zip: "40514" });
    // D4 pins the people page at 10 — op 1 already returned the rows, this call is only for the
    // clustered identities.
    expect(requests[1]!.query).toEqual({ limit: "10" });
    expect(context.preflight_queries.map((q) => q.operation)).toEqual(["resolve", "address_people"]);
  });

  test("the people call targets the service's own selection, not candidates[0]", async () => {
    const payload = resolve1104() as Record<string, any>;
    const decoy = { ...payload.candidates[0], address_id: 9999, match_score: 0.4, norm_address: "1104 SPRING RUN RD APT 2" };
    const { context, requests } = await preflight({
      resolve: { ...payload, candidates: [decoy, payload.candidates[0]] },
    });
    expect(requests[1]!.path).toBe("/v1/address/3342/people");
    expect(context.selected?.id).toBe(3342);
    // The service already chose; its candidate row survives, so match/relation counts are real.
    expect(context.selected?.relation_count).toBe(23);
  });

  test("maps candidates, the selection and source_counts straight off the resolve payload", async () => {
    const { context } = await preflight({});
    expect(context.selected?.id).toBe(3342);
    expect(context.selected?.norm_address).toBe("1104 SPRING RUN RD");
    expect(context.candidates[0]?.match_score).toBe(1);
    // handlers._candidate: relation_count is sum(source_counts.values()).
    expect(context.candidates[0]?.relation_count).toBe(23);
    expect(context.ambiguous).toBe(false);
    expect(Object.keys(context.source_counts).sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
    expect(context.source_counts["voter"]).toBeUndefined();
    expect(context.source_counts["criminal"]).toBeUndefined();
  });

  test("skips the people call and reports ambiguity when nothing resolves", async () => {
    const { context, requests } = await preflight({
      resolve: { candidates: [], address_id: null, source_counts: {}, dropped_counts: {}, tax_timed_out: false, records_by_source: {} },
    });
    // The whole sequence, not just its length: calling operation 3 with a coerced 0/NaN id would
    // still be "one more request" and would still be served by the fixture.
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v1/resolve"]);
    expect(context.selected).toBeNull();
    expect(context.ambiguous).toBe(true);
    expect(context.evidence_map.address_id).toBeNull();
  });

  test("dropped_counts and tax_timed_out reach the model as data gaps (D6)", async () => {
    const { context } = await preflight({
      resolve: { ...(resolve1104() as Record<string, unknown>), dropped_counts: { tax: 3 }, tax_timed_out: true },
    });
    expect(context.evidence_map.data_gaps).toContain("3 tax rows were refused by the data-quality gate and are not counted.");
    expect(context.evidence_map.data_gaps).toContain("The tax lookup timed out; tax rows may be incomplete.");
    // Additive: the zero-count gaps the map has always carried are still there, and still first.
    expect(context.evidence_map.data_gaps.slice(0, 2)).toEqual([
      "No drive rows found at selected address.",
      "No loan rows found at selected address.",
    ]);
  });

  test("a zero dropped_count is not a gap — the service reports tax: 0 on every clean resolve", async () => {
    const { context } = await preflight({});
    expect((resolve1104() as any).dropped_counts).toEqual({ tax: 0 });
    expect(context.evidence_map.data_gaps.some((g) => g.includes("data-quality gate"))).toBe(false);
    expect(context.evidence_map.data_gaps.some((g) => g.includes("timed out"))).toBe(false);
  });

  test("owner + people summaries survive unchanged off the new payload", async () => {
    const { context } = await preflight({});
    const owner = context.evidence_map.owner_summaries[0]!;
    expect(owner.owner_name).toBe("CORRELL, REBECCA CHRISTINE; CORRELL, JOSIAH STEEL");
    expect(owner.mailing_address).toBe("3360 RAVINIA CIR AURORA IL 60504");
    expect(owner.mailing_matches_subject).toBe(false);
    expect(context.evidence_map.owner_elsewhere_hints[0]).toContain("3360 RAVINIA CIR");
    expect(context.evidence_map.people_at_address.some((p) => p.sources.includes("base"))).toBe(true);
    expect(context.evidence_map.evidence_refs.every((r) => r.source === "tax")).toBe(true);
    expect(context.evidence_map.freshness_hints).toEqual(["Tax recordingdate=20180627"]);
  });

  test("a person's sources are the shapes the cluster came from, never a blanket base", async () => {
    const { context } = await preflight({});
    const by_name = new Map(context.evidence_map.people_at_address.map((p) => [p.name, p]));
    // Operation 3 clusters across every name-carrying shape, so labelling all of them `base` would
    // assert base-file provenance for people who have no base row. prompts.ts renders this verbatim.
    expect(by_name.get("JESSICA WHISMAN")?.sources).toEqual(["base", "trace"]);
    expect(by_name.get("AMY WILSON")?.sources).toEqual(["utility"]);
    expect(by_name.get("REBECCA CORRELL")?.sources).toEqual(["tax"]);
    expect(by_name.get("BRANDON MORGISON")?.sources).toEqual(["auto"]);
    // WAS A KNOWN GAP, NOW FIXED. This used to assert `by_name.has("TAMIE WORTHINGTON") === false`:
    // utility rows name people in snake_case (`first_name`/`last_name`, per
    // SOURCE_DATA_FIELDS.utility) and `_person_name` read only `firstname`/`firstName`, so the shape
    // pass could not name a single utility row and op 3's clustered list — paged at 10 — was the
    // ONLY path a utility identity reached this map. TAMIE WORTHINGTON is the 11th cluster, so she
    // fell off that page and vanished despite having two utility rows right here in the payload.
    // `_person_name` now reads the snake_case spellings the service actually serves, so the shape
    // pass reaches her.
    expect((resolve1104() as any).records_by_source.utility.records.some((r: any) => r.last_name === "WORTHINGTON")).toBe(true);
    expect(by_name.get("TAMIE WORTHINGTON")?.sources).toEqual(["utility"]);
    expect(by_name.get("TAMIE WORTHINGTON")?.relationship_to_owner).toBe("unrelated");
  });

  test("one human reached both ways is ONE person, not a middle-initial duplicate", async () => {
    const { context } = await preflight({});
    const people = context.evidence_map.people_at_address;
    // JOHN PIERCE arrives twice: once as op 3's cluster, whose `full_name` carries the middle
    // initial ("JOHN H PIERCE" — people.py joins first+middle+last), and once as a raw utility row,
    // which yields "JOHN PIERCE". Keying the map on the display name would file those as two
    // residents, inflating a count several heuristics read. Grouping is on the service's own
    // first|last identity key instead, so they collapse.
    expect(people.filter((p) => p.name.includes("PIERCE") && p.name.includes("JOHN"))).toHaveLength(1);
    expect(people.some((p) => p.name === "JOHN PIERCE")).toBe(false);
    const john = people.find((p) => p.name === "JOHN H PIERCE")!;
    expect(john).toBeDefined();
    // The collapse is real, not an accident of one path never running: the utility row's own
    // summary (which the cluster object cannot produce — it carries no address/zip) is on this
    // single person.
    expect(john.sources).toEqual(["utility"]);
    expect(john.summaries.some((s) => s.includes("address=1104 SPRING RUN RD"))).toBe(true);
    // Same collapse for the other three middle-initial clusters, and the whole map is 11 people:
    // the 10 clustered + TAMIE WORTHINGTON off the shape pass. Never 14.
    for (const name of ["SUSAN R PIERCE", "KENNETH S WORTHINGTON", "PATRICK A WILSON"]) {
      expect(people.filter((p) => p.name === name)).toHaveLength(1);
    }
    expect(people.map((p) => p.name)).toHaveLength(11);
    expect(new Set(people.map((p) => p.name)).size).toBe(11);
  });

  test("evidence refs cite the bundle position, and never re-export the service's derived keys", async () => {
    const { context } = await preflight({});
    const ref = context.evidence_map.evidence_refs[0]!;
    expect(ref.table).toBe("tax");
    // `__rowid` is a bundle POSITION, so 0 is a real citable row — it must survive as 0, not null.
    expect(ref.rowid).toBe(0);
    expect(ref.data["ownername"]).toBe("CORRELL, REBECCA CHRISTINE; CORRELL, JOSIAH STEEL");
    expect(Object.keys(ref.data).some((k) => k.startsWith("__"))).toBe(false);
  });

  test('the curated schema is fetched only in "tools" mode (D5)', async () => {
    const typed = await preflight({ schema: CURATED_SCHEMA }, "typed_tools");
    expect(typed.context.schema_guide).toBe("");
    expect(typed.requests.some((r) => r.path === "/v1/schema")).toBe(false);

    const tools = await preflight({ schema: CURATED_SCHEMA }, "tools");
    expect(tools.context.schema_guide).toContain("property_owner");
    expect(tools.requests.some((r) => r.path === "/v1/schema")).toBe(true);
  });

  test("the schema fetch spends the schema-tool counter, not the data-call budget", async () => {
    const tools = await preflight({ schema: CURATED_SCHEMA }, "tools");
    // Three HTTP calls, but only the two typed operations are budgeted data calls — which is what
    // lets preflight run under a 2-call ceiling while still priming the hatch.
    expect(tools.requests.length).toBe(3);
    expect(tools.context.preflight_queries.map((q) => q.operation)).toEqual(["resolve", "address_people"]);
  });

  test("a schema fetch failure degrades to the fallback and never fails the investigation", async () => {
    const { context } = await preflight({ schema: undefined }, "tools");
    expect(context.schema_guide).toContain("Curated data schema unavailable.");
    expect(context.selected?.id).toBe(3342);
  });

  test("a failed people call is not fatal — the address still resolves", async () => {
    const { context, requests } = await preflight({ address_people: undefined }); // 404s operation 3
    expect(requests.map((r) => r.path)).toEqual(["/v1/resolve", "/v1/address/3342/people"]);
    expect(context.selected?.id).toBe(3342);
    // The name-carrying shapes still contribute, so the map degrades rather than emptying. This
    // list used to be three names — utility rows were unnameable, so the corpus's most populous
    // shape at this address contributed nothing on the degraded path.
    expect(context.evidence_map.people_at_address.map((p) => p.name).sort()).toEqual([
      "AMY WILSON",
      "BRANDON MORGISON",
      "JENNIFER HOWARD",
      "JESSICA WHISMAN",
      "JOHN PIERCE",
      "JOSIAH CORRELL",
      "KENNETH WORTHINGTON",
      "PATRICK WILSON",
      "SUSAN PIERCE",
      "TAMIE WORTHINGTON",
    ]);
    // ...but the identities only op 3's clustering can supply are still gone: `base` and `tax` have
    // no shape pass at all. Without the cluster, the names carry no middle initial — that spelling
    // is op 3's, and it is exactly why the two paths need a normalized join key.
    expect(context.evidence_map.people_at_address.some((p) => p.sources.includes("base"))).toBe(false);
    expect(context.evidence_map.people_at_address.some((p) => p.sources.includes("tax"))).toBe(false);
    expect(context.evidence_map.people_at_address.some((p) => p.sources.includes("utility"))).toBe(true);
  });
});
