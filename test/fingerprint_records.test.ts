import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "../src/fingerprint/canonical.ts";
import {
  records_fingerprint,
  sort_records,
  type NormalizedRecord,
} from "../src/fingerprint/data_source_probe.ts";

function record(overrides: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return {
    scope: "address",
    subject_id: "3342",
    source: "tax",
    table: "tax",
    rowid: 1,
    data: { ownername: "WHISMAN JESSICA", zip: "40514" },
    ...overrides,
  };
}

describe("records_fingerprint", () => {
  test("is independent of the order the source returned rows in", () => {
    const a = record();
    const b = record({ source: "base", table: "base", rowid: 2, data: { firstname: "JESSICA" } });
    const c = record({ scope: "person", subject_id: "cd146804", source: "voter", table: "voter", rowid: 9 });
    expect(records_fingerprint([a, b, c])).toBe(records_fingerprint([c, a, b]));
    expect(records_fingerprint([a, b, c])).toBe(records_fingerprint([b, c, a]));
  });

  test("is independent of key order inside data", () => {
    const a = record({ data: { ownername: "X", zip: "40514" } });
    const b = record({ data: { zip: "40514", ownername: "X" } });
    expect(records_fingerprint([a])).toBe(records_fingerprint([b]));
  });

  test("changes when ANY field of ANY record changes", () => {
    const base = records_fingerprint([record()]);
    expect(records_fingerprint([record({ scope: "person" })])).not.toBe(base);
    expect(records_fingerprint([record({ subject_id: "9999" })])).not.toBe(base);
    expect(records_fingerprint([record({ source: "base" })])).not.toBe(base);
    expect(records_fingerprint([record({ table: "tax_v2" })])).not.toBe(base);
    expect(records_fingerprint([record({ rowid: 2 })])).not.toBe(base);
    expect(records_fingerprint([record({ rowid: null })])).not.toBe(base);
    expect(records_fingerprint([record({ data: { ownername: "SOMEONE ELSE", zip: "40514" } })])).not.toBe(base);
  });

  test("changes when a record is added or removed", () => {
    const one = records_fingerprint([record()]);
    const two = records_fingerprint([record(), record({ rowid: 2 })]);
    expect(two).not.toBe(one);
  });

  test("an empty record set is a REAL state with a stable hash, not an error", () => {
    expect(records_fingerprint([])).toBe(sha256Hex("[]"));
    expect(records_fingerprint([])).toBe(records_fingerprint([]));
  });

  test("is exactly sha256(canonicalJson(sorted records)) — no hidden salt", () => {
    const records = [record({ rowid: 2 }), record()];
    expect(records_fingerprint(records)).toBe(sha256Hex(canonicalJson(sort_records(records))));
  });
});

describe("sort_records", () => {
  test("does not mutate its input", () => {
    const input = [record({ rowid: 2 }), record({ rowid: 1 })];
    const snapshot = canonicalJson(input);
    sort_records(input);
    expect(canonicalJson(input)).toBe(snapshot);
  });
});
