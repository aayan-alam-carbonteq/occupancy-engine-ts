import { describe, expect, test } from "bun:test";
import {
  AgentInvestigationRequestSchema,
  CaseAdjudicationSchema,
  DataCallLogSchema,
  HeuristicAgentResultSchema,
  HeuristicInterpretationSchema,
  EvidenceReferenceSchema,
} from "../src/agents/models.ts";

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
  const req = { address: "1104 SPRING RUN RD" };

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

describe("X-016 request contract", () => {
  test("applies the new defaults with no data_url field at all", () => {
    const req = AgentInvestigationRequestSchema.parse({ address: "1104 SPRING RUN RD" });
    expect("data_url" in req).toBe(false);
    expect(req.max_data_calls_per_agent).toBe(8);
    expect(req.data_timeout_seconds).toBe(30.0);
    expect(req.retrieval_mode).toBe("tools");
  });

  test("rejects the retired graphql_url and include_shortcuts keys (schema is strict)", () => {
    expect(
      AgentInvestigationRequestSchema.safeParse({ address: "a", graphql_url: "http://g" }).success,
    ).toBe(false);
    expect(
      AgentInvestigationRequestSchema.safeParse({ address: "a", include_shortcuts: true }).success,
    ).toBe(false);
  });

  test("graphql_url is rejected as an unknown key", () => {
    const r = AgentInvestigationRequestSchema.safeParse({ address: "a", graphql_url: "http://g" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain("graphql_url");
  });

  // Same trap on the two renamed budget fields: they must be gone by name, not just renamed in
  // passing while the old key still slips through .strict().
  test("the retired budget keys are rejected by name", () => {
    for (const key of ["max_graphql_calls_per_agent", "graphql_timeout_seconds"]) {
      const r = AgentInvestigationRequestSchema.safeParse({ address: "a", [key]: 5 });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error!.issues)).toContain(key);
    }
  });

  // D6 (this change): data_url is RETIRED from the request the same way graphql_url was — the
  // engine resolves its own data-service address (DATA_URL env, one resolver), so a request that
  // still names one is a caller bug worth surfacing loudly, not a field to silently ignore.
  test("data_url is rejected as an unknown key — the engine resolves its own, not the caller's", () => {
    const r = AgentInvestigationRequestSchema.safeParse({ address: "a", data_url: "http://g" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain("data_url");
  });
});

describe("DataCallLogSchema", () => {
  test("carries operation/params and defaults the rest", () => {
    const log = DataCallLogSchema.parse({ operation: "resolve", params: { zip: "40514" } });
    expect(log.operation).toBe("resolve");
    expect(log.params).toEqual({ zip: "40514" });
    expect(log.result_summary).toBe("");
    expect(log.error).toBeNull();
  });

  test("rejects the retired query_name/variables keys", () => {
    expect(DataCallLogSchema.safeParse({ query_name: "searchAddresses", variables: {} }).success).toBe(false);
  });
});

describe("HeuristicAgentResult", () => {
  test("exposes data_queries, not graphql_queries", () => {
    const r = HeuristicAgentResultSchema.parse({
      heuristic_id: "h",
      status: "not_triggered",
      direction: "risk",
      score: 0,
      confidence: "low",
      finding: "f",
      missing_evidence: ["none"],
      data_queries: [{ operation: "address_records", params: { shapes: ["tax"] } }],
    });
    expect(r.data_queries.length).toBe(1);
    expect((r as Record<string, unknown>)["graphql_queries"]).toBeUndefined();
  });
});

// X-078. The case-level roll-up of what PUBLIC RECORDS say about occupancy. Not relative to any
// scan claim — the engine never sees one (test/external_evidence_blind_contract.test.ts).
const adjudicationBase = {
  raw_score: 4,
  verdict_band: "review" as const,
  case_archetype: "mixed_evidence" as const,
  reasoning_summary: "Absentee owner with unrelated occupants at the subject.",
};

describe("X-078 CaseAdjudication.records_read", () => {
  test("parses a full block and preserves every field", () => {
    const adj = CaseAdjudicationSchema.parse({
      ...adjudicationBase,
      records_read: {
        occupancy_signal: "non_owner_occupancy", nonowner_occupancy_strength: 5,
        reasoning: "Owner mails elsewhere; two unrelated adults hold utility service at the subject.",
        driving_heuristic_ids: ["owner_identity_and_mailing", "subject_occupancy_surfaces"],
      },
    });
    expect(adj.records_read.occupancy_signal).toBe("non_owner_occupancy");
    expect(adj.records_read.driving_heuristic_ids).toEqual([
      "owner_identity_and_mailing",
      "subject_occupancy_surfaces",
    ]);
  });

  test("driving_heuristic_ids defaults to [] — the UI link-through is optional, the signal is not", () => {
    const adj = CaseAdjudicationSchema.parse({
      ...adjudicationBase,
      records_read: { occupancy_signal: "no_signal", nonowner_occupancy_strength: 5, reasoning: "Records are silent." },
    });
    expect(adj.records_read.driving_heuristic_ids).toEqual([]);
  });

  test("records_read is REQUIRED — an adjudication without it is not a valid adjudication", () => {
    // This is what forces the retry/repair channel rather than letting a silent null through to the
    // backend, where it would surface as "no corroboration available" on a case that had one.
    const result = CaseAdjudicationSchema.safeParse(adjudicationBase);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).toContain("records_read");
  });

  test("all four occupancy signals are accepted, and only those four", () => {
    // `conflicting` joined the ladder after the X-078 Task 10 measurement: without it, the model
    // used `no_signal` for record-rich addresses whose evidence pointed both ways, collapsing
    // "the records disagree" into "there are no records". They are different findings.
    for (const signal of ["non_owner_occupancy", "owner_occupancy", "conflicting", "no_signal"]) {
      const r = CaseAdjudicationSchema.safeParse({
        ...adjudicationBase,
        records_read: { occupancy_signal: signal, nonowner_occupancy_strength: 5, reasoning: "r" },
      });
      expect([signal, r.success]).toEqual([signal, true]);
    }
    // "no_signal" must stay distinct from "owner_occupancy": absence of evidence is not evidence of
    // owner occupancy, and the backend maps them to different corroboration states.
    for (const bad of ["none", "unknown", "not_applicable", "owner", "rented"]) {
      const r = CaseAdjudicationSchema.safeParse({
        ...adjudicationBase,
        records_read: { occupancy_signal: bad, nonowner_occupancy_strength: 5, reasoning: "r" },
      });
      expect([bad, r.success]).toEqual([bad, false]);
    }
  });

  test("`strength` is REJECTED — the schema is .strict() and the field is gone", () => {
    // Removed 2026-09-08: measured `moderate` in 21 of 24 live cases and perfectly correlated with
    // occupancy_signal, so it carried almost no information, and nothing downstream consumed it.
    // .strict() means a stale caller still sending it fails loudly instead of being ignored.
    const r = CaseAdjudicationSchema.safeParse({
      ...adjudicationBase,
      records_read: { occupancy_signal: "owner_occupancy", nonowner_occupancy_strength: 5, strength: "moderate", reasoning: "r" },
    });
    expect(r.success).toBe(false);
  });
  test("the block is strict — an unknown key is a caller bug, not a field to ignore", () => {
    const r = CaseAdjudicationSchema.safeParse({
      ...adjudicationBase,
      records_read: {
        occupancy_signal: "no_signal", nonowner_occupancy_strength: 5,
        reasoning: "r",
        confidence: 0.8, // model self-confidence has no home in records_read at all
      },
    });
    expect(r.success).toBe(false);
  });
});
