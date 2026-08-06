import { describe, expect, test } from "bun:test";
import { GraphQLHttpTool } from "../src/agents/graphql_tool.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import { _resolve_bundle_address_id } from "../src/agents/retrieval.ts";
import { records_fingerprint } from "../src/fingerprint/data_source_probe.ts";
import { GraphQLDataSourceProbe } from "../src/fingerprint/graphql_probe.ts";
import { FixtureGraphQLServer } from "./support/fixture_graphql.ts";
import { loadPreflight1104, probeGraphPayload } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

const ADDRESS = "1104 SPRING RUN RD";
const ZIP = "40514";

async function probeOver(payload: Record<string, unknown>, max_probed_persons?: number) {
  const server = new FixtureGraphQLServer(payload);
  try {
    const probe = new GraphQLDataSourceProbe(
      new GraphQLHttpTool(server.url),
      max_probed_persons === undefined ? {} : { max_probed_persons },
    );
    return await probe.probe(ADDRESS, ZIP);
  } finally {
    server.close();
  }
}

describe("GraphQLDataSourceProbe — determinism", () => {
  test("the same graph state probed twice yields the same hash", async () => {
    const first = await probeOver(probeGraphPayload());
    const second = await probeOver(probeGraphPayload());
    expect(first).not.toBeNull();
    expect(records_fingerprint(first!)).toBe(records_fingerprint(second!));
  });

  test("changing one source row changes the hash", async () => {
    const before = await probeOver(probeGraphPayload());
    const mutated = probeGraphPayload();
    (mutated["address"] as any).taxProperties.nodes[0].data.ownername = "SOMEONE ELSE";
    const after = await probeOver(mutated);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(records_fingerprint(after!)).not.toBe(records_fingerprint(before!));
  });

  test("the ORDER the source returns rows in does not change the hash", async () => {
    const before = await probeOver(probeGraphPayload());
    const reordered = probeGraphPayload();
    (reordered["peopleAtAddress"] as any).nodes.reverse();
    const after = await probeOver(reordered);
    expect(records_fingerprint(after!)).toBe(records_fingerprint(before!));
  });

  test("an address that resolves with no rows anywhere still fingerprints — empty is a real state", async () => {
    const records = await probeOver(loadPreflight1104());
    expect(records).toEqual([]);
    expect(typeof records_fingerprint(records!)).toBe("string");
  });

  test("the person hop is bounded and the bound is honoured", async () => {
    const capped = await probeOver(probeGraphPayload(), 1);
    expect(capped).not.toBeNull();
    const probedPersons = [
      ...new Set(capped!.filter((r) => r.scope === "person" && r.source !== "identity").map((r) => r.subject_id)),
    ];
    // WHICH person, not merely how many. The fixture returns cd146889 FIRST and cd146804 second;
    // the probe must sort by id, so the capped window is cd146804. Asserting only the count let a
    // mutation that DELETED the sort pass every test — and without that sort the window follows
    // arrival order, so the same graph state hashes two ways and the cache never hits.
    expect(probedPersons).toEqual(["cd146804"]);
    // The identity rows for BOTH people are still fingerprinted — only the record hop is capped.
    expect(capped!.filter((r) => r.source === "identity").length).toBe(2);
  });
});

describe("GraphQLDataSourceProbe — never throws, degrades to null", () => {
  test("an unresolvable address yields null", async () => {
    const records = await probeOver({ searchAddresses: { totalCount: 0, nodes: [] }, addressByText: null });
    expect(records).toBeNull();
  });

  test("a graph that returns GraphQL errors yields null", async () => {
    const server = new FixtureGraphQLServer({}, [{ message: "boom" }]);
    try {
      const probe = new GraphQLDataSourceProbe(new GraphQLHttpTool(server.url));
      expect(await probe.probe(ADDRESS, ZIP)).toBeNull();
    } finally {
      server.close();
    }
  });

  test("an unreachable graph yields null", async () => {
    const probe = new GraphQLDataSourceProbe(
      new GraphQLHttpTool("http://127.0.0.1:1/graphql", { timeout_seconds: 2 }),
    );
    expect(await probe.probe(ADDRESS, ZIP)).toBeNull();
  });
});

describe("GraphQLDataSourceProbe — reads what the investigation reads", () => {
  test("address rows are scoped to the id the REAL preflight resolved, and carry no summary", async () => {
    const server = new FixtureGraphQLServer(probeGraphPayload());
    try {
      const tool = new GraphQLHttpTool(server.url);
      const context = await new AgentOrchestrator({ graphql: tool, subagent: new FakeSubagent() }).preflight(
        AgentInvestigationRequestSchema.parse({ address: ADDRESS, zip: ZIP, graphql_url: server.url }),
      );
      const records = await new GraphQLDataSourceProbe(tool).probe(ADDRESS, ZIP);
      expect(records).not.toBeNull();

      const addressRows = records!.filter((r) => r.scope === "address");
      expect(addressRows.length).toBeGreaterThan(0);
      expect([...new Set(addressRows.map((r) => r.subject_id))]).toEqual([
        String(_resolve_bundle_address_id(context)),
      ]);

      // `summary` is a rendering of `data`; hashing both would double-weight a change.
      for (const record of records!) {
        expect(Object.hasOwn(record, "summary")).toBe(false);
      }
      // The compact projection reached the record, not the raw GraphQL node.
      const tax = addressRows.find((r) => r.source === "tax");
      expect(tax === undefined).toBe(false);
      expect(tax!.data["ownername"]).toBe("WHISMAN JESSICA");
    } finally {
      server.close();
    }
  });
});
