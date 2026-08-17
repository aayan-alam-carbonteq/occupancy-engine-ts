import { describe, expect, test } from "bun:test";
import {
  AgentInvestigationRequestSchema,
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
  const req = { address: "1104 SPRING RUN RD", data_url: "http://localhost:8000" };

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
  test("accepts data_url and applies the new defaults", () => {
    const req = AgentInvestigationRequestSchema.parse({
      address: "1104 SPRING RUN RD",
      data_url: "http://graph:8000",
    });
    expect(req.data_url).toBe("http://graph:8000");
    expect(req.max_data_calls_per_agent).toBe(8);
    expect(req.data_timeout_seconds).toBe(30.0);
    expect(req.retrieval_mode).toBe("tools");
  });

  test("rejects the retired graphql_url and include_shortcuts keys (schema is strict)", () => {
    expect(
      AgentInvestigationRequestSchema.safeParse({ address: "a", graphql_url: "http://g" }).success,
    ).toBe(false);
    expect(
      AgentInvestigationRequestSchema.safeParse({
        address: "a",
        data_url: "http://g",
        include_shortcuts: true,
      }).success,
    ).toBe(false);
  });

  // The assertion above cannot distinguish "graphql_url is an unknown key" from "data_url is
  // missing" — both make the parse fail. This one supplies data_url so only strictness can reject
  // it, and names the offending key, so it fails if graphql_url is ever quietly re-accepted.
  test("graphql_url is rejected as an unknown key, not merely as a missing data_url", () => {
    const r = AgentInvestigationRequestSchema.safeParse({
      address: "a",
      data_url: "http://g",
      graphql_url: "http://g",
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toContain("graphql_url");
  });

  // Same trap on the two renamed budget fields: they must be gone by name, not just renamed in
  // passing while the old key still slips through .strict().
  test("the retired budget keys are rejected by name", () => {
    for (const key of ["max_graphql_calls_per_agent", "graphql_timeout_seconds"]) {
      const r = AgentInvestigationRequestSchema.safeParse({ address: "a", data_url: "http://g", [key]: 5 });
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error!.issues)).toContain(key);
    }
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
