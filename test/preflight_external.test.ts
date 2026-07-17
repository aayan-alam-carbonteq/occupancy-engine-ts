import { describe, expect, test } from "bun:test";
import { GraphQLHttpTool } from "../src/agents/graphql_tool.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import { FixtureGraphQLServer } from "./support/fixture_graphql.ts";
import { externalEvidenceFixture, loadPreflight1104 } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

async function preflight(external_evidence: unknown) {
  const server = new FixtureGraphQLServer(loadPreflight1104());
  try {
    const orch = new AgentOrchestrator({
      graphql: new GraphQLHttpTool(server.url),
      subagent: new FakeSubagent(),
    });
    return await orch.preflight(
      AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        graphql_url: server.url,
        external_evidence,
      }),
    );
  } finally {
    server.close();
  }
}

describe("preflight folds the payload into the context", () => {
  test("no payload: everything stays empty — byte-identical to today", async () => {
    const context = await preflight(null);
    expect(context.property_types).toEqual([]);
    expect(context.evidence_map.property_types).toEqual([]);
    expect(context.evidence_map.rental_market_summary).toEqual([]);
    expect(context.evidence_map.evidence_refs.every((r) => r.source === "tax")).toBe(true);
  });

  test("a payload fills the CONTEXT property_types and the listing channel", async () => {
    const context = await preflight(externalEvidenceFixture());
    expect(context.property_types).toEqual(["single_family"]);
    expect(context.evidence_map.rental_market_summary[0]).toContain(
      "Short-term rental listing found on vrbo",
    );
  });

  test("CORRECTION 2: evidence_map.property_types stays EMPTY so the portfolio gate stays blind", async () => {
    // adapters.ts:81 copies this field into AddressEvidence and _has_portfolio_hint
    // (atomic_eval.ts:1184) fires on "multi"/"portfolio", flipping a SCORING packet from skip to
    // run. Enrichment must move the score through reasoning, never through a gate flip.
    const context = await preflight({
      property_facts: { source_provider: "redfin", home_type: "multi_family" },
    });
    expect(context.property_types).toEqual(["multi_family"]); // prompts see it
    expect(context.evidence_map.property_types).toEqual([]); // the gate does not
  });

  test("external refs are emitted FIRST so they survive the ref cap downstream", async () => {
    const context = await preflight(externalEvidenceFixture());
    expect(context.evidence_map.evidence_refs.map((r) => r.source).slice(0, 2)).toEqual([
      "str_scan",
      "property_facts",
    ]);
    expect(context.evidence_map.evidence_refs.some((r) => r.source === "tax")).toBe(true);
  });

  test("an empty-but-present payload is negative evidence with no refs", async () => {
    const context = await preflight({ scan_id: "scan_9" });
    expect(context.evidence_map.rental_market_summary).toEqual([
      "All platforms scanned; no short-term rental listings matched this property.",
    ]);
    expect(context.evidence_map.evidence_refs.every((r) => r.source === "tax")).toBe(true);
    expect(context.property_types).toEqual([]);
  });

  test("source_counts never gains an external key — the deterministic weights are untouched", async () => {
    const context = await preflight(externalEvidenceFixture());
    expect(Object.keys(context.evidence_map.source_counts).sort()).toEqual([
      "auto",
      "base",
      "criminal",
      "drive",
      "loan",
      "tax",
      "trace",
      "utility",
      "voter",
    ]);
  });
});
