import { describe, expect, test } from "bun:test";
import { ScriptedChatModel } from "./scripted_llm.ts";
import { FixtureDataService } from "./fixture_data_service.ts";
import { people1104, resolve1104, sparseResolvePayload } from "./fixtures.ts";

describe("ScriptedChatModel", () => {
  test("bindTools returns an invocable that yields the scripted batch, then throws when exhausted", async () => {
    const m = new ScriptedChatModel([[{ name: "submit_x", args: { a: 1 } }]]);
    const bound = m.bindTools([{}]);
    const r = await bound.invoke([], {});
    expect(r.tool_calls).toEqual([{ name: "submit_x", args: { a: 1 }, id: "call_submit_x_0", type: "tool_call" }]);
    expect(r.usage_metadata).toBeDefined();
    await expect(bound.invoke([], {})).rejects.toThrow(/exhausted/);
  });
});

describe("FixtureDataService", () => {
  test("serves POST /v1/resolve and records the request", async () => {
    const s = new FixtureDataService({
      resolve: { address_id: 7, candidates: [], source_counts: { tax: 1 }, dropped_counts: {}, tax_timed_out: false, records_by_source: {} },
    });
    try {
      const r = await fetch(`${s.url}/v1/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: "1104 SPRING RUN RD", zip: "40514" }),
      });
      expect(await r.json()).toMatchObject({ address_id: 7 });
      expect(s.requests).toEqual([{ method: "POST", path: "/v1/resolve", body: { address: "1104 SPRING RUN RD", zip: "40514" } }]);
    } finally {
      s.close();
    }
  });

  test("serves a 422 SQL refusal with the pinned refusal body", async () => {
    const s = new FixtureDataService({
      sql: { refused: true, stage: "explain", reason: "Seq Scan on records_legacy (cost=0.00..184000000.00)", hint: "Indexed paths: zip; ssn; phone; email." },
    });
    try {
      const r = await fetch(`${s.url}/v1/sql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "SELECT * FROM records_legacy" }),
      });
      expect(r.status).toBe(422);
      expect((await r.json()) as Record<string, unknown>).toMatchObject({ refused: true, stage: "explain" });
    } finally {
      s.close();
    }
  });

  test("404s an unknown path", async () => {
    const s = new FixtureDataService({});
    try {
      expect((await fetch(`${s.url}/graphql`, { method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      s.close();
    }
  });

  // Contract B addendum 1. rowid is a position within ONE address's rows for a shape, so the real
  // service (handlers.source_record) refuses a naked call with 400 before it even checks the shape.
  // A fixture that answered anyway could not catch a client that forgot to thread address_id.
  test("operation 6 requires ?address_id= and 400s without it, recording the query when present", async () => {
    const s = new FixtureDataService({ source_record: { source: "tax", table: "tax", rowid: 3, record_id: "t9", summary: "", data: {} } });
    try {
      const naked = await fetch(`${s.url}/v1/source-record/tax/3`);
      expect(naked.status).toBe(400);
      expect((await naked.json()) as Record<string, unknown>).toMatchObject({ error: expect.stringContaining("address_id") });

      const scoped = await fetch(`${s.url}/v1/source-record/tax/3?address_id=7`);
      expect(scoped.status).toBe(200);
      expect(await scoped.json()).toMatchObject({ rowid: 3 });
      expect(s.requests[1]).toEqual({ method: "GET", path: "/v1/source-record/tax/3", query: { address_id: "7" } });
    } finally {
      s.close();
    }
  });

  // Contract B addenda 2 and 3. The fixture is a verbatim pass-through, so these two additive fields
  // reach the client byte-for-byte rather than being normalised away by the fixture.
  test("passes __rowid and records_timed_out through untouched", async () => {
    const s = new FixtureDataService({
      address_records: { records_by_source: { tax: { totalCount: 1, hasMore: false, records: [{ ownername: "SMITH JOHN", __rowid: 0 }] } }, dropped_counts: { tax: 2 }, tax_timed_out: true },
      person_records: { records_by_source: {}, records_timed_out: true },
    });
    try {
      const rec = (await (await fetch(`${s.url}/v1/address/7/records?shapes=tax&limit=5&offset=0`)).json()) as any;
      expect(rec.records_by_source.tax.records[0].__rowid).toBe(0);
      expect(rec.records_by_source.tax.records[0].ownername).toBe("SMITH JOHN"); // raw vendor column, untidied
      expect(rec.dropped_counts).toEqual({ tax: 2 });
      expect(rec.tax_timed_out).toBe(true);
      expect(s.requests[0]!.query).toEqual({ shapes: "tax", limit: "5", offset: "0" });

      const per = (await (await fetch(`${s.url}/v1/person/hal:abc123/records?shapes=tax&limit=5`)).json()) as any;
      expect(per.records_timed_out).toBe(true);
    } finally {
      s.close();
    }
  });

  // The real service routes /v1/address/{address_id:int} and /v1/source-record/{shape}/{rowid:int}
  // with Starlette's int converter, so a non-numeric id does not match the route at all.
  test("mirrors the int path converters: a non-numeric address id is a 404, not a match", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: {} }, address_people: { people: [] } });
    try {
      expect((await fetch(`${s.url}/v1/address/abc/records`)).status).toBe(404);
      expect((await fetch(`${s.url}/v1/address/7/people?limit=10`)).status).toBe(200);
    } finally {
      s.close();
    }
  });

  test("an unfixtured but pinned route 404s rather than answering empty", async () => {
    const s = new FixtureDataService({ resolve: { address_id: 1 } });
    try {
      expect((await fetch(`${s.url}/v1/schema`)).status).toBe(404);
      expect((await fetch(`${s.url}/v1/people/search?name=SMITH&limit=5`)).status).toBe(404);
    } finally {
      s.close();
    }
  });

  test("status forces an error status on a matched route", async () => {
    const s = new FixtureDataService({ resolve: { error: "boom" }, status: 500 });
    try {
      expect((await fetch(`${s.url}/v1/resolve`, { method: "POST", body: "{}" })).status).toBe(500);
    } finally {
      s.close();
    }
  });
});

// These guard the fixture against the ONE failure mode a capture-free fixture has: drifting away
// from the response the service actually serves, with nothing to diff it against. Each assertion
// pins a property of handlers.resolve_address / records.records_block, not just a value.
describe("fixtures", () => {
  test("resolve_1104 is a Contract-B resolve body for the real case", () => {
    const p = resolve1104() as any;
    expect(p.address_id).toBe(3342);
    expect(Object.keys(p).sort()).toEqual([
      "address_id",
      "candidates",
      "dropped_counts",
      "records_by_source",
      "source_counts",
      "tax_timed_out",
    ]);
    // records_by_source covers every live shape, and only those: voter/criminal/linkedin are gone.
    expect(Object.keys(p.records_by_source).sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
    expect(Object.keys(p.source_counts).sort()).toEqual(Object.keys(p.records_by_source).sort());
    // handlers._candidate: relation_count IS sum(source_counts.values()).
    const summed = Object.values(p.source_counts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(p.candidates[0].relation_count).toBe(summed);
  });

  test("records are RAW vendor rows stamped with __rowid, not {table,rowid,data} envelopes", () => {
    const tax = (resolve1104() as any).records_by_source.tax.records[0];
    expect(tax.ownername).toBe("CORRELL, REBECCA CHRISTINE; CORRELL, JOSIAH STEEL"); // raw column, untidied
    expect(tax.__rowid).toBe(0); // bundle position, so the first row is 0 — never a database rowid
    expect(tax.data).toBeUndefined();
    expect(tax.table).toBeUndefined();
  });

  test("every block's paging arithmetic matches records_block at limit 10, offset 0", () => {
    for (const [shape, block] of Object.entries((resolve1104() as any).records_by_source) as [string, any][]) {
      expect(block.records.length).toBe(Math.min(block.total_count, 10));
      expect(block.has_more).toBe(block.records.length < block.total_count);
      expect(block.records.map((r: any) => r.__rowid)).toEqual(block.records.map((_: unknown, i: number) => i));
      expect(block.total_count).toBe((resolve1104() as any).source_counts[shape]);
    }
    expect((resolve1104() as any).records_by_source.utility.has_more).toBe(true); // 15 rows, page of 10
  });

  test("people1104 is an operation-3 body: clustered, sorted, and with no hal identity", () => {
    const p = people1104() as any;
    expect(p.people.length).toBe(10);
    expect(p.has_more).toBe(p.people.length < p.total_count);
    expect(p.people.map((x: any) => x.norm_name_key)).toEqual([...p.people.map((x: any) => x.norm_name_key)].sort());
    expect(p.people.map((x: any) => x.id)).toEqual(p.people.map((_: unknown, i: number) => `addr:3342:${i}`));
    // handlers._PERSON_KEYS omits both — an addr:-clustered person has no hal identity to score.
    expect(p.people.every((x: any) => !("identity_confidence" in x) && !("is_suspicious" in x))).toBe(true);
    // sources is the shapes the cluster was drawn from, so it is not uniformly "base".
    expect(p.people.find((x: any) => x.norm_name_key === "jessica|whisman").sources).toEqual(["base", "trace"]);
    expect(p.people.find((x: any) => x.norm_name_key === "amy|wilson").sources).toEqual(["utility"]);
  });

  test("sparse payload has zero-count sources", () => {
    const p = sparseResolvePayload() as any;
    expect(p.source_counts.tax).toBe(0);
    expect(Object.values(p.records_by_source as Record<string, any>).every((b) => b.records.length === 0)).toBe(true);
  });
});
