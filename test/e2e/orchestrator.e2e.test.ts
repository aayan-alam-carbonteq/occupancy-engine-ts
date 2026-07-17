import { describe, expect, test } from "bun:test";
import { AgentOrchestrator } from "../../src/agents/orchestrator.ts";
import { GraphQLHttpTool } from "../../src/agents/graphql_tool.ts";
import { AgentInvestigationRequestSchema } from "../../src/agents/models.ts";
import { RetrievalHeuristicSubagent } from "../../src/agents/subagents.ts";
import { TypedToolset } from "../../src/agents/toolsets/typed_toolset.ts";
import { FixtureGraphQLServer } from "../support/fixture_graphql.ts";
import { loadPreflight1104 } from "../support/fixtures.ts";
import { ScriptedChatModel } from "../support/scripted_llm.ts";
import { FakeSubagent } from "../support/subagents.ts";

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

describe("E2E-2: real subagent driven by scripted LLM (no API)", () => {
  test("investigate() runs the real subagent to a scored submit for one allowlisted packet", async () => {
    const server = new FixtureGraphQLServer(loadPreflight1104());
    try {
      const llm = new ScriptedChatModel([
        [
          {
            name: "submit_heuristic_result",
            args: {
              heuristic_id: "property_tax_context",
              status: "not_triggered",
              direction: "risk",
              score: 0,
              confidence: "low",
              finding: "property_tax_context finding.",
              missing_evidence: ["No supporting rows in fixture."],
            },
          },
        ],
      ]);
      const subagent = new RetrievalHeuristicSubagent(llm as any, new TypedToolset());
      const orch = new AgentOrchestrator({ graphql: new GraphQLHttpTool(server.url), subagent });
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        graphql_url: server.url,
        retrieval_mode: "typed_tools",
        heuristic_allowlist: ["property_tax_context"],
      });

      const a = await orch.investigate(request);

      expect(a.heuristics.length).toBe(1);
      expect(a.heuristics[0]!.heuristic_id).toBe("property_tax_context");
      expect(a.heuristics[0]!.status).not.toBe("error");
    } finally {
      server.close();
    }
  });
});
