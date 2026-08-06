// Diagnostics container and the RetrievalToolset interface for subagent runs.
import type { CountingGraphQLTool } from "../graphql_tool.ts";
import type { HeuristicAgentInput } from "../models.ts";

/** Mutable per-subagent run diagnostics shared by the loop and toolset dispatch. */
export class Diagnostics {
  tool_errors: string[] = [];
  validation_errors: string[] = [];
  query_repair_attempts = 0;
  raw_model_failures: string[] = [];
  output_validation_failures: string[] = [];
  graphql_budget_exhausted = false;
  fetched_rows: Record<string, any>[] = [];
}

/** Mode-specific retrieval surface consumed by RetrievalHeuristicSubagent. */
export interface RetrievalToolset {
  /** "tools" | "typed_tools" — not verified by isinstance() at runtime. */
  name: string;

  /** LangChain tools to bind, excluding the shared submit tool. */
  tool_definitions(): any[];

  system_prompt(): string;

  build_context(agent_input: HeuristicAgentInput): Record<string, any>;

  user_prompt(agent_input: HeuristicAgentInput, context: Record<string, any>): string;

  /** Render one shared-context prompt for a group of packets in a single conversation. */
  group_user_prompt(agent_inputs: HeuristicAgentInput[]): string;

  /** Execute one non-submit tool call and return a JSON-serializable result dict. */
  dispatch(
    name: string,
    args: Record<string, any>,
    agent_input: HeuristicAgentInput,
    graphql: CountingGraphQLTool,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>>;

  owns_tool(name: string): boolean;

  /** Per-mode breakdown metadata for the tool_call telemetry event. */
  describe_call(name: string, args: Record<string, any>, result: Record<string, any>): Record<string, any>;
}
