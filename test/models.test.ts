import { describe, expect, test } from "bun:test";
import { AgentInvestigationRequestSchema, HeuristicAgentResultSchema, HeuristicInterpretationSchema, EvidenceReferenceSchema } from "../src/agents/models.ts";

const base = {
  heuristic_id: "property_tax_context",
  direction: "risk" as const,
  confidence: "low" as const,
  finding: "some finding",
};

describe("HeuristicAgentResult schema validators", () => {
  test("triggered requires evidence_for", () => {
    expect(() => HeuristicAgentResultSchema.parse({ ...base, status: "triggered", score: 2, evidence_for: [] })).toThrow();
    const ok = HeuristicAgentResultSchema.parse({
      ...base,
      status: "triggered",
      score: 2,
      evidence_for: [{ source: "tax", rowid: 1 }],
    });
    expect(ok.status).toBe("triggered");
    expect(ok.evidence_for[0]!.source).toBe("tax");
  });

  test("not_triggered requires evidence_against or missing_evidence", () => {
    expect(() => HeuristicAgentResultSchema.parse({ ...base, status: "not_triggered", score: 0 })).toThrow();
    const ok = HeuristicAgentResultSchema.parse({ ...base, status: "not_triggered", score: 0, missing_evidence: ["none"] });
    expect(ok.status).toBe("not_triggered");
  });

  test("inconclusive requires context AND score 0", () => {
    expect(() => HeuristicAgentResultSchema.parse({ ...base, status: "inconclusive", score: 0 })).toThrow(); // no context
    expect(() => HeuristicAgentResultSchema.parse({ ...base, status: "inconclusive", score: 2, missing_evidence: ["x"] })).toThrow(); // score != 0
    const ok = HeuristicAgentResultSchema.parse({ ...base, status: "inconclusive", score: 0, missing_evidence: ["x"] });
    expect(ok.score).toBe(0);
  });

  test("empty finding rejected; defaults applied", () => {
    expect(() => HeuristicAgentResultSchema.parse({ ...base, finding: "   ", status: "context", score: 0 })).toThrow();
    const r = HeuristicAgentResultSchema.parse({ ...base, status: "context", score: 0 });
    expect(r.interpretation.signal_strength).toBe("none"); // nested default_factory applied
    expect(r.evidence_refs).toEqual([]);
    expect(r.needs_second_pass).toBe(false);
  });

  test("strict() rejects unknown keys (extra=forbid)", () => {
    expect(() => HeuristicAgentResultSchema.parse({ ...base, status: "context", score: 0, bogus: 1 })).toThrow();
  });

  test("EvidenceReference + interpretation defaults", () => {
    expect(EvidenceReferenceSchema.parse({ source: "tax" }).summary).toBe("");
    expect(HeuristicInterpretationSchema.parse({}).recommended_weight).toBe("low");
  });
});

describe("AgentInvestigationRequest.external_evidence", () => {
  const req = { address: "1104 SPRING RUN RD", graphql_url: "http://localhost:8000/graphql" };

  test("defaults to null when absent — the absent payload IS the blind switch", () => {
    expect(AgentInvestigationRequestSchema.parse(req).external_evidence).toBeNull();
  });

  test("accepts and validates a payload", () => {
    const parsed = AgentInvestigationRequestSchema.parse({
      ...req,
      external_evidence: { str_listings: [{ platform: "airbnb", address_match_pct: 88 }] },
    });
    expect(parsed.external_evidence!.str_listings[0]!.platform).toBe("airbnb");
  });

  test("an empty-but-present payload is distinct from an absent one (negative evidence)", () => {
    const parsed = AgentInvestigationRequestSchema.parse({ ...req, external_evidence: { scan_id: "scan_9" } });
    expect(parsed.external_evidence).not.toBeNull();
    expect(parsed.external_evidence!.str_listings).toEqual([]);
  });

  test("a malformed payload fails the request parse — no silent fallback to blind", () => {
    expect(() =>
      AgentInvestigationRequestSchema.parse({ ...req, external_evidence: { str_listings: [{ platform: "airbnb" }] } }),
    ).toThrow();
  });
});
