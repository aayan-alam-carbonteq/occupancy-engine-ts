// Port of occupancy_engine/agents/typed_tools.py.
//
// The "typed_tools" retrieval surface: a fixed set of LangChain tools (get_records, get_people,
// search_people, and per-shape get_* tools) plus the dispatch logic (`run_typed_tool`) and the
// per-heuristic tool guide text. Behavior is preserved 1:1 with the Python source.
//
// PORT NOTE (LangChain tool() shape): Python `@tool(args_schema=PydanticModel)` uses the *function
// name* as the tool name and the *function docstring* as the description. LangChain.js `tool(func,
// { name, description, schema })` takes those explicitly, so each tool below passes name =
// (Python function name), description = (Python docstring verbatim), and schema = a zod object that
// mirrors the pydantic args_schema field-for-field (names, types, descriptions, defaults, min/max).
// The func body is a stub (`async () => ({})`) — exactly like Python's stubs that `return {}` — because
// the subagent loop routes by tool name through `run_typed_tool`, it never invokes the tool's own func.
// The pydantic class docstring becomes the schema-level `.describe(...)`.
//
// PORT NOTE (str()/casefold()): shape normalization uses `.trim().toLowerCase()` for Python
// `.strip().casefold()` (identical for the ASCII shape names here). Python list interpolation
// (f"shapes={suggested}") is reproduced with `pyReprList` so the guide text matches byte-for-byte.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { CountingGraphQLTool } from "./graphql_tool.ts";
import type { HeuristicAgentInput } from "./models.ts";
import {
  ADDRESS_SOURCE_FIELDS,
  PERSON_SOURCE_FIELDS,
  _resolve_bundle_address_id,
  fetch_address_records,
  fetch_address_records_multi,
  fetch_people_at_address,
  fetch_person_records,
  fetch_search_people,
} from "./retrieval.ts";

// tool_name -> [shape, mode]; mode in {"both", "address", "person"}
export const SHAPE_TOOLS: Record<string, [string, string]> = {
  get_base: ["base", "both"],
  get_tax: ["tax", "both"],
  get_loans: ["loan", "both"],
  get_vehicles: ["auto", "both"],
  get_drivers_licenses: ["drive", "both"],
  get_voter_records: ["voter", "both"],
  get_trace_records: ["trace", "both"],
  get_criminal_records: ["criminal", "both"],
  get_utility: ["utility", "address"],
  get_linkedin: ["linkedin", "person"],
};

const ShapeToolArgs = z
  .object({
    person_id: z
      .string()
      .nullish()
      .default(null)
      .describe("Omit for records at the subject address; provide a person id to get that person's records of this shape."),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .describe("Records of one shape at the subject address, or for a specific person.");

const AddressOnlyArgs = z.object({
  limit: z.number().int().min(1).max(100).default(25),
});

const PersonOnlyArgs = z.object({
  person_id: z.string().describe("Person id (this shape is person-scoped only)."),
  limit: z.number().int().min(1).max(100).default(25),
});

const SearchPeopleArgs = z.object({
  name: z.string().describe("Name to search for, e.g. a tax owner name."),
  limit: z.number().int().min(1).max(50).default(10),
});

export const ALL_SHAPES: Set<string> = new Set([...Object.keys(ADDRESS_SOURCE_FIELDS), ...Object.keys(PERSON_SOURCE_FIELDS)]);

const GetRecordsArgs = z
  .object({
    shapes: z
      .array(z.string())
      .describe("Shapes to fetch together in ONE call: base, tax, loan, auto, drive, voter, trace, criminal, utility (address-only), linkedin (person-only)."),
    person_id: z
      .string()
      .nullish()
      .default(null)
      .describe("Omit for records at the subject address; provide a person id for that person's records."),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .describe("Fetch several record shapes for one entity in a single query.");

function _envelope(source: string, block: Record<string, any>): Record<string, any> {
  return {
    ok: true,
    source,
    count: pyInt(orElse(block["totalCount"], 0)),
    has_more: truthy(block["hasMore"]),
    records: orElse(block["records"], []),
  };
}

function _normalize_shapes(args: Record<string, any>, agent_input: HeuristicAgentInput): string[] {
  const raw = args["shapes"];
  let shapes = Array.isArray(raw)
    ? raw.filter((s) => String(s).trim() !== "").map((s) => String(s).trim().toLowerCase())
    : [];
  if (shapes.length === 0) {
    const scope = orElse(orElse(agent_input.heuristic["context_scope"], agent_input.heuristic["input_sources"]), []) as any[];
    shapes = orElse(
      scope.filter((s) => String(s).trim() !== "").map((s) => String(s).trim().toLowerCase()),
      ["tax", "base"],
    ) as string[];
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const s of shapes) {
    if (!seen.has(s)) {
      seen.add(s);
      deduped.push(s);
    }
  }
  return deduped;
}

async function _run_get_records(args: Record<string, any>, agent_input: HeuristicAgentInput, graphql: CountingGraphQLTool): Promise<Record<string, any>> {
  const shapes = _normalize_shapes(args, agent_input);
  const unknown = shapes.filter((s) => !ALL_SHAPES.has(s));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown shape(s): ${pyReprList(unknown)}`, valid_shapes: [...ALL_SHAPES].sort() };
  }
  const limit = Math.max(1, Math.min(pyInt(orElse(args["limit"], 25)), 100));
  const person_id = String(orElse(args["person_id"], "")).trim();
  if (person_id) {
    const res = await fetch_person_records(graphql, person_id, { sources: shapes, limit });
    if (!res["ok"]) return res;
    return {
      ok: true,
      scope: "person",
      person: res["person"],
      records_by_source: orElse(res["records_by_source"], {}),
      unsupported_sources: orElse(res["unsupported_sources"], []),
    };
  }
  const address_id = _resolve_bundle_address_id(agent_input.context);
  if (address_id === null) {
    return { ok: false, error: "No resolved subject address is available." };
  }
  const res = await fetch_address_records_multi(graphql, address_id, { sources: shapes, limit });
  if (!res["ok"]) return res;
  return {
    ok: true,
    scope: "address",
    records_by_source: orElse(res["records_by_source"], {}),
    unsupported_sources: orElse(res["unsupported_sources"], []),
  };
}

async function _run_shape_tool(name: string, args: Record<string, any>, agent_input: HeuristicAgentInput, graphql: CountingGraphQLTool): Promise<Record<string, any>> {
  const [shape, mode] = SHAPE_TOOLS[name]!;
  const limit = Math.max(1, Math.min(pyInt(orElse(args["limit"], 25)), 100));
  const person_id = String(orElse(args["person_id"], "")).trim();
  if (person_id && (mode === "both" || mode === "person")) {
    const res = await fetch_person_records(graphql, person_id, { sources: [shape], limit });
    if (!res["ok"]) return res;
    const block = orElse(orElse(res["records_by_source"], {})[shape], { totalCount: 0, hasMore: false, records: [] });
    return _envelope(shape, block);
  }
  if (mode === "person") {
    return { ok: false, error: `${name} is person-scoped; provide a person_id.` };
  }
  const address_id = _resolve_bundle_address_id(agent_input.context);
  if (address_id === null) {
    return { ok: false, error: "No resolved subject address is available." };
  }
  const res = await fetch_address_records(graphql, address_id, shape, { limit });
  if (!res["ok"]) return res;
  return _envelope(shape, res);
}

async function _run_get_people(args: Record<string, any>, agent_input: HeuristicAgentInput, graphql: CountingGraphQLTool): Promise<Record<string, any>> {
  const address_id = _resolve_bundle_address_id(agent_input.context);
  if (address_id === null) {
    return { ok: false, error: "No resolved subject address is available." };
  }
  const res = await fetch_people_at_address(graphql, address_id, { limit: Math.max(1, Math.min(pyInt(orElse(args["limit"], 25)), 100)) });
  if (!res["ok"]) return res;
  return { ok: true, source: "people", count: pyInt(orElse(res["totalCount"], 0)), has_more: truthy(res["hasMore"]), records: orElse(res["people"], []) };
}

async function _run_search_people(args: Record<string, any>, _agent_input: HeuristicAgentInput, graphql: CountingGraphQLTool): Promise<Record<string, any>> {
  return await fetch_search_people(graphql, String(orElse(args["name"], "")), { limit: Math.max(1, Math.min(pyInt(orElse(args["limit"], 10)), 50)) });
}

// tool_name -> handler(args, agent_input, graphql) for non-shape tools
export const SPECIAL_HANDLERS: Record<string, (args: Record<string, any>, agent_input: HeuristicAgentInput, graphql: CountingGraphQLTool) => Promise<Record<string, any>>> = {
  get_people: _run_get_people,
  search_people: _run_search_people,
};

export async function run_typed_tool(name: string, args: Record<string, any>, agent_input: HeuristicAgentInput, graphql: CountingGraphQLTool): Promise<Record<string, any>> {
  if (name === "get_records") {
    return await _run_get_records(args, agent_input, graphql);
  }
  if (Object.hasOwn(SPECIAL_HANDLERS, name)) {
    return await SPECIAL_HANDLERS[name]!(args, agent_input, graphql);
  }
  if (Object.hasOwn(SHAPE_TOOLS, name)) {
    return await _run_shape_tool(name, args, agent_input, graphql);
  }
  return { ok: false, error: `Unknown tool: ${name}` };
}

const get_records = tool(async () => ({}), {
  name: "get_records",
  description:
    "Fetch multiple record shapes for ONE entity in a single query. Subject address by default, or pass person_id. Prefer this over the individual get_* tools to gather everything you need at once. Shapes: base, tax, loan, auto, drive, voter, trace, criminal, utility (address-only), linkedin (person-only).",
  schema: GetRecordsArgs,
});

const get_people = tool(async () => ({}), {
  name: "get_people",
  description: "People linked to the subject address. Returns person ids + names; use these ids with the other tools.",
  schema: AddressOnlyArgs,
});

const search_people = tool(async () => ({}), {
  name: "search_people",
  description: "Find person entities by name (e.g. a tax owner who may live elsewhere). Returns person ids to traverse.",
  schema: SearchPeopleArgs,
});

const get_base = tool(async () => ({}), {
  name: "get_base",
  description:
    "Base demographic/consumer records: homeowner probability, length of residence, home purchase year/price, year built, mortgage and refinance amount/lender. Useful for owner-vs-occupant tenure and financing. Subject address by default, or a person's base record.",
  schema: ShapeToolArgs,
});

const get_tax = tool(async () => ({}), {
  name: "get_tax",
  description:
    "Tax/property records: owner name, owner mailing address, residential/condo flags, lender, liens, foreclosure markers. Subject address by default, or a person's tax records.",
  schema: ShapeToolArgs,
});

const get_loans = tool(async () => ({}), {
  name: "get_loans",
  description:
    "Loan application records: own/rent claim, loan amount, monthly income, employer, occupation. Subject address by default, or a person's loans.",
  schema: ShapeToolArgs,
});

const get_vehicles = tool(async () => ({}), {
  name: "get_vehicles",
  description:
    "Vehicle/auto registration records: VIN, year, make, model, name, address. Subject address by default, or a person's vehicles.",
  schema: ShapeToolArgs,
});

const get_drivers_licenses = tool(async () => ({}), {
  name: "get_drivers_licenses",
  description: "Driver-license records: name, address, license number and state. Subject address by default, or a person's licenses.",
  schema: ShapeToolArgs,
});

const get_voter_records = tool(async () => ({}), {
  name: "get_voter_records",
  description: "Voter-registration records: name, address, gender, contact. Subject address by default, or a person's voter records.",
  schema: ShapeToolArgs,
});

const get_trace_records = tool(async () => ({}), {
  name: "get_trace_records",
  description: "Trace/skip-trace residency records: name, address, phone, email, DOB parts. Subject address by default, or a person's trace records.",
  schema: ShapeToolArgs,
});

const get_criminal_records = tool(async () => ({}), {
  name: "get_criminal_records",
  description: "Criminal records: name, address, category, offense description, county, arrest date. Subject address by default, or a person's criminal records.",
  schema: ShapeToolArgs,
});

const get_utility = tool(async () => ({}), {
  name: "get_utility",
  description: "Utility-account names at the subject address (address-only): names, DOB, address. Useful for occupancy by non-owners.",
  schema: AddressOnlyArgs,
});

const get_linkedin = tool(async () => ({}), {
  name: "get_linkedin",
  description: "LinkedIn records for a person (person-only): name, profile url, position title and company.",
  schema: PersonOnlyArgs,
});

// fixed set of per-shape data tools
const _DATA_TOOLS: any[] = [
  get_base,
  get_tax,
  get_loans,
  get_vehicles,
  get_drivers_licenses,
  get_voter_records,
  get_trace_records,
  get_criminal_records,
  get_utility,
  get_linkedin,
];

export function _typed_tool_definitions(): any[] {
  return [get_records, get_people, search_people, ..._DATA_TOOLS];
}

const _TOOL_ONE_LINERS: Record<string, string> = {
  get_people: "people at the subject address (returns person ids)",
  search_people: "find a person entity by name (e.g. a tax owner who may live elsewhere)",
  get_base: "base demographic/consumer: homeowner probability, length of residence, purchase year/price, mortgage/refi",
  get_tax: "tax/property: owner, mailing address, liens, foreclosure",
  get_loans: "loan records: own/rent claim, amount, income, employer",
  get_utility: "utility-account names at the address (address-only)",
  get_vehicles: "vehicle/auto registrations",
  get_drivers_licenses: "driver-license records",
  get_voter_records: "voter-registration records",
  get_trace_records: "trace/skip-trace residency records",
  get_criminal_records: "criminal records",
  get_linkedin: "LinkedIn records (person-only)",
};

// shape -> the per-shape tool that serves it, for relevance selection
const _SHAPE_TO_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(SHAPE_TOOLS).map(([name, [shape]]) => [shape, name]),
);

export function typed_tools_guide(heuristic: Record<string, any>): string {
  const scope = (orElse(orElse(heuristic["context_scope"], heuristic["input_sources"]), []) as any[])
    .filter((s) => String(s).trim() !== "")
    .map((s) => String(s).trim().toLowerCase());
  const suggested = orElse(scope.filter((s) => ALL_SHAPES.has(s)), ["tax", "base"]) as string[];
  const relevant_tools: string[] = [];
  for (const s of scope) {
    const tool_name = Object.hasOwn(_SHAPE_TO_TOOL, s) ? _SHAPE_TO_TOOL[s] : undefined;
    if (tool_name && !relevant_tools.includes(tool_name)) {
      relevant_tools.push(tool_name);
    }
  }
  const lines = [
    "PRIMARY tool — fetch everything you need for one entity in a SINGLE call:",
    "- get_records(shapes=[...], person_id?=...): pass multiple shapes at once " +
      "(subject address by default, or a person_id). For this heuristic, start with " +
      `shapes=${pyReprList(suggested)}.`,
    "Entity discovery:",
    "- get_people: people at the subject address (returns person ids)",
    "- search_people: find a person entity by name (e.g. a tax owner who may live elsewhere)",
    "Drill-down only (use get_records first; these fetch ONE shape, for pagination or a single follow-up):",
  ];
  const drill = orElse(relevant_tools, ["get_tax", "get_base"]) as string[];
  for (const t of drill) {
    lines.push(`- ${t}: ${Object.hasOwn(_TOOL_ONE_LINERS, t) ? _TOOL_ONE_LINERS[t] : ""}`);
  }
  const others = Object.keys(_TOOL_ONE_LINERS).filter((n) => !drill.includes(n) && n !== "get_people" && n !== "search_people");
  if (others.length > 0) {
    lines.push("Other per-shape tools: " + others.join(", ") + ".");
  }
  lines.push("Be concise. State each fact once in the most appropriate field; do not repeat the conclusion across finding/evidence/caveats. Put genuine data gaps in missing_evidence, interpretation caveats in caveats.");
  lines.push('evidence_for is REQUIRED when status is triggered (cite at least one supporting source/table/rowid); evidence_against or missing_evidence is required when not_triggered. Citing rows is not "repeating the conclusion" — these structured citations are mandatory anchors, separate from the finding narrative.');
  return lines.join("\n");
}

// ── Python-semantics helpers ──────────────────────────────────────────────────

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

/** Python int(): truncate toward zero. */
function pyInt(value: any): number {
  return Math.trunc(Number(value));
}

/** Python repr() of a string. */
function pyReprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += "\\x" + code.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + quote;
}

/** Python str() of a list of strings: `['a', 'b']`. */
function pyReprList(items: any[]): string {
  return "[" + items.map((v) => (typeof v === "string" ? pyReprStr(v) : String(v))).join(", ") + "]";
}
