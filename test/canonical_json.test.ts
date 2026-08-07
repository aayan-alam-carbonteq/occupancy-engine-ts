import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "../src/fingerprint/canonical.ts";
import { QueryCache } from "../src/agents/query_cache.ts";

describe("canonicalJson", () => {
  test("object key order does not matter, at any depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("array ORDER is preserved — it is data, not noise", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("keys inside array members are sorted too", () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  test("null and empty containers survive verbatim", () => {
    expect(canonicalJson({ a: null, b: [], c: {} })).toBe('{"a":null,"b":[],"c":{}}');
  });
});

describe("sha256Hex", () => {
  test("matches the published sha256 vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("is 64 lowercase hex characters", () => {
    expect(/^[0-9a-f]{64}$/.test(sha256Hex(""))).toBe(true);
  });
});

describe("QueryCache still uses the shared canonicalizer", () => {
  test("identical queries whose variables differ only in KEY ORDER are one execution", async () => {
    const cache = new QueryCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return { ok: true };
    };
    await cache.get_or_execute("query Q { a }", { b: 1, a: 2 }, factory);
    await cache.get_or_execute("query Q { a }", { a: 2, b: 1 }, factory);
    expect(calls).toBe(1);
    expect(cache.hits).toBe(1);
  });
});
