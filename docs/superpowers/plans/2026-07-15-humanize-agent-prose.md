# Human-Readable, Gated Prose — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the occupancy engine's user-facing prose human-readable and free of internal data-surface leaks (table/field names, raw `column=value` values), behind two default-off feature flags, without changing data coverage.

**Architecture:** Two coordinated levers. (A) A prompt "writing register" injected into the three user-prompt builders (gated by `OE_PROSE_REGISTER`) tells the field-analyst and adjudicator LLMs to write plain prose and cite only in structured fields. (B) A new pure, deterministic redaction module (`prose_redaction.ts`) that substitutes identifier-shaped tokens for neutral human phrases as a security backstop; the orchestrator applies it as a single finalization pass over the human-facing prose fields (gated by `OE_PROSE_REDACT`) after adjudication and before `build_report`. A new always-on `prose_leak_count` metric measures leakage for the A/B.

**Tech Stack:** TypeScript, Bun (`bun test`), Zod, LangChain. Spec: `docs/superpowers/specs/2026-07-15-humanize-agent-prose-design.md`.

---

## File Structure

- **Create `src/agents/prose_redaction.ts`** — pure deterministic redaction. Owns: the schema-token lexicon, `detect_leaks`, `redact_prose`, `count_prose_leaks`, the object-level `sanitize_result_prose` / `sanitize_adjudication_prose`, and the `proseRedactEnabled()` gate. No dependency on models/orchestrator (uses structural types) so it is trivially unit-testable.
- **Create `test/prose_redaction.test.ts`** — unit tests for the module (known tokens, catch-all, `column=value`, no false positives on clean prose, structured fields untouched) plus one integration test through `build_report`.
- **Modify `src/agents/prompts.ts`** — add `OE_PROSE_REGISTER` flag, the `SOURCE_HUMAN_PHRASES` glossary, `buildProseRegisterLines()` (pure) + `_prose_register_lines()` (gated), and wire the gated lines into `heuristic_user_prompt`, `grouped_heuristic_user_prompt`, and `master_adjudication_user_prompt`.
- **Modify `src/agents/orchestrator.ts`** — import from `prose_redaction.ts`; add the gated finalization scrub pass in `_investigate`; thread the sanitized results/adjudication through caveats, `build_report`, `_agent_metrics`, and the assessment; add `prose_leak_count` to `_agent_metrics`.
- **Modify `docs/superpowers/specs/2026-07-15-humanize-agent-prose-design.md`** — append the experiment runbook (3-arm protocol) at the end.

**Coverage-neutrality invariants (must hold after every task):**
- With both flags unset (default), all outputs are byte-identical to today. The register lines are additive-when-on; the scrub only runs when on.
- The scrub is token substitution, never clause deletion, and runs *after* adjudication — so it never perturbs the adjudicator's inputs.
- The scrub never touches structured citation fields (`evidence_for`/`evidence_against`/`evidence_refs`) or enum fields.

---

## Task 1: Redaction core — `detect_leaks` + `redact_prose`

**Files:**
- Create: `src/agents/prose_redaction.ts`
- Test: `test/prose_redaction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/prose_redaction.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { detect_leaks, redact_prose } from "../src/agents/prose_redaction.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/prose_redaction.test.ts`
Expected: FAIL — `Cannot find module "../src/agents/prose_redaction.ts"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agents/prose_redaction.ts`:

```ts
// Deterministic prose redaction: a SECURITY BACKSTOP that guarantees no internal data-surface
// identifier (GraphQL field/table names, DB column names) survives in the human-facing prose
// fields. It is NOT a beautifier — it substitutes identifier-shaped tokens for neutral human
// phrases (never deletes clauses), so it is coverage-neutral by construction. The primary
// readability lever is the prompt "writing register" (see prompts.ts, OE_PROSE_REGISTER); this
// module is the hard guarantee behind OE_PROSE_REDACT.
//
// Design note: only IDENTIFIER-SHAPED tokens are treated as sensitive — camelCase, snake_case, or
// an explicitly enumerated concatenated identifier (e.g. "ownername"). Bare dictionary words that
// happen to also be column names ("residential", "condo", "tax", "loan") are ordinary English and
// are left alone; rewriting them would mangle good prose and does not expose the data surface.

// Exact schema/column tokens → the human phrase they should read as. Keys are lowercased; matching
// lowercases the candidate token before lookup.
export const SCHEMA_TOKEN_PHRASES: Record<string, string> = {
  // record connections / types
  baserecords: "residence record",
  residents: "resident record",
  taxproperties: "property-tax record",
  taxrecords: "property-tax record",
  utilityrecords: "utility service record",
  tracerecords: "address-history record",
  autorecords: "vehicle-registration record",
  loanrecords: "mortgage/loan application record",
  driverecords: "driver's-license record",
  voterrecords: "voter-registration record",
  criminalrecords: "criminal record",
  // associations / query roots
  personassociations: "person association",
  propertyassociations: "property association",
  addressassociations: "address association",
  organizationassociations: "organization association",
  sourcerecord: "source record",
  sourcerecords: "source record",
  resolveaddress: "address lookup",
  searchaddresses: "address search",
  addressbytext: "address lookup",
  // columns
  own_rent: "tenure (owner or renter)",
  ownrent: "tenure (owner or renter)",
  ownername: "owner name",
  owneraddressline1: "owner mailing address",
  ownercity: "owner mailing city",
  ownerstate: "owner mailing state",
  ownerzipcode: "owner mailing ZIP",
  lendername: "lender name",
  totalliencount: "lien count",
  totallienbalance: "lien balance",
  ownerrescount: "owner property count",
  recordingdate: "recording date",
  foreclosecode: "foreclosure marker",
  forecloserecorddate: "foreclosure record date",
  rowid: "record reference",
  recordid: "record reference",
};

const CATCH_ALL_PHRASE = "an internal record field";

// camelCase (a lowercase run then an uppercase), e.g. utilityRecords, ownRent, normAddress.
const CAMEL_RE = /^[a-z]+[A-Z][A-Za-z0-9]*$/;
// snake_case, e.g. own_rent, dob_year, some_unknown_field.
const SNAKE_RE = /^[a-z0-9]+_[a-z0-9_]+$/;
// A word-like token (letters/digits/underscore). Punctuation and whitespace are boundaries.
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
// "identifier = value" / "identifier=value". Value stops before whitespace or sentence punctuation.
const ASSIGN_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s,;.)]+)/g;

function isIdentifierToken(token: string): boolean {
  if (token.toLowerCase() in SCHEMA_TOKEN_PHRASES) {
    return true;
  }
  return CAMEL_RE.test(token) || SNAKE_RE.test(token);
}

function phraseFor(token: string): string {
  const mapped = SCHEMA_TOKEN_PHRASES[token.toLowerCase()];
  return mapped ?? CATCH_ALL_PHRASE;
}

/** Distinct identifier-shaped tokens still present in `text` (first-seen order, case-insensitive). */
export function detect_leaks(text: string): string[] {
  if (!text) {
    return [];
  }
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    const key = token.toLowerCase();
    if (isIdentifierToken(token) && !seen.has(key)) {
      seen.add(key);
      found.push(token);
    }
  }
  return found;
}

/**
 * Replace every internal identifier in `text` with a neutral human phrase. Two passes:
 *  1. Collapse `identifier = value` to the identifier's phrase (dropping the raw value).
 *  2. Replace any remaining standalone identifier token with its phrase.
 * Non-identifier words are left exactly as-is.
 */
export function redact_prose(text: string): string {
  if (!text) {
    return text;
  }
  const afterAssign = text.replace(ASSIGN_RE, (whole, ident: string) =>
    isIdentifierToken(ident) ? phraseFor(ident) : whole,
  );
  return afterAssign.replace(TOKEN_RE, (token) =>
    isIdentifierToken(token) ? phraseFor(token) : token,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/prose_redaction.test.ts`
Expected: PASS (all tests in both `describe` blocks).

- [ ] **Step 5: Commit**

```bash
git add src/agents/prose_redaction.ts test/prose_redaction.test.ts
git commit -m "feat(agents): deterministic prose redaction core (detect_leaks, redact_prose)"
```

---

## Task 2: Object-level sanitizers, leak count, and the gate

**Files:**
- Modify: `src/agents/prose_redaction.ts`
- Test: `test/prose_redaction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/prose_redaction.test.ts`:

```ts
import {
  count_prose_leaks,
  proseRedactEnabled,
  sanitize_adjudication_prose,
  sanitize_result_prose,
} from "../src/agents/prose_redaction.ts";

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
});

describe("proseRedactEnabled", () => {
  test("is off by default", () => {
    expect(proseRedactEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/prose_redaction.test.ts`
Expected: FAIL — `count_prose_leaks`, `sanitize_result_prose`, `sanitize_adjudication_prose`, `proseRedactEnabled` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/agents/prose_redaction.ts`:

```ts
// Gated so nothing changes until explicitly enabled (mirrors OE_SYNTH_AUGMENT / OE_PROMPT_CACHE).
const _REDACT_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.OE_PROSE_REDACT ?? "").trim().toLowerCase(),
);

export function proseRedactEnabled(): boolean {
  return _REDACT_ENABLED;
}

/** Total identifier leaks across all strings (used for the always-on prose_leak_count metric). */
export function count_prose_leaks(texts: Iterable<string>): number {
  let total = 0;
  for (const text of texts) {
    total += detect_leaks(text).length;
  }
  return total;
}

// Structural shapes — kept local so this module needs no dependency on models.ts and stays
// trivially testable with plain objects. The generic <T extends ...> preserves the caller's full
// type (the orchestrator passes HeuristicAgentResult / CaseAdjudication and gets them back).
interface ResultProse {
  finding: string;
  caveats: string[];
  missing_evidence: string[];
}

interface AdjudicationProse {
  reasoning_summary: string;
  why_not_higher: string[];
  why_not_lower: string[];
}

/** Return a copy with the human-facing prose fields redacted; all other fields are preserved. */
export function sanitize_result_prose<T extends ResultProse>(result: T): T {
  // `as T`: we only overwrite same-typed prose fields, so the object stays a valid T. The cast
  // avoids TS's generic-spread widening error without loosening the public signature.
  return {
    ...result,
    finding: redact_prose(result.finding),
    caveats: result.caveats.map(redact_prose),
    missing_evidence: result.missing_evidence.map(redact_prose),
  } as T;
}

/** Return a copy with the adjudicator's prose fields redacted; all other fields are preserved. */
export function sanitize_adjudication_prose<T extends AdjudicationProse>(adjudication: T): T {
  return {
    ...adjudication,
    reasoning_summary: redact_prose(adjudication.reasoning_summary),
    why_not_higher: adjudication.why_not_higher.map(redact_prose),
    why_not_lower: adjudication.why_not_lower.map(redact_prose),
  } as T;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test test/prose_redaction.test.ts`
Expected: PASS (all describe blocks).

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/prose_redaction.ts test/prose_redaction.test.ts
git commit -m "feat(agents): object-level prose sanitizers, leak count, OE_PROSE_REDACT gate"
```

---

## Task 3: Prompt "writing register" lever (`OE_PROSE_REGISTER`)

**Files:**
- Modify: `src/agents/prompts.ts` (flag near line 27; glossary + builders near line 40 and in `heuristic_user_prompt`/`grouped_heuristic_user_prompt`/`master_adjudication_user_prompt`)
- Test: `test/prose_redaction.test.ts` (reuse file) — or add `test/prompts_register.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/prompts_register.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { _prose_register_lines, buildProseRegisterLines } from "../src/agents/prompts.ts";

describe("buildProseRegisterLines (pure content)", () => {
  test("includes the register heading, the named fields, glossary, and a coverage guard", () => {
    const lines = buildProseRegisterLines("finding, caveats, missing_evidence");
    const text = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(text).toContain("Writing register");
    expect(text).toContain("finding, caveats, missing_evidence");
    expect(text).toContain("property-tax record");
    expect(text.toLowerCase()).toContain("dimension");
  });
});

describe("_prose_register_lines (gated)", () => {
  test("is empty by default (flag off) so prompts are byte-identical", () => {
    expect(_prose_register_lines("finding, caveats, missing_evidence")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/prompts_register.test.ts`
Expected: FAIL — `buildProseRegisterLines` / `_prose_register_lines` not exported.

- [ ] **Step 3a: Add the flag + glossary + builders to `prompts.ts`**

In `src/agents/prompts.ts`, immediately after the `_SYNTH_AUGMENT_ENABLED` const (ends line 29), add:

```ts
// Gated by OE_PROSE_REGISTER so the human-readable writing register can be A/B'd against baseline
// without CLI plumbing (mirrors OE_SYNTH_AUGMENT). Off by default: prompts are unchanged until enabled.
const _PROSE_REGISTER_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.OE_PROSE_REGISTER ?? "").trim().toLowerCase(),
);

// Plain-language names for each source, shared with the reader in the register so the model has
// consistent replacement language for internal record types.
const SOURCE_HUMAN_PHRASES: Record<string, string> = {
  tax: "property-tax record",
  base: "identity/residence record",
  utility: "utility service record",
  drive: "driver's-license record",
  voter: "voter-registration record",
  auto: "vehicle-registration record",
  loan: "mortgage/loan application record",
  trace: "address-history record",
  criminal: "criminal record",
};

// The register instructions themselves (unconditional; the gate lives in _prose_register_lines).
// `fields` names the prose fields this agent submits, e.g. "finding, caveats, missing_evidence".
export function buildProseRegisterLines(fields: string): string[] {
  const glossary = Object.entries(SOURCE_HUMAN_PHRASES)
    .map(([code, phrase]) => `${code} → ${phrase}`)
    .join("; ");
  return [
    `Writing register (applies to every prose field you submit: ${fields}):`,
    "- Write for a non-technical risk decision-maker in plain, professional English. No data-engineering jargon.",
    "- Do NOT name internal data structures in prose: no database table names, GraphQL field names, source-bucket codes, or column names. Describe the KIND of record in plain language instead.",
    `- Use these plain-language record names: ${glossary}.`,
    '- Do NOT quote raw stored values or column=value pairs. Translate them to meaning (e.g. not "own_rent=0" but "the mortgage application lists the occupant as a renter"; not "ownerrescount=3" but "the owner is linked to three properties").',
    "- Keep citing precisely in the STRUCTURED fields (evidence_for, evidence_against, evidence_refs) using source/table/rowid — those are machine anchors, excluded from what the user sees. Cite precisely there; narrate cleanly in the prose.",
    "- This changes wording only, never substance: still explicitly state a conclusion for every required dimension and sub-signal. Humanizing must NOT drop, merge, or hedge any dimension.",
  ];
}

export function _prose_register_lines(fields: string): string[] {
  return _PROSE_REGISTER_ENABLED ? buildProseRegisterLines(fields) : [];
}
```

- [ ] **Step 3b: Wire the lines into `heuristic_user_prompt` (both branches)**

In the packet branch of `heuristic_user_prompt`, the returned array currently ends (around line 173) with:

```ts
      "- Use score 0 for inconclusive.",
    ].join("\n");
```

Change it to:

```ts
      "- Use score 0 for inconclusive.",
      ..._prose_register_lines("finding, caveats, missing_evidence"),
    ].join("\n");
```

In the non-packet branch, the `.concat([...])` list currently ends (around line 219-220) with:

```ts
      "Separate supporting rows in evidence_for, contradicting/mitigating rows in evidence_against,",
      "and unavailable or insufficient facts in missing_evidence.",
    ])
    .join("\n");
```

Change it to:

```ts
      "Separate supporting rows in evidence_for, contradicting/mitigating rows in evidence_against,",
      "and unavailable or insufficient facts in missing_evidence.",
      ..._prose_register_lines("finding, caveats, missing_evidence"),
    ])
    .join("\n");
```

- [ ] **Step 3c: Wire the lines into `grouped_heuristic_user_prompt`**

The final returned array currently ends (around line 318-319) with:

```ts
    "- Use inconclusive (score 0) when data availability, query failure, identity ambiguity, or conflicting evidence prevents a defensible conclusion for that packet.",
  ].join("\n");
```

Change it to:

```ts
    "- Use inconclusive (score 0) when data availability, query failure, identity ambiguity, or conflicting evidence prevents a defensible conclusion for that packet.",
    ..._prose_register_lines("finding, caveats, missing_evidence"),
  ].join("\n");
```

- [ ] **Step 3d: Wire the lines into `master_adjudication_user_prompt`**

The final returned array currently ends (around line 509-510) with:

```ts
    "- Submit using submit_case_adjudication. Include keys: raw_score, calibrated_score,",
    "  clarity_score, verdict_band, case_archetype, score_adjustments, reasoning_summary,",
    "  why_not_higher, why_not_lower.",
  ].join("\n");
```

Change it to:

```ts
    "- Submit using submit_case_adjudication. Include keys: raw_score, calibrated_score,",
    "  clarity_score, verdict_band, case_archetype, score_adjustments, reasoning_summary,",
    "  why_not_higher, why_not_lower.",
    ..._prose_register_lines("reasoning_summary, why_not_higher, why_not_lower"),
  ].join("\n");
```

- [ ] **Step 4: Run test + typecheck**

Run: `bun test test/prompts_register.test.ts`
Expected: PASS (both describe blocks).

Run: `bun test`
Expected: PASS — full suite green (default flags off ⇒ existing behavior unchanged).

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/prompts.ts test/prompts_register.test.ts
git commit -m "feat(agents): OE_PROSE_REGISTER human-readable writing register in prompt builders"
```

---

## Task 4: Orchestrator finalization scrub + `prose_leak_count` metric

**Files:**
- Modify: `src/agents/orchestrator.ts` (imports near line 53; `_investigate` lines ~304-343; `_agent_metrics` lines ~1095-1115)
- Test: `test/prose_redaction.test.ts` (add an integration test through `build_report`)

- [ ] **Step 1: Write the failing test**

Append to `test/prose_redaction.test.ts`:

```ts
import { build_report } from "../src/agents/orchestrator.ts";
import { CaseAdjudicationSchema, HeuristicAgentResultSchema } from "../src/agents/models.ts";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/prose_redaction.test.ts`
Expected: FAIL — the assertion fails because `build_report` today emits the raw `loanRecords`/`own_rent` text (the sanitizers are applied in the test, but this proves the composition; if it already passes because the test applies the sanitizers, skip to Step 3 — the real target of this task is the orchestrator wiring below). If it PASSES immediately, that is fine: it locks in the shipping-path composition. Proceed to Step 3 regardless.

- [ ] **Step 3a: Add the import to `orchestrator.ts`**

After the existing import block (the `import { evaluate_packet_gates } ...` line ~56 / `MetricsRecorder` line ~57), add:

```ts
import {
  count_prose_leaks,
  proseRedactEnabled,
  sanitize_adjudication_prose,
  sanitize_result_prose,
} from "./prose_redaction.ts";
```

- [ ] **Step 3b: Add the finalization scrub in `_investigate`**

Locate this block in `_investigate` (around lines 304-315):

```ts
    const caveats = [...new Set(results.flatMap((result) => result.caveats))].sort();
    caveats.push(..._global_caveats(context, results));
    const report = await recorder.span("report_build", { agent_id: "orchestrator" }, () =>
      build_report(adjudication, scoring.score_breakdown.final_score, results, scoring.conflicts),
    );
    const agent_metrics = _agent_metrics({
      candidate_count,
      gated_count: candidate_heuristics.length,
      plan: investigation_plan,
      results,
      report,
    });
```

Replace it with:

```ts
    // Finalization: humanize the human-facing prose (gated by OE_PROSE_REDACT) AFTER adjudication
    // and BEFORE the report is assembled. Running it after adjudication keeps it a pure output
    // filter that never perturbs the adjudicator's inputs (so the redact-only experiment arm is
    // verdict-neutral); running it before build_report lets the derived report inherit clean text.
    const finalResults = proseRedactEnabled() ? results.map((r) => sanitize_result_prose(r)) : results;
    const finalAdjudication = proseRedactEnabled() ? sanitize_adjudication_prose(adjudication) : adjudication;

    const caveats = [...new Set(finalResults.flatMap((result) => result.caveats))].sort();
    caveats.push(..._global_caveats(context, finalResults));
    const report = await recorder.span("report_build", { agent_id: "orchestrator" }, () =>
      build_report(finalAdjudication, scoring.score_breakdown.final_score, finalResults, scoring.conflicts),
    );
    const agent_metrics = _agent_metrics({
      candidate_count,
      gated_count: candidate_heuristics.length,
      plan: investigation_plan,
      results: finalResults,
      adjudication: finalAdjudication,
      report,
    });
```

- [ ] **Step 3c: Use the finalized values in the assessment**

In the `assessment` object literal just below (around lines 330-338), change the two lines that reference the pre-scrub values:

```ts
      adjudication,
```
→
```ts
      adjudication: finalAdjudication,
```

and

```ts
      heuristics: results,
```
→
```ts
      heuristics: finalResults,
```

(Leave every other field of the assessment untouched.)

- [ ] **Step 3d: Add `prose_leak_count` to `_agent_metrics`**

Locate `_agent_metrics` (around lines 1095-1115). Change its signature and body:

```ts
function _agent_metrics(opts: {
  candidate_count: number;
  gated_count: number;
  plan: CaseInvestigationPlan;
  results: HeuristicAgentResult[];
  report: string;
}): Record<string, any> {
  const { candidate_count, gated_count, plan, results, report } = opts;
  return {
    candidate_packets: candidate_count,
    gated_packets: gated_count,
    skipped_packets: plan.skipped.length,
    launched_subagents: results.length,
    graphql_query_count: results.reduce((acc, result) => acc + result.graphql_queries.length, 0),
    tool_error_count: results.reduce((acc, result) => acc + result.tool_errors.length, 0),
    validation_error_count: results.reduce((acc, result) => acc + result.validation_errors.length, 0),
    query_repair_attempts: results.reduce((acc, result) => acc + result.query_repair_attempts, 0),
    evidence_refs_count: results.reduce((acc, result) => acc + result.evidence_refs.length, 0),
    report_bytes_estimate: Buffer.byteLength(report, "utf8"),
  };
}
```

to:

```ts
function _agent_metrics(opts: {
  candidate_count: number;
  gated_count: number;
  plan: CaseInvestigationPlan;
  results: HeuristicAgentResult[];
  adjudication: CaseAdjudication;
  report: string;
}): Record<string, any> {
  const { candidate_count, gated_count, plan, results, adjudication, report } = opts;
  // Always measured (both flags on and off) so the A/B can read leakage before vs after.
  const prose_texts = [
    ...results.flatMap((r) => [r.finding, ...r.caveats, ...r.missing_evidence]),
    adjudication.reasoning_summary,
    ...adjudication.why_not_higher,
    ...adjudication.why_not_lower,
    report,
  ];
  return {
    candidate_packets: candidate_count,
    gated_packets: gated_count,
    skipped_packets: plan.skipped.length,
    launched_subagents: results.length,
    graphql_query_count: results.reduce((acc, result) => acc + result.graphql_queries.length, 0),
    tool_error_count: results.reduce((acc, result) => acc + result.tool_errors.length, 0),
    validation_error_count: results.reduce((acc, result) => acc + result.validation_errors.length, 0),
    query_repair_attempts: results.reduce((acc, result) => acc + result.query_repair_attempts, 0),
    evidence_refs_count: results.reduce((acc, result) => acc + result.evidence_refs.length, 0),
    report_bytes_estimate: Buffer.byteLength(report, "utf8"),
    prose_leak_count: count_prose_leaks(prose_texts),
  };
}
```

(`CaseAdjudication` is already imported as a type in `orchestrator.ts`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test`
Expected: PASS — full suite green, including the new integration test.

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator.ts test/prose_redaction.test.ts
git commit -m "feat(agents): gated prose scrub finalization pass + prose_leak_count metric"
```

---

## Task 5: Live smoke of the flags + experiment runbook

**Files:**
- Modify: `docs/superpowers/specs/2026-07-15-humanize-agent-prose-design.md` (append runbook)

- [ ] **Step 1: Baseline smoke (flags off)**

Run one address with metrics and confirm today's behavior + a baseline leak count is emitted. Use a known-good address for your environment (replace `<ADDR>`/`<ZIP>`):

Run: `bun run cli/run_address.ts "<ADDR>" --zip <ZIP>`
Expected: completes; the assessment's `agent_metrics` now includes a `prose_leak_count` field (likely > 0 on a data-rich case). Prose still contains internal terms — this is the baseline arm.

- [ ] **Step 2: Redact-only smoke**

Run: `OE_PROSE_REDACT=on bun run cli/run_address.ts "<ADDR>" --zip <ZIP>`
Expected: same verdict_band / case_archetype as Step 1 (redact is a post-adjudication output filter); `prose_leak_count` drops toward 0; `report`/`finding`/`reasoning_summary` no longer contain camelCase field names or `column=value`.

- [ ] **Step 3: Full smoke (both flags)**

Run: `OE_PROSE_REGISTER=on OE_PROSE_REDACT=on bun run cli/run_address.ts "<ADDR>" --zip <ZIP>`
Expected: `prose_leak_count` 0; prose reads as plain professional English; every packet's `finding` still concludes on its dimensions (eyeball against Step 1's findings — no dimension dropped).

- [ ] **Step 4: Append the experiment runbook to the spec**

Append this section to `docs/superpowers/specs/2026-07-15-humanize-agent-prose-design.md`:

```markdown
## Experiment runbook (gated A/B)

Flags (both default off): `OE_PROSE_REGISTER` (prompt register lever), `OE_PROSE_REDACT` (deterministic scrub lever). Enable with any of `1|true|yes|on`.

Run each arm on the fixed case set at temperature 0, repeated a few times to separate signal from LLM noise. For each run capture: (1) the external `judge/` package dimension-coverage score, (2) verdict_band + case_archetype (per case), and (3) `agent_metrics.prose_leak_count`.

- **Arm A — Baseline** (no flags): reference coverage, verdicts, and baseline leak count.
- **Arm B — Redact-only** (`OE_PROSE_REDACT=on`): expect coverage ≈ Arm A and verdicts identical (post-adjudication output filter); `prose_leak_count` → 0. Confirms the security fix is coverage- and verdict-neutral.
- **Arm C — Full** (`OE_PROSE_REGISTER=on OE_PROSE_REDACT=on`): ship gate — aggregate coverage within tolerance of Arm A AND band/archetype match unchanged AND `prose_leak_count` 0.

Ship-gate tolerance (default, tunable): no single packet loses a dimension; aggregate coverage within ±1 dimension across the set. If Arm C moves band/archetype, treat as a regression and investigate before shipping. Once validated, flip the flag defaults to on (or keep them for continued A/B).
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-15-humanize-agent-prose-design.md
git commit -m "docs: prose-humanization experiment runbook (gated A/B protocol)"
```

---

## Final verification

- [ ] `bun test` — full suite green.
- [ ] `bunx tsc --noEmit` — no type errors.
- [ ] With no flags set, a diff of prompt-builder output and assessment JSON vs. `main` for a fixed case is empty (default-off ⇒ byte-identical behavior).
- [ ] `prose_leak_count` present in `agent_metrics`; 0 under `OE_PROSE_REDACT=on`.
