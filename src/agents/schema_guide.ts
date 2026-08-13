// Formats the curated GET /v1/schema payload into the guide the agent reads before writing SQL.
//
// The access paths lead, deliberately: a predicate off an indexed path is refused by the EXPLAIN
// gate before it ever runs, and dumping columns without saying which predicates are fast would
// guarantee refused queries.
//
// WHICH predicates are fast is the SERVICE's answer, not this module's, and it changes underneath
// us: the partner owns the indexes and has added them mid-project (an address path landed
// 2026-08-11, reachable only through silver.s5_street_norm(address) with an anchored LIKE prefix).
// So this comment deliberately does NOT enumerate the indexed columns — the version of
// services/graph pinned by any given commit may pre- or post-date such a change, and a list here
// would be wrong for one of them. `summarizeDataSchema` renders `path.predicate` verbatim from
// GET /v1/schema, so the agent gets whatever the deployed service actually knows. If you need the
// current list, read it from the service (service/schema_doc.py) at the pinned submodule commit,
// not from here.
//
// Field names mirror service/schema_doc.py exactly — an access path is
// {predicate, table, index, measured, hint_key}, and `measured` is PROSE ("173 ms warm, 24 k rows
// examined"), not a number. `table` matters because the same predicate costs an order of magnitude
// more on records_legacy than on records_partitioned, and `hint_key` is the token a 422 refusal
// names the path by, which is the only thing tying "Indexed paths: ... zip ..." in a refusal back
// to the line that says what zip actually costs.
import type { DataSchema } from "./data_client.ts";

const GUARD_LINES = [
  "Hatch guard, applied in this order to every run_sql call:",
  "1. Parse — exactly one SELECT. ';'-chaining, DML inside a CTE, and BEGIN/COMMIT/SET/COPY/DO/CALL/GRANT/ALTER are rejected.",
  "2. A LIMIT is injected if you omit one, and any limit you supply is capped.",
  "3. EXPLAIN (no ANALYZE) — a sequential scan on a records table, or a plan cost above the ceiling, is refused BEFORE execution.",
  "4. Execution runs under a statement timeout with a row cap.",
  "A refused query returns {refused, stage, reason, hint} carrying the planner's own reason. Read the",
  "hint and move the predicate onto an indexed access path; do not retry the same shape.",
];

export function summarizeDataSchema(schema: DataSchema | null | undefined): string {
  const tables = schema?.tables ?? [];
  const access_paths = schema?.access_paths ?? [];
  if (tables.length === 0 && access_paths.length === 0) {
    return fallbackSchemaGuide("the data service returned no tables or access paths");
  }
  const lines: string[] = [
    "Data surface for run_sql. Only the predicates listed here are servable; everything else is refused.",
    "",
    "Indexed access paths (the only fast predicates):",
  ];
  for (const path of access_paths) {
    const where = [path.table, path.index].filter((part) => part).join(" · ");
    const hint = path.hint_key ? `  (refusals name this path as "${path.hint_key}")` : "";
    lines.push(`- ${path.predicate}  [${where}]  measured: ${path.measured}${hint}`);
  }
  if (access_paths.length === 0) {
    lines.push("- (none advertised — treat every predicate as unindexed and expect a refusal)");
  }
  lines.push("", "Tables:");
  for (const table of tables) {
    lines.push(`- ${table.name}: ${table.purpose} Key columns: ${(table.key_columns ?? []).join(", ")}.`);
  }
  lines.push("", ...GUARD_LINES);
  // The ceiling the query has to fit inside. Contract C pins only {tables, access_paths, caveats},
  // so this block is optional — but when the service sends it, withholding it would leave the agent
  // guessing at the numbers its query is about to be measured against.
  const limits = schema?.limits;
  if (limits) {
    lines.push(
      "",
      "Execution ceiling (a query that exceeds any of these is refused or truncated):",
      `- max_rows: ${limits.max_rows}`,
      `- max_plan_cost: ${limits.max_plan_cost}`,
      `- max_records_seqscan_cost: ${limits.max_records_seqscan_cost}`,
      `- statement_timeout_ms: ${limits.statement_timeout_ms}`,
    );
  }
  const caveats = schema?.caveats ?? [];
  if (caveats.length > 0) {
    lines.push("", "Data-quality caveats — these are facts about the corpus, not hypotheses:");
    for (const caveat of caveats) {
      lines.push(`- ${caveat}`);
    }
  }
  return lines.join("\n");
}

export function fallbackSchemaGuide(message = ""): string {
  const suffix = message ? ` Schema fetch failed: ${message}` : "";
  return [
    `Curated data schema unavailable.${suffix} Use the typed operations only; do not guess at SQL.`,
    "Typed operations:",
    "- POST /v1/resolve {address, zip} — candidates, the resolved address_id, source_counts and the first rows per shape.",
    "- GET /v1/address/{id}/records?shapes=&limit=&offset= — rows at an address, per shape.",
    "- GET /v1/address/{id}/people?limit=&offset= — people linked to an address.",
    "- GET /v1/person/{id}/records?shapes=&limit= — a person's rows; id is addr:<addressId>:<n> or hal:<hal_id>.",
    "- GET /v1/people/search?name=&limit= — person entities by name.",
    // address_id is REQUIRED (Contract B addendum 1): a rowid is a position within ONE address's
    // rows for that shape, so the service refuses a naked call with a 400.
    "- GET /v1/source-record/{shape}/{rowid}?address_id=<id> — one raw row, for provenance.",
    "Live shapes: base, tax, utility, trace, auto, loan, drive.",
  ].join("\n");
}
