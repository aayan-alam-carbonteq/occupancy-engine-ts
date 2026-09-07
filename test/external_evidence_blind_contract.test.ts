import { describe, expect, test } from "bun:test";
import { ExternalEvidenceSchema } from "../src/agents/external_evidence.ts";

/**
 * X-078 constraint 1. The engine is never told the scan's conclusion. `records_read` is the case
 * adjudicator's read of the PUBLIC RECORDS, judged with no knowledge of any scan claim, and the
 * backend does the comparing.
 *
 * Two things depend on that and both fail silently if this schema grows a verdict field:
 *  1. blind/enriched parity — models.ts:200 promises "Blind (benchmarking) and enriched (prod) run
 *     identical code", and the payload is the only variable between the two arms;
 *  2. the backend's AI-report cache key (KEYED_EVIDENCE_FIELDS) — a scan verdict left OUT of the key
 *     makes two different verdicts hash identically and serves a report judged against the wrong
 *     one; a scan verdict put IN the key makes an org's threshold edit force a full engine re-run.
 *
 * So the key set is pinned by name, not merely spot-checked.
 */
describe("X-078: ExternalEvidenceSchema is frozen — the engine stays blind", () => {
  test("carries exactly the six evidence fields and nothing else", () => {
    expect(Object.keys(ExternalEvidenceSchema.shape).sort()).toEqual([
      "address_match_confidence",
      "property_facts",
      "rental_listings",
      "scan_id",
      "scanned_at",
      "str_listings",
    ]);
  });

  test("rejects every shape of scan conclusion by name (the schema is .strict())", () => {
    for (const key of [
      "scan_claim",
      "verdict",
      "scan_verdict",
      "conclusivity",
      "occupancy_status",
      "declared_intent",
      "records_read",
    ]) {
      const result = ExternalEvidenceSchema.safeParse({ [key]: "rented" });
      expect([key, result.success]).toEqual([key, false]);
    }
  });
});
