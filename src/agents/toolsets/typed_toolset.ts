// Port of occupancy_engine/agents/toolsets/typed_toolset.py.
//
// The "typed_tools" retrieval surface adapter (implements RetrievalToolset). Tool definitions,
// dispatch, and the per-heuristic guide live in typed_tools.ts; this class wires them into the
// subagent loop's toolset protocol. Behavior is preserved 1:1 with the Python source: same tool
// ownership set, same prompt wiring (TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT, typed_tools_guide),
// the schema_mini_guide is dropped from context, and grouping reuses `_union_source_scope` from
// graphql_toolset.ts.
//
// PORT NOTE (dict.pop / model_dump): Python `context.pop("schema_mini_guide", None)` -> `delete
// context["schema_mini_guide"]`. `agent_input.context.model_dump()` / `ai.plan.model_dump()` are
// already plain objects in this port, so they are passed through directly. Python `dict.get(k) or
// default` -> orElse.
import type { CountingGraphQLTool } from "../graphql_tool.ts";
import type { HeuristicAgentInput } from "../models.ts";
import {
  TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT,
  grouped_heuristic_user_prompt,
  heuristic_user_prompt,
  prompt_context,
} from "../prompts.ts";
import {
  SHAPE_TOOLS,
  SPECIAL_HANDLERS,
  _typed_tool_definitions,
  run_typed_tool,
  typed_tools_guide,
} from "../typed_tools.ts";
import type { Diagnostics, RetrievalToolset } from "./base.ts";
import { _union_source_scope } from "./graphql_toolset.ts";

export class TypedToolset implements RetrievalToolset {
  name = "typed_tools";

  tool_definitions(): any[] {
    return [..._typed_tool_definitions()];
  }

  owns_tool(name: string): boolean {
    return name === "get_records" || Object.hasOwn(SHAPE_TOOLS, name) || Object.hasOwn(SPECIAL_HANDLERS, name);
  }

  system_prompt(): string {
    return TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT;
  }

  build_context(agent_input: HeuristicAgentInput): Record<string, any> {
    const context = prompt_context(
      agent_input.context,
      agent_input.prompt_profile,
      orElse(orElse(agent_input.heuristic["context_scope"], agent_input.heuristic["input_sources"]), []),
    );
    delete context["schema_mini_guide"];
    return context;
  }

  user_prompt(agent_input: HeuristicAgentInput, context: Record<string, any>): string {
    return heuristic_user_prompt(agent_input.heuristic, context, typed_tools_guide(agent_input.heuristic));
  }

  group_user_prompt(agent_inputs: HeuristicAgentInput[]): string {
    const base = agent_inputs[0]!;
    const union_scope = _union_source_scope(agent_inputs);
    const context = prompt_context(base.context, base.prompt_profile, union_scope);
    delete context["schema_mini_guide"];
    const guide = typed_tools_guide({ context_scope: union_scope });
    return grouped_heuristic_user_prompt(
      agent_inputs.map((ai) => ai.heuristic),
      context,
      agent_inputs.map((ai) => (ai.plan !== null && ai.plan !== undefined ? ai.plan : {})),
      guide,
    );
  }

  async dispatch(
    name: string,
    args: Record<string, any>,
    agent_input: HeuristicAgentInput,
    graphql: CountingGraphQLTool,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>> {
    const content = await run_typed_tool(name, args, agent_input, graphql);
    if (!truthy(content["ok"]) && truthy(content["error"])) {
      diagnostics.tool_errors.push(String(content["error"]));
    }
    return content;
  }

  describe_call(name: string, args: Record<string, any>, _result: Record<string, any>): Record<string, any> {
    if (name === "get_records") {
      const shapes = [...(orElse(args["shapes"], []) as any)].map((s) => String(s));
      const person_scoped = String(orElse(args["person_id"], "")).trim().length > 0;
      return { shapes, scope: person_scoped ? "person" : "address", person_scoped };
    }
    const shape_entry = Object.hasOwn(SHAPE_TOOLS, name) ? SHAPE_TOOLS[name] : undefined;
    if (shape_entry === undefined) {
      return {};
    }
    const [shape, _mode] = shape_entry;
    const person_scoped = String(orElse(args["person_id"], "")).trim().length > 0;
    return { shape, scope: person_scoped ? "person" : "address", person_scoped };
  }
}

// ── Python-semantics helpers ─────────────────────────────────────────────────────────────────────────

function truthy(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (value === false) return false;
  if (value === true) return true;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `value or fallback`. */
function orElse(value: any, fallback: any): any {
  return truthy(value) ? value : fallback;
}
