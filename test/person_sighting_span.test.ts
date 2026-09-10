import { describe, expect, test } from "bun:test";
import { PersonEvidenceSummarySchema } from "../src/agents/models.ts";

describe("X-083 — per-person sighting span on the evidence map", () => {
  test("a person with no span parses with explicit nulls — undated, never a guessed date", () => {
    const p = PersonEvidenceSummarySchema.parse({ name: "X", relationship_to_owner: "unrelated", sources: ["utility"] });
    expect(p.first_seen).toBeNull();
    expect(p.last_seen).toBeNull();
  });

  test("a YYYYMM span round-trips", () => {
    const p = PersonEvidenceSummarySchema.parse({
      name: "BRENT MUSIC", relationship_to_owner: "unrelated", sources: ["trace"],
      first_seen: "200101", last_seen: "202504",
    });
    expect([p.first_seen, p.last_seen]).toEqual(["200101", "202504"]);
  });

  test("the schema stays strict — an unrelated extra key is still rejected", () => {
    expect(() => PersonEvidenceSummarySchema.parse({ name: "X", rows: [] })).toThrow();
  });
});
