import { describe, expect, test } from "bun:test";
import { derive_corroboration } from "../src/agents/orchestrator.ts";
import { CaseAdjudicationSchema, type CaseAdjudication } from "../src/agents/models.ts";

// Parsed through the REAL schema, not cast: a cast erases all checking, so a new required field
// or a changed range would drift silently while these tests stayed green.
const adj = (occupancy_signal: string, nonowner_occupancy_strength: number): CaseAdjudication =>
  CaseAdjudicationSchema.parse({
    raw_score: 4,
    verdict_band: "review",
    case_archetype: "mixed_evidence",
    score_adjustments: [],
    reasoning_summary: "r",
    why_not_higher: [],
    why_not_lower: [],
    records_read: {
      occupancy_signal,
      nonowner_occupancy_strength,
      reasoning: "r",
      driving_heuristic_ids: [],
    },
  });

describe("X-078 derive_corroboration", () => {
  test("no scan_claim -> null (blind run: nothing to compare against)", () => {
    expect(derive_corroboration(adj("non_owner_occupancy", 8), null)).toBeNull();
    expect(derive_corroboration(adj("non_owner_occupancy", 8), undefined)).toBeNull();
  });

  test("no_signal -> null, NOT 50 — silence is not a midpoint finding", () => {
    // A 50 here would render as a real reading ("the records land exactly between") on a property
    // where the records said nothing at all. Absence of evidence is not evidence of balance.
    expect(derive_corroboration(adj("no_signal", 5), { verdict: "rented" })).toBeNull();
    expect(derive_corroboration(adj("no_signal", 0), { verdict: "not-rented" })).toBeNull();
  });

  test("scan asserts non-owner use -> strength maps straight through", () => {
    for (const verdict of ["rented", "possibly-rented"] as const) {
      expect(derive_corroboration(adj("non_owner_occupancy", 8), { verdict })!.agreement).toBe(80);
      expect(derive_corroboration(adj("owner_occupancy", 2), { verdict })!.agreement).toBe(20);
    }
  });

  test("scan asserts owner occupancy -> the axis mirrors", () => {
    const v = { verdict: "not-rented" } as const;
    expect(derive_corroboration(adj("owner_occupancy", 2), v)!.agreement).toBe(80);
    expect(derive_corroboration(adj("non_owner_occupancy", 8), v)!.agreement).toBe(20);
  });

  test("THE case the old design could not express: no listing, but records show non-owner use", () => {
    const r = derive_corroboration(adj("non_owner_occupancy", 9), { verdict: "not-rented" })!;
    expect([r.agreement, r.state]).toEqual([10, "contradicted"]);
  });

  test("state is banded from the SAME figure — they can never disagree", () => {
    const v = { verdict: "rented" } as const;
    for (let s = 0; s <= 10; s++) {
      const r = derive_corroboration(adj("conflicting", s), v)!;
      const expected = r.agreement >= 67 ? "corroborated" : r.agreement <= 33 ? "contradicted" : "mixed";
      expect([s, r.state]).toEqual([s, expected]);
    }
  });

  test("band boundaries land where the spec says", () => {
    const v = { verdict: "rented" } as const;
    expect(derive_corroboration(adj("conflicting", 3), v)!.state).toBe("contradicted"); // 30
    expect(derive_corroboration(adj("conflicting", 4), v)!.state).toBe("mixed"); // 40
    expect(derive_corroboration(adj("conflicting", 6), v)!.state).toBe("mixed"); // 60
    expect(derive_corroboration(adj("conflicting", 7), v)!.state).toBe("corroborated"); // 70
  });

  test("echoes the verdict it was compared against, so a report is self-describing", () => {
    expect(derive_corroboration(adj("conflicting", 5), { verdict: "possibly-rented" })!.scan_verdict).toBe(
      "possibly-rented",
    );
  });

  test("possibly-rented reaches the extremes — a hedged verdict can still read as certainty", () => {
    // Grouped with `rented` because agreement measures DIRECTION, not the scan's own confidence.
    // The consequence, pinned so it is a known property rather than a surprise: a HEDGED verdict
    // can still produce 100/"corroborated" or 0/"contradicted". Consumers that care are expected to
    // read the echoed scan_verdict, which is why it is on the block at all.
    const v = { verdict: "possibly-rented" } as const;
    expect(derive_corroboration(adj("non_owner_occupancy", 10), v)!).toMatchObject({
      agreement: 100,
      state: "corroborated",
    });
    expect(derive_corroboration(adj("owner_occupancy", 0), v)!).toMatchObject({
      agreement: 0,
      state: "contradicted",
    });
  });

  test("agreement takes only 11 distinct values — it is a 0-10 scale times ten, not a 101-point one", () => {
    // Worth pinning before anything downstream calibrates thresholds against it: the figure reads
    // like a percentage but has the granularity of the strength it is derived from.
    const v = { verdict: "rented" } as const;
    const seen = new Set<number>();
    for (let s = 0; s <= 10; s++) seen.add(derive_corroboration(adj("conflicting", s), v)!.agreement);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  test("is pure — same inputs, same figure, every time", () => {
    const v = { verdict: "rented" } as const;
    const a = derive_corroboration(adj("conflicting", 7), v);
    const b = derive_corroboration(adj("conflicting", 7), v);
    expect(a).toEqual(b);
  });
});
