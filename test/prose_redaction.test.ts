import { describe, expect, test } from "bun:test";
import { detect_leaks, redact_prose } from "../src/agents/prose_redaction.ts";
import {
  count_prose_leaks,
  proseRedactEnabled,
  sanitize_adjudication_prose,
  sanitize_result_prose,
} from "../src/agents/prose_redaction.ts";
import { build_report } from "../src/agents/orchestrator.ts";
import { CaseAdjudicationSchema, HeuristicAgentResultSchema } from "../src/agents/models.ts";

describe("redact_prose", () => {
  test("rewrites a camelCase schema field to a human phrase", () => {
    const out = redact_prose("The utilityRecords show recent activity.");
    expect(out).not.toContain("utilityRecords");
    expect(out).toContain("utility service record");
  });

  test("drops a column=value pair, keeping a human phrase", () => {
    const out = redact_prose("own_rent=0 for the occupant.");
    expect(out).not.toContain("own_rent");
    expect(out).not.toContain("=0");
    expect(out).toContain("tenure (owner or renter)");
  });

  test("collapses an unknown snake_case identifier via the catch-all", () => {
    const out = redact_prose("The some_unknown_field was present.");
    expect(out).not.toContain("some_unknown_field");
    expect(out).toContain("an internal record field");
  });

  test("leaves clean human prose untouched (no false positives)", () => {
    const clean = "The property tax record lists the owner as a renter.";
    expect(redact_prose(clean)).toBe(clean);
    const clean2 = "The residential condominium appears owner-occupied.";
    expect(redact_prose(clean2)).toBe(clean2);
  });

  test("empty input returns empty", () => {
    expect(redact_prose("")).toBe("");
  });
});

describe("detect_leaks", () => {
  test("finds distinct identifier tokens", () => {
    expect(detect_leaks("utilityRecords and own_rent appear here")).toEqual([
      "utilityRecords",
      "own_rent",
    ]);
  });

  test("returns nothing for clean prose", () => {
    expect(detect_leaks("a plain english sentence about a house")).toEqual([]);
  });
});

describe("redact_prose / detect_leaks — hardening", () => {
  test("does not treat Object.prototype members as identifiers", () => {
    const clean = "The original constructor finished the build.";
    expect(redact_prose(clean)).toBe(clean);
    expect(detect_leaks("Review the toString output before filing.")).toEqual([]);
    expect(detect_leaks("The lender will hasOwnProperty this account.")).toEqual([]);
  });

  test("catches singular / PascalCase GraphQL type names shown to the model", () => {
    const out = redact_prose("The LoanRecord shows a recent origination.");
    expect(out).not.toContain("LoanRecord");
    expect(out).toContain("mortgage/loan application record");
    expect(detect_leaks("SourceRecordConnection returned zero nodes.")).toEqual([
      "SourceRecordConnection",
    ]);
  });

  test("catches unmapped snake_case regardless of case", () => {
    expect(detect_leaks("The Some_Unknown_Field was present.")).toEqual(["Some_Unknown_Field"]);
    expect(detect_leaks("SOME_UNKNOWN_FIELD was present.")).toEqual(["SOME_UNKNOWN_FIELD"]);
  });

  test("never mangles owner names or bare type words", () => {
    const clean = "The owner is John McDonald and the person at the property is a renter.";
    expect(redact_prose(clean)).toBe(clean);
  });
});

describe("count_prose_leaks", () => {
  test("sums leaks across many strings", () => {
    expect(count_prose_leaks(["utilityRecords here", "and own_rent", "clean text"])).toBe(2);
  });
});

describe("sanitize_result_prose", () => {
  test("cleans prose fields and leaves everything else untouched", () => {
    const result = {
      finding: "The loanRecords show own_rent=0.",
      caveats: ["ownerrescount=3 for this owner"],
      missing_evidence: ["taxProperties absent"],
      status: "triggered",
      score: 2,
      evidence_for: [{ source: "loan", rowid: 1 }],
    };
    const out = sanitize_result_prose(result);
    expect(count_prose_leaks([out.finding, ...out.caveats, ...out.missing_evidence])).toBe(0);
    // Untouched:
    expect(out.status).toBe("triggered");
    expect(out.score).toBe(2);
    expect(out.evidence_for).toEqual([{ source: "loan", rowid: 1 }]);
  });
});

describe("sanitize_adjudication_prose", () => {
  test("cleans reasoning_summary and why_not_* arrays", () => {
    const adj = {
      reasoning_summary: "driveRecords indicate presence.",
      why_not_higher: ["own_rent=0"],
      why_not_lower: [],
      verdict_band: "review",
    };
    const out = sanitize_adjudication_prose(adj);
    expect(count_prose_leaks([out.reasoning_summary, ...out.why_not_higher, ...out.why_not_lower])).toBe(0);
    expect(out.verdict_band).toBe("review");
  });

  test("also cleans score_adjustments reasons and preserves their other fields", () => {
    const adj = {
      reasoning_summary: "clean summary",
      why_not_higher: [],
      why_not_lower: [],
      score_adjustments: [
        { heuristic_ids: ["loan_tenure"], delta: -2, reason: "own_rent=0 conflicts with utilityRecords" },
      ],
    };
    const out = sanitize_adjudication_prose(adj);
    expect(count_prose_leaks([out.score_adjustments[0]!.reason])).toBe(0);
    expect(out.score_adjustments[0]!.delta).toBe(-2);
    expect(out.score_adjustments[0]!.heuristic_ids).toEqual(["loan_tenure"]);
  });
});

describe("proseRedactEnabled", () => {
  test("is off by default", () => {
    expect(proseRedactEnabled()).toBe(false);
  });
});

describe("controlled vocabulary is not a leak", () => {
  test("engine verdict/archetype/status labels are ignored", () => {
    const s =
      "Case archetype: mixed_evidence. Verdict band: high_priority_review. Status: not_triggered.";
    expect(detect_leaks(s)).toEqual([]);
    expect(redact_prose(s)).toBe(s);
  });
});

describe("integration: sanitized findings produce a leak-free report", () => {
  test("build_report over sanitized inputs has no identifier leaks", () => {
    const result = HeuristicAgentResultSchema.parse({
      heuristic_id: "loan_tenure",
      status: "triggered",
      direction: "risk",
      score: 2,
      confidence: "medium",
      finding: "The loanRecords show own_rent=0 for the occupant.",
      evidence_for: [{ source: "loan", rowid: 1 }],
    });
    const adjudication = CaseAdjudicationSchema.parse({
      raw_score: 2,
      calibrated_score: 2,
      clarity_score: 5,
      verdict_band: "review",
      case_archetype: "mixed_evidence",
      reasoning_summary: "driveRecords indicate presence at the subject.",
    });
    const report = build_report(
      sanitize_adjudication_prose(adjudication),
      2,
      [sanitize_result_prose(result)],
      [],
    );
    expect(detect_leaks(report)).toHaveLength(0);
  });
});
