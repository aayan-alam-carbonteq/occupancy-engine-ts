import { describe, expect, test } from "bun:test";
import { DataHttpClient } from "../src/agents/data_client.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import { _resolve_bundle_address_id } from "../src/agents/retrieval.ts";
import { records_fingerprint } from "../src/fingerprint/data_source_probe.ts";
import { TypedDataSourceProbe } from "../src/fingerprint/typed_probe.ts";
import { FixtureDataService, type FixtureDataPlan } from "./support/fixture_data_service.ts";
import { people1104, resolve1104, sparsePeoplePayload, sparseResolvePayload } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

const ADDRESS = "1104 SPRING RUN RD";
const ZIP = "40514";

const PERSON_RECORDS_FIXTURE = {
  person: { id: "addr:3342:0" },
  records_by_source: {
    tax: { total_count: 1, has_more: false, records: [{ __rowid: 0, id: "p1", ownername: "PROBED PERSON ROW" }] },
  },
  records_timed_out: false,
  unsupported_shapes: [],
};

/** The full 1104 fixture, wired as a FixtureDataPlan: op1 (resolve), op2 (address records), op3 (people). */
function fullPlan(overrides: FixtureDataPlan = {}): FixtureDataPlan {
  const payload = resolve1104() as Record<string, any>;
  return {
    resolve: payload,
    address_records: { records_by_source: payload["records_by_source"], unsupported_shapes: [] },
    address_people: people1104(),
    person_records: PERSON_RECORDS_FIXTURE,
    ...overrides,
  };
}

async function probeOver(plan: FixtureDataPlan, max_probed_persons?: number) {
  const s = new FixtureDataService(plan);
  try {
    const probe = new TypedDataSourceProbe(
      new DataHttpClient(s.url),
      max_probed_persons === undefined ? {} : { max_probed_persons },
    );
    return await probe.probe(ADDRESS, ZIP);
  } finally {
    s.close();
  }
}

describe("TypedDataSourceProbe — determinism", () => {
  test("the same data-service state probed twice yields the same hash", async () => {
    const first = await probeOver(fullPlan());
    const second = await probeOver(fullPlan());
    expect(first).not.toBeNull();
    expect(records_fingerprint(first!)).toBe(records_fingerprint(second!));
  });

  test("changing one source row changes the hash", async () => {
    const before = await probeOver(fullPlan());
    // resolve1104() returns the SAME parsed-JSON object on every call (it is not a deep clone), so
    // mutating it in place would poison every other test in this file that reads the fixture after
    // this one runs. structuredClone isolates this test's mutation.
    const mutatedPayload = structuredClone(resolve1104()) as Record<string, any>;
    mutatedPayload["records_by_source"]["tax"]["records"][0]["ownername"] = "SOMEONE ELSE";
    const after = await probeOver(
      fullPlan({ address_records: { records_by_source: mutatedPayload["records_by_source"], unsupported_shapes: [] } }),
    );
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(records_fingerprint(after!)).not.toBe(records_fingerprint(before!));
  });

  test("the ORDER the source returns rows in does not change the hash", async () => {
    // max_probed_persons covers every person in the fixture (10), so reversing arrival order cannot
    // change WHICH persons get their records read — only whether the final hash is order-sensitive.
    const before = await probeOver(fullPlan(), 10);
    const reversedPeople = { ...(people1104() as Record<string, any>) };
    reversedPeople["people"] = [...reversedPeople["people"]].reverse();
    const after = await probeOver(fullPlan({ address_people: reversedPeople }), 10);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(records_fingerprint(after!)).toBe(records_fingerprint(before!));
  });

  test("an address that resolves with no rows anywhere still fingerprints — empty is a real state", async () => {
    const sparse = sparseResolvePayload() as Record<string, any>;
    const records = await probeOver({
      resolve: sparse,
      address_records: { records_by_source: sparse["records_by_source"], unsupported_shapes: [] },
      address_people: sparsePeoplePayload(),
    });
    expect(records).toEqual([]);
    expect(typeof records_fingerprint(records!)).toBe("string");
  });

  test("the person hop is bounded and the bound is honoured", async () => {
    // Arrival order deliberately disagrees with sort order — the fixture returns addr:3342:9 FIRST
    // and addr:3342:1 second; the probe must sort by id, so the capped (max=1) window is addr:3342:1.
    // Asserting only the count let a mutation that DELETED the sort pass every test — and without
    // that sort the window follows arrival order, so the same data-service state hashes two ways and
    // the cache never hits.
    const s = new FixtureDataService(
      fullPlan({
        address_people: {
          total_count: 2,
          has_more: false,
          people: [
            { id: "addr:3342:9", firstname: "LAST", lastname: "ARRIVAL", full_name: "LAST ARRIVAL", sources: ["utility"], primary_address_id: 3342 },
            { id: "addr:3342:1", firstname: "SECOND", lastname: "ARRIVAL", full_name: "SECOND ARRIVAL", sources: ["utility"], primary_address_id: 3342 },
          ],
        },
      }),
    );
    try {
      const probe = new TypedDataSourceProbe(new DataHttpClient(s.url), { max_probed_persons: 1 });
      const capped = await probe.probe(ADDRESS, ZIP);
      expect(capped).not.toBeNull();
      const probedPersons = [
        ...new Set(capped!.filter((r) => r.scope === "person" && r.source !== "identity").map((r) => r.subject_id)),
      ];
      expect(probedPersons).toEqual(["addr:3342:1"]);
      // The identity rows for BOTH people are still fingerprinted — only the record hop is capped.
      expect(capped!.filter((r) => r.source === "identity").length).toBe(2);
      expect(s.requests.filter((r) => r.path.startsWith("/v1/person/")).map((r) => r.path)).toEqual([
        `/v1/person/${encodeURIComponent("addr:3342:1")}/records`,
      ]);
    } finally {
      s.close();
    }
  });
});

describe("TypedDataSourceProbe — never throws, degrades to null", () => {
  test("an unresolvable address yields null", async () => {
    const records = await probeOver({
      resolve: { candidates: [], address_id: null, source_counts: {}, dropped_counts: {}, tax_timed_out: false, records_by_source: {} },
    });
    expect(records).toBeNull();
  });

  test("a data-service call that fails yields null", async () => {
    // resolve succeeds, but op 2 (address records) has no fixture configured and 404s — the port
    // says a probe never throws, and retrieval.ts swallows that into {ok:false}, so the probe must
    // degrade to null rather than propagate or hash the failure.
    const records = await probeOver({ resolve: resolve1104() as Record<string, unknown> });
    expect(records).toBeNull();
  });

  test("an unreachable data service yields null", async () => {
    const probe = new TypedDataSourceProbe(new DataHttpClient("http://127.0.0.1:1", { timeout_seconds: 2 }));
    expect(await probe.probe(ADDRESS, ZIP)).toBeNull();
  });
});

describe("TypedDataSourceProbe — reads what the investigation reads", () => {
  test("address rows are scoped to the id the REAL preflight resolved, and carry no summary", async () => {
    const plan = fullPlan();
    const s = new FixtureDataService(plan);
    try {
      const request = AgentInvestigationRequestSchema.parse({ address: ADDRESS, zip: ZIP, data_url: s.url });
      const context = await new AgentOrchestrator({ data: new DataHttpClient(s.url), subagent: new FakeSubagent() }).preflight(
        request,
      );
      const records = await new TypedDataSourceProbe(new DataHttpClient(s.url)).probe(ADDRESS, ZIP);
      expect(records).not.toBeNull();

      const addressRows = records!.filter((r) => r.scope === "address");
      expect(addressRows.length).toBeGreaterThan(0);
      expect([...new Set(addressRows.map((r) => r.subject_id))]).toEqual([String(_resolve_bundle_address_id(context))]);

      // `summary` is a rendering of `data`; hashing both would double-weight a change.
      for (const record of records!) {
        expect(Object.hasOwn(record, "summary")).toBe(false);
      }
      // The compact projection reached the record, not the raw source row (`junk`/`__rowid`/etc.
      // never leak through).
      const tax = addressRows.find((r) => r.source === "tax");
      expect(tax === undefined).toBe(false);
      expect(tax!.data["ownername"]).toBe("CORRELL, REBECCA CHRISTINE; CORRELL, JOSIAH STEEL");
      expect(Object.keys(tax!.data).some((k) => k.startsWith("__"))).toBe(false);
    } finally {
      s.close();
    }
  });
});
