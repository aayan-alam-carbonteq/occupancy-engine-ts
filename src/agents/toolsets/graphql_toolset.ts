// The "tools" retrieval surface: the raw-GraphQL tools (validate_graphql, execute_graphql,
// describe_schema) plus the optional shortcut tools (get_address_records, get_people_at_address,
// get_person_records), their dispatch/compaction helpers, the budget-terminal envelope, and the
// GraphQLToolset adapter (implements RetrievalToolset). The EXACT tool names, arg schemas
// (names/types/descriptions/defaults/min-max), dispatch routing, the budget error strings the
// subagent loop matches on, and the union source scope used for grouped prompts are all significant.
//
// Each tool is declared with `tool(func, { name, description, schema })`: name is the tool name,
// description is its help text, and schema is a zod object describing its args. The func body is a
// stub (`async () => ({})`) because the subagent loop routes by tool name through `dispatch`, never
// invoking the tool's func.
//
// ADDRESS_SOURCE_FIELDS / PERSON_SOURCE_FIELDS / SOURCE_DATA_FIELDS live in retrieval.ts and are
// imported here (not duplicated). `_resolved_address_id(agent_input)` delegates to retrieval.ts's
// `_resolve_bundle_address_id(agent_input.context)`. The compaction helpers
// (_compact_person_node/_compact_record_data/_record_summary/_compact_source_node) are kept here as
// private copies (retrieval.ts keeps its own).
//
// Source normalization uses `.trim().toLowerCase()`; the small primitive helpers at the bottom of
import { createHash } from "node:crypto";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { compact_graphql_data, GraphQLToolError, type CountingGraphQLTool } from "../graphql_tool.ts";
import type { HeuristicAgentInput } from "../models.ts";
import {
  HEURISTIC_SYSTEM_PROMPT,
  grouped_heuristic_user_prompt,
  heuristic_user_prompt,
  prompt_context,
} from "../prompts.ts";
import {
  ADDRESS_SOURCE_FIELDS,
  PERSON_SOURCE_FIELDS,
  SOURCE_DATA_FIELDS,
  _resolve_bundle_address_id,
} from "../retrieval.ts";
import type { Diagnostics, RetrievalToolset } from "./base.ts";

// ── Arg models (zod object schemas) ──────────────────────────────────────────────────────────────

const ValidateGraphQLArgs = z
  .object({
    query: z.string().describe("Raw GraphQL query operation to validate."),
    variables: z.record(z.string(), z.any()).default({}).describe("GraphQL variables for the query."),
  })
  .describe("Validate a raw read-only GraphQL query against the schema without executing it.");

const ExecuteGraphQLArgs = z
  .object({
    query: z.string().describe("Raw GraphQL query operation to execute."),
    variables: z.record(z.string(), z.any()).default({}).describe("GraphQL variables for the query."),
    compact: z
      .boolean()
      .default(true)
      .describe("Compact source connection outputs by default to reduce token use. Set false only when full raw data is required."),
  })
  .describe("Execute a raw read-only GraphQL query after schema validation.");

const DescribeSchemaArgs = z
  .object({
    target: z
      .string()
      .nullish()
      .default(null)
      .describe("Schema target such as Query, Address, Person, TaxRecordWhereInput, or SourceRecordConnection."),
  })
  .describe("Describe GraphQL schema fields/types/inputs relevant to a planned query.");

const GetAddressRecordsArgs = z
  .object({
    source: z.string().describe("One of: base, tax, utility, trace, auto, loan, drive, voter, criminal."),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  })
  .describe("Retrieve compact source rows linked to the resolved subject address.");

const GetPeopleAtAddressArgs = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    offset: z.number().int().min(0).default(0),
  })
  .describe("Retrieve compact people linked to the resolved subject address.");

const GetPersonRecordsArgs = z
  .object({
    person_id: z.string().describe("Person id, usually a String id from Person.id or source row id."),
    sources: z
      .array(z.string())
      .default([])
      .describe("Source groups. Supported: base, tax, trace, auto, loan, drive, voter, criminal, linkedin."),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .describe("Retrieve compact records for a person id from selected source groups.");

// ── Tool stubs (LangChain tool definitions) ──────────────────────────────────────────────────────

const validate_graphql = tool(async () => ({}), {
  name: "validate_graphql",
  description: "Validate a raw read-only GraphQL query against the schema without executing it.",
  schema: ValidateGraphQLArgs,
});

const execute_graphql = tool(async () => ({}), {
  name: "execute_graphql",
  description: "Execute a raw read-only GraphQL query after schema validation.",
  schema: ExecuteGraphQLArgs,
});

const describe_schema = tool(async () => ({}), {
  name: "describe_schema",
  description: "Describe GraphQL schema fields/types/inputs relevant to a planned query.",
  schema: DescribeSchemaArgs,
});

const get_address_records = tool(async () => ({}), {
  name: "get_address_records",
  description: "Retrieve compact source rows linked to the resolved subject address.",
  schema: GetAddressRecordsArgs,
});

const get_people_at_address = tool(async () => ({}), {
  name: "get_people_at_address",
  description: "Retrieve compact people linked to the resolved subject address.",
  schema: GetPeopleAtAddressArgs,
});

const get_person_records = tool(async () => ({}), {
  name: "get_person_records",
  description: "Retrieve compact records for a person id from selected source groups.",
  schema: GetPersonRecordsArgs,
});

// ── Constants ─────────────────────────────────────────────────────────────────────────────────────

const _RAW_GRAPHQL_TOOLS = new Set<string>(["validate_graphql", "execute_graphql", "describe_schema"]);
const _SHORTCUT_TOOLS = new Set<string>(["get_address_records", "get_people_at_address", "get_person_records"]);

// ── Budget helpers (EXACT strings — the subagent loop matches on them) ──────────────────────────────

function _is_graphql_budget_error(exc: unknown): boolean {
  return errStr(exc).includes("GraphQL query budget exceeded");
}

function _graphql_budget_terminal_response(error: string | null = null): Record<string, any> {
  const message = error || "GraphQL query budget is exhausted.";
  return {
    ok: false,
    stage: "budget_exhausted",
    error: message,
    instruction:
      "Do not call execute_graphql, validate_graphql, describe_schema, or shortcut retrieval tools again. " +
      "Submit the best available partial or inconclusive result now with submit_heuristic_result.",
  };
}

// ── Private dispatch helpers ───────────────────────────────────────────────────────────────────────

async function _validate_graphql_tool(
  args: Record<string, any>,
  graphql: CountingGraphQLTool,
  diagnostics: Diagnostics,
): Promise<Record<string, any>> {
  if (diagnostics.graphql_budget_exhausted) {
    return _graphql_budget_terminal_response();
  }
  const query = String(args["query"] ?? "");
  const variables = isDict(args["variables"]) ? args["variables"] : {};
  const result = await graphql.validate(query, variables);
  const payload = { ...result };
  if (!result.ok) {
    diagnostics.validation_errors.push(...result.errors);
    diagnostics.query_repair_attempts += 1;
  }
  return payload;
}

async function _execute_graphql_tool(
  args: Record<string, any>,
  graphql: CountingGraphQLTool,
  diagnostics: Diagnostics,
): Promise<Record<string, any>> {
  if (diagnostics.graphql_budget_exhausted) {
    return _graphql_budget_terminal_response();
  }
  const query = String(args["query"] ?? "");
  const variables = isDict(args["variables"]) ? args["variables"] : {};
  const compact = Boolean(Object.hasOwn(args, "compact") ? args["compact"] : true);
  const validation = await graphql.validate(query, variables);
  if (!validation.ok) {
    diagnostics.validation_errors.push(...validation.errors);
    diagnostics.query_repair_attempts += 1;
    // Emit { ok, stage: "validation", ...rest }: keep `ok` at position 1 with its value (false here),
    // and destructure `ok` out of the spread so TS doesn't flag the intentional override.
    const { ok: _ok, ...validationRest } = validation;
    return { ok: validation.ok, stage: "validation", ...validationRest };
  }
  let data: Record<string, unknown>;
  try {
    data = await graphql.query(query, variables);
  } catch (exc) {
    if (!(exc instanceof GraphQLToolError)) {
      throw exc;
    }
    diagnostics.tool_errors.push(errStr(exc));
    if (_is_graphql_budget_error(exc)) {
      diagnostics.graphql_budget_exhausted = true;
      return _graphql_budget_terminal_response(errStr(exc));
    }
    return { ok: false, stage: "execution", error: errStr(exc) };
  }
  return { ok: true, data: compact ? compact_graphql_data(data) : data, compact };
}

async function _describe_schema_tool(
  args: Record<string, any>,
  agent_input: HeuristicAgentInput,
  graphql: CountingGraphQLTool,
  diagnostics: Diagnostics,
): Promise<Record<string, any>> {
  if (diagnostics.graphql_budget_exhausted) {
    return _graphql_budget_terminal_response();
  }
  const target = args["target"];
  try {
    return {
      ok: true,
      schema: await graphql.describe_schema(target !== null && target !== undefined ? String(target) : null, {
        max_calls: agent_input.schema_tool_budget,
      }),
    };
  } catch (exc) {
    if (!(exc instanceof GraphQLToolError)) {
      throw exc;
    }
    diagnostics.tool_errors.push(errStr(exc));
    if (_is_graphql_budget_error(exc)) {
      diagnostics.graphql_budget_exhausted = true;
      return _graphql_budget_terminal_response(errStr(exc));
    }
    return { ok: false, error: errStr(exc) };
  }
}

function _resolved_address_id(agent_input: HeuristicAgentInput): number | null {
  return _resolve_bundle_address_id(agent_input.context);
}

// ── Compaction helpers ──────────────────────────────────────────────────────────────────────────────

function _compact_person_node(node: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of ["id", "firstname", "middlename", "lastname", "fullName", "normNameKey", "primaryAddressId"]) {
    const value = node[key];
    if (value !== null && value !== undefined && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

function _compact_record_data(source: string, data: Record<string, any>): Record<string, any> {
  const fields = Object.hasOwn(SOURCE_DATA_FIELDS, source) ? SOURCE_DATA_FIELDS[source]! : Object.keys(data).slice(0, 12);
  const compact: Record<string, any> = {};
  for (const field of fields) {
    let value = data[field];
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (typeof value === "string" && codePointLength(value) > 500) {
      value = codePointSlice(value, 500) + "...";
    }
    compact[field] = value;
  }
  return compact;
}

function _record_summary(source: string, data: Record<string, any>): string {
  const bits: string[] = [source];
  for (const key of ["ownername", "firstname", "first_name", "lastname", "last_name", "address", "zip", "status", "own_rent", "matched", "property_type_normalized"]) {
    const value = data[key];
    if (value !== null && value !== undefined && value !== "") {
      bits.push(`${key}=${String(value)}`);
    }
  }
  return bits.join("; ");
}

function _compact_source_node(source: string, node: Record<string, any>): Record<string, any> {
  const data = isDict(node["data"]) ? node["data"] : {};
  const compact_data = _compact_record_data(source, data);
  return {
    source,
    table: node["table"] || source,
    rowid: node["rowid"] ?? null,
    summary: _record_summary(source, compact_data),
    data: compact_data,
  };
}

async function _get_address_records_tool(
  args: Record<string, any>,
  agent_input: HeuristicAgentInput,
  graphql: CountingGraphQLTool,
  diagnostics: Diagnostics,
): Promise<Record<string, any>> {
  if (diagnostics.graphql_budget_exhausted) {
    return _graphql_budget_terminal_response();
  }
  const source = String(args["source"] ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(Math.trunc(Number(args["limit"] || 20)), 100));
  const offset = Math.max(0, Math.trunc(Number(args["offset"] || 0)));
  const address_id = _resolved_address_id(agent_input);
  if (address_id === null) {
    return { ok: false, error: "No resolved address id is available." };
  }
  const field = mapGet(ADDRESS_SOURCE_FIELDS, source);
  if (!field) {
    return { ok: false, error: `Unsupported address source: ${source}`, supported_sources: ["base", ...Object.keys(ADDRESS_SOURCE_FIELDS).sort()] };
  }
  const query = `
    query AgentAddressRecordsShortcut($id: Int!, $limit: Int, $offset: Int) {
      address(id: $id) {
        ${field}(limit: $limit, offset: $offset) {
          totalCount
          hasMore
          nodes { table rowid data }
        }
      }
    }
    `;
  let data: Record<string, unknown>;
  try {
    data = await graphql.query(query, { id: address_id, limit, offset }, { result_summary: `shortcut ${source} records at address ${address_id}` });
  } catch (exc) {
    if (!(exc instanceof GraphQLToolError)) {
      throw exc;
    }
    diagnostics.tool_errors.push(errStr(exc));
    if (_is_graphql_budget_error(exc)) {
      diagnostics.graphql_budget_exhausted = true;
      return _graphql_budget_terminal_response(errStr(exc));
    }
    return { ok: false, error: errStr(exc) };
  }
  const conn: any = ((data["address"] ?? {}) as any)[field] ?? {};
  return {
    ok: true,
    source,
    totalCount: Math.trunc(Number(conn["totalCount"] ?? 0)),
    hasMore: Boolean(conn["hasMore"]),
    records: asArray(conn["nodes"]).map((node) => _compact_source_node(source, node)),
  };
}

async function _get_people_at_address_tool(
  args: Record<string, any>,
  agent_input: HeuristicAgentInput,
  graphql: CountingGraphQLTool,
  diagnostics: Diagnostics,
): Promise<Record<string, any>> {
  if (diagnostics.graphql_budget_exhausted) {
    return _graphql_budget_terminal_response();
  }
  const address_id = _resolved_address_id(agent_input);
  if (address_id === null) {
    return { ok: false, error: "No resolved address id is available." };
  }
  const limit = Math.max(1, Math.min(Math.trunc(Number(args["limit"] || 25)), 100));
  const offset = Math.max(0, Math.trunc(Number(args["offset"] || 0)));
  const query = `
    query AgentPeopleAtAddressShortcut($id: Int!, $limit: Int, $offset: Int) {
      peopleAtAddress(addressId: $id, limit: $limit, offset: $offset) {
        totalCount
        hasMore
        nodes { id firstname middlename lastname fullName normNameKey primaryAddressId }
      }
    }
    `;
  let data: Record<string, unknown>;
  try {
    data = await graphql.query(query, { id: address_id, limit, offset }, { result_summary: `shortcut people at address ${address_id}` });
  } catch (exc) {
    if (!(exc instanceof GraphQLToolError)) {
      throw exc;
    }
    diagnostics.tool_errors.push(errStr(exc));
    if (_is_graphql_budget_error(exc)) {
      diagnostics.graphql_budget_exhausted = true;
      return _graphql_budget_terminal_response(errStr(exc));
    }
    return { ok: false, error: errStr(exc) };
  }
  const conn: any = data["peopleAtAddress"] ?? {};
  return {
    ok: true,
    address_id,
    totalCount: Math.trunc(Number(conn["totalCount"] ?? 0)),
    hasMore: Boolean(conn["hasMore"]),
    people: asArray(conn["nodes"]).map((node) => _compact_person_node(node)),
  };
}

async function _get_person_records_tool(
  args: Record<string, any>,
  graphql: CountingGraphQLTool,
  diagnostics: Diagnostics,
): Promise<Record<string, any>> {
  if (diagnostics.graphql_budget_exhausted) {
    return _graphql_budget_terminal_response();
  }
  const person_id = String(args["person_id"] ?? "").trim();
  if (!person_id) {
    return { ok: false, error: "person_id is required." };
  }
  const requested_sources = Array.isArray(args["sources"]) ? args["sources"] : [];
  const normalizedSources = requested_sources
    .filter((source: any) => String(source).trim() !== "")
    .map((source: any) => String(source).trim().toLowerCase());
  const sources = (normalizedSources.length > 0
    ? normalizedSources
    : ["base", "tax", "trace", "auto", "loan", "drive", "voter", "criminal", "linkedin"]) as string[];
  const supported = sources.filter((source) => Object.hasOwn(PERSON_SOURCE_FIELDS, source));
  const unsupported = setDifferenceSorted(sources, supported);
  const limit = Math.max(1, Math.min(Math.trunc(Number(args["limit"] || 20)), 100));
  const selections = supported
    .map((source) => PERSON_SOURCE_FIELDS[source])
    .map((field) => `${field}(limit: $limit) { totalCount hasMore nodes { table rowid data } }`)
    .join("\n");
  const query = `
    query AgentPersonRecordsShortcut($personId: String!, $limit: Int) {
      person(id: $personId) {
        id
        firstname
        middlename
        lastname
        fullName
        ${selections}
      }
    }
    `;
  let data: Record<string, unknown>;
  try {
    data = await graphql.query(query, { personId: person_id, limit }, { result_summary: `shortcut person records for ${person_id}` });
  } catch (exc) {
    if (!(exc instanceof GraphQLToolError)) {
      throw exc;
    }
    diagnostics.tool_errors.push(errStr(exc));
    if (_is_graphql_budget_error(exc)) {
      diagnostics.graphql_budget_exhausted = true;
      return _graphql_budget_terminal_response(errStr(exc));
    }
    return { ok: false, error: errStr(exc), unsupported_sources: unsupported };
  }
  const person: any = data["person"] ?? {};
  const records: Record<string, any> = {};
  for (const source of supported) {
    const field = PERSON_SOURCE_FIELDS[source]!;
    const conn: any = person[field] ?? {};
    records[source] = {
      totalCount: Math.trunc(Number(conn["totalCount"] ?? 0)),
      hasMore: Boolean(conn["hasMore"]),
      records: asArray(conn["nodes"]).map((node) => _compact_source_node(source, node)),
    };
  }
  return {
    ok: true,
    person: _compact_person_node(person),
    records_by_source: records,
    unsupported_sources: unsupported,
  };
}

function _tool_protocol_prompt(opts: { include_shortcuts?: boolean } = {}): string {
  const include_shortcuts = opts.include_shortcuts ?? false;
  if (include_shortcuts) {
    return `Use the available tools. Do not write ad hoc JSON actions or final answers in message text.
Tool workflow:
1. Use get_address_records, get_people_at_address, and get_person_records for common evidence retrieval.
2. Use describe_schema when shortcut tools are insufficient or you are unsure about schema shape.
3. Use execute_graphql for read-only raw GraphQL queries; if it returns validation errors, revise using its hints and skeletons.
4. Use submit_heuristic_result exactly once when finished.

Final result constraints:
- direction must be one of risk, mitigation, context, quality.
- status must be one of triggered, not_triggered, inconclusive, context, mitigation, quality, error.
- interpretation must be an object. If unsure, use unknown/not_applicable defaults rather than omitting it.
- finding: ONE concise paragraph stating the conclusion, the key reasoning, and the per-sub-signal outcomes. Do not pad or repeat.
- evidence_for and evidence_against must cite compact row references: source, table, rowid, record_id, summary.
- Do not copy row data into evidence citations.
- missing_evidence and caveats must be arrays.
- Be concise. State each fact once in the most appropriate field; do not repeat the conclusion across finding/evidence/caveats. Put genuine data gaps in missing_evidence, interpretation caveats in caveats.
- evidence_for is REQUIRED when status is triggered (cite at least one supporting source/table/rowid); evidence_against or missing_evidence is required when not_triggered. Citing rows is not "repeating the conclusion" — these structured citations are mandatory anchors, separate from the finding narrative.
`;
  }
  return `Use the available tools. Do not write ad hoc JSON actions or final answers in message text.
Tool workflow:
1. Use describe_schema when you are unsure about schema shape.
2. Use execute_graphql for read-only raw GraphQL queries; if it returns validation errors, revise using its hints and skeletons.
3. Use submit_heuristic_result exactly once when finished.

Final result constraints:
- direction must be one of risk, mitigation, context, quality.
- status must be one of triggered, not_triggered, inconclusive, context, mitigation, quality, error.
- interpretation must be an object. If unsure, use unknown/not_applicable defaults rather than omitting it.
- finding: ONE concise paragraph stating the conclusion, the key reasoning, and the per-sub-signal outcomes. Do not pad or repeat.
- evidence_for and evidence_against must cite compact row references: source, table, rowid, record_id, summary.
- Do not copy row data into evidence citations.
- missing_evidence and caveats must be arrays.
- Be concise. State each fact once in the most appropriate field; do not repeat the conclusion across finding/evidence/caveats. Put genuine data gaps in missing_evidence, interpretation caveats in caveats.
- evidence_for is REQUIRED when status is triggered (cite at least one supporting source/table/rowid); evidence_against or missing_evidence is required when not_triggered. Citing rows is not "repeating the conclusion" — these structured citations are mandatory anchors, separate from the finding narrative.
`;
}

export function _union_source_scope(agent_inputs: HeuristicAgentInput[]): string[] {
  const scope: string[] = [];
  for (const ai of agent_inputs) {
    const contextScope = ai.heuristic["context_scope"] as any[] | undefined;
    const inputSources = ai.heuristic["input_sources"] as any[] | undefined;
    const sources: any[] = contextScope?.length ? contextScope : inputSources?.length ? inputSources : [];
    for (const source of sources) {
      const name = String(source);
      if (!scope.includes(name)) {
        scope.push(name);
      }
    }
  }
  return scope;
}

// ── GraphQLToolset adapter ──────────────────────────────────────────────────────────────────────────

export class GraphQLToolset implements RetrievalToolset {
  name = "tools";
  include_shortcuts: boolean;

  constructor(opts: { include_shortcuts?: boolean } = {}) {
    this.include_shortcuts = opts.include_shortcuts ?? false;
  }

  tool_definitions(): any[] {
    let tools: any[] = [execute_graphql, describe_schema];
    if (this.include_shortcuts) {
      tools = [get_address_records, get_people_at_address, get_person_records, ...tools];
    }
    return tools;
  }

  owns_tool(name: string): boolean {
    if (_RAW_GRAPHQL_TOOLS.has(name)) {
      return true;
    }
    return this.include_shortcuts && _SHORTCUT_TOOLS.has(name);
  }

  system_prompt(): string {
    return HEURISTIC_SYSTEM_PROMPT + "\n\n" + _tool_protocol_prompt({ include_shortcuts: this.include_shortcuts });
  }

  build_context(agent_input: HeuristicAgentInput): Record<string, any> {
    return prompt_context(
      agent_input.context,
      agent_input.prompt_profile,
      ((agent_input.heuristic["context_scope"] as any[] | undefined)?.length
        ? (agent_input.heuristic["context_scope"] as string[])
        : (agent_input.heuristic["input_sources"] as any[] | undefined)?.length
          ? (agent_input.heuristic["input_sources"] as string[])
          : []),
    );
  }

  user_prompt(agent_input: HeuristicAgentInput, context: Record<string, any>): string {
    return heuristic_user_prompt(agent_input.heuristic, context, null, this.include_shortcuts);
  }

  group_user_prompt(agent_inputs: HeuristicAgentInput[]): string {
    const base = agent_inputs[0]!;
    const union_scope = _union_source_scope(agent_inputs);
    const context = prompt_context(base.context, base.prompt_profile, union_scope);
    return grouped_heuristic_user_prompt(
      agent_inputs.map((ai) => ai.heuristic),
      context,
      agent_inputs.map((ai) => (ai.plan !== null && ai.plan !== undefined ? ai.plan : {})),
      null,
      this.include_shortcuts,
    );
  }

  async dispatch(
    name: string,
    args: Record<string, any>,
    agent_input: HeuristicAgentInput,
    graphql: CountingGraphQLTool,
    diagnostics: Diagnostics,
  ): Promise<Record<string, any>> {
    if (diagnostics.graphql_budget_exhausted && (_RAW_GRAPHQL_TOOLS.has(name) || _SHORTCUT_TOOLS.has(name))) {
      return _graphql_budget_terminal_response();
    }
    if (name === "validate_graphql") {
      return await _validate_graphql_tool(args, graphql, diagnostics);
    }
    if (name === "execute_graphql") {
      return await _execute_graphql_tool(args, graphql, diagnostics);
    }
    if (name === "describe_schema") {
      return await _describe_schema_tool(args, agent_input, graphql, diagnostics);
    }
    if (name === "get_address_records" && this.include_shortcuts) {
      return await _get_address_records_tool(args, agent_input, graphql, diagnostics);
    }
    if (name === "get_people_at_address" && this.include_shortcuts) {
      return await _get_people_at_address_tool(args, agent_input, graphql, diagnostics);
    }
    if (name === "get_person_records" && this.include_shortcuts) {
      return await _get_person_records_tool(args, graphql, diagnostics);
    }
    const content: Record<string, any> = {
      ok: false,
      error: `Unknown tool: ${name}`,
      available_tools: this.tool_definitions().map((t) => t.name),
    };
    diagnostics.tool_errors.push(String(content["error"]));
    return content;
  }

  describe_call(name: string, args: Record<string, any>, _result: Record<string, any>): Record<string, any> {
    if (name === "execute_graphql" || name === "validate_graphql") {
      const query = String(args["query"] ?? "");
      return { query_sha256: createHash("sha256").update(query, "utf8").digest("hex"), query_chars: Array.from(query).length };
    }
    if (name === "describe_schema") {
      return { target: args["target"] || "Query" };
    }
    return Boolean(args["source"]) ? { source: args["source"] } : {};
  }
}

// ── Primitive coercion helpers ───────────────────────────────────────────────────────────────────────

function isDict(value: any): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Map lookup by key: own-property lookup only (never the prototype chain). */
function mapGet(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Coerce to an array for list access (nodes may be null). */
function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

/** Error message: GraphQLToolError message with no "Error: " prefix. */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Items in `a` not in `b`, deduped and sorted. */
function setDifferenceSorted(a: string[], b: string[]): string[] {
  const bset = new Set(b);
  return [...new Set(a.filter((s) => !bset.has(s)))].sort();
}

function codePointLength(s: string): number {
  return Array.from(s).length;
}

function codePointSlice(s: string, end: number): string {
  return Array.from(s).slice(0, end).join("");
}
