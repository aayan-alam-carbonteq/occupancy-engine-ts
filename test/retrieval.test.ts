import { describe, expect, test } from "bun:test";
import { CountingDataClient, DataHttpClient } from "../src/agents/data_client.ts";
import {
  ADDRESS_SHAPES,
  PERSON_SHAPES,
  SOURCE_DATA_FIELDS,
  fetch_address_records,
  fetch_address_records_multi,
  fetch_people_at_address,
  fetch_person_records,
  fetch_search_people,
} from "../src/agents/retrieval.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";

function counted(s: FixtureDataService) {
  return new CountingDataClient(new DataHttpClient(s.url), { max_calls: 8 });
}

// A record block exactly as service/records.records_block serves it: the RAW vendor row plus the
// `__rowid` stamp. There is no {table, rowid, data} wrapper — the vendor column names ARE the keys.
const TAX_BLOCK = {
  total_count: 1,
  has_more: false,
  records: [
    {
      __rowid: 12,
      id: "4001",
      ownername: "DOE, JANE",
      owneraddressline1: "3360 RAVINIA CIR",
      ownerstate: "IL",
      junk: "drop me",
      __norm_lastname: "doe",
    },
  ],
};

const EMPTY_TAX_BLOCK = { total_count: 0, has_more: false, records: [] };

describe("shape catalogue", () => {
  test("only the seven live shapes remain; voter/criminal/linkedin are gone", () => {
    expect([...ADDRESS_SHAPES].sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
    expect([...PERSON_SHAPES].sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace"]);
    expect(Object.keys(SOURCE_DATA_FIELDS).sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
  });

  test("the surviving per-shape projections are unchanged (raw vendor column names)", () => {
    expect(SOURCE_DATA_FIELDS["utility"]).toEqual(["first_name", "last_name", "middle_name", "dob", "dod", "address", "city", "state", "zip", "phone"]);
    expect(SOURCE_DATA_FIELDS["trace"]).toContain("dob_day");
    expect(SOURCE_DATA_FIELDS["tax"]).toContain("ownername");
  });
});

describe("fetch_address_records", () => {
  test("calls op 2 for one shape and projects the raw row with SOURCE_DATA_FIELDS", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: { tax: TAX_BLOCK }, unsupported_shapes: [] } });
    try {
      const out = await fetch_address_records(counted(s), 3342, "tax", { limit: 20, offset: 0 });
      expect(out["ok"]).toBe(true);
      expect(out["totalCount"]).toBe(1);
      expect(out["hasMore"]).toBe(false);
      const row = (out["records"] as Record<string, any>[])[0]!;
      expect(row["source"]).toBe("tax");
      expect(row["table"]).toBe("tax");
      expect(row["rowid"]).toBe(12);
      // `junk`, `__rowid` and the `__norm_*` helpers are all outside SOURCE_DATA_FIELDS["tax"].
      expect(row["data"]).toEqual({ id: "4001", ownername: "DOE, JANE", owneraddressline1: "3360 RAVINIA CIR", ownerstate: "IL" });
      expect(row["summary"]).toContain("ownername=DOE, JANE");
      expect(s.requests[0]!.query).toEqual({ shapes: "tax", limit: "20", offset: "0" });
    } finally {
      s.close();
    }
  });

  test("a row with no __rowid is null, never 0; __rowid 0 is a real citable position", async () => {
    const s = new FixtureDataService({
      address_records: {
        records_by_source: {
          tax: {
            total_count: 2,
            has_more: false,
            // A hal:-sourced / clustered row is served with no bundle position, or an explicit null.
            records: [{ id: "a", ownername: "NO ROWID" }, { __rowid: 0, id: "b", ownername: "ROW ZERO" }],
          },
        },
        unsupported_shapes: [],
      },
    });
    try {
      const out = await fetch_address_records(counted(s), 3342, "tax");
      const rows = out["records"] as Record<string, any>[];
      expect(rows[0]!["rowid"]).toBe(null);
      expect(rows[1]!["rowid"]).toBe(0);
    } finally {
      s.close();
    }
  });

  test("rejects a shape the corpus does not have, naming the live shapes, without calling the service", async () => {
    const s = new FixtureDataService({});
    try {
      const out = await fetch_address_records(counted(s), 1, "voter");
      expect(out["ok"]).toBe(false);
      expect(out["error"]).toBe("Unsupported address shape: voter");
      expect(out["supported_shapes"]).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
      // The rejection must be local. If `voter` were still live this would be an HTTP 404 instead,
      // which also yields ok:false — the request count is what makes this assertion mean anything.
      expect(s.requests.length).toBe(0);
    } finally {
      s.close();
    }
  });
});

describe("fetch_address_records_multi / people / person / search", () => {
  test("multi passes every requested shape in one call and forwards unsupported_shapes", async () => {
    const s = new FixtureDataService({ address_records: { records_by_source: { tax: TAX_BLOCK }, unsupported_shapes: ["voter"] } });
    try {
      const out = await fetch_address_records_multi(counted(s), 3342, { sources: ["tax", "voter"], limit: 25 });
      expect(out["ok"]).toBe(true);
      expect(Object.keys(out["records_by_source"] as object)).toEqual(["tax"]);
      expect(out["unsupported_sources"]).toEqual(["voter"]);
      expect(s.requests.length).toBe(1);
      expect(s.requests[0]!.query).toEqual({ shapes: "tax", limit: "25", offset: "0" });
    } finally {
      s.close();
    }
  });

  test("people surfaces identity_confidence and is_suspicious, including a false flag", async () => {
    const s = new FixtureDataService({
      address_people: {
        total_count: 1,
        has_more: false,
        people: [{ id: "hal:HAL0001", firstname: "JANE", lastname: "DOE", full_name: "JANE DOE", identity_confidence: 40.5, is_suspicious: false }],
      },
    });
    try {
      const out = await fetch_people_at_address(counted(s), 3342, { limit: 25 });
      const p = (out["people"] as Record<string, any>[])[0]!;
      expect(p["identity_confidence"]).toBe(40.5);
      // `false` is a VERDICT, not an empty value — the compaction filter must not drop it.
      expect(p["is_suspicious"]).toBe(false);
    } finally {
      s.close();
    }
  });

  test("person_records requires an id and calls op 4", async () => {
    const s = new FixtureDataService({ person_records: { person: { id: "addr:1:0", firstname: "JANE" }, records_by_source: { tax: TAX_BLOCK }, records_timed_out: false, unsupported_shapes: [] } });
    try {
      const blank = await fetch_person_records(counted(s), "  ");
      expect(blank["ok"]).toBe(false);
      expect(s.requests.length).toBe(0);
      const out = await fetch_person_records(counted(s), "addr:1:0", { sources: ["tax"], limit: 20 });
      expect(out["ok"]).toBe(true);
      expect((out["person"] as Record<string, any>)["id"]).toBe("addr:1:0");
      expect(s.requests[0]!.path).toBe("/v1/person/addr%3A1%3A0/records");
    } finally {
      s.close();
    }
  });

  test("search_people maps op 5 results into the record envelope", async () => {
    const s = new FixtureDataService({
      people_search: {
        total_count: 1,
        has_more: false,
        results: [
          {
            id: "hal:HAL0001",
            firstname: "JANE",
            lastname: "DOE",
            full_name: "JANE DOE",
            match_score: 1.0,
            record_count: 3,
            identity_confidence: 40.5,
            is_suspicious: false,
            address_line1: "3360 RAVINIA CIR",
            city: "MISSISSAUGA",
            state: "IL",
            zip: "60010",
          },
        ],
      },
    });
    try {
      const out = await fetch_search_people(counted(s), "Jane Doe", { limit: 10 });
      expect(out["count"]).toBe(1);
      expect((out["records"] as Record<string, any>[])[0]).toMatchObject({ id: "hal:HAL0001", match_score: 1.0, identity_confidence: 40.5, is_suspicious: false });
    } finally {
      s.close();
    }
  });

  test("search_people keeps the entity's canonical address — that IS the owner-elsewhere answer", async () => {
    const s = new FixtureDataService({
      people_search: {
        total_count: 1,
        has_more: false,
        results: [{ id: "hal:HAL0001", firstname: "JANE", lastname: "DOE", match_score: 1.0, record_count: 3, address_line1: "3360 RAVINIA CIR", city: "MISSISSAUGA", state: "IL", zip: "60010" }],
      },
    });
    try {
      const out = await fetch_search_people(counted(s), "Jane Doe");
      expect((out["records"] as Record<string, any>[])[0]).toMatchObject({
        address_line1: "3360 RAVINIA CIR",
        city: "MISSISSAUGA",
        state: "IL",
        zip: "60010",
      });
    } finally {
      s.close();
    }
  });
});

// Contract B addendum 3. `records_timed_out` is the one unindexed hop in the typed surface, and the
// natural `records.length === 0 -> "no records elsewhere"` reading is exactly the failure mode that
// would quietly break owner-elsewhere detection. A timeout must reach the model as STATED ABSENCE.
describe("fetch_person_records — records_timed_out", () => {
  test("a timed-out lookup states the gap instead of reporting an empty result", async () => {
    const s = new FixtureDataService({
      person_records: { person: { id: "hal:HAL0001", firstname: "JANE" }, records_by_source: { tax: EMPTY_TAX_BLOCK }, records_timed_out: true, unsupported_shapes: [] },
    });
    try {
      const out = await fetch_person_records(counted(s), "hal:HAL0001", { sources: ["tax"] });
      expect(out["ok"]).toBe(true);
      expect(out["records_timed_out"]).toBe(true);
      const gaps = out["data_gaps"] as string[];
      expect(gaps.length).toBe(1);
      expect(gaps[0]).toContain("timed out");
      expect(gaps[0]).toContain("hal:HAL0001");
      // The block IS empty. That silence is what the gap exists to break, so the envelope must
      // carry both: zero rows AND the reason they may be missing.
      expect((out["records_by_source"] as Record<string, any>)["tax"]["totalCount"]).toBe(0);
    } finally {
      s.close();
    }
  });

  test("an honestly-empty lookup emits no gap", async () => {
    // The control for the test above: without it, `data_gaps` could be emitted unconditionally and
    // the timeout assertion would pass for the wrong reason.
    const s = new FixtureDataService({
      person_records: { person: { id: "hal:HAL0001", firstname: "JANE" }, records_by_source: { tax: EMPTY_TAX_BLOCK }, records_timed_out: false, unsupported_shapes: [] },
    });
    try {
      const out = await fetch_person_records(counted(s), "hal:HAL0001", { sources: ["tax"] });
      expect(out["ok"]).toBe(true);
      expect(out["records_timed_out"]).toBe(false);
      expect(out["data_gaps"]).toBeUndefined();
    } finally {
      s.close();
    }
  });
});
