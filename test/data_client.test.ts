import { describe, expect, test } from "bun:test";
import {
  CountingDataClient,
  DataClientError,
  DataHttpClient,
  isSqlRefusal,
  rowRowid,
} from "../src/agents/data_client.ts";
import { QueryCache } from "../src/agents/query_cache.ts";
import { MetricsRecorder, makeRunMetricsContext, runWithRecorder } from "../src/observability/recorder.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";

describe("DataHttpClient — the six typed operations", () => {
  test("resolve posts {address, zip} to /v1/resolve", async () => {
    const s = new FixtureDataService({
      resolve: { candidates: [], address_id: 1, source_counts: { tax: 1 }, dropped_counts: { tax: 0 }, tax_timed_out: false, records_by_source: {} },
    });
    try {
      const out = await new DataHttpClient(s.url).resolve("1104 SPRING RUN RD", "40514");
      expect(out.address_id).toBe(1);
      expect(out.source_counts).toEqual({ tax: 1 });
      expect(s.requests[0]).toEqual({ method: "POST", path: "/v1/resolve", body: { address: "1104 SPRING RUN RD", zip: "40514" } });
    } finally {
      s.close();
    }
  });

  test("address_records builds the shapes/limit/offset query string", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: {}, unsupported_shapes: [] } });
    try {
      await new DataHttpClient(s.url).address_records(3342, { shapes: ["tax", "base"], limit: 25, offset: 10 });
      expect(s.requests[0]!.path).toBe("/v1/address/3342/records");
      expect(s.requests[0]!.query).toEqual({ shapes: "tax,base", limit: "25", offset: "10" });
    } finally {
      s.close();
    }
  });

  test("person_records url-encodes a hal: person id", async () => {
    const s = new FixtureDataService({
      person_records: { person: { id: "hal:HAL0001" }, records_by_source: {}, records_timed_out: false, unsupported_shapes: [] },
    });
    try {
      const out = await new DataHttpClient(s.url).person_records("hal:HAL0001", { shapes: ["tax"], limit: 20 });
      expect(out.person.id).toBe("hal:HAL0001");
      expect(s.requests[0]!.path).toBe("/v1/person/hal%3AHAL0001/records");
    } finally {
      s.close();
    }
  });

  test("search_people, address_people and source_record hit their pinned paths", async () => {
    const s = new FixtureDataService({
      people_search: { total_count: 0, has_more: false, results: [] },
      address_people: { total_count: 0, has_more: false, people: [] },
      source_record: { source: "tax", table: "tax", rowid: 0, record_id: "4001", summary: "tax; ownername=DOE", data: {} },
    });
    try {
      const c = new DataHttpClient(s.url);
      await c.search_people("Jane Doe", { limit: 10 });
      await c.address_people(3342, { limit: 25, offset: 0 });
      const rec = await c.source_record("tax", 0, 3342);
      expect(rec.record_id).toBe("4001");
      expect(s.requests.map((r) => r.path)).toEqual(["/v1/people/search", "/v1/address/3342/people", "/v1/source-record/tax/0"]);
      expect(s.requests[0]!.query).toEqual({ name: "Jane Doe", limit: "10" });
    } finally {
      s.close();
    }
  });

  test("source_record threads the required address_id onto the query string", async () => {
    const s = new FixtureDataService({
      source_record: { source: "tax", table: "tax", rowid: 4, record_id: "4001", summary: "tax; ownername=DOE", data: { ownername: "DOE, JANE ANN" } },
    });
    try {
      const rec = await new DataHttpClient(s.url).source_record("tax", 4, 3342);
      expect(rec.rowid).toBe(4);
      expect(s.requests[0]!.query).toEqual({ address_id: "3342" });
    } finally {
      s.close();
    }
  });

  test("the service refuses operation 6 without address_id — so the assertion above is load-bearing", async () => {
    // Contract B addendum 1, mirrored by the fixture: a naked call is a 400 naming the parameter,
    // checked BEFORE the shape. Proven with a raw fetch because the client's signature makes the
    // omission unrepresentable — which is the point.
    const s = new FixtureDataService({
      source_record: { source: "tax", table: "tax", rowid: 4, record_id: "4001", summary: "", data: {} },
    });
    try {
      const naked = await fetch(`${s.url}/v1/source-record/tax/4`);
      expect(naked.status).toBe(400);
      expect(((await naked.json()) as { error: string }).error).toMatch(/address_id is required/);
      const scoped = await fetch(`${s.url}/v1/source-record/tax/4?address_id=3342`);
      expect(scoped.status).toBe(200);
    } finally {
      s.close();
    }
  });

  test("records keep their raw vendor columns; only bundle-sourced ones carry a citable __rowid", async () => {
    const s = new FixtureDataService({
      address_records: {
        records_by_source: {
          tax: {
            total_count: 1,
            has_more: false,
            records: [{ ownername: "DOE, JANE ANN", address: "1104 SPRING RUN RD", __rowid: 4 }],
          },
        },
        unsupported_shapes: ["voter"],
      },
      person_records: {
        person: { id: "hal:HAL0001", identity_confidence: 40.5, is_suspicious: false },
        // hal:-sourced rows are served with with_rowid=False, so they carry no __rowid at all.
        records_by_source: { tax: { total_count: 1, has_more: false, records: [{ ownername: "DOE, JANE ANN" }] } },
        records_timed_out: false,
        unsupported_shapes: [],
      },
    });
    try {
      const c = new DataHttpClient(s.url);
      const addr = await c.address_records(3342, { shapes: ["tax"] });
      const row = addr.records_by_source["tax"]!.records[0]!;
      expect(row["ownername"]).toBe("DOE, JANE ANN");
      expect(rowRowid(row)).toBe(4);
      expect(addr.unsupported_shapes).toEqual(["voter"]);

      const person = await c.person_records("hal:HAL0001", { shapes: ["tax"] });
      expect(person.person.identity_confidence).toBe(40.5);
      expect(person.person.is_suspicious).toBe(false);
      expect(rowRowid(person.records_by_source["tax"]!.records[0]!)).toBeNull();
    } finally {
      s.close();
    }
  });

  test("records_timed_out keeps an empty person-records result distinguishable from a timed-out one", async () => {
    // The two payloads differ in exactly one field, so nothing but the flag can carry the answer.
    for (const timed_out of [false, true]) {
      const s = new FixtureDataService({
        person_records: {
          person: { id: "hal:HAL0001" },
          records_by_source: { tax: { total_count: 0, has_more: false, records: [] } },
          records_timed_out: timed_out,
          unsupported_shapes: [],
        },
      });
      try {
        const out = await new DataHttpClient(s.url).person_records("hal:HAL0001", { shapes: ["tax"] });
        expect(out.records_by_source["tax"]!.records).toEqual([]);
        expect(out.records_timed_out).toBe(timed_out);
      } finally {
        s.close();
      }
    }
  });

  test("a base_url with a trailing slash does not produce a double slash", async () => {
    const s = new FixtureDataService({ schema: { tables: [], access_paths: [], caveats: [] } });
    try {
      await new DataHttpClient(`${s.url}/`).schema();
      expect(s.requests[0]!.path).toBe("/v1/schema");
    } finally {
      s.close();
    }
  });

  test("schema() reads the curated access paths as the service actually names them", async () => {
    const s = new FixtureDataService({
      schema: {
        tables: [{ name: "public.records_legacy", purpose: "Older feeds", key_columns: ["record_id", "zip"] }],
        access_paths: [
          {
            predicate: "zip = $1 AND address ILIKE 'N STREET%'",
            table: "public.records_partitioned",
            index: "per-partition zip btree",
            measured: "173 ms warm, 24 k rows examined",
            hint_key: "zip",
          },
        ],
        caveats: ["imported_at is a load date, not an observation date"],
        limits: { max_rows: 500, max_plan_cost: 2_000_000, max_records_seqscan_cost: 50_000_000, statement_timeout_ms: 20_000 },
      },
    });
    try {
      const out = await new DataHttpClient(s.url).schema();
      expect(out.tables[0]!.key_columns).toEqual(["record_id", "zip"]);
      expect(out.access_paths[0]!.measured).toBe("173 ms warm, 24 k rows examined");
      expect(out.access_paths[0]!.table).toBe("public.records_partitioned");
      expect(out.limits?.max_rows).toBe(500);
    } finally {
      s.close();
    }
  });

  test("a non-2xx status raises DataClientError naming the operation and status", async () => {
    const s = new FixtureDataService({ resolve: {}, status: 500 });
    try {
      const client = new DataHttpClient(s.url);
      await expect(client.resolve("a", "")).rejects.toThrow(/resolve failed: HTTP 500/);
      await expect(client.resolve("a", "")).rejects.toBeInstanceOf(DataClientError);
    } finally {
      s.close();
    }
  });

  test("an oversize response is refused before parsing", async () => {
    const s = new FixtureDataService({ resolve: { candidates: [], address_id: 1, source_counts: {}, dropped_counts: {}, tax_timed_out: false, records_by_source: { pad: "x".repeat(5000) } } });
    try {
      await expect(
        new DataHttpClient(s.url, { max_response_bytes: 1000 }).resolve("a", ""),
      ).rejects.toThrow(/exceeded 1000 bytes/);
    } finally {
      s.close();
    }
  });
});

describe("DataHttpClient — the SQL hatch", () => {
  test("a 200 returns the result rows", async () => {
    const s = new FixtureDataService({ sql: { columns: ["record_id"], rows: [[4001]], row_count: 1, truncated: false, plan_cost: 8.14, duration_ms: 173 } });
    try {
      const out = await new DataHttpClient(s.url).run_sql("SELECT record_id FROM tax LIMIT 1");
      expect("refused" in out).toBe(false);
      expect(out).toMatchObject({ row_count: 1, plan_cost: 8.14 });
      expect(s.requests[0]).toEqual({ method: "POST", path: "/v1/sql", body: { query: "SELECT record_id FROM tax LIMIT 1" } });
    } finally {
      s.close();
    }
  });

  test("a 422 refusal is RETURNED, not thrown — it is the agent's repair signal", async () => {
    const s = new FixtureDataService({ sql: { refused: true, stage: "explain", reason: "Seq Scan on records_legacy", hint: "Indexed paths: zip; ssn; phone; email." } });
    try {
      const out = await new DataHttpClient(s.url).run_sql("SELECT * FROM records_legacy");
      expect(out).toEqual({ refused: true, stage: "explain", reason: "Seq Scan on records_legacy", hint: "Indexed paths: zip; ssn; phone; email." });
    } finally {
      s.close();
    }
  });

  test("only 422 is accepted on the hatch — a 500 from /v1/sql still raises", async () => {
    // Guards the accept_statuses list: widening it to "any non-2xx" would turn a broken service into
    // a refusal the agent would try to repair forever.
    const s = new FixtureDataService({ sql: { detail: "boom" }, status: 500 });
    try {
      await expect(new DataHttpClient(s.url).run_sql("SELECT 1")).rejects.toThrow(/run_sql failed: HTTP 500/);
    } finally {
      s.close();
    }
  });
});

function counted(s: FixtureDataService, max_calls: number, cache: QueryCache | null = null) {
  return new CountingDataClient(new DataHttpClient(s.url), { max_calls, agent_id: "w1", heuristic_id: "h1", cache });
}

describe("CountingDataClient — budget accounting", () => {
  test("counts every typed call and throws the pinned budget message on overrun", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: {}, unsupported_shapes: [] } });
    try {
      const c = counted(s, 2);
      await c.address_records(1, { shapes: ["tax"] });
      await c.address_records(1, { shapes: ["base"] });
      expect(c.calls).toBe(2);
      await expect(c.address_records(1, { shapes: ["loan"] })).rejects.toThrow("Data call budget exceeded: 2");
      // The refused call is NOT counted and NOT sent.
      expect(c.calls).toBe(2);
      expect(s.requests.length).toBe(2);
    } finally {
      s.close();
    }
  });

  test("logs one DataCallLog per call, with the operation and a result summary", async () => {
    const s = new FixtureDataService({ resolve: { candidates: [], address_id: 9, source_counts: { tax: 1 }, dropped_counts: {}, tax_timed_out: false, records_by_source: {} } });
    try {
      const c = counted(s, 4);
      await c.resolve("1104 SPRING RUN RD", "40514");
      expect(c.logs.length).toBe(1);
      expect(c.logs[0]!.operation).toBe("resolve");
      expect(c.logs[0]!.params).toEqual({ address: "1104 SPRING RUN RD", zip: "40514" });
      expect(c.logs[0]!.result_summary).not.toBe("");
      expect(c.logs[0]!.error).toBeNull();
    } finally {
      s.close();
    }
  });

  test("a failed call is logged with its error and still consumes budget", async () => {
    const s = new FixtureDataService({ resolve: {}, status: 500 });
    try {
      const c = counted(s, 4);
      await expect(c.resolve("a", "")).rejects.toThrow(/HTTP 500/);
      expect(c.calls).toBe(1);
      expect(c.logs.length).toBe(1);
      expect(c.logs[0]!.error).toMatch(/HTTP 500/);
    } finally {
      s.close();
    }
  });

  test("schema() spends the SEPARATE schema budget, never the data budget", async () => {
    const s = new FixtureDataService({ schema: { tables: [], access_paths: [], caveats: [] } });
    try {
      const c = counted(s, 1);
      await c.schema({ max_calls: 1 });
      expect(c.schema_tool_calls).toBe(1);
      expect(c.calls).toBe(0);
      await expect(c.schema({ max_calls: 1 })).rejects.toThrow("Schema description tool budget exceeded: 1");
      // The data budget is untouched by either schema call, so a typed op still gets through.
      await expect(c.resolve("a", "")).rejects.toThrow(/no fixture for this route|HTTP 404/);
      expect(c.calls).toBe(1);
    } finally {
      s.close();
    }
  });

  test("a SQL refusal is recorded on refusal_logs, counts against the budget, and does not throw", async () => {
    const s = new FixtureDataService({ sql: { refused: true, stage: "parse", reason: "only one SELECT is allowed", hint: "Remove the ';'." } });
    try {
      const c = counted(s, 4);
      const out = await c.run_sql("SELECT 1; DROP TABLE tax");
      expect(isSqlRefusal(out)).toBe(true);
      expect(c.refusal_logs.length).toBe(1);
      expect(c.refusal_logs[0]!.stage).toBe("parse");
      expect(c.refusal_logs[0]!.reason).toBe("only one SELECT is allowed");
      expect(c.calls).toBe(1);
      // The refusal is a RESULT, so it is logged as one: the log carries no error.
      expect(c.logs[0]!.error).toBeNull();
      expect(c.logs[0]!.result_summary).toBe("refused at parse: only one SELECT is allowed");
      // The raw SQL never reaches the log or the telemetry — only its digest and length.
      expect(c.logs[0]!.params).toEqual({
        query_sha256: expect.any(String),
        query_chars: "SELECT 1; DROP TABLE tax".length,
      });
    } finally {
      s.close();
    }
  });

  test("the shared QueryCache coalesces identical calls and spends budget only once per execution", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: {}, unsupported_shapes: [] } });
    try {
      const cache = new QueryCache();
      const c = counted(s, 4, cache);
      await c.address_records(1, { shapes: ["tax"], limit: 25 });
      await c.address_records(1, { shapes: ["tax"], limit: 25 });
      expect(cache.executed).toBe(1);
      expect(cache.hits).toBe(1);
      expect(s.requests.length).toBe(1);
    } finally {
      s.close();
    }
  });

  test("the cache keys source_record on the address too — a rowid is meaningless without it", async () => {
    const s = new FixtureDataService({
      source_record: { source: "tax", table: "tax", rowid: 0, record_id: "4001", summary: "", data: {} },
    });
    try {
      const cache = new QueryCache();
      const c = counted(s, 4, cache);
      await c.source_record("tax", 0, 3342);
      await c.source_record("tax", 0, 9999);
      expect(cache.executed).toBe(2);
      expect(s.requests.map((r) => r.query)).toEqual([{ address_id: "3342" }, { address_id: "9999" }]);
    } finally {
      s.close();
    }
  });
});

describe("CountingDataClient — telemetry", () => {
  test("emits one data_call event per call and rolls them up onto the renamed counters", async () => {
    const s = new FixtureDataService({
      address_records: { records_by_source: {}, unsupported_shapes: [] },
      sql: { refused: true, stage: "explain", reason: "Seq Scan on records_legacy", hint: "Indexed paths: zip." },
      schema: { tables: [], access_paths: [], caveats: [] },
    });
    try {
      const recorder = new MetricsRecorder(makeRunMetricsContext({ run_id: "run-1" }), { enabled: true });
      await runWithRecorder(recorder, async () => {
        const c = counted(s, 4);
        await c.address_records(1, { shapes: ["tax"] });
        await c.run_sql("SELECT * FROM records_legacy");
        await c.schema({ max_calls: 2 });
      });
      const events = recorder.events();
      expect(events.map((e) => e.event_type)).toEqual(["data_call", "data_call", "data_call"]);
      expect(events.map((e) => e.phase)).toEqual(["data_op", "data_sql", "data_schema"]);
      expect(events.map((e) => e.status)).toEqual(["ok", "refused", "ok"]);
      expect(events[0]!.agent_id).toBe("w1");
      expect(events[0]!.heuristic_id).toBe("h1");

      const summary = recorder.summary();
      expect(summary.data_call_count).toBe(2); // the typed op + the hatch call
      expect(summary.sql_refusal_count).toBe(1);
      expect(summary.data_schema_call_count).toBe(1);
      // A refusal is the agent's repair signal, not a failure of the data layer.
      expect(summary.data_error_count).toBe(0);
    } finally {
      s.close();
    }
  });

  test("a failed call rolls up onto data_error_count, not sql_refusal_count", async () => {
    const s = new FixtureDataService({ address_records: {}, status: 500 });
    try {
      const recorder = new MetricsRecorder(makeRunMetricsContext({ run_id: "run-1" }), { enabled: true });
      await runWithRecorder(recorder, async () => {
        await expect(counted(s, 4).address_records(1, {})).rejects.toThrow(/HTTP 500/);
      });
      const summary = recorder.summary();
      expect(summary.data_error_count).toBe(1);
      expect(summary.sql_refusal_count).toBe(0);
      expect(summary.data_call_count).toBe(1);
    } finally {
      s.close();
    }
  });
});
