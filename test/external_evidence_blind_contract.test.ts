import { describe, expect, test } from "bun:test";
import { ExternalEvidenceSchema } from "../src/agents/external_evidence.ts";

/**
 * X-078 boundary. REVISED 2026-09-08: the engine may now be told the scan's VERDICT, so it can
 * report how far its own read of the records agrees with it. The boundary did not disappear — it
 * moved, and the half that matters is still pinned here.
 *
 * ALLOWED: `scan_claim.verdict` — a factual finding ("a listing was found we believe is this
 * property"), identical for every organisation looking at the same scan.
 *
 * FORBIDDEN: everything downstream of it. `conclusivity`, `occupancyStatus`, `declaredIntent`,
 * `confidenceBands`, `configVersion` are per-organisation POLICY, computed by the backend and
 * pinned to a config version. Two orgs can read the same verdict and reach opposite policy
 * outcomes, so an engine that saw them would be reasoning about one org's rules — and its report
 * could not be reused for another. That reuse is not hypothetical: the AI-report cache lookup is
 * deliberately cross-organisation (no owner column).
 *
 * Two further protections live outside this file and must not be quietly dropped:
 *  - the adjudicator is NEVER shown the verdict; agreement is computed in code afterwards
 *    (orchestrator.ts derive_corroboration), so the investigation cannot be anchored by the answer
 *    it is being compared against;
 *  - `scan_claim` is an INPUT that changes the output, so the backend MUST add it to
 *    KEYED_EVIDENCE_FIELDS. Left out, two scans with different verdicts hash identically and the
 *    cache serves corroboration judged against the wrong one.
 */
describe("X-078: ExternalEvidenceSchema carries the verdict, and nothing but the verdict", () => {
  test("carries exactly the seven evidence fields and nothing else", () => {
    expect(Object.keys(ExternalEvidenceSchema.shape).sort()).toEqual([
      "address_match_confidence",
      "property_facts",
      "rental_listings",
      "scan_claim",
      "scan_id",
      "scanned_at",
      "str_listings",
    ]);
  });

  test("accepts the three verdicts, and only those three", () => {
    for (const verdict of ["not-rented", "possibly-rented", "rented"]) {
      const r = ExternalEvidenceSchema.safeParse({ scan_claim: { verdict } });
      expect([verdict, r.success]).toEqual([verdict, true]);
    }
    for (const bad of ["rented!", "unknown", "green", "consistent", ""]) {
      const r = ExternalEvidenceSchema.safeParse({ scan_claim: { verdict: bad } });
      expect([bad, r.success]).toEqual([bad, false]);
    }
  });

  test("absent scan_claim defaults to null — the absent payload IS the blind switch", () => {
    expect(ExternalEvidenceSchema.parse({}).scan_claim).toBeNull();
  });

  test("REJECTS every per-organisation policy field by name (scan_claim is .strict())", () => {
    for (const key of [
      "conclusivity",
      "occupancy_status",
      "occupancyStatus",
      "declared_intent",
      "declaredIntent",
      "confidence_bands",
      "config_version",
      "outcome_matrix",
    ]) {
      const r = ExternalEvidenceSchema.safeParse({ scan_claim: { verdict: "rented", [key]: "x" } });
      expect([key, r.success]).toEqual([key, false]);
    }
  });

  test("REJECTS policy fields smuggled in at the top level too", () => {
    for (const key of ["conclusivity", "declared_intent", "occupancy_status", "config_version"]) {
      const r = ExternalEvidenceSchema.safeParse({ [key]: "rented" });
      expect([key, r.success]).toEqual([key, false]);
    }
  });
});
