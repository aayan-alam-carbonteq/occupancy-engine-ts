import { describe, expect, test } from "bun:test";
import { CountingDataClient, DataHttpClient } from "../src/agents/data_client.ts";
import { Diagnostics } from "../src/agents/toolsets/base.ts";
import { make_toolset } from "../src/agents/toolsets/index.ts";
import { SqlToolset } from "../src/agents/toolsets/sql_toolset.ts";
import { TypedToolset } from "../src/agents/toolsets/typed_toolset.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";

const AGENT_INPUT = {
  heuristic: { id: "h", packet: true, context_scope: ["tax"] },
  context: { selected: { id: 3342 }, evidence_map: { address_id: 3342 } },
  schema_tool_budget: 2,
  prompt_profile: "compact",
} as any;

function counted(s: FixtureDataService, max_calls = 8) {
  return new CountingDataClient(new DataHttpClient(s.url), { max_calls });
}

/** One tax row at the subject address, so a typed tool can succeed against the fixture. */
const TAX_RECORDS = {
  records_by_source: {
    tax: { total_count: 1, has_more: false, records: [{ ownername: "DOE, JANE", __rowid: 0 }] },
  },
  unsupported_shapes: [],
};

describe("mode semantics (D0)", () => {
  test('"tools" is the typed surface PLUS the hatch; "typed_tools" is typed only', () => {
    const tools = make_toolset("tools").tool_definitions().map((t: any) => t.name);
    const typed = make_toolset("typed_tools").tool_definitions().map((t: any) => t.name);
    expect(tools).toEqual([...typed, "run_sql", "describe_schema", "get_source_record"]);
    expect(typed).not.toContain("run_sql");
    expect(make_toolset("tools").name).toBe("tools");
    expect(make_toolset("tools") instanceof SqlToolset).toBe(true);
    expect(make_toolset("typed_tools") instanceof TypedToolset).toBe(true);
  });

  test("no GraphQL tool exists in either mode", () => {
    const all = [
      ...make_toolset("tools").tool_definitions(),
      ...make_toolset("typed_tools").tool_definitions(),
    ].map((t: any) => t.name);
    for (const dead of [
      "execute_graphql",
      "validate_graphql",
      "get_address_records",
      "get_people_at_address",
      "get_person_records",
    ]) {
      expect(all).not.toContain(dead);
    }
  });

  test("SqlToolset owns both its own tools and every typed tool", () => {
    const ts = new SqlToolset();
    expect(ts.owns_tool("run_sql")).toBe(true);
    expect(ts.owns_tool("describe_schema")).toBe(true);
    expect(ts.owns_tool("get_source_record")).toBe(true);
    expect(ts.owns_tool("get_records")).toBe(true);
    expect(ts.owns_tool("get_tax")).toBe(true);
    expect(ts.owns_tool("execute_graphql")).toBe(false);
  });

  test("SqlToolset composes TypedToolset rather than redeclaring the typed tools", () => {
    // Composition, not duplication: the hatch mode serves the *same* tool objects the bounded mode
    // does, so a typed tool can never drift between the two surfaces.
    const typed = new TypedToolset().tool_definitions();
    const sql = new SqlToolset().tool_definitions();
    expect(sql.slice(0, typed.length)).toEqual(typed);
    for (const name of typed.map((t: any) => t.name)) {
      expect(new SqlToolset().owns_tool(name)).toBe(true);
    }
  });
});

describe("run_sql dispatch", () => {
  test("a successful query returns rows and does not touch the repair counters", async () => {
    const s = new FixtureDataService({
      sql: {
        columns: ["record_id"],
        rows: [[4001]],
        row_count: 1,
        truncated: false,
        plan_cost: 8.14,
        duration_ms: 173,
      },
    });
    try {
      const d = new Diagnostics();
      const out = await new SqlToolset().dispatch(
        "run_sql",
        { query: "SELECT record_id FROM tax LIMIT 1" },
        AGENT_INPUT,
        counted(s),
        d,
      );
      expect(out).toMatchObject({ ok: true, row_count: 1, plan_cost: 8.14 });
      expect(d.validation_errors).toEqual([]);
      expect(d.query_repair_attempts).toBe(0);
    } finally {
      s.close();
    }
  });

  test("a 422 refusal becomes an ok:false repair payload and drives the repair counters (D3)", async () => {
    const s = new FixtureDataService({
      sql: {
        refused: true,
        stage: "explain",
        reason: "Seq Scan on records_legacy (cost=0.00..184000000.00)",
        hint: "Indexed paths: zip; ssn; phone; email.",
      },
    });
    try {
      const d = new Diagnostics();
      const out = await new SqlToolset().dispatch(
        "run_sql",
        { query: "SELECT * FROM records_legacy" },
        AGENT_INPUT,
        counted(s),
        d,
      );
      expect(out).toEqual({
        ok: false,
        stage: "explain",
        error: "Seq Scan on records_legacy (cost=0.00..184000000.00)",
        hint: "Indexed paths: zip; ssn; phone; email.",
      });
      expect(d.validation_errors).toEqual(["Seq Scan on records_legacy (cost=0.00..184000000.00)"]);
      expect(d.query_repair_attempts).toBe(1);
      // Contract C: a 422 is a RESULT. It must never reach tool_errors, which is the "the call
      // broke" channel — a refusal the agent can repair is not a broken call.
      expect(d.tool_errors).toEqual([]);
    } finally {
      s.close();
    }
  });

  test("a 500 from /v1/sql stays an error and does NOT become a repairable refusal", async () => {
    // The client widens `accept_statuses` for 422 only. If it ever widened to "any non-2xx", a
    // broken service would present as a refusal the agent repairs forever.
    const s = new FixtureDataService({ sql: {}, status: 500 });
    try {
      const d = new Diagnostics();
      const out = await new SqlToolset().dispatch(
        "run_sql",
        { query: "SELECT 1" },
        AGENT_INPUT,
        counted(s),
        d,
      );
      expect(out["ok"]).toBe(false);
      expect(out["stage"]).toBe("execution");
      expect(String(out["error"])).toMatch(/HTTP 500/);
      expect(d.validation_errors).toEqual([]);
      expect(d.query_repair_attempts).toBe(0);
      expect(d.tool_errors.length).toBe(1);
    } finally {
      s.close();
    }
  });

  test("budget exhaustion flips the terminal envelope and blocks every later data tool", async () => {
    const s = new FixtureDataService({
      sql: { columns: [], rows: [], row_count: 0, truncated: false, plan_cost: 1, duration_ms: 1 },
    });
    try {
      const ts = new SqlToolset();
      const d = new Diagnostics();
      const data = counted(s, 1);
      await ts.dispatch("run_sql", { query: "SELECT 1" }, AGENT_INPUT, data, d);
      const second = await ts.dispatch("run_sql", { query: "SELECT 2" }, AGENT_INPUT, data, d);
      expect(second["stage"]).toBe("budget_exhausted");
      expect(d.data_budget_exhausted).toBe(true);
      const typed = await ts.dispatch("get_tax", { limit: 5 }, AGENT_INPUT, data, d);
      expect(typed["stage"]).toBe("budget_exhausted");
      expect(String(typed["instruction"])).toContain("submit_heuristic_result");
    } finally {
      s.close();
    }
  });

  test("a TYPED tool's budget error is recognised as exhaustion, not a plain tool error", async () => {
    // The load-bearing case for the budget predicate: `data_budget_exhausted` is still FALSE here,
    // so the toolset's top guard cannot short-circuit and the terminal envelope can only come from
    // matching CountingDataClient's real thrown message, routed back as an ok:false payload by
    // retrieval.ts. If the predicate goes stale, this returns the bare {ok:false, error} instead.
    const s = new FixtureDataService({ address_records: TAX_RECORDS });
    try {
      const ts = new SqlToolset();
      const d = new Diagnostics();
      const data = counted(s, 1);
      const first = await ts.dispatch("get_tax", { limit: 5 }, AGENT_INPUT, data, d);
      expect(first["ok"]).toBe(true);
      expect(d.data_budget_exhausted).toBe(false);

      const second = await ts.dispatch("get_tax", { limit: 5 }, AGENT_INPUT, data, d);
      expect(second["stage"]).toBe("budget_exhausted");
      expect(String(second["error"])).toContain("Data call budget exceeded: 1");
      expect(String(second["instruction"])).toContain("submit_heuristic_result");
      expect(d.data_budget_exhausted).toBe(true);
    } finally {
      s.close();
    }
  });
});

describe("describe_schema + get_source_record", () => {
  test("describe_schema returns the formatted curated guide and spends the schema budget", async () => {
    const s = new FixtureDataService({
      schema: {
        tables: [{ name: "property_owner", purpose: "tax rows", key_columns: ["ownername"] }],
        access_paths: [],
        caveats: ["imported_at is a load date, not an observation date"],
      },
    });
    try {
      const data = counted(s);
      const out = await new SqlToolset().dispatch(
        "describe_schema",
        {},
        AGENT_INPUT,
        data,
        new Diagnostics(),
      );
      expect(out["ok"]).toBe(true);
      expect(String(out["schema"])).toContain("property_owner");
      expect(String(out["schema"])).toContain("imported_at is a load date");
      expect(data.schema_tool_calls).toBe(1);
      expect(data.calls).toBe(0);
    } finally {
      s.close();
    }
  });

  test("describe_schema surfaces a schema-budget refusal without flipping data exhaustion", async () => {
    const s = new FixtureDataService({ schema: { tables: [], access_paths: [], caveats: [] } });
    try {
      const ts = new SqlToolset();
      const d = new Diagnostics();
      const data = counted(s);
      const input = { ...AGENT_INPUT, schema_tool_budget: 1 };
      await ts.dispatch("describe_schema", {}, input, data, d);
      const second = await ts.dispatch("describe_schema", {}, input, data, d);
      expect(second["ok"]).toBe(false);
      expect(String(second["error"])).toContain("Schema description tool budget exceeded");
      // The schema budget is a SEPARATE ceiling: exhausting it must not terminate data retrieval.
      expect(d.data_budget_exhausted).toBe(false);
      expect(second["stage"]).toBeUndefined();
    } finally {
      s.close();
    }
  });

  test("get_source_record turns a SQL rowid into a citable evidence row", async () => {
    const s = new FixtureDataService({
      source_record: {
        source: "tax",
        table: "tax",
        rowid: 12,
        record_id: "4001",
        summary: "tax; ownername=DOE, JANE",
        data: { ownername: "DOE, JANE" },
      },
    });
    try {
      const out = await new SqlToolset().dispatch(
        "get_source_record",
        { shape: "tax", rowid: 12 },
        AGENT_INPUT,
        counted(s),
        new Diagnostics(),
      );
      expect(out).toMatchObject({ ok: true, source: "tax", rowid: 12, record_id: "4001" });
    } finally {
      s.close();
    }
  });

  test("get_source_record threads the required address_id (Contract B addendum 1)", async () => {
    // The fixture mirrors the real handler: a naked call is a 400 naming the parameter, checked
    // before the shape. Asserting the recorded query proves the id is threaded, not that the
    // fixture happened to answer.
    const s = new FixtureDataService({
      source_record: { source: "tax", table: "tax", rowid: 12, record_id: "4001", summary: "", data: {} },
    });
    try {
      const out = await new SqlToolset().dispatch(
        "get_source_record",
        { shape: "tax", rowid: 12 },
        AGENT_INPUT,
        counted(s),
        new Diagnostics(),
      );
      expect(out["ok"]).toBe(true);
      const hit = s.requests.find((r) => r.path === "/v1/source-record/tax/12");
      expect(hit?.query?.["address_id"]).toBe("3342");
    } finally {
      s.close();
    }
  });

  test("get_source_record accepts an explicit address_id for a row from another bundle", async () => {
    // A rowid read off an `addr:<addressId>:<n>` person's records is a position in THAT address's
    // bundle, so the subject address is a default, not a constraint.
    const s = new FixtureDataService({
      source_record: { source: "tax", table: "tax", rowid: 3, record_id: "9", summary: "", data: {} },
    });
    try {
      const out = await new SqlToolset().dispatch(
        "get_source_record",
        { shape: "tax", rowid: 3, address_id: 991 },
        AGENT_INPUT,
        counted(s),
        new Diagnostics(),
      );
      expect(out["ok"]).toBe(true);
      const hit = s.requests.find((r) => r.path === "/v1/source-record/tax/3");
      expect(hit?.query?.["address_id"]).toBe("991");
    } finally {
      s.close();
    }
  });

  test("get_source_record rejects a dead shape before spending a call", async () => {
    const s = new FixtureDataService({ source_record: { source: "voter" } });
    try {
      const data = counted(s);
      const out = await new SqlToolset().dispatch(
        "get_source_record",
        { shape: "voter", rowid: 1 },
        AGENT_INPUT,
        data,
        new Diagnostics(),
      );
      expect(out["ok"]).toBe(false);
      expect(String(out["error"])).toContain("voter");
      expect(out["supported_shapes"]).not.toContain("voter");
      expect(data.calls).toBe(0);
      expect(s.requests.length).toBe(0);
    } finally {
      s.close();
    }
  });

  test("an unknown tool name reports the available tools", async () => {
    const s = new FixtureDataService({});
    try {
      const d = new Diagnostics();
      const out = await new SqlToolset().dispatch(
        "execute_graphql",
        {},
        AGENT_INPUT,
        counted(s),
        d,
      );
      expect(out["ok"]).toBe(false);
      expect(String(out["error"])).toBe("Unknown tool: execute_graphql");
      expect(out["available_tools"]).toContain("run_sql");
      expect(d.tool_errors).toEqual(["Unknown tool: execute_graphql"]);
    } finally {
      s.close();
    }
  });
});

describe("describe_call telemetry", () => {
  test("run_sql is described by digest, not by query text", () => {
    const meta = new SqlToolset().describe_call(
      "run_sql",
      { query: "SELECT 1" },
      { ok: false, stage: "parse" },
    );
    expect(meta["query_chars"]).toBe(8);
    expect(meta["refused_stage"]).toBe("parse");
    expect(String(meta["query_sha256"])).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(meta)).not.toContain("SELECT 1");
  });

  test("a typed tool's telemetry is delegated to TypedToolset unchanged", () => {
    const args = { shapes: ["tax"], person_id: "" };
    expect(new SqlToolset().describe_call("get_records", args, {})).toEqual(
      new TypedToolset().describe_call("get_records", args, {}),
    );
  });
});
