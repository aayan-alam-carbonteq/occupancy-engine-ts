import { describe, expect, test } from "bun:test";
import { CountingGraphQLTool, GraphQLHttpTool } from "../src/agents/graphql_tool.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import {
  AgentOrchestrator,
  resolve_subject_address,
  resolved_address_id,
} from "../src/agents/orchestrator.ts";
import { _resolve_bundle_address_id } from "../src/agents/retrieval.ts";
import { FixtureGraphQLServer } from "./support/fixture_graphql.ts";
import { loadPreflight1104, sparsePreflightPayload } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

/** Drives BOTH the real preflight and the extracted resolver over the same graph state. */
async function bothPaths(payload: Record<string, unknown>) {
  const server = new FixtureGraphQLServer(payload);
  try {
    const tool = new GraphQLHttpTool(server.url);
    const request = AgentInvestigationRequestSchema.parse({
      address: "1104 SPRING RUN RD",
      zip: "40514",
      graphql_url: server.url,
    });
    const context = await new AgentOrchestrator({ graphql: tool, subagent: new FakeSubagent() }).preflight(request);
    const resolution = await resolve_subject_address(
      new CountingGraphQLTool(tool, { max_calls: 3, agent_id: "fingerprint_probe" }),
      request.address,
      request.zip,
    );
    return { context, resolution };
  } finally {
    server.close();
  }
}

describe("resolve_subject_address is the SAME resolution AgentOrchestrator.preflight performs", () => {
  test("real 1104 fixture: same candidates, same selection, same address id", async () => {
    const { context, resolution } = await bothPaths(loadPreflight1104());
    expect(resolution.candidates).toEqual(context.candidates);
    expect(resolution.selected).toEqual(context.selected);
    expect(resolved_address_id(resolution)).toBe(_resolve_bundle_address_id(context));
    expect(resolved_address_id(resolution)).toBe(3342);
  });

  test("sparse fixture: same candidates, same selection, same address id", async () => {
    const { context, resolution } = await bothPaths(sparsePreflightPayload());
    expect(resolution.candidates).toEqual(context.candidates);
    expect(resolution.selected).toEqual(context.selected);
    expect(resolved_address_id(resolution)).toBe(_resolve_bundle_address_id(context));
  });

  test("unresolvable address: both paths yield no selection and a null address id", async () => {
    const { context, resolution } = await bothPaths({
      searchAddresses: { totalCount: 0, nodes: [] },
      addressByText: null,
    });
    expect(resolution.selected).toBeNull();
    expect(context.selected).toBeNull();
    expect(resolved_address_id(resolution)).toBeNull();
    expect(_resolve_bundle_address_id(context)).toBeNull();
  });
});
