import { describe, expect, test } from "bun:test";
import { derive_corroboration } from "../src/agents/orchestrator.ts";
import type { CaseAdjudication } from "../src/agents/models.ts";

const adj = (occupancy_signal: string, nonowner_occupancy_strength: number): CaseAdjudication =>
  ({
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
  }) as unknown as CaseAdjudication;

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

  test("is pure — same inputs, same figure, every time", () => {
    const v = { verdict: "rented" } as const;
    const a = derive_corroboration(adj("conflicting", 7), v);
    const b = derive_corroboration(adj("conflicting", 7), v);
    expect(a).toEqual(b);
  });
});
