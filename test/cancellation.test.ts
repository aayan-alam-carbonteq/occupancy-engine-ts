import { describe, expect, test } from "bun:test";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import { CountingDataClient, DataHttpClient } from "../src/agents/data_client.ts";
import {
  AgentInvestigationRequestSchema,
  HeuristicAgentResultSchema,
  ResolvedAddressContextSchema,
} from "../src/agents/models.ts";
import { RetrievalHeuristicSubagent, type HeuristicSubagent } from "../src/agents/subagents.ts";
import { TypedToolset } from "../src/agents/toolsets/typed_toolset.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";
import { people1104, resolve1104 } from "./support/fixtures.ts";

describe("should_cancel stops launching new subagent work (orchestrator sites 3 + 4)", () => {
  test("flag flips after the first bucket → no further subagent launches, run tears down", async () => {
    let launches = 0;
    class CountingSubagent implements HeuristicSubagent {
      async run(agent_input: any, _data: any) {
        launches += 1;
        return HeuristicAgentResultSchema.parse({
          heuristic_id: String(agent_input.heuristic.id),
          status: "not_triggered",
          direction: "risk",
          score: 0,
          confidence: "low",
          finding: "counted.",
          missing_evidence: ["none"],
        });
      }
    }
    const server = new FixtureDataService({
      resolve: resolve1104(),
      address_people: people1104(),
      address_records: { records_by_source: (resolve1104() as any).records_by_source, unsupported_shapes: [] },
      schema: { tables: [], access_paths: [], caveats: [] },
    });
    try {
      const orch = new AgentOrchestrator({
        data: new DataHttpClient(server.url),
        subagent: new CountingSubagent(),
        max_concurrency: 1, // FIFO: buckets launch one at a time, so the flip is deterministic
        should_cancel: () => launches >= 1, // cancel once the first bucket has launched
      });
      // Two packets that both survive the 1104 gate (tax present; synthesis always runs), each a
      // singleton bucket → exactly two buckets, only the first may launch its subagent.
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        heuristic_allowlist: ["property_tax_context", "case_quality_and_synthesis"],
      });
      await expect(orch.investigate(request)).rejects.toThrow(/cancelled/);
      expect(launches).toBe(1); // the second bucket was gated before it ever invoked the subagent
    } finally {
      server.close();
    }
  });
});

describe("should_cancel unwinds a subagent turn loop before the LLM call (sites 1 + 2)", () => {
  function agentInput(id: string) {
    return {
      heuristic: { id, category: "risk", input_sources: [], context_scope: [] },
      context: ResolvedAddressContextSchema.parse({ input_address: "1104 SPRING RUN RD", input_zip: "40514" }),
      max_data_calls: 8,
      max_output_retries: 2,
      max_query_repair_attempts: 3,
      schema_tool_budget: 8,
      prompt_profile: "compact" as const,
      plan: null,
      trace: {},
    } as any;
  }
  function stubLlm(counter: { invokes: number }) {
    return {
      bindTools() {
        return {
          async invoke() {
            counter.invokes += 1;
            return { content: "", tool_calls: [] };
          },
        };
      },
    };
  }
  const data = new CountingDataClient(new DataHttpClient("http://127.0.0.1:9"), { max_calls: 8 });

  test("run() throws and never calls the model when should_cancel is true", async () => {
    const counter = { invokes: 0 };
    const sub = new RetrievalHeuristicSubagent(stubLlm(counter) as any, new TypedToolset(), () => true);
    await expect(sub.run(agentInput("property_tax_context"), data)).rejects.toThrow(/cancelled/);
    expect(counter.invokes).toBe(0);
  });

  test("run_group() error-fills without calling the model when should_cancel is true", async () => {
    const counter = { invokes: 0 };
    const sub = new RetrievalHeuristicSubagent(stubLlm(counter) as any, new TypedToolset(), () => true);
    const results = await sub.run_group(
      [agentInput("property_tax_context"), agentInput("case_quality_and_synthesis")],
      data,
    );
    expect(results.length).toBe(2);
    expect(results.every((r) => r.status === "error")).toBe(true);
    expect(counter.invokes).toBe(0);
  });
});
