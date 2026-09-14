// test/reconcile_evidence_map.test.ts
import { describe, expect, test } from "bun:test";
import { type CaseEvidenceMap, CaseEvidenceMapSchema } from "../src/agents/models.ts";
import { reconcile_evidence_map } from "../src/agents/orchestrator.ts";

function map(): CaseEvidenceMap {
  return CaseEvidenceMapSchema.parse({
    normalized_address: "1105 CLOVELLY CT",
    owner_summaries: [
      {
        owner_name: "FURRY, CATHERINE DIANE",
        mailing_address: "1105 CLOVELLY CT LEXINGTON KY 40517",
        mailing_matches_subject: true,
        summaries: ["owner=FURRY, CATHERINE DIANE"],
      },
    ],
    people_at_address: [
      { name: "THOMAS RICHARDSON", relationship_to_owner: "unrelated", sources: ["utility"], summaries: ["utility"] },
      { name: "TOM RICHARDSON", relationship_to_owner: "unrelated", sources: ["trace"], summaries: ["trace"] },
      { name: "KATE FURRY", relationship_to_owner: "likely_family", sources: ["utility"], summaries: ["utility"] },
    ],
    owner_presence_hints: ["At least one tax owner mailing address matches the selected address."],
    nonowner_occupancy_hints: [
      "unrelated person at address via utility: THOMAS RICHARDSON.",
      "unrelated person at address via trace: TOM RICHARDSON.",
      "likely_family person at address via utility: KATE FURRY.",
    ],
    data_gaps: ["No auto rows found at selected address."],
    evidence_refs: [{ source: "tax", table: "tax", rowid: 0, summary: "tax; ownername=FURRY, CATHERINE DIANE" }],
  });
}

const THOMAS_AND_TOM = { person_indexes: [0, 1], includes_owner: false, name: "THOMAS RICHARDSON" };

describe("X-091 reconcile_evidence_map", () => {
  test("no groups returns the very same map", () => {
    const input = map();
    expect(reconcile_evidence_map(input, [])).toBe(input);
  });

  test("merges the people and rebuilds both hint lists from the merged list", () => {
    const out = reconcile_evidence_map(map(), [THOMAS_AND_TOM]);
    expect(out.people_at_address.map((p) => p.name)).toEqual(["THOMAS RICHARDSON", "KATE FURRY"]);
    expect(out.nonowner_occupancy_hints).toEqual([
      "unrelated person at address via utility, trace: THOMAS RICHARDSON.",
      "likely_family person at address via utility: KATE FURRY.",
    ]);
    expect(out.owner_presence_hints).toEqual(["At least one tax owner mailing address matches the selected address."]);
  });

  test("a person grouped with the owner id becomes the owner, in the hints too", () => {
    const out = reconcile_evidence_map(map(), [{ person_indexes: [2], includes_owner: true, name: "KATE FURRY" }]);
    expect(out.people_at_address[2]!.relationship_to_owner).toBe("owner");
    expect(out.owner_presence_hints).toEqual([
      "At least one tax owner mailing address matches the selected address.",
      "Owner-like name appears in utility: KATE FURRY.",
    ]);
    expect(out.nonowner_occupancy_hints.some((hint) => hint.includes("KATE FURRY"))).toBe(false);
  });

  test("every other field is carried by reference, and the input is never mutated", () => {
    const input = map();
    const snapshot = structuredClone(input);
    const out = reconcile_evidence_map(input, [THOMAS_AND_TOM]);
    expect(out.owner_summaries).toBe(input.owner_summaries);
    expect(out.evidence_refs).toBe(input.evidence_refs);
    expect(out.data_gaps).toBe(input.data_gaps);
    expect(input).toEqual(snapshot);
  });
});
