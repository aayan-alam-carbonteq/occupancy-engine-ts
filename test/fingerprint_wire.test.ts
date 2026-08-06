import { describe, expect, test } from "bun:test";
import { MAX_FINGERPRINT_ITEMS, parse_fingerprint_request } from "../src/fingerprint/wire.ts";

describe("parse_fingerprint_request", () => {
  test("accepts the pinned batch shape and preserves order", () => {
    const result = parse_fingerprint_request({
      items: [
        { address: "1104 Spring Run Rd", zip: "40514" },
        { address: "22 Elm St" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.items.length).toBe(2);
    expect(result.request.items[0]!.address).toBe("1104 Spring Run Rd");
    expect(result.request.items[0]!.zip).toBe("40514");
    expect(result.request.items[1]!.address).toBe("22 Elm St");
    expect(result.request.items[1]!.zip).toBeNull(); // omitted zip is null, not undefined
  });

  test("accepts an explicit null zip (the backend may send one)", () => {
    const result = parse_fingerprint_request({ items: [{ address: "22 Elm St", zip: null }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.items[0]!.zip).toBeNull();
  });

  test("rejects a missing address, with the zod path", () => {
    const result = parse_fingerprint_request({ items: [{ zip: "40514" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.startsWith("items.0.address:"))).toBe(true);
  });

  test("rejects an empty address", () => {
    expect(parse_fingerprint_request({ items: [{ address: "" }] }).ok).toBe(false);
  });

  test("rejects unknown keys (strict) at both levels", () => {
    const item = parse_fingerprint_request({ items: [{ address: "a", model: "claude-haiku-4-5" }] });
    expect(item.ok).toBe(false);
    const root = parse_fingerprint_request({ items: [{ address: "a" }], model: "claude-haiku-4-5" });
    expect(root.ok).toBe(false);
  });

  test("rejects an empty batch and one over the cap", () => {
    expect(parse_fingerprint_request({ items: [] }).ok).toBe(false);
    const tooMany = { items: Array.from({ length: MAX_FINGERPRINT_ITEMS + 1 }, () => ({ address: "a" })) };
    expect(parse_fingerprint_request(tooMany).ok).toBe(false);
    const atCap = { items: Array.from({ length: MAX_FINGERPRINT_ITEMS }, () => ({ address: "a" })) };
    expect(parse_fingerprint_request(atCap).ok).toBe(true);
  });

  test("rejects a non-object body with a (root) path", () => {
    const result = parse_fingerprint_request("nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.startsWith("(root):"))).toBe(true);
  });
});
