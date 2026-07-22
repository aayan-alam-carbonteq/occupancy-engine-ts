# Full-Surface Prose Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove internal data-surface vocabulary (source-tag citations, row ids, `column=value` pairs, snake_case enums, and the obscure `situs` jargon) from every string a human investigator sees in the assessment JSON — both the model's free prose and the deterministic `evidence_map` display strings — without changing what the model concludes.

**Architecture:** A single finalization pass over the human-facing string surface, run after all model work. Two components: (A) extend the deterministic scrubber (`prose_redaction.ts`) with the leak classes it currently misses, and flip it default-on; (B) a new value-aware humanizer (`prose_display.ts`) that rewrites the deterministic `evidence_map` strings on a **display copy** at orchestrator finalization, leaving the prompt-grounding copy byte-identical. Both are coverage-neutral and default-on; the prompt-register lever stays gated behind `OE_PROSE_REGISTER`.

**Tech Stack:** TypeScript, Bun (`bun test`), Zod schemas, Biome. Engine repo, branch `feat/prose-refinement-full-surface`.

**Spec:** [docs/superpowers/specs/2026-07-22-prose-refinement-full-surface-design.md](../specs/2026-07-22-prose-refinement-full-surface-design.md)

---

## File Structure

- **Modify** `src/agents/prose_redaction.ts` — add four leak-pattern classes to `detect_leaks`/`redact_prose`; invert the `OE_PROSE_REDACT` default to on (opt-out).
- **Create** `src/agents/prose_display.ts` — value-aware humanizer for the deterministic `evidence_map` display strings (owner summaries, person summaries, non-owner-occupancy hints).
- **Modify** `src/agents/orchestrator.ts` — at finalization, place a humanized display copy of `context.evidence_map` into `resolved_address`; extend `_agent_metrics` `prose_texts` with the humanized display strings.
- **Modify** `test/prose_redaction.test.ts` — new-class tests; update the default-state test to expect on + opt-out.
- **Create** `test/prose_display.test.ts` — raw→humanized table + immutability (grounding-integrity) assertion.

Conventions to follow (already in the repo): `bun:test` (`import { describe, expect, test } from "bun:test";`), snake_case exported functions in `prose_redaction.ts`, one focused responsibility per file. Run a single test file with `bun test <path>`; filter by name with `-t "<substring>"`.

---

## Task 1: Extend the scrubber with the four missing leak classes

**Files:**
- Modify: `src/agents/prose_redaction.ts`
- Test: `test/prose_redaction.test.ts`

Today `detect_leaks`/`redact_prose` only recognize identifier-*shaped* tokens (`CAMEL_RE`/`SNAKE_RE`) plus the enumerated `SCHEMA_TOKEN_PHRASES`. Four classes from the baseline `demo_response.json` survive: source-tag citations (`TAX:68344`), row ids (`rowid 1296784`, `cd113530`), bare `word=value` where the left side is an ordinary word (`residential=True`), and the jargon term `situs`. This task adds all four as pure substitution/detection, keeping the existing false-positive guards intact (owner names like "McDonald", `LTV`/`CLTV`, `constructor`).

- [ ] **Step 1: Write the failing tests**

Append to `test/prose_redaction.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/prose_redaction.test.ts -t "new leak classes"`
Expected: FAIL (source-tag/rowid/word=value/situs not yet handled).

- [ ] **Step 3: Add the new pattern constants**

In `src/agents/prose_redaction.ts`, after the existing regex block (`ASSIGN_RE`, around line 183), add:

```ts
// Source-tag CITATIONS the model embeds inline, e.g. "TAX:68344", "LOAN:74141-74144".
// These are not identifier-shaped, so CAMEL_RE/SNAKE_RE miss them. The digits/ranges are the
// machine anchor — it lives in the structured evidence fields, so we strip it from prose entirely.
const SOURCE_TAGS = "TAX|LOAN|BASE|TRACE|UTILITY|VOTER|DRIVE|AUTO|CRIMINAL";
const SOURCE_REF_RE = new RegExp(`\\b(?:${SOURCE_TAGS}):\\d[\\d-]*`, "gi");
// A parenthetical wrapping ONLY source-tag citations (optionally comma/space separated), e.g.
// " (TAX:68344)" or " (LOAN:74141-74144)". Removed whole so no empty "()" is left behind.
const SOURCE_REF_PARENS_RE = new RegExp(
  `\\s*\\((?:${SOURCE_TAGS}):\\d[\\d-]*(?:[\\s,]+(?:${SOURCE_TAGS}):\\d[\\d-]*)*\\)`,
  "gi",
);
// Row / record ids: "rowid 1296784" and opaque trace codes like "cd113530" (letter prefix + a
// long digit run). Both are internal record references, not meaningful to a human reader.
const ROWID_RE = /\browid\s+\d+/gi;
const TRACE_CODE_RE = /\bcd\d{4,}\b/gi;
// Bare `word=value` where the value is a raw data literal (boolean / null / number / quoted /
// ALL-CAPS code). The existing ASSIGN_RE only fires when the LEFT side is identifier-shaped, so
// "residential=True" / "condo=False" slip through. Collapse to the plain word, dropping "=value".
const BARE_ASSIGN_RE =
  /\b([A-Za-z][A-Za-z0-9]*)=(?:"[^"]*"|'[^']*'|True|False|None|null|NULL|-?\d[\d,.]*|[A-Z][A-Z0-9_]+)\b/g;
// Obscure legal jargon → plain wording. Standard finance terms (LTV, CLTV) are deliberately kept.
const JARGON_PHRASES: Record<string, string> = {
  "situs address": "subject address",
  situs: "subject property",
};
const JARGON_RE = /\bsitus(?:\s+address)?\b/gi;
```

- [ ] **Step 4: Teach `detect_leaks` the new classes**

Replace the body of `detect_leaks` (currently lines ~211-226) with a version that counts the new patterns first, then the existing token scan:

```ts
export function detect_leaks(text: string): string[] {
  if (!text) {
    return [];
  }
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (token: string) => {
    const key = token.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(token);
    }
  };
  for (const re of [SOURCE_REF_RE, ROWID_RE, TRACE_CODE_RE, JARGON_RE]) {
    for (const m of text.matchAll(re)) {
      push(m[0]);
    }
  }
  for (const m of text.matchAll(BARE_ASSIGN_RE)) {
    push(m[0]);
  }
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    if (isIdentifierToken(token)) {
      push(token);
    }
  }
  return found;
}
```

- [ ] **Step 5: Teach `redact_prose` the new classes**

Replace the body of `redact_prose` (currently lines ~234-244) so the new passes run before the existing identifier passes:

```ts
export function redact_prose(text: string): string {
  if (!text) {
    return text;
  }
  let out = text.replace(SOURCE_REF_PARENS_RE, "");
  out = out.replace(SOURCE_REF_RE, "");
  out = out.replace(ROWID_RE, "");
  out = out.replace(TRACE_CODE_RE, "");
  out = out.replace(JARGON_RE, (m) => JARGON_PHRASES[m.toLowerCase()] ?? "the subject property");
  out = out.replace(BARE_ASSIGN_RE, (_whole, word: string) => word);
  out = out.replace(ASSIGN_RE, (whole, ident: string) =>
    isIdentifierToken(ident) ? phraseFor(ident) : whole,
  );
  out = out.replace(TOKEN_RE, (token) => (isIdentifierToken(token) ? phraseFor(token) : token));
  // Drop empty parens left when an INNER ref was stripped but the parens were not a pure
  // source-tag citation (e.g. "(rowid 1296784)" → "()"), then collapse leftover whitespace.
  out = out.replace(/\s*\(\s*\)/g, "");
  return out.replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").trim();
}
```

Traced cases:
- `"Tax owner WINKFIELD (TAX:68344) is identified."` → `SOURCE_REF_PARENS_RE` removes ` (TAX:68344)` → `"Tax owner WINKFIELD is identified."`
- `"four loan records (LOAN:74141-74144) at"` → `"four loan records at"`
- `"utility account (rowid 1296784) and trace cd113530 present"` → `ROWID_RE`/`TRACE_CODE_RE` strip the ids leaving `"utility account () and trace  present"` → empty-parens + whitespace cleanup → `"utility account and trace present"`

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `bun test test/prose_redaction.test.ts -t "new leak classes"`
Expected: PASS (all 6).

- [ ] **Step 7: Run the FULL prose_redaction suite to catch regressions**

Run: `bun test test/prose_redaction.test.ts`
Expected: all pass EXCEPT `proseRedactEnabled > is off by default` (fixed in Task 2). If any *other* test fails (e.g. a clean-prose false positive), narrow the offending regex before moving on.

- [ ] **Step 8: Commit**

```bash
git add src/agents/prose_redaction.ts test/prose_redaction.test.ts
git commit -m "feat(prose): scrubber catches source-tag refs, row ids, bare word=value, situs"
```

---

## Task 2: Flip the scrubber default to on (opt-out)

**Files:**
- Modify: `src/agents/prose_redaction.ts:246-253`
- Test: `test/prose_redaction.test.ts:139-143`

The scrubber is coverage-neutral by construction, and the rollout decision is "ship it on by default." Invert `proseRedactEnabled()`: unset/empty → **enabled**; disable only with an explicit falsy value (`0|false|no|off`) for the baseline experiment arm. `OE_PROSE_REGISTER` (the risky prompt lever) is untouched and stays default-off.

- [ ] **Step 1: Update the default-state test**

In `test/prose_redaction.test.ts`, replace the existing block (lines ~139-143):

```ts
describe("proseRedactEnabled", () => {
  test("is off by default", () => {
    expect(proseRedactEnabled()).toBe(false);
  });
});
```

with:

```ts
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
```

Add `afterEach` to the existing `bun:test` import at the top of the file:
`import { afterEach, describe, expect, test } from "bun:test";`

Note: `proseRedactEnabled()` must read `process.env` at call time (not a module-load constant) for the env overrides above to take effect — Step 3 makes it do so.

- [ ] **Step 2: Run to verify the new default test fails**

Run: `bun test test/prose_redaction.test.ts -t "proseRedactEnabled"`
Expected: FAIL ("is on by default" expects true, current default is false).

- [ ] **Step 3: Invert the default in the source**

In `src/agents/prose_redaction.ts`, replace the gate (lines ~246-253):

```ts
// Gated so nothing changes until explicitly enabled (mirrors OE_SYNTH_AUGMENT / OE_PROMPT_CACHE).
const _REDACT_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.OE_PROSE_REDACT ?? "").trim().toLowerCase(),
);

export function proseRedactEnabled(): boolean {
  return _REDACT_ENABLED;
}
```

with (default-on, opt-out, evaluated per call):

```ts
// Default-ON: the scrubber is coverage-neutral by construction, so it ships enabled. Disable
// only with an explicit falsy value (0|false|no|off) to capture the baseline experiment arm.
// Read at call time so tests and per-run env can flip it. (Contrast OE_PROSE_REGISTER, the
// prompt lever with real coverage risk, which stays default-off.)
export function proseRedactEnabled(): boolean {
  const raw = (process.env.OE_PROSE_REDACT ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}
```

- [ ] **Step 4: Run the proseRedactEnabled tests to verify pass**

Run: `bun test test/prose_redaction.test.ts -t "proseRedactEnabled"`
Expected: PASS (both).

- [ ] **Step 5: Run the full prose_redaction suite**

Run: `bun test test/prose_redaction.test.ts`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/prose_redaction.ts test/prose_redaction.test.ts
git commit -m "feat(prose): scrubber default-on with explicit opt-out"
```

---

## Task 3: Value-aware humanizer for the deterministic evidence strings

**Files:**
- Create: `src/agents/prose_display.ts`
- Test: `test/prose_display.test.ts`

The `evidence_map` display strings are semi-structured (`key=value; key=value`) and carry values a generic scrubber would lose (`totallienbalance=83000.0` → "$83,000"). This module parses those bits and re-renders them as clean sentences, reusing the source→phrase glossary already exported from `prompts.ts` (`SOURCE_HUMAN_PHRASES`) so wording matches the register lever. Three public translators, one per string shape.

- [ ] **Step 1: Write the failing tests**

Create `test/prose_display.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  humanizeNonownerHint,
  humanizeOwnerSummary,
  humanizePersonSummary,
} from "../src/agents/prose_display.ts";

describe("humanizePersonSummary", () => {
  test("renders a loan record with renter tenure, dropping address/dob", () => {
    expect(humanizePersonSummary("loan; own_rent=0; address=1552 SAMARA GLEN WAY; zip=40515")).toBe(
      "Mortgage/loan application record; listed as a renter",
    );
  });
  test("renders unknown tenure as 'tenure not stated'", () => {
    expect(humanizePersonSummary("loan; own_rent=U; address=1552 SAMARA GLEN WAY; dob_year=1975")).toBe(
      "Mortgage/loan application record; tenure not stated",
    );
  });
  test("renders a bare trace record with no extra bits", () => {
    expect(humanizePersonSummary("trace; address=1552 SAMARA GLEN WAY; zip=40515; dob_year=0")).toBe(
      "Address-history record",
    );
  });
});

describe("humanizeOwnerSummary", () => {
  test("renders owner, mailing, residential, lien math, and property count", () => {
    const raw =
      "owner=WINKFIELD, JERAHMY S; mailing=209 FALCON DR VERSAILLES KY 40383; residential=True; condo=False; lendername=NOT AVAILABLE; totalliencount=1; totallienbalance=83000.0; ownerrescount=1";
    expect(humanizeOwnerSummary(raw)).toBe(
      "Owner Winkfield, Jerahmy S; mailing address 209 FALCON DR VERSAILLES KY 40383; residential property; 1 lien totaling $83,000; owner linked to 1 property",
    );
  });
});

describe("humanizeNonownerHint", () => {
  test("maps the relationship enum and the source list, title-casing the name", () => {
    expect(humanizeNonownerHint("likely_family person at address via trace: JEREHMY WINKFIELD.")).toBe(
      "Likely a family member, in address-history records: Jerehmy Winkfield.",
    );
    expect(humanizeNonownerHint("unrelated person at address via base: DONALD R CAIN.")).toBe(
      "Unrelated person, in identity/residence records: Donald R Cain.",
    );
  });
  test("passes a string that does not match the template through unchanged", () => {
    expect(humanizeNonownerHint("Some other hint.")).toBe("Some other hint.");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/prose_display.test.ts`
Expected: FAIL ("Cannot find module '../src/agents/prose_display.ts'").

- [ ] **Step 3: Implement the module**

Create `src/agents/prose_display.ts`:

```ts
// Value-aware humanizer for the DETERMINISTIC evidence_map display strings. These are built by
// orchestrator (_owner_summaries / _people_at_address_summaries / _nonowner_occupancy_hints) as
// "key=value; key=value" bit-strings and are ALSO fed to prompts as grounding — so this module
// NEVER mutates in place: it maps to NEW strings for a display copy only (see orchestrator
// finalization). Unlike the scrubber it keeps meaning: "1 lien totaling $83,000", not "a lien field".
import { SOURCE_HUMAN_PHRASES } from "./prompts.ts";

const RELATIONSHIP_DISPLAY: Record<string, string> = {
  likely_family: "Likely a family member",
  unrelated: "Unrelated person",
  unknown: "Relationship unknown",
  owner: "The owner",
};

// own_rent / ownRent stored codes → plain tenure phrase.
const OWN_RENT_DISPLAY: Record<string, string> = {
  "0": "listed as a renter",
  "1": "listed as owner-occupant",
  o: "listed as owner-occupant",
  own: "listed as owner-occupant",
  r: "listed as a renter",
  rent: "listed as a renter",
  u: "tenure not stated",
  "": "tenure not stated",
};

/** Source code → capitalized human record name, e.g. "loan" → "Mortgage/loan application record". */
function sourcePhrase(code: string): string {
  const phrase = SOURCE_HUMAN_PHRASES[code] ?? "record";
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** "in <phrase>, <phrase>" for a comma/space-separated list of source codes. */
function sourceListPhrase(codes: string): string {
  const parts = codes
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((c) => `${SOURCE_HUMAN_PHRASES[c] ?? "record"}s`);
  return parts.join(", ");
}

/** "DONALD R CAIN" → "Donald R Cain"; "WINKFIELD, JERAHMY S" → "Winkfield, Jerahmy S". */
function titleCaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a "lead; key=value; key=value" bit-string. First bit may be a bare source code. */
function parseBits(raw: string): { lead: string | null; fields: Map<string, string> } {
  const parts = raw.split(";").map((p) => p.trim()).filter(Boolean);
  const fields = new Map<string, string>();
  let lead: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      if (lead === null) lead = part;
      continue;
    }
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return { lead, fields };
}

/** Format "83000.0" → "83,000" (drop cents, thousands separators). */
function formatMoney(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return Math.round(n).toLocaleString("en-US");
}

/** A person-at-address summary: "loan; own_rent=0; address=…" → "Mortgage/loan application record; listed as a renter". */
export function humanizePersonSummary(raw: string): string {
  const { lead, fields } = parseBits(raw);
  const out: string[] = [];
  if (lead) out.push(sourcePhrase(lead));
  const tenure = fields.get("own_rent") ?? fields.get("ownRent");
  if (tenure !== undefined) {
    out.push(OWN_RENT_DISPLAY[tenure.toLowerCase()] ?? "tenure recorded");
  }
  // address / zip / dob / dob_year / year / make / model are dropped (redundant or PII-ish).
  return out.join("; ");
}

/** An owner summary: "owner=…; residential=True; totalliencount=1; totallienbalance=83000.0; …". */
export function humanizeOwnerSummary(raw: string): string {
  const { fields } = parseBits(raw);
  const out: string[] = [];
  const owner = fields.get("owner");
  if (owner) out.push(`Owner ${titleCaseName(owner)}`);
  const mailing = fields.get("mailing");
  if (mailing) out.push(`mailing address ${mailing}`);
  if ((fields.get("residential") ?? "").toLowerCase() === "true") out.push("residential property");
  if ((fields.get("condo") ?? "").toLowerCase() === "true") out.push("condominium");
  const lender = fields.get("lendername");
  if (lender && lender.toUpperCase() !== "NOT AVAILABLE") out.push(`lender ${lender}`);
  const lienCount = fields.get("totalliencount");
  if (lienCount && Number(lienCount) > 0) {
    const n = Number(lienCount);
    const balance = fields.get("totallienbalance");
    const balPart = balance ? ` totaling $${formatMoney(balance)}` : "";
    out.push(`${n} lien${n === 1 ? "" : "s"}${balPart}`);
  }
  const resCount = fields.get("ownerrescount");
  if (resCount) {
    const n = Number(resCount);
    out.push(`owner linked to ${n} propert${n === 1 ? "y" : "ies"}`);
  }
  const recorded = fields.get("recordingdate");
  if (recorded) out.push(`recorded ${recorded}`);
  return out.join("; ");
}

const NONOWNER_HINT_RE = /^(\w+) person at address via ([^:]+):\s*(.+?)\.?$/;

/** A non-owner-occupancy hint: "likely_family person at address via trace: NAME." */
export function humanizeNonownerHint(raw: string): string {
  const m = NONOWNER_HINT_RE.exec(raw);
  if (!m) return raw;
  const [, rel, sources, name] = m;
  const relPhrase = RELATIONSHIP_DISPLAY[rel!] ?? rel!;
  return `${relPhrase}, in ${sourceListPhrase(sources!)}: ${titleCaseName(name!)}.`;
}
```

- [ ] **Step 4: Confirm `SOURCE_HUMAN_PHRASES` is exported from prompts.ts**

Run: `grep -n "export const SOURCE_HUMAN_PHRASES" src/agents/prompts.ts`
Expected: a match. If it is `const` without `export`, add `export` to its declaration (`src/agents/prompts.ts:65`).

- [ ] **Step 5: Run the tests to verify pass**

Run: `bun test test/prose_display.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/agents/prose_display.ts test/prose_display.test.ts
git commit -m "feat(prose): value-aware humanizer for evidence_map display strings"
```

---

## Task 4: Whole-map display projection + grounding-integrity guarantee

**Files:**
- Modify: `src/agents/prose_display.ts`
- Test: `test/prose_display.test.ts`

Wrap the three translators into one function that returns a NEW `CaseEvidenceMap` with the three human-facing string arrays humanized and everything else (including `evidence_refs`, the machine anchors) passed through untouched. The critical guarantee — proven by an immutability test — is that the input object is not mutated, so the copy the model already consumed for grounding stays byte-identical.

- [ ] **Step 1: Write the failing tests**

Append to `test/prose_display.test.ts`:

```ts
import { humanize_evidence_map_for_display } from "../src/agents/prose_display.ts";
import { CaseEvidenceMapSchema } from "../src/agents/models.ts";

function sampleMap() {
  return CaseEvidenceMapSchema.parse({
    normalized_address: "1552 SAMARA GLEN WAY",
    owner_summaries: [
      {
        owner_name: "WINKFIELD, JERAHMY S",
        mailing_address: "209 FALCON DR VERSAILLES KY 40383",
        mailing_matches_subject: false,
        summaries: ["owner=WINKFIELD, JERAHMY S; residential=True; totalliencount=1; totallienbalance=83000.0; ownerrescount=1"],
      },
    ],
    people_at_address: [
      { name: "DONALD CAIN", relationship_to_owner: "unrelated", sources: ["loan"], summaries: ["loan; own_rent=0; address=X"] },
    ],
    nonowner_occupancy_hints: ["unrelated person at address via loan: DONALD CAIN."],
    evidence_refs: [{ source: "tax", table: "taxProperties", rowid: 5, summary: "tax; own_rent=0" }],
  });
}

describe("humanize_evidence_map_for_display", () => {
  test("humanizes the three human-facing arrays", () => {
    const out = humanize_evidence_map_for_display(sampleMap());
    expect(out.owner_summaries[0]!.summaries[0]).toBe(
      "Owner Winkfield, Jerahmy S; residential property; 1 lien totaling $83,000; owner linked to 1 property",
    );
    expect(out.people_at_address[0]!.summaries[0]).toBe("Mortgage/loan application record; listed as a renter");
    expect(out.nonowner_occupancy_hints[0]).toBe("Unrelated person, in mortgage/loan application records: Donald Cain.");
  });

  test("leaves evidence_refs (machine anchors) untouched", () => {
    const out = humanize_evidence_map_for_display(sampleMap());
    expect(out.evidence_refs[0]!.summary).toBe("tax; own_rent=0");
  });

  test("GROUNDING INTEGRITY: does not mutate the input map", () => {
    const input = sampleMap();
    const snapshot = structuredClone(input);
    humanize_evidence_map_for_display(input);
    expect(input).toEqual(snapshot);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test test/prose_display.test.ts -t "humanize_evidence_map_for_display"`
Expected: FAIL ("humanize_evidence_map_for_display is not a function").

- [ ] **Step 3: Implement the projection**

Append to `src/agents/prose_display.ts`:

```ts
import type { CaseEvidenceMap } from "./models.ts";

/**
 * Return a NEW CaseEvidenceMap with the human-facing string arrays humanized for DISPLAY.
 * Everything else — including evidence_refs (machine anchors) — is passed through. The input is
 * never mutated: this is the copy the model already consumed for grounding, and it must stay
 * byte-identical (asserted by the grounding-integrity test).
 */
export function humanize_evidence_map_for_display(map: CaseEvidenceMap): CaseEvidenceMap {
  return {
    ...map,
    owner_summaries: map.owner_summaries.map((o) => ({ ...o, summaries: o.summaries.map(humanizeOwnerSummary) })),
    people_at_address: map.people_at_address.map((p) => ({ ...p, summaries: p.summaries.map(humanizePersonSummary) })),
    nonowner_occupancy_hints: map.nonowner_occupancy_hints.map(humanizeNonownerHint),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test test/prose_display.test.ts`
Expected: PASS (all, including grounding integrity).

- [ ] **Step 5: Commit**

```bash
git add src/agents/prose_display.ts test/prose_display.test.ts
git commit -m "feat(prose): whole-map display projection with grounding-integrity guarantee"
```

---

## Task 5: Wire the display projection into orchestrator finalization + metric

**Files:**
- Modify: `src/agents/orchestrator.ts` (finalization block ~347-394; `_agent_metrics` ~1187-1220)

At finalization the scrubber already cleans the model prose (gated by `proseRedactEnabled()`). Add the parallel move for the deterministic strings: build a display copy of `context.evidence_map` under the same gate, use it as `resolved_address`, and feed its humanized strings into `prose_leak_count` so the metric measures the served surface. The prompt-grounding `context` is consumed earlier in the pipeline, so this pure output filter cannot change coverage.

- [ ] **Step 1: Import the humanizer**

In `src/agents/orchestrator.ts`, add to the import from `./prose_redaction.ts` (lines ~65-68) a new import line just after it:

```ts
import { humanize_evidence_map_for_display } from "./prose_display.ts";
```

- [ ] **Step 2: Build the display context at finalization**

In `_investigate`, immediately after the two `final*` prose lines (currently 351-352), add:

```ts
    // Deterministic evidence_map strings are ALSO human-facing (frontend renders owner_summaries,
    // people_at_address, nonowner_occupancy_hints). Humanize a DISPLAY COPY under the same gate;
    // `context` (the prompt-grounding copy) was consumed earlier, so this cannot change coverage.
    const displayContext = proseRedactEnabled()
      ? { ...context, evidence_map: humanize_evidence_map_for_display(context.evidence_map) }
      : context;
```

- [ ] **Step 3: Use the display context in the assessment**

Change the assessment field (currently `resolved_address: context,` at line 382) to:

```ts
      resolved_address: displayContext,
```

- [ ] **Step 4: Feed humanized strings into the leak metric**

Change the `_agent_metrics` call (lines ~359-367) to pass the humanized evidence map. Add one property to the options object:

```ts
    const agent_metrics = _agent_metrics({
      candidate_count,
      gated_count: candidate_heuristics.length,
      workers_total: buckets.length,
      plan: investigation_plan,
      results: finalResults,
      adjudication: finalAdjudication,
      report,
      display_evidence_map: displayContext.evidence_map,
    });
```

Then in `_agent_metrics` (signature ~1187-1195), add `display_evidence_map` to the destructured options and its type, and extend `prose_texts` (lines ~1198-1205) to include the humanized display strings:

```ts
function _agent_metrics(opts: {
  candidate_count: number;
  gated_count: number;
  workers_total: number;
  plan: CaseInvestigationPlan;
  results: HeuristicAgentResult[];
  adjudication: CaseAdjudication;
  report: string;
  display_evidence_map: CaseEvidenceMap;
}): Record<string, any> {
  const { candidate_count, gated_count, workers_total, plan, results, adjudication, report, display_evidence_map } = opts;
  const prose_texts = [
    ...results.flatMap((r) => [r.finding, ...r.caveats, ...r.missing_evidence]),
    adjudication.reasoning_summary,
    ...adjudication.why_not_higher,
    ...adjudication.why_not_lower,
    ...adjudication.score_adjustments.map((sa) => sa.reason),
    report,
    ...display_evidence_map.owner_summaries.flatMap((o) => o.summaries),
    ...display_evidence_map.people_at_address.flatMap((p) => p.summaries),
    ...display_evidence_map.nonowner_occupancy_hints,
  ];
```

Confirm `CaseEvidenceMap` is imported in orchestrator.ts (it is used by `_evidence_map`'s return type; if the import is type-only from `./models.ts`, no change needed). Run: `grep -n "CaseEvidenceMap" src/agents/orchestrator.ts | head -3` — expect an existing reference.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors. (Catches any missed import or field-name mismatch in the wiring.)

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: all pass. Any orchestrator/assessment fixture test that asserts on `resolved_address.evidence_map` strings should now see humanized text — if a fixture snapshot fails, update the expected string to the humanized form (that is the intended change), not the code.

- [ ] **Step 7: Commit**

```bash
git add src/agents/orchestrator.ts
git commit -m "feat(prose): humanize evidence_map display copy at finalization + leak metric"
```

---

## Task 6: End-to-end verification against the baseline example

**Files:**
- Test: `test/prose_display.test.ts` (one regression test)

Prove the combined effect: the representative leaky strings from the baseline `demo_response.json` produce **zero** detected leaks after the full pass (scrubber over prose + humanizer over evidence strings).

- [ ] **Step 1: Write the end-to-end leak-count regression test**

Append to `test/prose_display.test.ts`:

```ts
import { count_prose_leaks, detect_leaks, redact_prose } from "../src/agents/prose_redaction.ts";

describe("end-to-end: baseline demo leaks are eliminated", () => {
  test("model-prose leaks are gone after redact_prose", () => {
    const finding =
      "Tax owner WINKFIELD (TAX:68344); DONALD R CAIN holds four loan records (LOAN:74141-74144); " +
      "residential=True; the situs address shows own_rent=0.";
    expect(count_prose_leaks([redact_prose(finding)])).toBe(0);
  });

  test("evidence_map display strings are leak-free after humanization", () => {
    const out = humanize_evidence_map_for_display(sampleMap());
    const strings = [
      ...out.owner_summaries.flatMap((o) => o.summaries),
      ...out.people_at_address.flatMap((p) => p.summaries),
      ...out.nonowner_occupancy_hints,
    ];
    for (const s of strings) {
      expect(detect_leaks(s)).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run the regression test**

Run: `bun test test/prose_display.test.ts -t "end-to-end"`
Expected: PASS (both). If a leak survives, note which token `detect_leaks` returns and extend the matching pattern in Task 1 (do not weaken the assertion).

- [ ] **Step 3: Full suite + typecheck + lint**

Run: `bun test && bun run typecheck && bunx biome check src/agents/prose_redaction.ts src/agents/prose_display.ts src/agents/orchestrator.ts test/prose_redaction.test.ts test/prose_display.test.ts`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/prose_display.test.ts
git commit -m "test(prose): end-to-end leak-count regression over baseline example"
```

---

## Self-Review notes (for the executor)

- **Coverage-neutrality** is guaranteed structurally: the scrubber and humanizer run only at finalization, after the model has produced everything; the grounding-integrity test (Task 4) proves the prompt copy is never mutated. No offline judge run is required for these components (it remains the gate for the *register* lever, which this plan does not enable).
- **`OE_PROSE_REGISTER` stays default-off** — not touched by any task. Only `OE_PROSE_REDACT` flips to default-on.
- **Machine anchors preserved:** `evidence_refs` / `evidence_for` / `evidence_against` are passed through untouched (Task 4 test asserts it) — they are stripped before display and must stay exact.
- If any existing fixture/snapshot test encodes the OLD leaky evidence_map strings, updating the expectation to the humanized form is correct; changing the humanizer to reproduce a leak is not.
