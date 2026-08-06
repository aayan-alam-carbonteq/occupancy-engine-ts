import { afterEach, describe, expect, test } from "bun:test";
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
  const original = process.env.OE_PROSE_REDACT;
  afterEach(() => {
    if (original === undefined) delete process.env.OE_PROSE_REDACT;
    else process.env.OE_PROSE_REDACT = original;
  });
  test("is on by default (unset)", () => {
    delete process.env.OE_PROSE_REDACT;
    expect(proseRedactEnabled()).toBe(true);
  });
  test("can be explicitly disabled for the baseline arm", () => {
    for (const v of ["0", "false", "no", "off"]) {
      process.env.OE_PROSE_REDACT = v;
      expect(proseRedactEnabled()).toBe(false);
    }
  });
});

describe("engine contract vocabulary is never eaten", () => {
  test("packet ids, output_fields and result field names survive verbatim", async () => {
    const { PACKETS } = await import("../src/heuristics/packets.ts");
    const packetIds = PACKETS.map((p) => p.id);
    const outputFields = PACKETS.flatMap((p) => p.output_fields);
    const contract = [
      "evidence_for",
      "evidence_against",
      "evidence_refs",
      "missing_evidence",
      "needs_second_pass",
      "score_adjustments",
    ];
    for (const token of [...packetIds, ...outputFields, ...contract]) {
      expect(detect_leaks(token)).toEqual([]);
      expect(redact_prose(token)).toBe(token);
    }
  });

  test("error diagnostics keep their packet id", () => {
    const msg = "Heuristic agent exceeded turn budget: portfolio_and_primary_comparison";
    expect(redact_prose(msg)).toBe(msg);
  });

  test("but the real data surface is still redacted", () => {
    expect(detect_leaks("utilityRecords own_rent ownerrescount LoanRecord").length).toBe(4);
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

describe("new leak classes (X-prose-refinement)", () => {
  test("strips a parenthetical source-tag citation, keeping the sentence", () => {
    const out = redact_prose("Tax owner WINKFIELD (TAX:68344) is identified.");
    expect(out).toBe("Tax owner WINKFIELD is identified.");
    expect(detect_leaks("Tax owner WINKFIELD (TAX:68344) is identified.")).toContain("TAX:68344");
  });

  test("strips a bare source-tag citation with a hyphenated id range", () => {
    expect(redact_prose("four loan records (LOAN:74141-74144) at the address")).toBe(
      "four loan records at the address",
    );
  });

  test("drops rowid and trace-code references, cleaning empty parens", () => {
    expect(redact_prose("utility account (rowid 1296784) and trace cd113530 present")).toBe(
      "utility account and trace present",
    );
    expect(detect_leaks("rowid 1296784")).toContain("rowid 1296784");
    expect(detect_leaks("cd113530")).toContain("cd113530");
  });

  test("collapses bare word=value pairs to the plain words (backstop, not beautifier)", () => {
    // The scrubber keeps the WORD and drops the raw value; it does not judge True vs False
    // (that nicety lives in the Component B owner-summary humanizer, not here).
    expect(redact_prose("the property (residential=True, condo=False) built in 1983")).toBe(
      "the property (residential, condo) built in 1983",
    );
    expect(detect_leaks("residential=True")).toContain("residential=True");
  });

  test("replaces the obscure jargon 'situs' but keeps LTV/CLTV", () => {
    expect(redact_prose("the situs address shows LTV ~64.6% and CLTV 38.7%")).toBe(
      "the subject address shows LTV ~64.6% and CLTV 38.7%",
    );
    expect(detect_leaks("LTV CLTV")).toEqual([]);
  });

  test("still leaves clean human prose untouched", () => {
    const clean = "The owner lives at the property and holds one mortgage.";
    expect(redact_prose(clean)).toBe(clean);
    expect(detect_leaks(clean)).toEqual([]);
  });

  test("strips quoted values in bare word=value pairs", () => {
    expect(redact_prose('type="single_family" and status="ACTIVE" here')).toBe("type and status here");
    expect(detect_leaks('type="single_family"')).toContain('type="single_family"');
  });

  test("tidies a mixed parenthetical of refs + prose into clean text", () => {
    expect(
      redact_prose("owner presence (BASE:81239 with 10-year residence, TAX:68344, TRACE:267914) confirmed"),
    ).toBe("owner presence (with 10-year residence) confirmed");
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
