import { describe, expect, test } from "bun:test";
import { AgentOrchestrator } from "../../src/agents/orchestrator.ts";
import { GraphQLHttpTool } from "../../src/agents/graphql_tool.ts";
import { AgentInvestigationRequestSchema, HeuristicAgentResultSchema } from "../../src/agents/models.ts";
import type { HeuristicSubagent } from "../../src/agents/subagents.ts";
import { FixtureGraphQLServer } from "../support/fixture_graphql.ts";
import { loadPreflight1104 } from "../support/fixtures.ts";

// Fake subagent: returns a schema-valid not_triggered result echoing the packet id
// (the orchestrator drops results whose id isn't in the requested set).
class FakeSubagent implements HeuristicSubagent {
  async run(agent_input: any, _graphql: any) {
    const hid = String(agent_input.heuristic.id);
    return HeuristicAgentResultSchema.parse({
      heuristic_id: hid,
      status: "not_triggered",
      direction: "risk",
      score: 0,
      confidence: "low",
      finding: `${hid} finding.`,
      missing_evidence: ["No supporting rows in fixture."],
    });
  }
}

describe("E2E-1: orchestrator assembly (fixture GraphQL + fake subagent, no LLM)", () => {
  test("investigate() assembles a full assessment from the real preflight fixture", async () => {
    const server = new FixtureGraphQLServer(loadPreflight1104());
    try {
      const orch = new AgentOrchestrator({
        graphql: new GraphQLHttpTool(server.url),
        subagent: new FakeSubagent(),
      });
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        graphql_url: server.url,
      });

      const a = await orch.investigate(request);

      expect(a.resolved_address.selected).not.toBeNull();
      expect(typeof a.resolved_address.source_counts).toBe("object");
      expect(a.heuristics.length).toBeGreaterThan(0);
      expect(a.heuristics.every((h: any) => h.status !== "error")).toBe(true);
      expect(a.adjudication.verdict_band).toBeTruthy();
      expect(typeof a.report).toBe("string");
      expect(a.report.length).toBeGreaterThan(0);
      expect(server.requests.length).toBeGreaterThanOrEqual(1);
    } finally {
      server.close();
    }
  });
});
