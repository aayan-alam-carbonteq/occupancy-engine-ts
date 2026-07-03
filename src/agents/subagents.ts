// Heuristic subagent execution: the single-subagent turn loop (`run`), the grouped multi-submit
// collection (`run_group` + `_handle_group_tool_calls`), the prompt-caching / forced-tool-choice env
// flags, and the compact-result validation + coercion helpers that control coverage. The pure
// multi-fetch turn in `_handle_tool_calls` runs independent dispatches concurrently and returns them
// in input order so message order matches.
import { performance } from "node:perf_hooks";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { MessageContent } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { CountingGraphQLTool } from "./graphql_tool.ts";
import {
  CONFIDENCE,
  HEURISTIC_DIRECTION,
  HEURISTIC_STATUS,
  HeuristicAgentResultSchema,
  HeuristicInterpretationSchema,
  emptyHeuristicInterpretation,
  type HeuristicAgentInput,
  type HeuristicAgentResult,
} from "./models.ts";
import { runnableConfig } from "./tracing.ts";
import { Diagnostics, type RetrievalToolset } from "./toolsets/base.ts";
import { currentRecorder } from "../observability/index.ts";
import { extractUsage } from "../observability/usage.ts";

type AnyRecorder = ReturnType<typeof currentRecorder>;

// Optional Anthropic prompt caching of the static prefix (tools + system prompt, and the initial user
// prompt). Toggled by OE_PROMPT_CACHE so it can be benchmarked without CLI plumbing. Caching the system
// message gives cross-subagent hits (identical system prompt within the 5-min TTL); caching the initial
// user message gives within-conversation hits across the multi-turn tool loop.
const _PROMPT_CACHE_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.OE_PROMPT_CACHE ?? "").trim().toLowerCase(),
);

/** Wrap prompt text in an Anthropic cache_control block when prompt caching is enabled. */
function _cache_content(text: string): MessageContent {
  if (!_PROMPT_CACHE_ENABLED) {
    return text;
  }
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

// Optional forced tool choice (OE_FORCE_TOOL_CALL): the model MUST respond with a tool call, making
// pre-submit preamble prose structurally impossible (the no-preamble instruction only reduced it).
// Haiku is generation-bound, so eliminated prose is direct latency+cost savings.
const _FORCE_TOOL_CALL = ["1", "true", "yes", "on"].includes(
  (process.env.OE_FORCE_TOOL_CALL ?? "").trim().toLowerCase(),
);

/** Bind worker tools, forcing a tool call per turn when OE_FORCE_TOOL_CALL is enabled. */
function _bind_worker_tools(llm: any, tools: any[]): any {
  if (_FORCE_TOOL_CALL) {
    return llm.bindTools(tools, { tool_choice: "any" });
  }
  return llm.bindTools(tools);
}

/**
 * Extract {source, table, rowid, summary} for every record row in a retrieval tool result.
 *
 * Handles typed_tools shapes (records_by_source / records) AND the tools-mode execute_graphql shape
 * (rows nested under 'data'), by recursively collecting any dict that carries a rowid.
 */
function _harvest_evidence_rows(content: any): Record<string, any>[] {
  const rows: Record<string, any>[] = [];
  const seen = new Set<string>();

  function _add(node: Record<string, any>): void {
    const rowid = node["rowid"];
    if (rowid === null || rowid === undefined) {
      return;
    }
    const source = node["source"] || node["table"];
    if (!source) {
      // Not a source-record row (e.g. a raw-GraphQL association/edge node that has a rowid but no
      // source/table) — skip it; an empty source is an invalid EvidenceReference.
      return;
    }
    const key = JSON.stringify([String(source), rowid ?? null]);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    rows.push({
      source,
      table: node["table"] || source,
      rowid,
      summary: sliceCodePoints(String(node["summary"] || ""), 200),
    });
  }

  function _walk(value: any): void {
    if (isRecord(value)) {
      if (value["rowid"] !== null && value["rowid"] !== undefined) {
        _add(value);
        // do not descend into a row's own scalar 'data' blob
        return;
      }
      for (const v of Object.values(value)) {
        _walk(v);
      }
    } else if (Array.isArray(value)) {
      for (const v of value) {
        _walk(v);
      }
    }
  }

  if (isRecord(content)) {
    _walk(content);
  }
  return rows;
}

/** Structural contract for a heuristic subagent; RetrievalHeuristicSubagent conforms structurally. */
export interface HeuristicSubagent {
  run(agent_input: HeuristicAgentInput, graphql: CountingGraphQLTool): Promise<HeuristicAgentResult>;
}

export class RetrievalHeuristicSubagent {
  /** Single instrumented subagent loop, parameterized by a RetrievalToolset. */
  constructor(
    public llm: any,
    public toolset: RetrievalToolset,
  ) {}

  async run(agent_input: HeuristicAgentInput, graphql: CountingGraphQLTool): Promise<HeuristicAgentResult> {
    const diagnostics = new Diagnostics();
    if (typeof this.llm.bindTools !== "function") {
      throw new Error("Native tool calls are required, but this LLM does not support bind_tools.");
    }
    const hid = String(agent_input.heuristic["id"]);
    const context = this.toolset.build_context(agent_input);
    if (agent_input.plan !== null && agent_input.plan !== undefined) {
      context["_heuristic_plan"] = agent_input.plan;
    }
    const messages: any[] = [
      new SystemMessage({ content: _cache_content(this.toolset.system_prompt()) }),
      new HumanMessage({ content: _cache_content(this.toolset.user_prompt(agent_input, context)) }),
    ];
    const model = _bind_worker_tools(this.llm, [...this.toolset.tool_definitions(), submit_heuristic_result_compact]);
    const max_turns =
      agent_input.max_graphql_calls +
      agent_input.schema_tool_budget +
      agent_input.max_output_retries +
      agent_input.max_query_repair_attempts +
      4;
    const recorder = currentRecorder();
    for (let turn_index = 0; turn_index < max_turns; turn_index++) {
      const start = performance.now();
      const response = await model.invoke(
        messages,
        runnableConfig(
          `heuristic:${hid}`,
          {
            heuristic_id: hid,
            phase: "heuristic_llm_turn",
            agent_id: `heuristic:${hid}`,
            turn_index,
          },
          ["heuristic-llm", this.toolset.name, `heuristic:${hid}`],
          agent_input.trace,
        ),
      );
      recorder.record_counter("heuristic_turn", {
        phase: "heuristic_llm_turn",
        agent_id: `heuristic:${hid}`,
        heuristic_id: hid,
        metadata: {
          turn_index,
          latency_ms: _elapsed_ms(start),
          message_count: messages.length,
          retrieval_mode: this.toolset.name,
          response: recorder.payload_metadata(response?.content ?? ""),
          usage: extractUsage(response),
        },
      });
      const tool_calls = _response_tool_calls(response);
      if (tool_calls.length > 0) {
        messages.push(response);
        const final_result = await this._handle_tool_calls(tool_calls, messages, agent_input, graphql, diagnostics);
        if (final_result !== null) {
          return final_result;
        }
        continue;
      }
      diagnostics.raw_model_failures.push("Model returned no tool calls.");
      if (diagnostics.raw_model_failures.length > agent_input.max_output_retries) {
        throw new Error("Heuristic agent did not use required native tools.");
      }
      messages.push(
        new HumanMessage({
          content:
            "Your previous response did not use a tool call. Use one of the available tools; submit final output with submit_heuristic_result.",
        }),
      );
    }
    throw new Error(`Heuristic agent exceeded turn budget: ${hid}`);
  }

  /**
   * Evaluate a group of packets in one shared conversation, one submit per packet.
   *
   * A single-input group delegates to run() so solo packets are unchanged.
   */
  async run_group(
    agent_inputs: HeuristicAgentInput[],
    graphql: CountingGraphQLTool,
  ): Promise<HeuristicAgentResult[]> {
    if (agent_inputs.length === 0) {
      return [];
    }
    if (agent_inputs.length === 1) {
      return [await this.run(agent_inputs[0]!, graphql)];
    }

    const diagnostics = new Diagnostics();
    if (typeof this.llm.bindTools !== "function") {
      throw new Error("Native tool calls are required, but this LLM does not support bind_tools.");
    }
    const inputs_by_id = new Map<string, HeuristicAgentInput>();
    for (const ai of agent_inputs) {
      inputs_by_id.set(String(ai.heuristic["id"]), ai);
    }
    const group_id = [...inputs_by_id.keys()].join("+");
    const base = agent_inputs[0]!;
    const union_scope: string[] = [];
    for (const ai of agent_inputs) {
      // Prefer context_scope, but an empty scope list falls through to input_sources (then to []).
      const contextScope = ai.heuristic["context_scope"];
      const inputSources = ai.heuristic["input_sources"];
      const scoped =
        Array.isArray(contextScope) && contextScope.length > 0 ? contextScope : inputSources;
      const sources = Array.isArray(scoped) && scoped.length > 0 ? scoped : [];
      for (const source of Array.isArray(sources) ? sources : []) {
        const name = String(source);
        if (!union_scope.includes(name)) {
          union_scope.push(name);
        }
      }
    }
    // One representative input for SHARED fetches: union scope so a no-`shapes` get_records (which falls
    // back to the input's context_scope) covers every packet's sources.
    const group_dispatch_input: HeuristicAgentInput = {
      ...base,
      heuristic: { ...base.heuristic, context_scope: union_scope, input_sources: union_scope },
    };
    const messages: any[] = [
      new SystemMessage({ content: _cache_content(this.toolset.system_prompt()) }),
      new HumanMessage({ content: _cache_content(this.toolset.group_user_prompt(agent_inputs)) }),
    ];
    const model = _bind_worker_tools(this.llm, [...this.toolset.tool_definitions(), submit_heuristic_result_compact]);
    // Budget scales with group size: each packet needs room to submit (and correct).
    const max_turns =
      base.max_graphql_calls +
      base.schema_tool_budget +
      (base.max_output_retries + 2) * agent_inputs.length +
      base.max_query_repair_attempts +
      4;
    const results_by_id = new Map<string, HeuristicAgentResult>();
    const pending = new Set<string>(inputs_by_id.keys());
    const recorder = currentRecorder();
    let group_error: string | null = null;
    try {
      for (let turn_index = 0; turn_index < max_turns; turn_index++) {
        const start = performance.now();
        const response = await model.invoke(
          messages,
          runnableConfig(
            `group:${group_id}`,
            {
              heuristic_id: group_id,
              phase: "heuristic_llm_turn",
              agent_id: `group:${group_id}`,
              turn_index,
            },
            ["heuristic-llm", this.toolset.name, `group:${group_id}`],
            base.trace,
          ),
        );
        recorder.record_counter("heuristic_turn", {
          phase: "heuristic_llm_turn",
          agent_id: `group:${group_id}`,
          heuristic_id: group_id,
          metadata: {
            turn_index,
            latency_ms: _elapsed_ms(start),
            message_count: messages.length,
            retrieval_mode: this.toolset.name,
            response: recorder.payload_metadata(response?.content ?? ""),
            usage: extractUsage(response),
            group_size: agent_inputs.length,
          },
        });
        const tool_calls = _response_tool_calls(response);
        if (tool_calls.length > 0) {
          messages.push(response);
          await this._handle_group_tool_calls(
            tool_calls,
            messages,
            inputs_by_id,
            results_by_id,
            pending,
            graphql,
            diagnostics,
            group_id,
            group_dispatch_input,
          );
          if (pending.size === 0) {
            break;
          }
          continue;
        }
        diagnostics.raw_model_failures.push("Model returned no tool calls.");
        if (diagnostics.raw_model_failures.length > base.max_output_retries) {
          break;
        }
        const remaining = [...pending].sort().join(", ");
        messages.push(
          new HumanMessage({
            content:
              `Your previous response used no tool call. Submit findings with submit_heuristic_result ` +
              `for each remaining heuristic_id: ${remaining}.`,
          }),
        );
      }
    } catch (exc) {
      // keep packets already collected; error-fill only the rest
      group_error = errStr(exc);
    }
    for (const hid of inputs_by_id.keys()) {
      if (!results_by_id.has(hid)) {
        const message =
          group_error !== null
            ? `Grouped subagent raised before this packet was submitted: ${group_error}`
            : "Grouped subagent did not submit a result for this packet within the turn budget.";
        results_by_id.set(hid, error_result(inputs_by_id.get(hid)!.heuristic, message, graphql));
      }
    }
    return agent_inputs.map((ai) => results_by_id.get(String(ai.heuristic["id"]))!);
  }

  private async _handle_group_tool_calls(
    tool_calls: Record<string, any>[],
    messages: any[],
    inputs_by_id: Map<string, HeuristicAgentInput>,
    results_by_id: Map<string, HeuristicAgentResult>,
    pending: Set<string>,
    graphql: CountingGraphQLTool,
    diagnostics: Diagnostics,
    group_id: string,
    group_dispatch_input: HeuristicAgentInput,
  ): Promise<void> {
    const recorder = currentRecorder();
    for (const call of tool_calls) {
      const start = performance.now();
      const name = String(call["name"] || "");
      const args = isRecord(call["args"]) ? call["args"] : {};
      if (name === "submit_heuristic_result") {
        const submitted_id = String(args["heuristic_id"] || "");
        const agent_input = inputs_by_id.get(submitted_id);
        if (agent_input === undefined || !pending.has(submitted_id)) {
          const remaining = [...pending].sort().join(", ") || "(all already submitted)";
          const reason =
            `Unknown or duplicate heuristic_id '${submitted_id}'. Submit once for each of: ${remaining}.`;
          const content: any = { ok: false, error: reason, instruction: reason };
          this._record_tool_result(call, content, start, recorder, messages, group_id, `group:${group_id}`);
          continue;
        }
        const result = _validate_compact_final_result(args, agent_input, graphql, diagnostics);
        if (!("ok" in result)) {
          results_by_id.set(submitted_id, result);
          pending.delete(submitted_id);
          const content: any = { ok: true, recorded: submitted_id, remaining: [...pending].sort() };
          recorder.record_tool_call({
            tool_name: name,
            agent_id: `group:${group_id}`,
            heuristic_id: submitted_id,
            latency_ms: _elapsed_ms(start),
            metadata: {
              args: recorder.payload_metadata(args),
              final_result: true,
              retrieval_mode: this.toolset.name,
            },
          });
          messages.push(
            new ToolMessage({
              content: JSON.stringify(content),
              tool_call_id: String(call["id"] || `call_${messages.length}`),
              name,
            }),
          );
          continue;
        }
        // validation-error dict: surface the corrective message and let the agent retry
        this._record_tool_result(call, result, start, recorder, messages, group_id, `group:${group_id}`);
        continue;
      }
      const content = await this.toolset.dispatch(name, args, group_dispatch_input, graphql, diagnostics);
      diagnostics.fetched_rows.push(..._harvest_evidence_rows(content));
      this._record_tool_result(call, content, start, recorder, messages, group_id, `group:${group_id}`);
    }
  }

  private async _handle_tool_calls(
    tool_calls: Record<string, any>[],
    messages: any[],
    agent_input: HeuristicAgentInput,
    graphql: CountingGraphQLTool,
    diagnostics: Diagnostics,
  ): Promise<HeuristicAgentResult | null> {
    const recorder = currentRecorder();
    const hid = String(agent_input.heuristic["id"]);
    const names = tool_calls.map((c) => String(c["name"] || ""));
    if (tool_calls.length <= 1 || names.includes("submit_heuristic_result")) {
      // Serial path: preserves terminal-submit semantics and the single-call case (where concurrency
      // provides no benefit).
      for (const call of tool_calls) {
        const start = performance.now();
        const name = String(call["name"] || "");
        const args = isRecord(call["args"]) ? call["args"] : {};
        let content: any;
        if (name === "submit_heuristic_result") {
          const result = _validate_compact_final_result(args, agent_input, graphql, diagnostics);
          if (!("ok" in result)) {
            recorder.record_tool_call({
              tool_name: name,
              agent_id: `heuristic:${hid}`,
              heuristic_id: hid,
              latency_ms: _elapsed_ms(start),
              metadata: {
                args: recorder.payload_metadata(args),
                final_result: true,
                retrieval_mode: this.toolset.name,
              },
            });
            return result;
          }
          content = result;
        } else {
          content = await this.toolset.dispatch(name, args, agent_input, graphql, diagnostics);
          diagnostics.fetched_rows.push(..._harvest_evidence_rows(content));
        }
        this._record_tool_result(call, content, start, recorder, messages, hid);
      }
      return null;
    }
    // Parallel path: a pure multi-fetch turn (no submit). Independent fetches run concurrently; results
    // return in input order so message order matches.
    const starts: number[] = [];
    const coros: Promise<Record<string, any>>[] = [];
    for (const call of tool_calls) {
      starts.push(performance.now());
      const name = String(call["name"] || "");
      const args = isRecord(call["args"]) ? call["args"] : {};
      coros.push(this.toolset.dispatch(name, args, agent_input, graphql, diagnostics));
    }
    const contents = await Promise.all(coros);
    for (let i = 0; i < tool_calls.length; i++) {
      const call = tool_calls[i]!;
      const content = contents[i]!;
      const start = starts[i]!;
      diagnostics.fetched_rows.push(..._harvest_evidence_rows(content));
      this._record_tool_result(call, content, start, recorder, messages, hid);
    }
    return null;
  }

  private _record_tool_result(
    call: Record<string, any>,
    content: any,
    start: number,
    recorder: AnyRecorder,
    messages: any[],
    hid: string,
    agent_id?: string,
  ): void {
    const name = String(call["name"] || "");
    const args = isRecord(call["args"]) ? call["args"] : {};
    const tool_call_id = String(call["id"] || `call_${messages.length}`);
    let status = "ok";
    let error = "";
    if (isRecord(content) && content["ok"] === false) {
      status = "error";
      error = String(content["error"] || content["stage"] || "tool returned ok=false");
    }
    const resolvedAgentId: string = agent_id ?? `heuristic:${hid}`;
    const describe =
      name !== "submit_heuristic_result" ? this.toolset.describe_call(name, args, content) : {};
    recorder.record_tool_call({
      tool_name: name,
      agent_id: resolvedAgentId,
      heuristic_id: hid,
      latency_ms: _elapsed_ms(start),
      status,
      error,
      metadata: {
        args: recorder.payload_metadata(args),
        result: recorder.payload_metadata(content),
        tool_call_id,
        ...describe,
      },
    });
    messages.push(
      new ToolMessage({ content: sliceCodePoints(JSON.stringify(content), 20000), tool_call_id, name }),
    );
  }
}

// ── Compact submit tool ──

const EvidenceCitationSchema = z.object({
  source: z.string(),
  table: z.string().nullish().default(null),
  rowid: z.number().int().nullish().default(null),
  record_id: z.string().nullish().default(null),
  summary: z.string().default(""),
});

const SubmitHeuristicResultFields = z
  .object({
    heuristic_id: z.string(),
    status: z.enum(HEURISTIC_STATUS),
    direction: z.enum(HEURISTIC_DIRECTION),
    score: z.number().int().min(-10).max(10),
    confidence: z.enum(CONFIDENCE),
    finding: z.string().min(1),
    interpretation: z.record(z.string(), z.unknown()).default({}),
    evidence_for: z.array(EvidenceCitationSchema).default([]),
    evidence_against: z.array(EvidenceCitationSchema).default([]),
    missing_evidence: z.array(z.string()).default([]),
    caveats: z.array(z.string()).default([]),
    needs_second_pass: z.boolean().default(false),
  })
  .describe("Submit the final structured heuristic result without runtime telemetry.");

// The func body is a stub that returns {} — the subagent loop routes by tool name and reads the tool
// call args directly, so the tool's own func is never invoked.
export const submit_heuristic_result_compact = tool(async () => ({}), {
  name: "submit_heuristic_result",
  description: "Submit the final HeuristicAgentResult without runtime telemetry.",
  schema: SubmitHeuristicResultFields,
});

// ── Compact-result validation + coercion (coverage-critical; ported EXACTLY) ──

interface ValidationErrorPayload {
  ok: false;
  error: string;
  instruction: string;
  required_literals: { status: string[]; direction: string[]; confidence: string[] };
}

function _corrective_instruction(error_text: string): string {
  const low = error_text.toLowerCase();
  if (low.includes("require evidence_for")) {
    return (
      "You set status='triggered' but evidence_for is empty. Either add the supporting rows to " +
      "evidence_for (cite source, table, rowid for each), or set status='inconclusive' if you cannot " +
      "cite supporting evidence."
    );
  }
  if (low.includes("require evidence_against or missing_evidence")) {
    return (
      "You set status='not_triggered' but gave neither evidence_against nor missing_evidence. Add the " +
      "contradicting rows to evidence_against, list the unavailable facts in missing_evidence, or set " +
      "status='inconclusive'."
    );
  }
  return "Retry submit_heuristic_result with all required fields and compact evidence citations.";
}

/**
 * Last-resort: if a triggered/not_triggered verdict lacks its required evidence, demote to inconclusive
 * so the finding + any cited evidence survive instead of crashing into an error stub.
 */
function _coerce_status_to_valid(result: Record<string, any>): void {
  const status = String(result["status"] || "");
  let demoted = false;
  if (status === "triggered" && result["evidence_for"].length === 0) {
    result["status"] = "inconclusive";
    demoted = true;
  } else if (
    status === "not_triggered" &&
    result["evidence_against"].length === 0 &&
    result["missing_evidence"].length === 0
  ) {
    result["status"] = "inconclusive";
    demoted = true;
  }
  if (demoted) {
    const sc = result["score"];
    if (!(sc === 0 || sc === null || sc === undefined)) {
      result["score"] = 0;
    }
    // The inconclusive validator additionally requires missing_evidence / tool_errors /
    // validation_errors / error to be non-empty; backfill missing_evidence so the demoted result is
    // genuinely valid rather than tripping a different validator.
    if (
      result["missing_evidence"].length === 0 &&
      result["validation_errors"].length === 0 &&
      result["tool_errors"].length === 0 &&
      !result["error"]
    ) {
      result["missing_evidence"] = [
        "Could not cite the evidence required for a defensible triggered/not_triggered verdict; " +
          "demoted to inconclusive.",
      ];
    }
  }
}

function _validate_compact_final_result(
  args: Record<string, any>,
  agent_input: HeuristicAgentInput,
  graphql: CountingGraphQLTool,
  diagnostics: Diagnostics,
): HeuristicAgentResult | ValidationErrorPayload {
  const result: Record<string, any> = isRecord(args["result"]) ? { ...args["result"] } : { ...args };
  _coerce_result_payload(result, agent_input, graphql, diagnostics);
  try {
    return HeuristicAgentResultSchema.parse(result);
  } catch (exc) {
    if (!(exc instanceof z.ZodError)) {
      throw exc;
    }
    const text = zodErrorText(exc);
    diagnostics.output_validation_failures.push(text);
    if (diagnostics.output_validation_failures.length <= agent_input.max_output_retries) {
      return {
        ok: false,
        error: text,
        instruction: _corrective_instruction(text),
        required_literals: {
          status: ["triggered", "not_triggered", "inconclusive", "context", "mitigation", "quality", "error"],
          direction: ["risk", "mitigation", "context", "quality"],
          confidence: ["low", "medium", "high"],
        },
      };
    }
    _coerce_status_to_valid(result);
    // A still-invalid payload propagates as a ZodError.
    return HeuristicAgentResultSchema.parse(result);
  }
}

function _coerce_result_payload(
  result: Record<string, any>,
  agent_input: HeuristicAgentInput,
  graphql: CountingGraphQLTool,
  diagnostics: Diagnostics,
): void {
  if (!("heuristic_id" in result)) {
    result["heuristic_id"] = String(agent_input.heuristic["id"]);
  }
  const category = String(agent_input.heuristic["category"] || "risk");
  let direction = String(result["direction"] || category);
  if (!["risk", "mitigation", "context", "quality"].includes(direction)) {
    direction = ["neutral", "agent_only"].includes(direction) ? "context" : "quality";
  }
  result["direction"] = direction;
  if (result["status"] === "neutral") {
    result["status"] = "context";
  }
  const runtime_validation_errors = _validation_errors_from_logs(graphql);
  result["graphql_queries"] = _merge_graphql_logs(null, graphql);
  result["tool_errors"] = _merge_strings(null, diagnostics.tool_errors);
  result["validation_errors"] = _merge_strings(null, [...diagnostics.validation_errors, ...runtime_validation_errors]);
  result["query_repair_attempts"] = Math.max(
    diagnostics.query_repair_attempts,
    _query_repair_attempts_from_logs(graphql),
  );
  result["raw_model_failures"] = _merge_strings(null, diagnostics.raw_model_failures);
  let evidence_refs = _coerce_evidence_refs(result["evidence_refs"]);
  result["evidence_for"] = _coerce_evidence_refs(result["evidence_for"]);
  result["evidence_against"] = _coerce_evidence_refs(result["evidence_against"]);
  result["evidence_for"] = (result["evidence_for"] as Record<string, any>[]).map((ref) => _strip_ref_data(ref));
  result["evidence_against"] = (result["evidence_against"] as Record<string, any>[]).map((ref) =>
    _strip_ref_data(ref),
  );
  evidence_refs = evidence_refs.map((ref) => _strip_ref_data(ref));
  result["missing_evidence"] = _coerce_string_list(result["missing_evidence"]);
  if (diagnostics.graphql_budget_exhausted) {
    result["missing_evidence"] = _merge_strings(result["missing_evidence"], [
      "GraphQL query budget was exhausted; result is based on evidence collected before budget exhaustion.",
    ]);
  }
  const status = String(result["status"] || "");
  const score = Math.trunc(Number(result["score"])) || 0;
  if (
    evidence_refs.length > 0 &&
    (result["evidence_for"] as any[]).length === 0 &&
    (result["evidence_against"] as any[]).length === 0
  ) {
    if (status === "triggered" || score > 0) {
      result["evidence_for"] = evidence_refs;
    } else {
      result["evidence_against"] = evidence_refs;
    }
  }
  result["evidence_refs"] = _dedupe_evidence_dicts([...result["evidence_for"], ...result["evidence_against"]]);
  const existing: Record<string, any>[] =
    result["evidence_refs"].length > 0 ? result["evidence_refs"] : [];
  const seen = new Set<string>();
  for (const r of existing) {
    if (isRecord(r)) {
      seen.add(_evidence_manifest_key(r["source"], r["rowid"]));
    }
  }
  const MANIFEST_CAP = 40;
  for (const row of diagnostics.fetched_rows) {
    const key = _evidence_manifest_key(row["source"], row["rowid"]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    existing.push(row);
    if (existing.length >= MANIFEST_CAP) {
      break;
    }
  }
  result["evidence_refs"] = existing;
  result["interpretation"] = _coerce_interpretation(result["interpretation"], result);
  result["caveats"] = _coerce_string_list(result["caveats"]);
  if (
    status === "not_triggered" &&
    (result["evidence_against"] as any[]).length === 0 &&
    (result["missing_evidence"] as any[]).length === 0
  ) {
    result["missing_evidence"] = ["No local GraphQL evidence was found that supports this heuristic."];
  }
  if (status === "inconclusive") {
    result["score"] = 0;
    if (
      (result["missing_evidence"] as any[]).length === 0 &&
      (result["tool_errors"] as any[]).length === 0 &&
      (result["validation_errors"] as any[]).length === 0
    ) {
      result["missing_evidence"] = [
        "The available local evidence was insufficient for a defensible triggered/not_triggered conclusion.",
      ];
    }
  }
  _repair_result_text(result);
  // Drop any keys the LLM emitted that are not on the (trimmed) HeuristicAgentResult schema — defends
  // against stale prompts / non-conforming models hitting extra="forbid" (.strict()).
  for (const key of Object.keys(result)) {
    if (!HEURISTIC_RESULT_FIELDS.has(key)) {
      delete result[key];
    }
  }
}

/** Stable manifest key; JSON.stringify keeps the source string and preserves int/string/null rowid. */
function _evidence_manifest_key(source: any, rowid: any): string {
  return JSON.stringify([String(source), rowid ?? null]);
}

function _coerce_evidence_refs(value: any): Record<string, any>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: Record<string, any>[] = [];
  for (const item of value) {
    if (isRecord(item)) {
      const ref: Record<string, any> = { ...item };
      if (!("source" in ref) && ref["table"]) {
        ref["source"] = String(ref["table"]);
      }
      if (!("summary" in ref) && "description" in ref) {
        const desc = ref["description"];
        delete ref["description"];
        ref["summary"] = String(desc || "");
      }
      refs.push(ref);
      continue;
    }
    if (typeof item === "string") {
      const [table, , raw_rowid] = partition(item, ":");
      const ref: Record<string, any> = { source: table || "unknown", table: table || null, summary: item };
      if (isDigits(raw_rowid)) {
        ref["rowid"] = parseInt(raw_rowid, 10);
      } else if (raw_rowid) {
        ref["record_id"] = raw_rowid;
      }
      refs.push(ref);
    }
  }
  return refs;
}

function _dedupe_evidence_dicts(refs: Record<string, any>[]): Record<string, any>[] {
  const deduped: Record<string, any>[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const source = String(ref["source"] || "");
    const table = ref["table"] === null || ref["table"] === undefined ? null : String(ref["table"]);
    const rowid = typeof ref["rowid"] === "number" && Number.isInteger(ref["rowid"]) ? Math.trunc(ref["rowid"]) : null;
    const record_id = ref["record_id"] === null || ref["record_id"] === undefined ? null : String(ref["record_id"]);
    const summary = String(ref["summary"] || "");
    const key = JSON.stringify([source, table, rowid, record_id, summary]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(ref);
  }
  return deduped;
}

function _strip_ref_data(ref: Record<string, any>): Record<string, any> {
  const clean = { ...ref };
  delete clean["data"];
  return clean;
}

function _coerce_string_list(value: any): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter((s) => s.trim().length > 0);
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, val]) => `${key}: ${val}`);
  }
  const text = String(value).trim();
  return text ? [text] : [];
}

function _coerce_interpretation(value: any, result: Record<string, any>): Record<string, any> {
  const raw: Record<string, any> = isRecord(value) ? { ...value } : {};
  if (!("signal_strength" in raw)) {
    const score = Math.trunc(Number(result["score"])) || 0;
    const status = String(result["status"] || "");
    if (status === "not_triggered" || status === "error" || score === 0) {
      raw["signal_strength"] = "none";
    } else if (Math.abs(score) >= 3) {
      raw["signal_strength"] = "strong";
    } else if (Math.abs(score) === 2) {
      raw["signal_strength"] = "moderate";
    } else {
      raw["signal_strength"] = "weak";
    }
  }
  if (!("recommended_weight" in raw)) {
    const map: Record<string, string> = { none: "ignore", weak: "low", moderate: "medium", strong: "high" };
    raw["recommended_weight"] = map[String(raw["signal_strength"])] ?? "low";
  }
  try {
    return HeuristicInterpretationSchema.parse(raw);
  } catch {
    return emptyHeuristicInterpretation();
  }
}

export function error_result(
  heuristic: Record<string, any>,
  message: string,
  graphql: CountingGraphQLTool | null = null,
): HeuristicAgentResult {
  const msg = String(message || "").trim() || "Heuristic agent failed without an error message.";
  const category = heuristic["category"] || "risk";
  const direction = ["risk", "mitigation", "context", "quality"].includes(category) ? category : "quality";
  let validation_errors: string[] = [];
  if (graphql) {
    validation_errors = graphql.validation_logs.flatMap((log) => log.errors);
  }
  const logs = graphql ? graphql.logs : [];
  const validation_logs = graphql ? graphql.validation_logs : [];
  return HeuristicAgentResultSchema.parse({
    heuristic_id: String(heuristic["id"]),
    status: "error",
    direction,
    score: 0,
    confidence: "low",
    finding: `Heuristic agent failed: ${msg}`,
    missing_evidence: ["Heuristic execution failed before a defensible conclusion could be reached."],
    graphql_queries: logs.map((log) => ({ ...log })),
    tool_errors: logs.filter((log) => Boolean(log.error)).map((log) => log.error as string),
    validation_errors,
    query_repair_attempts: validation_logs.filter((log) => !log.ok).length,
    caveats: [],
    needs_second_pass: false,
    error: msg,
  });
}

function _repair_result_text(result: Record<string, any>): void {
  const finding = String(result["finding"] || "").trim();
  if (!finding) {
    result["finding"] = "Heuristic agent returned no narrative finding.";
  }
}

function _merge_graphql_logs(existing: any, graphql: CountingGraphQLTool): Record<string, any>[] {
  const logs = graphql.logs.map((log) => ({ ...log }) as Record<string, any>);
  if (!Array.isArray(existing)) {
    return logs;
  }
  const merged: Record<string, any>[] = [];
  const seen = new Set<string>();
  for (const item of [...existing, ...logs]) {
    if (!isRecord(item)) {
      continue;
    }
    const key = JSON.stringify([
      String(item["query_name"] || ""),
      stableStringify(item["variables"] ?? {}),
      item["error"] ?? null,
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function _validation_errors_from_logs(graphql: CountingGraphQLTool): string[] {
  return graphql.validation_logs.flatMap((log) => log.errors);
}

function _query_repair_attempts_from_logs(graphql: CountingGraphQLTool): number {
  return graphql.validation_logs.filter((log) => !log.ok).length;
}

function _merge_strings(existing: any, additions: string[]): string[] {
  const values: string[] = [];
  if (Array.isArray(existing)) {
    for (const item of existing) {
      const s = String(item);
      if (s.trim().length > 0) {
        values.push(s);
      }
    }
  } else if (existing) {
    values.push(String(existing));
  }
  for (const item of additions) {
    const s = String(item);
    if (s.trim().length > 0) {
      values.push(s);
    }
  }
  return [...new Set(values)];
}

function _response_tool_calls(response: any): Record<string, any>[] {
  const tool_calls = response?.tool_calls;
  if (Array.isArray(tool_calls)) {
    return tool_calls.filter((call) => isRecord(call)).map((call) => ({ ...call }));
  }
  const additional_kwargs = response?.additional_kwargs ?? {};
  const raw_calls = additional_kwargs["tool_calls"];
  const calls: Record<string, any>[] = [];
  if (!Array.isArray(raw_calls)) {
    return calls;
  }
  for (const raw of raw_calls) {
    if (!isRecord(raw)) {
      continue;
    }
    const func = raw["function"] ?? {};
    const name = func["name"] || raw["name"];
    const raw_args = func["arguments"] || raw["args"] || {};
    let args: any;
    if (typeof raw_args === "string") {
      try {
        args = JSON.parse(raw_args);
      } catch {
        args = {};
      }
    } else {
      args = isRecord(raw_args) ? raw_args : {};
    }
    calls.push({ name, args, id: raw["id"] });
  }
  return calls;
}

function _elapsed_ms(startMs: number): number {
  return Math.round((performance.now() - startMs) * 1000) / 1000;
}

export function validate_result_dict(data: Record<string, any>): HeuristicAgentResult {
  // Thin wrapper that validates the dict and lets any ZodError propagate.
  return HeuristicAgentResultSchema.parse(data);
}

// ── HeuristicAgentResult field set ──
// HeuristicAgentResultSchema is a ZodEffects (a .strict() object wrapped by .superRefine); unwrap to
// the inner object to read its field names.
function _heuristic_result_field_names(): Set<string> {
  let schema: any = HeuristicAgentResultSchema;
  while (schema?._def?.typeName === "ZodEffects") {
    schema = schema._def.schema;
  }
  return new Set(Object.keys(schema?.shape ?? {}));
}
const HEURISTIC_RESULT_FIELDS = _heuristic_result_field_names();

// ── Local helpers ──

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split on the first occurrence of `sep` into [before, sep, after]; no match -> [s, "", ""]. */
function partition(s: string, sep: string): [string, string, string] {
  const idx = s.indexOf(sep);
  if (idx === -1) {
    return [s, "", ""];
  }
  return [s.slice(0, idx), sep, s.slice(idx + sep.length)];
}

/** True for a non-empty ASCII all-digit string. */
function isDigits(s: string): boolean {
  return s.length > 0 && /^[0-9]+$/.test(s);
}

/** Truncate to at most `limit` Unicode code points (astral-safe). */
function sliceCodePoints(text: string, limit: number): string {
  return [...text].slice(0, limit).join("");
}

/** Message text of an error (no "Error: " prefix), or a stringified non-error value. */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// Render a ZodError as one "<path>: <message>" line per issue; keeps the superRefine messages
// ("...require evidence_for", "...require evidence_against or missing_evidence") that
// `_corrective_instruction` matches on.
function zodErrorText(exc: unknown): string {
  if (exc instanceof z.ZodError) {
    return exc.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
  }
  return String(exc);
}

/** Deterministic JSON with recursively sorted object keys, for stable dedup keys. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}
