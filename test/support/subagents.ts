// Deterministic subagents for the E2E + exposure suites. Shared from test/support so the E2E and
// the external-evidence tests drive the orchestrator through the same fake rather than each
// carrying a private copy that can drift.
import { HeuristicAgentResultSchema } from "../../src/agents/models.ts";
import type { HeuristicSubagent } from "../../src/agents/subagents.ts";
import { TypedToolset } from "../../src/agents/toolsets/typed_toolset.ts";

/**
 * Returns a schema-valid not_triggered result echoing the packet id (the orchestrator drops
 * results whose id isn't in the requested set). No LLM, no network.
 */
export class FakeSubagent implements HeuristicSubagent {
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

/**
 * A FakeSubagent that also records the exact prompt each packet worker would have been sent, so a
 * test can assert on what the model actually sees rather than on an intermediate structure.
 */
export class PromptRecordingSubagent extends FakeSubagent {
  readonly prompts = new Map<string, string>();

  override async run(agent_input: any, graphql: any) {
    const toolset = new TypedToolset();
    this.prompts.set(
      String(agent_input.heuristic.id),
      toolset.user_prompt(agent_input, toolset.build_context(agent_input)),
    );
    return super.run(agent_input, graphql);
  }

  /** Every recorded prompt joined — for "this string appears nowhere" assertions. */
  all(): string {
    return [...this.prompts.values()].join("\n");
  }
}
