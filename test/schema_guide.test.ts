import { describe, expect, test } from "bun:test";
import type { DataSchema } from "../src/agents/data_client.ts";
import { fallbackSchemaGuide, summarizeDataSchema } from "../src/agents/schema_guide.ts";

// Field names and values taken from the real service/schema_doc.py — ACCESS_PATHS entries are
// {predicate, table, index, measured, hint_key}, and schema_document() also serves a `limits`
// block. Fixture rows are abridged, never renamed.
const SCHEMA: DataSchema = {
  tables: [
    {
      name: "public.records_legacy",
      purpose: "Older feeds: trace (~44%), utility (~26%), SSNxDOB, consumer base. 6.24 B rows.",
      key_columns: ["record_id", "source_file", "first_name", "last_name", "address", "zip"],
    },
    {
      name: "silver.entity_links",
      purpose: "hal_id -> (source_table, record_id). Indexed in both directions.",
      key_columns: ["hal_id", "source_table", "record_id", "match_type", "confidence"],
    },
  ],
  access_paths: [
    {
      predicate: "zip = $1 AND address ILIKE 'N STREET%'",
      table: "public.records_partitioned",
      index: "per-partition zip btree",
      measured: "173 ms warm, 24 k rows examined",
      hint_key: "zip",
    },
    {
      predicate: "upper(state) = $1 AND upper(city) = $2 AND address ILIKE 'N STREET%'",
      table: "public.records_partitioned",
      index: "(upper(state), upper(city))",
      measured: "613 ms warm / 53 s cold, 151 507 rows examined. The ONLY path to tax.",
      hint_key: "(upper(state), upper(city))",
    },
    {
      predicate: "hal_id = $1",
      table: "silver.entity_links",
      index: "entity_links(hal_id)",
      measured: "215 ms",
      // The silver paths carry no hint_key on purpose — the pinned refusal hint names records
      // indexes only. A null must render as a path, not as a crash or an empty parenthetical.
      hint_key: null as unknown as undefined,
    },
  ],
  caveats: [
    "house_number and zip are 0% populated on property_owner rows",
    "~17.5% of property_owner rows are column-shifted",
    "imported_at is a load date, not an observation date",
  ],
  limits: {
    max_rows: 500,
    max_plan_cost: 5_000_000,
    max_records_seqscan_cost: 1_000_000,
    statement_timeout_ms: 30_000,
  },
};

describe("summarizeDataSchema", () => {
  test("leads with the access paths, because unindexed predicates are refused", () => {
    const out = summarizeDataSchema(SCHEMA);
    const pathsAt = out.indexOf("Indexed access paths");
    const tablesAt = out.indexOf("Tables");
    expect(pathsAt).toBeGreaterThan(-1);
    expect(tablesAt).toBeGreaterThan(-1);
    expect(pathsAt).toBeLessThan(tablesAt);
    expect(out).toContain("zip = $1 AND address ILIKE 'N STREET%'");
    expect(out).toContain("173 ms warm, 24 k rows examined");
  });

  test("renders the table an access path belongs to — the same predicate costs differently per relation", () => {
    const out = summarizeDataSchema(SCHEMA);
    expect(out).toContain("public.records_partitioned");
    expect(out).toContain("silver.entity_links");
  });

  test("renders hint_key when present so a refusal maps back to a path, and omits it when null", () => {
    const out = summarizeDataSchema(SCHEMA);
    // schema_doc generates the refusal hint from these keys; without them "Indexed paths: ... zip"
    // in a 422 cannot be traced to the row that says what zip actually costs.
    expect(out).toContain('refusals name this path as "zip"');
    expect(out).toContain('refusals name this path as "(upper(state), upper(city))"');
    // The hal_id path has none; it must still appear, without an empty quote pair.
    expect(out).toContain("hal_id = $1");
    expect(out).not.toContain('refusals name this path as ""');
  });

  test("states the execution ceiling the query has to fit inside", () => {
    const out = summarizeDataSchema(SCHEMA);
    expect(out).toContain("500");
    expect(out).toContain("30000");
    expect(out).toContain("max_plan_cost");
  });

  test("a schema with no limits block renders without inventing one", () => {
    const { limits: _limits, ...noLimits } = SCHEMA;
    const out = summarizeDataSchema(noLimits);
    expect(out).not.toContain("max_plan_cost");
    expect(out).toContain("Indexed access paths");
  });

  test("names the guard and the refusal contract so a refusal is repairable", () => {
    const out = summarizeDataSchema(SCHEMA);
    expect(out).toContain("exactly one SELECT");
    expect(out).toContain("EXPLAIN");
    expect(out).toContain("refused");
  });

  test("renders every caveat verbatim", () => {
    const out = summarizeDataSchema(SCHEMA);
    for (const c of SCHEMA.caveats) expect(out).toContain(c);
  });

  test("no GraphQL vocabulary survives anywhere in the guide", () => {
    const text = summarizeDataSchema(SCHEMA) + fallbackSchemaGuide("boom");
    for (const dead of ["GraphQL", "resolveAddress", "personAssociations", "addressAssociations", "totalCount", "sourceRecord", "WhereInput"]) {
      expect(text).not.toContain(dead);
    }
  });

  test("an empty schema falls back rather than emitting an empty guide", () => {
    expect(summarizeDataSchema({ tables: [], access_paths: [], caveats: [] })).toBe(
      fallbackSchemaGuide("the data service returned no tables or access paths"),
    );
    expect(summarizeDataSchema(null)).toBe(fallbackSchemaGuide("the data service returned no tables or access paths"));
  });

  test("a schema with tables but no access paths says so instead of implying everything is fast", () => {
    const out = summarizeDataSchema({ tables: SCHEMA.tables, access_paths: [], caveats: [] });
    expect(out).toContain("none advertised");
  });
});

describe("fallbackSchemaGuide", () => {
  test("still names the six typed operations when the schema fetch fails", () => {
    const out = fallbackSchemaGuide("connection refused");
    expect(out).toContain("connection refused");
    for (const op of ["/v1/resolve", "/v1/address/{id}/records", "/v1/address/{id}/people", "/v1/person/{id}/records", "/v1/people/search", "/v1/source-record/{shape}/{rowid}"]) {
      expect(out).toContain(op);
    }
  });

  test("operation 6 is quoted with its required address_id (Contract B addendum 1)", () => {
    expect(fallbackSchemaGuide()).toContain("/v1/source-record/{shape}/{rowid}?address_id=");
  });
});
