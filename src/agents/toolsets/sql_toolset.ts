// The "tools" retrieval surface: the typed tools (delegated to TypedToolset) PLUS the guarded SQL
// hatch — run_sql, describe_schema and get_source_record. This is the exploratory mode; typed_tools
// is the bounded one. It COMPOSES TypedToolset rather than redeclaring the typed tools, so the two
// surfaces can never drift apart.
//
// A 422 refusal from the hatch is NOT an error: it is the repair signal, carrying the planner's own
// reason and a hint naming the indexed access paths. It lands on diagnostics.validation_errors and
// increments query_repair_attempts, which is exactly what the retired validate/repair loop did.
// DataHttpClient accepts 422 for /v1/sql and nothing else, so a 500 from the same endpoint still
// raises — a broken service must not present as a refusal the agent repairs forever.
import { createHash } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { DataClientError, SHAPES, isSqlRefusal, type CountingDataClient } from "../data_client.ts";
import type { HeuristicAgentInput } from "../models.ts";
import {
  HEURISTIC_SYSTEM_PROMPT,
  grouped_heuristic_user_prompt,
  heuristic_user_prompt,
  prompt_context,
} from "../prompts.ts";
import { _resolve_bundle_address_id } from "../retrieval.ts";
import { summarizeDataSchema } from "../schema_guide.ts";
import { sql_tools_guide } from "../typed_tools.ts";
import type { Diagnostics, RetrievalToolset } from "./base.ts";
import { TypedToolset, _union_source_scope } from "./typed_toolset.ts";

// ── Arg models (zod object schemas) ──────────────────────────────────────────────────────────────

const RunSqlArgs = z
  .object({
    query: z
      .string()
      .describe(
        "One read-only SELECT. A LIMIT is injected if you omit one. Unindexed predicates are refused before execution; describe_schema lists the indexed access paths.",
      ),
  })
  .describe("Run one exploratory read-only SELECT against the partner corpus.");

const DescribeSchemaArgs = z
  .object({})
  .describe(
    "The curated data schema: tables, the indexed access paths that are actually fast, and the known data-quality caveats.",
  );

const GetSourceRecordArgs = z
  .object({
    shape: z.string().describe(`One of: ${[...SHAPES].sort().join(", ")}.`),
    rowid: z.number().int().min(0).describe("Row id, e.g. the __rowid on a record you already fetched."),
    // Contract B addendum 1: a rowid is a position within ONE address's rows for that shape, so the
    // service requires the address that scopes it. The subject address is the default because that
    // is where almost every rowid the model has seen came from; an explicit id is for a rowid read
    // off an `addr:<addressId>:<n>` person's records, which belongs to a different bundle.
    address_id: z
      .number()
      .int()
      .nullish()
      .default(null)
      .describe("Omit for the subject address; provide it only for a rowid from another address's records."),
  })
  .describe(
    "Fetch one raw source row by shape and rowid, so a SQL hit becomes a citable evidence reference.",
  );

// ── Tool stubs (LangChain tool definitions) ──────────────────────────────────────────────────────
//
// The func body is a stub (`async () => ({})`) because the subagent loop routes by tool name through
// `dispatch` and never invokes a tool's own func.

const run_sql = tool(async () => ({}), {
  name: "run_sql",
  description:
    "Run one read-only SELECT against the partner corpus. Use it for questions the typed tools cannot answer — above all, enumerating an owner's other properties. Refused queries return the planner's reason plus a hint naming the indexed paths.",
  schema: RunSqlArgs,
});

const describe_schema = tool(async () => ({}), {
  name: "describe_schema",
  description:
    "The curated data schema: tables, the indexed access paths that are fast, and the known data-quality caveats. Read it before writing SQL.",
  schema: DescribeSchemaArgs,
});

const get_source_record = tool(async () => ({}), {
  name: "get_source_record",
  description:
    "Fetch one raw source row by shape and rowid. run_sql results carry no provenance — use this to turn a SQL hit into a citable evidence reference.",
  schema: GetSourceRecordArgs,
});

const _HATCH_TOOLS = new Set<string>(["run_sql", "describe_schema", "get_source_record"]);

// ── Budget helpers ───────────────────────────────────────────────────────────────────────────────

// The exact message CountingDataClient._budgeted throws on overrun (data_client.ts). The client
// exposes no typed marker for it — DataClientError carries a message and nothing else — and
// data_client.ts is not this task's file, so the condition is still recognised by text. Two things
// keep that from going stale silently: the literal lives here once, and the toolset test drives a
// real CountingDataClient to exhaustion rather than hand-rolling the message, so a rename on the
// throwing side fails the suite instead of quietly disabling budget termination.
const _BUDGET_ERROR_TEXT = "Data call budget exceeded";

function _is_budget_error(exc: unknown): boolean {
  return errStr(exc).includes(_BUDGET_ERROR_TEXT);
}

function _budget_terminal_response(error: string | null = null): Record<string, any> {
  const message = error || "Data call budget is exhausted.";
  return {
    ok: false,
    stage: "budget_exhausted",
    error: message,
    instruction:
      "Do not call run_sql, describe_schema, get_source_record, or any retrieval tool again. " +
      "Submit the best available partial or inconclusive result now with submit_heuristic_result.",
  };
}

// ── SqlToolset adapter ───────────────────────────────────────────────────────────────────────────

export class SqlToolset implements RetrievalToolset {
  name = "tools";
  private readonly typed = new TypedToolset();

  tool_definitions(): any[] {
    return [...this.typed.tool_definitions(), run_sql, describe_schema, get_source_record];
  }

  owns_tool(name: string): boolean {
    return _HATCH_TOOLS.has(name) || this.typed.owns_tool(name);
  }

  system_prompt(): string {
    return HEURISTIC_SYSTEM_PROMPT;
  }

  build_context(agent_input: HeuristicAgentInput): Record<string, any> {
    const heuristic = agent_input.heuristic as Record<string, any>;
    const scope = heuristic["context_scope"]?.length
      ? heuristic["context_scope"]
      : heuristic["input_sources"]?.length
        ? heuristic["input_sources"]
        : [];
    // Unlike TypedToolset, the hatch mode KEEPS schema_mini_guide: it is the data-surface primer.
    return prompt_context(agent_input.context, agent_input.prompt_profile, scope);
  }

  user_prompt(agent_input: HeuristicAgentInput, context: Record<string, any>): string {
    return heuristic_user_prompt(agent_input.heuristic, context, sql_tools_guide(agent_input.heuristic));
  }

  group_user_prompt(agent_inputs: HeuristicAgentInput[]): string {
    const base = agent_inputs[0]!;
    const union_scope = _union_source_scope(agent_inputs);
    const context = prompt_context(base.context, base.prompt_profile, union_scope);
    return grouped_heuristic_user_prompt(
      agent_inputs.map((ai) => ai.heuristic),
      context,
      agent_inputs.map((ai) => ai.plan ?? {}),
      sql_tools_guide({ context_scope: union_scope }),
    );
  }

  async dispatch(
    name: string,
    args: Record<string, any>,
    agent_input: HeuristicAgentInput,
    data: CountingDataClient,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>> {
    if (diagnostics.data_budget_exhausted && this.owns_tool(name)) {
      return _budget_terminal_response();
    }
    if (name === "run_sql") {
      return await this._run_sql(args, data, diagnostics);
    }
    if (name === "describe_schema") {
      return await this._describe_schema(agent_input, data, diagnostics);
    }
    if (name === "get_source_record") {
      return await this._get_source_record(args, agent_input, data, diagnostics);
    }
    if (this.typed.owns_tool(name)) {
      // retrieval.ts turns a DataClientError into an ok:false payload, so a typed tool's budget
      // overrun arrives as data rather than as a throw; it still has to terminate the run.
      const content = await this.typed.dispatch(name, args, agent_input, data, diagnostics);
      if (!content["ok"] && _is_budget_error(content["error"])) {
        diagnostics.data_budget_exhausted = true;
        return _budget_terminal_response(String(content["error"]));
      }
      return content;
    }
    const content: Record<string, any> = {
      ok: false,
      error: `Unknown tool: ${name}`,
      available_tools: this.tool_definitions().map((t) => t.name),
    };
    diagnostics.tool_errors.push(String(content["error"]));
    return content;
  }

  describe_call(name: string, args: Record<string, any>, result: Record<string, any>): Record<string, any> {
    if (name === "run_sql") {
      const query = String(args["query"] ?? "");
      return {
        query_sha256: createHash("sha256").update(query, "utf8").digest("hex"),
        query_chars: Array.from(query).length,
        refused_stage: result?.["stage"] ?? null,
      };
    }
    if (name === "describe_schema") {
      return { target: "schema" };
    }
    if (name === "get_source_record") {
      return { shape: args["shape"] ?? null, rowid: args["rowid"] ?? null };
    }
    return this.typed.describe_call(name, args, result);
  }

  private async _run_sql(
    args: Record<string, any>,
    data: CountingDataClient,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>> {
    const query = String(args["query"] ?? "").trim();
    if (!query) {
      diagnostics.tool_errors.push("run_sql requires a query.");
      return { ok: false, error: "run_sql requires a query." };
    }
    let result: Awaited<ReturnType<CountingDataClient["run_sql"]>>;
    try {
      result = await data.run_sql(query);
    } catch (exc) {
      if (!(exc instanceof DataClientError)) throw exc;
      diagnostics.tool_errors.push(errStr(exc));
      if (_is_budget_error(exc)) {
        diagnostics.data_budget_exhausted = true;
        return _budget_terminal_response(errStr(exc));
      }
      return { ok: false, stage: "execution", error: errStr(exc) };
    }
    if (isSqlRefusal(result)) {
      // A refusal is a RESULT, not a broken call: it feeds the repair channel and stays off
      // tool_errors so an agent that repairs successfully does not look like it failed.
      diagnostics.validation_errors.push(result.reason);
      diagnostics.query_repair_attempts += 1;
      return { ok: false, stage: result.stage, error: result.reason, hint: result.hint };
    }
    return { ok: true, ...result };
  }

  private async _describe_schema(
    agent_input: HeuristicAgentInput,
    data: CountingDataClient,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>> {
    try {
      const schema = await data.schema({ max_calls: agent_input.schema_tool_budget });
      return { ok: true, schema: summarizeDataSchema(schema) };
    } catch (exc) {
      if (!(exc instanceof DataClientError)) throw exc;
      // The schema budget is a separate ceiling from the data-call budget, so exhausting it is a
      // plain tool error — it must not terminate retrieval.
      diagnostics.tool_errors.push(errStr(exc));
      return { ok: false, error: errStr(exc) };
    }
  }

  private async _get_source_record(
    args: Record<string, any>,
    agent_input: HeuristicAgentInput,
    data: CountingDataClient,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>> {
    const shape = String(args["shape"] ?? "").trim().toLowerCase();
    const rowid = Math.trunc(Number(args["rowid"]));
    if (!SHAPES.includes(shape)) {
      return { ok: false, error: `Unsupported shape: ${shape}`, supported_shapes: [...SHAPES].sort() };
    }
    if (!Number.isFinite(rowid) || rowid < 0) {
      return { ok: false, error: "rowid must be a non-negative integer." };
    }
    const raw_address_id = args["address_id"];
    const address_id =
      raw_address_id === null || raw_address_id === undefined || raw_address_id === ""
        ? _resolve_bundle_address_id(agent_input.context)
        : Math.trunc(Number(raw_address_id));
    if (address_id === null || !Number.isFinite(address_id)) {
      return { ok: false, error: "No resolved subject address is available; pass address_id explicitly." };
    }
    try {
      const row = await data.source_record(shape, rowid, address_id);
      return { ok: true, ...row };
    } catch (exc) {
      if (!(exc instanceof DataClientError)) throw exc;
      diagnostics.tool_errors.push(errStr(exc));
      if (_is_budget_error(exc)) {
        diagnostics.data_budget_exhausted = true;
        return _budget_terminal_response(errStr(exc));
      }
      return { ok: false, error: errStr(exc) };
    }
  }
}

/** Error message text with no "Error: " prefix. */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
