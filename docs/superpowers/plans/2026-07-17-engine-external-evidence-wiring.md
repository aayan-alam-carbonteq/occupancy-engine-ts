# External Evidence Wiring (engine) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the engine reason over two data surfaces the platform already produces per listing but
currently discards — STR scan results and scraped property facts — injected per-run via
`--evidence-file` and exposed only to the packets that can reason with them.

**Architecture:** Two new first-class sources, `str_scan` and `property_facts`, arrive as an
engine-owned zod-validated JSON payload, fold into `CaseEvidenceMap`, and are exposed through the
existing source-scope machinery. **An absent payload is the blind switch:** with no `--evidence-file`
the engine behaves exactly as today, so benchmarking (blind) and prod (enriched) run identical code
and differ only by an input.

**Tech Stack:** Bun 1.3.10 + TypeScript + zod 3 (`.strict()`) + LangChain.js; `bun test`; Biome.

**Spec:** `../../../../docs/superpowers/specs/2026-07-17-engine-external-evidence-wiring-design.md`
— approved. Its **Grounding facts** carry every load-bearing claim with file:line; **do not
re-derive them.** Read its **Corrections** section: three of this plan's tasks exist because of it.

**Umbrella:** `../../../../docs/superpowers/plans/2026-07-17-engine-external-evidence-wiring.md` —
owns the **pinned contract** and the **pinned exposure map**. Honor them exactly.

**Branch:** `feat/external-evidence`, cut from **`main`** (`scripts/repo-branch.sh engine` → `main`;
promotion is `main` alone). Every `git checkout -b`, PR base and merge targets `main` — never
`staging`, never a rewrite of anyone's `main`.

**Conventions:** `src/**` uses snake_case functions + PascalCase schemas; `cli/**` uses camelCase.
`.strict()` on every schema. **Native TS only — no Python-referencing names or comments.**

---

## ⛔ Task 0 is a hard gate. Read it before anything else.

`main` is **37 commits behind** `feat/humanize-agent-prose` and is a **strict ancestor** of it
(`git rev-list --left-right --count main...feat/humanize-agent-prose` → `0 37`). Verified: `main`
has **no** `AGENTS.md`, `PROGRESS.md`, `feature_list.json`, `biome.json`, `test/e2e/`,
`test/support/`, and **no `verify` / `lint` / `e2e` scripts in `package.json`**.

**This plan's every task — and this repo's Definition of Done — assumes the harness tree.** Cutting
from `main` as it stands makes `bun run verify`, the feature_list entry and the E2E parity guard
impossible, and every file:line below wrong.

Every reference in this plan is against the harness tree (`fc990bd`), which Task 0 makes `main`.

---

### Task 0: Fast-forward `main`, then cut the branch

**Files:** none (git only).

- [ ] **Step 1: Confirm the base from config — never hardcode**

Run: `../scripts/repo-branch.sh engine`
Expected: `main`

- [ ] **Step 2: Verify `main` is still a strict ancestor**

```bash
git fetch origin
git rev-list --left-right --count main...feat/humanize-agent-prose
```
Expected: `0	37` — zero commits on `main` that the stack lacks, so the merge below is a pure
fast-forward that rewrites nothing.

**If the left number is not 0, STOP** — someone landed on `main` directly and this is no longer a
fast-forward. Resolve with the repo owner before proceeding.

- [ ] **Step 3: Land the X-008/X-009 stack on `main`**

This is the umbrella's recorded prerequisite (user decision, 2026-07-17) and is **gated on X-009's
live full-stack e2e** — see "Active work" in the workspace `docs/harness/progress.md`. Do not
fast-forward until that gate is satisfied; it is not this plan's to satisfy.

```bash
git checkout main
git merge --ff-only feat/humanize-agent-prose
git push origin main
```
Expected: fast-forward, no merge commit, no conflicts.

- [ ] **Step 4: Rebase the existing branch and record the pre-change baseline**

**The branch already exists.** It was created at planning time and carries this plan document
(commit `5901766`) on top of the **pre-fast-forward** `main`. Rebase it onto the now-current `main`
rather than cutting a new one — it is a single docs commit, so this is conflict-free.

```bash
git checkout feat/external-evidence
git rebase main                           # replays the plan doc onto the harness tree
git status --short                        # expect: empty
bun run verify                            # expect: GREEN before a single line changes
```

`bun run verify` existing at all is the signal Step 3 worked: it does not exist on the pre-ff
`main`. If it errors with "Script not found", the fast-forward did not happen — go back to Step 3.

Record the exact pass/fail counts. The parity guard is measured against them.

---

### Task 1: Source vocabulary — `EXTERNAL_EVIDENCE_SOURCES` + the rewritten note

**Files:**
- Modify: `src/heuristics/policy.ts` (beside `SUBSTANTIVE_SOURCES`)
- Modify: `src/heuristics/atomic.ts:69-72` (delete `WITHHELD_EXTERNAL_EVIDENCE_NOTE`)
- Modify: `src/heuristics/index.ts` (re-export)
- Test: `test/policy_external_sources.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/policy_external_sources.test.ts
import { describe, expect, test } from "bun:test";
import * as atomic from "../src/heuristics/atomic.ts";
import {
  EXTERNAL_EVIDENCE_NOTE,
  EXTERNAL_EVIDENCE_SOURCES,
  SUBSTANTIVE_SOURCES,
} from "../src/heuristics/policy.ts";

describe("external evidence source vocabulary", () => {
  test("names exactly the two external sources", () => {
    expect([...EXTERNAL_EVIDENCE_SOURCES]).toEqual(["str_scan", "property_facts"]);
  });

  test("they are deliberately NOT substantive sources", () => {
    const substantive = new Set<string>(SUBSTANTIVE_SOURCES);
    for (const source of EXTERNAL_EVIDENCE_SOURCES) {
      expect(substantive.has(source)).toBe(false);
    }
    // SUBSTANTIVE_SOURCES feeds row pre-seeding, the data-density gate, reliability weights,
    // RANKED_SOURCE_ORDER and _SOURCE_TOKEN_BY_PATH — the deterministic weighted synthesis.
    // Locking its contents makes any accidental widening fail here.
    expect([...SUBSTANTIVE_SOURCES]).toEqual([
      "tax", "base", "loan", "drive", "voter", "auto", "trace", "utility",
    ]);
  });

  test("the note records the injection route and the exclusion", () => {
    expect(EXTERNAL_EVIDENCE_NOTE).toContain("--evidence-file");
    expect(EXTERNAL_EVIDENCE_NOTE).toContain("input_sources");
    expect(EXTERNAL_EVIDENCE_NOTE).toContain("SUBSTANTIVE_SOURCES");
  });

  test("the stale withheld-evidence note is gone from atomic.ts", () => {
    // It asserted this data is excluded — which this change makes false — and was imported nowhere.
    expect(Object.keys(atomic)).not.toContain("WITHHELD_EXTERNAL_EVIDENCE_NOTE");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/policy_external_sources.test.ts`
Expected: FAIL — `Export named 'EXTERNAL_EVIDENCE_NOTE' not found in module '.../src/heuristics/policy.ts'`

- [ ] **Step 3: Minimal implementation**

In `src/heuristics/policy.ts`, immediately after the `SUBSTANTIVE_SOURCES` block:

```ts
// Injected per-run via --evidence-file and exposed only to the packets that name them. Kept here,
// beside SUBSTANTIVE_SOURCES, so the "deliberately not substantive" relationship is visible in one
// file instead of being an invariant split across two.
export const EXTERNAL_EVIDENCE_SOURCES = ["str_scan", "property_facts"] as const;

export const EXTERNAL_EVIDENCE_NOTE =
  "External evidence (STR scan results, property listing facts) is injected per-run via " +
  "--evidence-file and is absent by default: with no payload the engine reasons only from " +
  "the public-records graph, which is the benchmarking configuration. When present it is " +
  "exposed only to packets naming these sources in input_sources, and is never counted in " +
  "SUBSTANTIVE_SOURCES, source reliability weights, or deterministic synthesis.";
```

In `src/heuristics/atomic.ts`, delete lines 69-72 in full (verified safe: `grep -rn
WITHHELD_EXTERNAL_EVIDENCE_NOTE --include=*.ts .` matches only the definition).

In `src/heuristics/index.ts`, extend the `./policy.ts` re-export block with
`EXTERNAL_EVIDENCE_NOTE,` and `EXTERNAL_EVIDENCE_SOURCES,`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/policy_external_sources.test.ts && bun run typecheck`
Expected: PASS (4 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/heuristics/policy.ts src/heuristics/atomic.ts src/heuristics/index.ts test/policy_external_sources.test.ts
git commit -m "feat(heuristics): external evidence source vocabulary beside SUBSTANTIVE_SOURCES"
```

---

### Task 2: The pinned contract — `src/agents/external_evidence.ts`

**Files:**
- Create: `src/agents/external_evidence.ts`
- Test: `test/external_evidence.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/external_evidence.test.ts
import { describe, expect, test } from "bun:test";
import {
  ExternalEvidenceSchema,
  PropertyFactsSchema,
  StrListingSchema,
} from "../src/agents/external_evidence.ts";

describe("ExternalEvidenceSchema", () => {
  test("parses a full payload", () => {
    const parsed = ExternalEvidenceSchema.parse({
      scan_id: "scan_123",
      scanned_at: "2026-07-17T10:00:00Z",
      str_listings: [
        {
          platform: "vrbo",
          listing_url: "https://www.vrbo.com/1234567",
          bedrooms: 3,
          baths: 2,
          guests: 6,
          description: "Charming home minutes from downtown.",
          address_match_pct: 92,
        },
      ],
      address_match_confidence: 83,
      property_facts: {
        source_provider: "realtor",
        home_type: "single_family",
        year_built: 1998,
        bedrooms: 3,
        baths: 2,
        area_sqft: 1840,
        lot_sqft: 7200,
        listing_status: "for_rent",
        property_url: "https://www.realtor.com/realestateandhomes-detail/1104",
      },
    });
    expect(parsed.str_listings[0]!.platform).toBe("vrbo");
    expect(parsed.str_listings[0]!.address_match_pct).toBe(92);
    expect(parsed.property_facts?.listing_status).toBe("for_rent");
    expect(parsed.property_facts?.source_provider).toBe("realtor");
  });

  test("str_listings defaults to empty; everything else is optional", () => {
    const parsed = ExternalEvidenceSchema.parse({});
    expect(parsed.str_listings).toEqual([]);
    expect(parsed.property_facts ?? null).toBeNull();
    expect(parsed.address_match_confidence ?? null).toBeNull();
  });

  test("platform is an open string: a new platform is accepted, not rejected", () => {
    // An enum would fail the whole investigation the day the backend adds a platform.
    expect(StrListingSchema.parse({ platform: "booking", address_match_pct: 51 }).platform).toBe("booking");
  });

  test("the two required fields are required", () => {
    expect(() => StrListingSchema.parse({ platform: "airbnb" })).toThrow();
    expect(() => PropertyFactsSchema.parse({ home_type: "condo" })).toThrow();
  });

  test("strict(): unknown keys are rejected at every level — structural drift is loud", () => {
    expect(() => StrListingSchema.parse({ platform: "airbnb", address_match_pct: 90, lat: 38.0 })).toThrow();
    expect(() => PropertyFactsSchema.parse({ source_provider: "redfin", price: 100 })).toThrow();
    expect(() => ExternalEvidenceSchema.parse({ scan_id: "s1", verdict: "risk" })).toThrow();
  });

  test("a wrong-typed field is rejected", () => {
    expect(() =>
      ExternalEvidenceSchema.parse({ str_listings: [{ platform: "airbnb", address_match_pct: "92" }] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/external_evidence.test.ts`
Expected: FAIL — `Cannot find module '.../src/agents/external_evidence.ts'`

- [ ] **Step 3: Minimal implementation**

```ts
// src/agents/external_evidence.ts
// The external evidence contract: STR scan results + scraped property facts, injected per-run via
// cli/run_address.ts --evidence-file. The engine owns this shape; callers map into it.
//
// Imports nothing but zod, deliberately: models.ts imports ExternalEvidenceSchema, so anything this
// module imported from models.ts would be a cycle. The builders that turn a payload into
// CaseEvidenceMap fields live in external_evidence_map.ts.
import { z } from "zod";

export const StrListingSchema = z
  .object({
    // Open string, not an enum: value drift is tolerated (a new platform must not fail the whole
    // investigation), structural drift is not — hence .strict().
    platform: z.string(),
    listing_url: z.string().nullish(),
    bedrooms: z.number().nullish(),
    baths: z.number().nullish(),
    guests: z.number().nullish(),
    description: z.string().nullish(),
    // 0-100. The confidence that this listing refers to THIS property, computed from bedroom and
    // bathroom agreement — not a probability that the property is a rental. The name carries the
    // semantics structurally rather than relying on prompt prose a model may skim.
    address_match_pct: z.number(),
  })
  .strict();
export type StrListing = z.infer<typeof StrListingSchema>;

export const PropertyFactsSchema = z
  .object({
    // "realtor" | "redfin" — which provider won the property-details waterfall. Not an enum, and
    // not named realtor_*: a successful scan's facts may be Redfin-sourced, and this carries the truth.
    source_provider: z.string(),
    home_type: z.string().nullish(),
    year_built: z.number().nullish(),
    bedrooms: z.number().nullish(),
    baths: z.number().nullish(),
    area_sqft: z.number().nullish(),
    lot_sqft: z.number().nullish(),
    listing_status: z.string().nullish(),
    property_url: z.string().nullish(),
  })
  .strict();
export type PropertyFacts = z.infer<typeof PropertyFactsSchema>;

export const ExternalEvidenceSchema = z
  .object({
    scan_id: z.string().nullish(),
    scanned_at: z.string().nullish(),
    str_listings: z.array(StrListingSchema).default([]),
    address_match_confidence: z.number().nullish(),
    property_facts: PropertyFactsSchema.nullish(),
  })
  .strict();
export type ExternalEvidence = z.infer<typeof ExternalEvidenceSchema>;
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/external_evidence.test.ts && bun run typecheck`
Expected: PASS (6 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/external_evidence.ts test/external_evidence.test.ts
git commit -m "feat(agents): external evidence contract (str_scan + property_facts payload)"
```

---

### Task 3: `AgentInvestigationRequestSchema.external_evidence`

**Files:**
- Modify: `src/agents/models.ts` (import + the request schema)
- Test: `test/models.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/models.test.ts`, extending its import with `AgentInvestigationRequestSchema`:

```ts
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
    expect(parsed.external_evidence?.str_listings[0]!.platform).toBe("airbnb");
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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/models.test.ts`
Expected: FAIL — `Unrecognized key(s) in object: 'external_evidence'` (the schema is `.strict()`).

- [ ] **Step 3: Minimal implementation**

In `src/agents/models.ts`, after the zod import:

```ts
import { ExternalEvidenceSchema } from "./external_evidence.ts";
```

In `AgentInvestigationRequestSchema`, after `batch_id`:

```ts
    // Absent => blind: the engine reasons only from the public-records graph, exactly as it does
    // with no payload. Blind (benchmarking) and enriched (prod) run identical code.
    external_evidence: ExternalEvidenceSchema.nullish().default(null),
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/models.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/models.ts test/models.test.ts
git commit -m "feat(agents): external_evidence request field, null by default"
```

---

### Task 4: Payload → evidence-map builders

**Files:**
- Create: `src/agents/external_evidence_map.ts`
- Test: `test/external_evidence_map.test.ts`

> **Correction 2 (spec) applies here.** `property_types_from_external` exists to fill
> `ResolvedAddressContext.property_types` **only**. `evidence_map.property_types` stays `[]` —
> filling it would reach `_has_portfolio_hint` and flip a **scoring** gate. See Task 11.

- [ ] **Step 1: Write the failing test**

```ts
// test/external_evidence_map.test.ts
import { describe, expect, test } from "bun:test";
import { ExternalEvidenceSchema } from "../src/agents/external_evidence.ts";
import {
  external_evidence_refs,
  property_types_from_external,
  rental_market_summary_lines,
} from "../src/agents/external_evidence_map.ts";

const payload = () =>
  ExternalEvidenceSchema.parse({
    scan_id: "scan_123",
    scanned_at: "2026-07-17T10:00:00Z",
    str_listings: [
      { platform: "vrbo", listing_url: "https://www.vrbo.com/1234567", bedrooms: 3, baths: 2, guests: 6, address_match_pct: 92 },
    ],
    address_match_confidence: 83,
    property_facts: { source_provider: "realtor", home_type: "single_family", year_built: 1998, area_sqft: 1840, listing_status: "for_rent" },
  });

describe("rental_market_summary_lines", () => {
  test("states the listing and the address-match semantics outright", () => {
    const lines = rental_market_summary_lines(payload());
    expect(lines[0]).toBe("Short-term rental listing found on vrbo: 3 bd / 2 ba / sleeps 6. Address match 92%.");
    expect(lines.some((l) => l.includes("not a probability that the property is a rental"))).toBe(true);
    expect(lines.some((l) => l.includes("Scan-level address-match confidence 83%"))).toBe(true);
  });

  test("an empty-but-present payload is negative evidence, not silence", () => {
    expect(rental_market_summary_lines(ExternalEvidenceSchema.parse({ scan_id: "scan_9" }))).toEqual([
      "All platforms scanned; no short-term rental listings matched this property.",
    ]);
  });

  test("an absent payload produces nothing at all — the blind default", () => {
    expect(rental_market_summary_lines(null)).toEqual([]);
  });

  test("a listing with no bed/bath/guest detail still renders its match", () => {
    const evidence = ExternalEvidenceSchema.parse({ str_listings: [{ platform: "facebook", address_match_pct: 66.66 }] });
    expect(rental_market_summary_lines(evidence)[0]).toBe(
      "Short-term rental listing found on facebook. Address match 66.7%.",
    );
  });
});

describe("property_types_from_external", () => {
  test("derives the type from property_facts.home_type", () => {
    expect(property_types_from_external(payload())).toEqual(["single_family"]);
  });

  test("empty with no payload and with no home_type", () => {
    expect(property_types_from_external(null)).toEqual([]);
    expect(property_types_from_external(ExternalEvidenceSchema.parse({ property_facts: { source_provider: "redfin" } }))).toEqual([]);
  });
});

describe("external_evidence_refs", () => {
  test("one str_scan ref per listing plus one property_facts ref; detail survives in data", () => {
    const refs = external_evidence_refs(payload());
    expect(refs.map((r) => r.source)).toEqual(["str_scan", "property_facts"]);
    expect(refs[0]!.record_id).toBe("scan_123:0");
    expect(refs[0]!.summary).toContain("platform=vrbo");
    // data is preserved in the assessment's evidence map for audit; compact rendering strips it.
    expect(refs[0]!.data["listing_url"]).toBe("https://www.vrbo.com/1234567");
    expect(refs[1]!.summary).toContain("source_provider=realtor");
    expect(refs[1]!.summary).toContain("listing_status=for_rent");
    expect(refs[1]!.data["area_sqft"]).toBe(1840);
  });

  test("no payload and an empty payload yield no refs", () => {
    expect(external_evidence_refs(null)).toEqual([]);
    expect(external_evidence_refs(ExternalEvidenceSchema.parse({ scan_id: "scan_9" }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/external_evidence_map.test.ts`
Expected: FAIL — `Cannot find module '.../src/agents/external_evidence_map.ts'`

- [ ] **Step 3: Minimal implementation**

```ts
// src/agents/external_evidence_map.ts
// Folds an ExternalEvidence payload into the CaseEvidenceMap surfaces the prompt builders read:
// the property type (context only — see the note on property_types_from_external), the
// rental_market_summary listing channel, and str_scan / property_facts evidence refs.
//
// Separate from external_evidence.ts so the contract module stays free of a
// models.ts <-> external_evidence.ts import cycle.
import type { ExternalEvidence, PropertyFacts, StrListing } from "./external_evidence.ts";
import { EvidenceReferenceSchema, type EvidenceReference } from "./models.ts";

// Stated outright rather than left to the model to infer from the field name.
const ADDRESS_MATCH_SEMANTICS =
  "Address-match percentages are the confidence that a listing refers to this property, " +
  "computed from bedroom/bathroom agreement. They are not a probability that the property is a rental.";

// The empty-but-present payload: negative evidence the engine cannot represent without one.
const NO_LISTINGS_LINE = "All platforms scanned; no short-term rental listings matched this property.";

/** Trim a number for prose: 92 -> "92", 66.66 -> "66.7". */
function _num(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function _listing_line(listing: StrListing): string {
  const shape: string[] = [];
  if (typeof listing.bedrooms === "number") {
    shape.push(`${_num(listing.bedrooms)} bd`);
  }
  if (typeof listing.baths === "number") {
    shape.push(`${_num(listing.baths)} ba`);
  }
  if (typeof listing.guests === "number") {
    shape.push(`sleeps ${_num(listing.guests)}`);
  }
  const detail = shape.length > 0 ? `: ${shape.join(" / ")}` : "";
  return `Short-term rental listing found on ${listing.platform}${detail}. Address match ${_num(listing.address_match_pct)}%.`;
}

/** The rental_market_summary lines — the listing channel, gated behind str_scan scope. */
export function rental_market_summary_lines(evidence: ExternalEvidence | null): string[] {
  if (evidence === null) {
    return [];
  }
  if (evidence.str_listings.length === 0) {
    return [NO_LISTINGS_LINE];
  }
  const lines = evidence.str_listings.map((listing) => _listing_line(listing));
  lines.push(ADDRESS_MATCH_SEMANTICS);
  if (typeof evidence.address_match_confidence === "number") {
    lines.push(`Scan-level address-match confidence ${_num(evidence.address_match_confidence)}% (0-100, same semantics).`);
  }
  return lines;
}

/**
 * The property type, for ResolvedAddressContext.property_types ONLY.
 *
 * It must NOT be written to evidence_map.property_types: adapters.ts copies that field into
 * AddressEvidence and _has_portfolio_hint fires on any type containing "multi" or "portfolio",
 * flipping portfolio_primary_comparison_analysis from skip to run — a packet that SCORES. Writing
 * it there would let enrichment move the calibrated score through a deterministic gate rather than
 * through reasoning. Both prompt builders prefer the context value, so prompts still see it.
 */
export function property_types_from_external(evidence: ExternalEvidence | null): string[] {
  const home_type = evidence?.property_facts?.home_type;
  if (typeof home_type !== "string" || home_type.trim() === "") {
    return [];
  }
  return [home_type.trim()];
}

function _listing_summary(listing: StrListing): string {
  const parts = ["str_scan", `platform=${listing.platform}`, `address_match_pct=${_num(listing.address_match_pct)}`];
  if (typeof listing.bedrooms === "number") {
    parts.push(`bedrooms=${_num(listing.bedrooms)}`);
  }
  if (typeof listing.baths === "number") {
    parts.push(`baths=${_num(listing.baths)}`);
  }
  if (typeof listing.guests === "number") {
    parts.push(`guests=${_num(listing.guests)}`);
  }
  if (listing.listing_url) {
    parts.push(`listing_url=${listing.listing_url}`);
  }
  return parts.join("; ");
}

function _facts_summary(facts: PropertyFacts): string {
  const parts = ["property_facts", `source_provider=${facts.source_provider}`];
  const fields: Array<readonly [string, unknown]> = [
    ["home_type", facts.home_type],
    ["year_built", facts.year_built],
    ["bedrooms", facts.bedrooms],
    ["baths", facts.baths],
    ["area_sqft", facts.area_sqft],
    ["lot_sqft", facts.lot_sqft],
    ["listing_status", facts.listing_status],
    ["property_url", facts.property_url],
  ];
  for (const [key, value] of fields) {
    if (value !== null && value !== undefined && value !== "") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join("; ");
}

/**
 * The str_scan / property_facts evidence refs. A heuristic firing on a listing must cite one:
 * HeuristicAgentResultSchema requires non-empty evidence_for when status === "triggered".
 * `data` carries the full structured detail into the assessment's audit trail; compact prompt
 * rendering strips it back to `summary`.
 */
export function external_evidence_refs(evidence: ExternalEvidence | null): EvidenceReference[] {
  if (evidence === null) {
    return [];
  }
  const scan_key = evidence.scan_id ?? "scan";
  const refs: EvidenceReference[] = evidence.str_listings.map((listing, index) =>
    EvidenceReferenceSchema.parse({
      source: "str_scan",
      table: "str_listing",
      record_id: `${scan_key}:${index}`,
      summary: _listing_summary(listing),
      data: { ...listing, scan_id: evidence.scan_id ?? null, scanned_at: evidence.scanned_at ?? null },
    }),
  );
  const facts = evidence.property_facts;
  if (facts !== null && facts !== undefined) {
    refs.push(
      EvidenceReferenceSchema.parse({
        source: "property_facts",
        table: "property_facts",
        record_id: `${scan_key}:property_facts`,
        summary: _facts_summary(facts),
        data: { ...facts },
      }),
    );
  }
  return refs;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/external_evidence_map.test.ts && bun run typecheck && bun run lint`
Expected: PASS (8 tests), typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/external_evidence_map.ts test/external_evidence_map.test.ts
git commit -m "feat(agents): fold external evidence into evidence-map fields (summary, type, refs)"
```

---

### Task 5: `compact_evidence_map` — scope gate + external-refs-first ordering

**Files:**
- Modify: `src/agents/prompts.ts` (imports; `compact_evidence_map`)
- Test: `test/prompts_external_scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/prompts_external_scope.test.ts
import { describe, expect, test } from "bun:test";
import { compact_evidence_map } from "../src/agents/prompts.ts";

const LISTING_LINE = "Short-term rental listing found on vrbo: 3 bd / 2 ba / sleeps 6. Address match 92%.";

function evidenceMap(): Record<string, any> {
  return {
    address_id: 1104,
    normalized_address: "1104 SPRING RUN RD",
    zip5: "40514",
    source_counts: { tax: 2, base: 1 },
    property_types: [],
    rental_market_summary: [LISTING_LINE],
    owner_summaries: [],
    people_at_address: [],
    owner_presence_hints: [],
    owner_elsewhere_hints: [],
    nonowner_occupancy_hints: [],
    freshness_hints: [],
    data_gaps: [],
    evidence_refs: [
      { source: "str_scan", table: "str_listing", rowid: null, record_id: "scan_123:0", summary: "str_scan; platform=vrbo", data: {} },
      { source: "property_facts", table: "property_facts", rowid: null, record_id: "scan_123:property_facts", summary: "property_facts; source_provider=realtor", data: {} },
      ...Array.from({ length: 8 }, (_, i) => ({
        source: "tax", table: "tax", rowid: i + 1, record_id: null, summary: `tax row ${i + 1}`, data: {},
      })),
    ],
  };
}

describe("compact_evidence_map: external evidence scope gating", () => {
  test("rental_market_summary reaches a str_scan-scoped packet", () => {
    expect(compact_evidence_map(evidenceMap(), ["trace", "utility", "tax", "str_scan"])["rental_market_summary"]).toEqual([LISTING_LINE]);
  });

  test("rental_market_summary is WITHHELD from a packet without str_scan scope", () => {
    // The smoking-gun channel is unfiltered today; this is the selective-exposure design.
    expect(compact_evidence_map(evidenceMap(), ["tax", "base", "drive"])["rental_market_summary"]).toEqual([]);
  });

  test("property_facts scope alone does not unlock the listing channel", () => {
    expect(compact_evidence_map(evidenceMap(), ["tax", "base", "property_facts"])["rental_market_summary"]).toEqual([]);
  });

  test("an empty scope (the master prompts) sees everything, exactly as today", () => {
    expect(compact_evidence_map(evidenceMap(), null)["rental_market_summary"]).toEqual([LISTING_LINE]);
    expect(compact_evidence_map(evidenceMap(), [])["rental_market_summary"]).toEqual([LISTING_LINE]);
  });

  test("external refs are ordered FIRST and survive refs.slice(0, 8)", () => {
    const map = evidenceMap();
    // Put the external refs last so only the ordering can save them from the cap.
    map["evidence_refs"] = [...map["evidence_refs"].slice(2), ...map["evidence_refs"].slice(0, 2)];
    const refs = compact_evidence_map(map, ["tax", "str_scan", "property_facts"])["evidence_refs"] as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(8);
    expect(refs.map((r) => r["source"]).slice(0, 2)).toEqual(["str_scan", "property_facts"]);
  });

  test("an unscoped packet gets no external refs at all", () => {
    const refs = compact_evidence_map(evidenceMap(), ["tax", "base"])["evidence_refs"] as Array<Record<string, unknown>>;
    expect(refs.every((r) => r["source"] === "tax")).toBe(true);
    expect(refs).toHaveLength(8);
  });

  test("refs are still compacted to summary — data never rides the compact prompt", () => {
    const refs = compact_evidence_map(evidenceMap(), ["str_scan"])["evidence_refs"] as Array<Record<string, unknown>>;
    expect(refs[0]!["source"]).toBe("str_scan");
    expect(Object.hasOwn(refs[0]!, "data")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/prompts_external_scope.test.ts`
Expected: FAIL on "…is WITHHELD…": received `[LISTING_LINE]`, expected `[]`; and on the ordering test.

- [ ] **Step 3: Minimal implementation**

In `src/agents/prompts.ts`, add to the imports:

```ts
import { EXTERNAL_EVIDENCE_SOURCES } from "../heuristics/policy.ts";
```

(Acyclic: `policy.ts` imports nothing.) Below the `isDict` helper:

```ts
// Set (not .includes) so the `as const` tuple type doesn't narrow the lookup argument.
const EXTERNAL_SOURCE_SET: ReadonlySet<string> = new Set<string>(EXTERNAL_EVIDENCE_SOURCES);

function _ref_source(ref: any): string {
  return isDict(ref) ? String(ref["source"] ?? "") : "";
}

/**
 * External refs first. refs.slice(0, 8) caps AFTER scope filtering, so an str_scan ref would
 * otherwise compete with the graph sources for eight slots and could be silently crowded out —
 * removing the citation a heuristic needs to mark itself `triggered`. Stable within each partition.
 */
function _external_refs_first(refs: any[]): any[] {
  const external: any[] = [];
  const graph: any[] = [];
  for (const ref of refs) {
    if (EXTERNAL_SOURCE_SET.has(_ref_source(ref))) {
      external.push(ref);
    } else {
      graph.push(ref);
    }
  }
  return [...external, ...graph];
}
```

In `compact_evidence_map`, add the `scoped` helper, the ordering call, and gate
`rental_market_summary`:

```ts
  const scope = new Set<string>((source_scope ?? []) as string[]);
  // An empty scope means "no scope was supplied" (the master prompts), which sees everything.
  const scoped = (source: string): boolean => scope.size === 0 || scope.has(source);
  let refs: any[] = evidence_map["evidence_refs"] ?? [];
  if (scope.size > 0) {
    refs = refs.filter((ref) => isDict(ref) && scope.has(String(ref["source"] ?? "")));
  }
  refs = _external_refs_first(refs);
```
```ts
    // property_types is global (and is only ever context-sourced — see external_evidence_map.ts).
    property_types: evidence_map["property_types"] ?? [],
    // rental_market_summary is the listing channel and goes behind the gate. This split is the
    // selective-exposure design in two lines.
    rental_market_summary: scoped("str_scan") ? (evidence_map["rental_market_summary"] ?? []) : [],
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/prompts_external_scope.test.ts && bun run typecheck && bun test`
Expected: PASS (7 tests); full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/agents/prompts.ts test/prompts_external_scope.test.ts
git commit -m "feat(agents): scope-gate rental_market_summary and order external refs first"
```

---

### Task 6: `prompt_context` — close the full-profile hole

**Files:**
- Modify: `src/agents/prompts.ts` (`prompt_context`; add `scope_external_evidence`)
- Test: `test/prompts_external_scope.test.ts`

Grounding fact 6: `prompt_context` early-returns the entire unfiltered context when
`profile === "full"`. **Profile is verbosity; scope is authorization.** They are conflated today, so
selective exposure silently evaporates under `--prompt-profile full`. Prod defaults to compact, so
this is a latent hole — and exactly the one a later "let me debug with the full profile" session
falls into.

- [ ] **Step 1: Write the failing test**

Append to `test/prompts_external_scope.test.ts`, extending the import with `prompt_context`:

```ts
function context(): Record<string, any> {
  return {
    input_address: "1104 SPRING RUN RD",
    input_zip: "40514",
    selected: { id: 1104, norm_address: "1104 SPRING RUN RD", zip5: "40514" },
    candidates: [],
    ambiguous: false,
    source_counts: { tax: 2, base: 1 },
    property_types: ["single_family"],
    evidence_map: evidenceMap(),
    schema_guide: "",
  };
}

describe("prompt_context: profile is verbosity, scope is authorization", () => {
  test("full profile WITHHOLDS rental_market_summary from an unscoped packet", () => {
    expect(prompt_context(context(), "full", ["tax", "base", "drive"])["evidence_map"]["rental_market_summary"]).toEqual([]);
  });

  test("full profile withholds external refs but keeps graph refs verbatim and uncapped", () => {
    const refs = prompt_context(context(), "full", ["tax", "base", "drive"])["evidence_map"]["evidence_refs"] as Array<Record<string, unknown>>;
    expect(refs.some((r) => r["source"] === "str_scan")).toBe(false);
    expect(refs.some((r) => r["source"] === "property_facts")).toBe(false);
    // full profile does not scope-filter graph refs and does not cap at 8 — unchanged.
    expect(refs.filter((r) => r["source"] === "tax")).toHaveLength(8);
    expect(refs[0]!["data"]).toBeDefined();
  });

  test("full profile GRANTS them to a scoped packet, one source at a time", () => {
    const out = prompt_context(context(), "full", ["trace", "utility", "str_scan"]);
    expect(out["evidence_map"]["rental_market_summary"]).toEqual([LISTING_LINE]);
    const refs = out["evidence_map"]["evidence_refs"] as Array<Record<string, unknown>>;
    expect(refs.some((r) => r["source"] === "str_scan")).toBe(true);
    expect(refs.some((r) => r["source"] === "property_facts")).toBe(false);
  });

  test("full profile with no scope (the master prompts) is byte-for-byte untouched", () => {
    const ctx = context();
    expect(prompt_context(ctx, "full", null)).toBe(ctx);
    expect(prompt_context(ctx, "full")).toBe(ctx);
  });

  test("full profile keeps every non-evidence-map key verbatim", () => {
    const out = prompt_context(context(), "full", ["tax"]);
    expect(out["schema_guide"]).toBe("");
    expect(out["candidates"]).toEqual([]);
    expect(out["property_types"]).toEqual(["single_family"]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/prompts_external_scope.test.ts`
Expected: FAIL — "full profile WITHHOLDS…": received `[LISTING_LINE]`, expected `[]`.

- [ ] **Step 3: Minimal implementation**

Replace `prompt_context`'s early return:

```ts
  if (profile === "full") {
    // Profile controls verbosity; scope controls authorization. The full profile still returns
    // everything verbatim — except the external evidence fields, which stay behind the scope gate
    // in BOTH profiles. An empty scope means the master prompts, which see everything.
    const scope = new Set<string>((source_scope ?? []) as string[]);
    const full_map = context["evidence_map"];
    if (scope.size === 0 || !isDict(full_map)) {
      return context;
    }
    return { ...context, evidence_map: scope_external_evidence(full_map, source_scope) };
  }
```

And add, next to `compact_evidence_map`:

```ts
/**
 * The external-evidence scope gate for the full profile: filters ONLY the external fields, leaving
 * every graph field (and the ref cap, which the full profile does not apply) exactly as it is.
 */
export function scope_external_evidence(
  evidence_map: Dict,
  source_scope: string[] | readonly string[] | null = null,
): Dict {
  const scope = new Set<string>((source_scope ?? []) as string[]);
  if (scope.size === 0) {
    return evidence_map;
  }
  const refs: any[] = evidence_map["evidence_refs"] ?? [];
  return {
    ...evidence_map,
    rental_market_summary: scope.has("str_scan") ? (evidence_map["rental_market_summary"] ?? []) : [],
    evidence_refs: refs.filter((ref) => {
      const source = _ref_source(ref);
      return !EXTERNAL_SOURCE_SET.has(source) || scope.has(source);
    }),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/prompts_external_scope.test.ts && bun run typecheck && bun test`
Expected: PASS (12 tests in this file); full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/agents/prompts.ts test/prompts_external_scope.test.ts
git commit -m "fix(agents): scope-gate external evidence in the full prompt profile too"
```

---

### Task 7: Render the gated channel — the Rental Market section

**Files:**
- Modify: `src/agents/prompts.ts` (`render_context_sections`)
- Test: `test/prompts_rental_market.test.ts`

> **This task exists because of Correction 1 in the spec.** `render_context_sections` — the actual
> prompt renderer — emits Property Types, Owners, People At Address, Signals, Data Gaps and
> Evidence References, and **never reads `rental_market_summary`**. Without this task the gated
> channel is dead: the slot is filled, scope-gated, and rendered to no one.
> `_section_items(..., empty = false)` returns `[]` for an empty list, so **a blind run's prompt
> text stays byte-identical**.

- [ ] **Step 1: Write the failing test**

```ts
// test/prompts_rental_market.test.ts
import { describe, expect, test } from "bun:test";
import { render_context_sections } from "../src/agents/prompts.ts";

const LISTING_LINE = "Short-term rental listing found on vrbo: 3 bd / 2 ba / sleeps 6. Address match 92%.";

describe("render_context_sections: the rental market channel", () => {
  test("renders the rental market lines when the packet is authorized to see them", () => {
    const text = render_context_sections({
      input_address: "1104 SPRING RUN RD",
      input_zip: "40514",
      evidence_map: { rental_market_summary: [LISTING_LINE] },
    });
    expect(text).toContain("Rental Market");
    expect(text).toContain(`- ${LISTING_LINE}`);
  });

  test("renders NOTHING when empty — a blind run's prompt text is unchanged", () => {
    const text = render_context_sections({
      input_address: "1104 SPRING RUN RD",
      input_zip: "40514",
      evidence_map: { rental_market_summary: [] },
    });
    expect(text).not.toContain("Rental Market");
  });

  test("renders nothing when the field is absent entirely", () => {
    expect(render_context_sections({ input_address: "1104 SPRING RUN RD", evidence_map: {} })).not.toContain("Rental Market");
  });

  test("Property Types still renders '- none' when empty — that section is unchanged", () => {
    const text = render_context_sections({ input_address: "x", evidence_map: {} });
    expect(text).toContain("Property Types");
    expect(text).toContain("- none");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/prompts_rental_market.test.ts`
Expected: FAIL — `expect(received).toContain("Rental Market")`.

- [ ] **Step 3: Minimal implementation**

In `render_context_sections`, immediately after the `Property Types` push:

```ts
  // The listing channel. `empty = false` so an absent/withheld payload renders nothing at all,
  // which keeps the blind configuration's prompt text exactly as it is today. The scope gate has
  // already run in prompt_context/compact_evidence_map — this only renders what was authorized.
  lines.push(..._section_items("Rental Market", evidence_map["rental_market_summary"] ?? [], false));
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/prompts_rental_market.test.ts && bun test`
Expected: PASS (4 tests); full suite green (esp. `test/prompts_register.test.ts` and the E2E).

- [ ] **Step 5: Commit**

```bash
git add src/agents/prompts.ts test/prompts_rental_market.test.ts
git commit -m "feat(agents): render the rental market section for authorized packets only"
```

---

### Task 8: Register glossary + the prose-scrubber survival test

**Files:**
- Modify: `src/agents/prompts.ts` (`SOURCE_HUMAN_PHRASES`)
- Modify: `src/agents/prose_redaction.ts` (controlled vocabulary)
- Test: `test/prompts_register.test.ts`, `test/prose_external_evidence.test.ts`

> **This task carries the umbrella's ⚠ risk.** `feat/humanize-agent-prose` added a gated prose
> scrubber (`OE_PROSE_REDACT`) that redacts leaked vocabulary from findings, and its history has two
> fixes for exactly this failure mode: `6a885ba` "exclude engine controlled vocabulary from prose
> leak detection" and `87817f4` "scrubber must not eat engine contract vocabulary". This feature
> puts platform names and listing prose into findings. **If the scrubber eats them, every gate stays
> green and the feature silently does nothing.**
>
> Note `SNAKE_RE` matches `str_scan` / `property_facts` — unlike `tax`/`base`, which are neither
> snake nor camel and are never flagged. Flagging the *source tokens* is correct (the model should
> humanize them). Redacting the *platform names and listing prose* is not.

- [ ] **Step 1: Write the failing tests**

Append to `test/prompts_register.test.ts`:

```ts
describe("writing register glossary", () => {
  test("names plain-language phrases for the external sources too", () => {
    const glossary = buildProseRegisterLines("finding, caveats").join("\n");
    expect(glossary).toContain("str_scan → short-term-rental listing match");
    expect(glossary).toContain("property_facts → property listing record");
    expect(glossary).toContain("tax → property-tax record"); // existing entries untouched
  });
});
```

```ts
// test/prose_external_evidence.test.ts
//
// THE PROSE-SCRUBBER SURVIVAL TEST. The scrubber redacts "leaked" vocabulary from findings; this
// feature deliberately puts platform names and listing prose INTO findings. If it eats them, every
// gate stays green and the feature silently does nothing — the worst possible failure mode.
import { describe, expect, test } from "bun:test";
import { detect_leaks, redact_prose } from "../src/agents/prose_redaction.ts";

const FINDING =
  "A short-term rental listing was found on vrbo for this property (3 bd / 2 ba, sleeps 6), " +
  "matching the subject address at 92%. The listing record from realtor reports the home as for_rent.";

describe("the prose scrubber must not eat external evidence", () => {
  test("platform names and listing prose survive redaction intact", () => {
    const scrubbed = redact_prose(FINDING);
    expect(scrubbed).toContain("vrbo");
    expect(scrubbed).toContain("realtor");
    expect(scrubbed).toContain("short-term rental listing");
    expect(scrubbed).toContain("for_rent");
  });

  test("platform names are not reported as prose leaks", () => {
    const leaks = detect_leaks(FINDING).join(" ");
    expect(leaks).not.toContain("vrbo");
    expect(leaks).not.toContain("realtor");
    expect(leaks).not.toContain("for_rent");
  });

  test("the raw source tokens ARE still flagged — the model should humanize those", () => {
    // str_scan/property_facts are data-surface names, not evidence content. Flagging them is
    // correct and is what the register glossary gives the model a phrase for.
    expect(detect_leaks("The str_scan source shows a match.").join(" ")).toContain("str_scan");
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `bun test test/prompts_register.test.ts test/prose_external_evidence.test.ts`
Expected: FAIL on the glossary assertion. **The survival tests may pass or fail** — that is the
point of writing them. If they pass, the scrubber already leaves this vocabulary alone and Step 3's
`prose_redaction.ts` change is unnecessary: **record that, skip it, and keep the tests** as the
regression guard. If they fail, Step 3 is required.

- [ ] **Step 3: Minimal implementation**

In `src/agents/prompts.ts`, extend `SOURCE_HUMAN_PHRASES`:

```ts
  criminal: "criminal record",
  str_scan: "short-term-rental listing match",
  property_facts: "property listing record",
};
```

**Only if the survival tests failed in Step 2:** add the external-evidence vocabulary to
`prose_redaction.ts`'s controlled-vocabulary exclusion — the same mechanism `6a885ba` used for
engine contract vocabulary. Platform names (`vrbo`, `airbnb`, `facebook`), `for_rent`/`for_sale`
status values, and the listing prose are **evidence content, not leaked identifiers**, and must be
excluded from leak detection and redaction. Follow that commit's existing pattern exactly rather
than inventing a second mechanism.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `bun test test/prompts_register.test.ts test/prose_external_evidence.test.ts && bun test`
Expected: PASS; full suite green (the register is off by default, so no other prompt text moves).

- [ ] **Step 5: Verify under the real flag**

Run: `OE_PROSE_REDACT=1 bun test test/e2e && OE_PROSE_REDACT=1 bun run verify`
Expected: green. This is the configuration the risk lives in — a green suite with the flag off
proves nothing about it.

- [ ] **Step 6: Commit**

```bash
git add src/agents/prompts.ts src/agents/prose_redaction.ts test/prompts_register.test.ts test/prose_external_evidence.test.ts
git commit -m "feat(agents): keep external evidence vocabulary out of the prose scrubber"
```

---

### Task 9: The pinned exposure map

**Files:**
- Modify: `src/heuristics/packets.ts` (4 packets)
- Test: `test/packets_exposure_map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/packets_exposure_map.test.ts
import { describe, expect, test } from "bun:test";
import { PACKETS } from "../src/heuristics/packets.ts";
import { EXTERNAL_EVIDENCE_SOURCES, SUBSTANTIVE_SOURCES } from "../src/heuristics/policy.ts";

const EXTERNAL: ReadonlySet<string> = new Set<string>(EXTERNAL_EVIDENCE_SOURCES);

// The pinned exposure map. The three exclusions are forced by the payload, not by taste: it carries
// no host or owner identity, so the identity/portfolio packets have nothing to reason with, and
// legal_address_presence covers drive/voter/auto, which neither payload touches.
const EXPOSURE: Record<string, string[]> = {
  property_tax_context: ["property_facts"],
  owner_identity_and_mailing: [],
  subject_occupancy_surfaces: ["str_scan"],
  legal_address_presence: [],
  loan_tenure: ["str_scan"],
  portfolio_and_primary_comparison: [],
  case_quality_and_synthesis: ["str_scan", "property_facts"],
};

describe("the pinned exposure map", () => {
  test("covers every packet — a new packet must make an explicit exposure decision", () => {
    expect(PACKETS.map((p) => p.id).sort()).toEqual(Object.keys(EXPOSURE).sort());
  });

  test("each packet names exactly its pinned external sources in input_sources", () => {
    for (const packet of PACKETS) {
      expect([packet.id, packet.input_sources.filter((s) => EXTERNAL.has(s))]).toEqual([packet.id, EXPOSURE[packet.id]!]);
    }
  });

  test("gate.source_scope matches input_sources for the external sources", () => {
    for (const packet of PACKETS) {
      expect([packet.id, packet.gate.source_scope.filter((s) => EXTERNAL.has(s))]).toEqual([packet.id, EXPOSURE[packet.id]!]);
    }
  });

  test("case_quality_and_synthesis COPIES SUBSTANTIVE_SOURCES — it never mutates it", () => {
    const packet = PACKETS.find((p) => p.id === "case_quality_and_synthesis")!;
    expect(packet.input_sources).not.toBe(SUBSTANTIVE_SOURCES);
    expect(packet.gate.source_scope).not.toBe(SUBSTANTIVE_SOURCES);
    expect([...packet.input_sources]).toEqual([...SUBSTANTIVE_SOURCES, "str_scan", "property_facts"]);
    expect([...packet.gate.source_scope]).toEqual([...SUBSTANTIVE_SOURCES, "str_scan", "property_facts"]);
    // and the shared constant is unchanged after the catalog is built
    expect([...SUBSTANTIVE_SOURCES]).toEqual(["tax", "base", "loan", "drive", "voter", "auto", "trace", "utility"]);
  });

  test("case_quality_and_synthesis stays score-neutral, so exposing it cannot inflate the score", () => {
    const packet = PACKETS.find((p) => p.id === "case_quality_and_synthesis")!;
    expect(packet.score).toBe(0);
    expect(packet.score_cap).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/packets_exposure_map.test.ts`
Expected: FAIL — `["property_tax_context", []]` vs `["property_tax_context", ["property_facts"]]`.

- [ ] **Step 3: Minimal implementation**

In `src/heuristics/packets.ts` — add the external source to both `input_sources` and
`gate.source_scope` for each:

- `property_tax_context` → `+ "property_facts"` (home_type/year_built/area/lot corroborate the
  `residential` and `condo` tax fields and `single_family_clean_address_context`)
- `subject_occupancy_surfaces` → `+ "str_scan"` (a matched listing is direct current-rental-use
  evidence; precisely `rental_market_context: active_rental`)
- `loan_tenure` → `+ "str_scan"` (a listing contradicts an owner's `own_rent: own` claim, feeding
  `owner_loan_rent_conflict`)
- `case_quality_and_synthesis` → `[...SUBSTANTIVE_SOURCES, "str_scan", "property_facts"]` for both,
  **a copy, never a mutation** (it runs concurrently with every packet so it cannot get STR evidence
  transitively; blind, its prompt tells it to pick `non_rental_absentee_owner` when "rental-use
  evidence is absent", committing to the wrong archetype on the strongest cases; safe because
  `score: 0, score_cap: 0`)

`owner_identity_and_mailing`, `legal_address_presence`, `portfolio_and_primary_comparison`:
**unchanged.**

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/packets_exposure_map.test.ts && bun test && bun run typecheck`
Expected: PASS (5 tests); full suite green. (Verified safe: `_heuristic_sources`,
`typed_tools_guide` and `fetch_address_records_multi` all filter unknown sources, so adding a source
the GraphQL surface doesn't have cannot crash retrieval.)

- [ ] **Step 5: Commit**

```bash
git add src/heuristics/packets.ts test/packets_exposure_map.test.ts
git commit -m "feat(heuristics): expose external evidence to 4 of 7 packets (pinned map)"
```

---

### Task 10: THE CRITICAL NEGATIVE TEST

**Files:**
- Modify: `test/support/fixtures.ts` (add `externalEvidenceFixture`)
- Test: `test/external_evidence_exposure.test.ts`

This single assertion guards the entire selective-exposure design and is what catches a later
innocent "fix" to the scope filter. Pure test work — every source change it needs landed in Tasks 1-9.

> **The bucket is the unit of exposure, not the packet** (umbrella, re-pinned per-bucket).
> `_bucket_by_group` pairs packets by `group` and `_union_source_scope` merges their
> `input_sources` into one shared prompt. So `owner_identity_and_mailing` **will** see
> `property_facts` (via `property_tax_context`) and `legal_address_presence` **will** see
> `str_scan` (via `subject_occupancy_surfaces`). The **collapse-critical** exclusions survive:
> `owner_identity_and_mailing` never sees `str_scan`, and `portfolio_and_primary_comparison` is
> solo. This test asserts **both** levels so the boundary is a decision of record, not a surprise.

- [ ] **Step 1: Add the payload fixture — through the contract, never a second copy of it**

In `test/support/fixtures.ts`:

```ts
import { ExternalEvidenceSchema, type ExternalEvidence } from "../../src/agents/external_evidence.ts";

/**
 * The external evidence payload for the exposure + E2E suites. Built THROUGH
 * ExternalEvidenceSchema rather than declared as a typed literal, so it can never become a second
 * copy of the contract: a structural change fails loudly here, at the fixture, instead of silently
 * in the tests that consume it. (scripts/capture_preflight_fixture.ts already duplicates
 * PREFLIGHT_QUERY verbatim — do not repeat that drift hazard.)
 */
export function externalEvidenceFixture(): ExternalEvidence {
  return ExternalEvidenceSchema.parse({
    scan_id: "scan_123",
    scanned_at: "2026-07-17T10:00:00Z",
    str_listings: [
      {
        platform: "vrbo",
        listing_url: "https://www.vrbo.com/1234567",
        bedrooms: 3,
        baths: 2,
        guests: 6,
        description: "Charming home minutes from downtown.",
        address_match_pct: 92,
      },
    ],
    address_match_confidence: 83,
    property_facts: {
      source_provider: "realtor",
      home_type: "single_family",
      year_built: 1998,
      bedrooms: 3,
      baths: 2,
      area_sqft: 1840,
      lot_sqft: 7200,
      listing_status: "for_rent",
      property_url: "https://www.realtor.com/realestateandhomes-detail/1104-Spring-Run-Rd",
    },
  });
}
```

- [ ] **Step 2: Write the test**

```ts
// test/external_evidence_exposure.test.ts
//
// THE CRITICAL NEGATIVE TEST. Given a payload, owner_identity_and_mailing must never see str_scan
// in its rendered prompt — solo, grouped, or under either prompt profile. This guards the whole
// selective-exposure design.
import { describe, expect, test } from "bun:test";
import { external_evidence_refs, property_types_from_external, rental_market_summary_lines } from "../src/agents/external_evidence_map.ts";
import { HeuristicAgentInputSchema, ResolvedAddressContextSchema, type HeuristicAgentInput } from "../src/agents/models.ts";
import { TypedToolset } from "../src/agents/toolsets/typed_toolset.ts";
import { get_heuristic_catalog } from "../src/heuristics/index.ts";
import { externalEvidenceFixture } from "./support/fixtures.ts";

// Every surface the payload could leak through: the source token, the listing prose, the platform
// name, and the listing url fragment.
const STR_MARKERS = ["str_scan", "Short-term rental listing", "vrbo", "1234567"];

const SOURCE_COUNTS = { tax: 2, base: 1, trace: 1, utility: 1, loan: 1, drive: 1, voter: 0, auto: 0 };

function enrichedContext(): Record<string, unknown> {
  const evidence = externalEvidenceFixture();
  return ResolvedAddressContextSchema.parse({
    input_address: "1104 SPRING RUN RD",
    input_zip: "40514",
    selected: { id: 1104, norm_address: "1104 SPRING RUN RD", zip5: "40514", match_score: 1 },
    candidates: [],
    ambiguous: false,
    source_counts: SOURCE_COUNTS,
    // context-level only — evidence_map.property_types stays [] so the portfolio gate stays blind
    property_types: property_types_from_external(evidence),
    evidence_map: {
      address_id: 1104,
      normalized_address: "1104 SPRING RUN RD",
      zip5: "40514",
      source_counts: SOURCE_COUNTS,
      property_types: [],
      rental_market_summary: rental_market_summary_lines(evidence),
      evidence_refs: [
        ...external_evidence_refs(evidence),
        { source: "tax", table: "tax", rowid: 1, summary: "tax; ownername=DOE JOHN" },
      ],
    },
  }) as unknown as Record<string, unknown>;
}

function agentInput(packet_id: string, prompt_profile: "compact" | "full" = "compact"): HeuristicAgentInput {
  const heuristic = get_heuristic_catalog().find((item) => item["id"] === packet_id);
  if (heuristic === undefined) {
    throw new Error(`unknown packet: ${packet_id}`);
  }
  return HeuristicAgentInputSchema.parse({ heuristic, context: enrichedContext(), max_graphql_calls: 8, prompt_profile });
}

/** The exact prompt a solo packet worker is sent. */
function renderSolo(packet_id: string, prompt_profile: "compact" | "full" = "compact"): string {
  const toolset = new TypedToolset();
  const input = agentInput(packet_id, prompt_profile);
  return toolset.user_prompt(input, toolset.build_context(input));
}

/** The exact shared prompt a production bucket is sent (scope is UNIONed across the bucket). */
function renderGroup(packet_ids: string[], prompt_profile: "compact" | "full" = "compact"): string {
  return new TypedToolset().group_user_prompt(packet_ids.map((id) => agentInput(id, prompt_profile)));
}

describe("THE CRITICAL NEGATIVE TEST: owner_identity_and_mailing never sees str_scan", () => {
  test("solo prompt, compact profile", () => {
    const prompt = renderSolo("owner_identity_and_mailing");
    for (const marker of STR_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
  });

  test("solo prompt, full profile — profile is verbosity, not authorization", () => {
    const prompt = renderSolo("owner_identity_and_mailing", "full");
    for (const marker of STR_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
  });

  test("its PRODUCTION group prompt — the bucket union must not leak str_scan", () => {
    // _bucket_by_group pairs it with property_tax_context and run_group unions their scopes. The
    // exposure map is chosen so that union carries property_facts but NOT str_scan. This is the
    // assertion that makes the map's collapse-critical exclusion real in production.
    const prompt = renderGroup(["property_tax_context", "owner_identity_and_mailing"]);
    for (const marker of STR_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
  });
});

describe("portfolio_and_primary_comparison sees neither source", () => {
  test("it is a solo bucket, so nothing unions into it", () => {
    const prompt = renderSolo("portfolio_and_primary_comparison");
    for (const marker of STR_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
    expect(prompt).not.toContain("source_provider=realtor");
  });
});

describe("KNOWN CONSEQUENCES of the bucket union (decisions of record, not surprises)", () => {
  test("owner_identity_and_mailing DOES see property_facts via its bucket-mate", () => {
    // Accepted: property facts are not the smoking gun, and the packet is excluded because the
    // payload gives it no owner identity to reason with — not for collapse risk.
    expect(renderGroup(["property_tax_context", "owner_identity_and_mailing"])).toContain("source_provider=realtor");
  });

  test("legal_address_presence DOES see str_scan via its bucket-mate", () => {
    // It shares the occupancy_presence bucket with subject_occupancy_surfaces. Accepted per the
    // umbrella's per-bucket re-pin: regrouping would change a cost/latency property to serve an
    // exposure rule, and this packet is excluded for having nothing useful to reason with.
    expect(renderGroup(["subject_occupancy_surfaces", "legal_address_presence"])).toContain(
      "Short-term rental listing found on vrbo",
    );
  });

  test("but legal_address_presence sees nothing when run solo", () => {
    const prompt = renderSolo("legal_address_presence");
    for (const marker of STR_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
  });
});

describe("the exposed packets do see their sources", () => {
  test("subject_occupancy_surfaces sees the listing and the address-match framing", () => {
    const prompt = renderSolo("subject_occupancy_surfaces");
    expect(prompt).toContain("Rental Market");
    expect(prompt).toContain("Short-term rental listing found on vrbo: 3 bd / 2 ba / sleeps 6. Address match 92%.");
    expect(prompt).toContain("not a probability that the property is a rental");
  });

  test("subject_occupancy_surfaces sees it under the full profile too", () => {
    expect(renderSolo("subject_occupancy_surfaces", "full")).toContain("Short-term rental listing found on vrbo");
  });

  test("property_tax_context sees property_facts but NOT the listing channel", () => {
    const prompt = renderSolo("property_tax_context");
    expect(prompt).toContain("source_provider=realtor");
    expect(prompt).toContain("listing_status=for_rent");
    expect(prompt).not.toContain("Short-term rental listing");
    expect(prompt).not.toContain("vrbo");
  });

  test("loan_tenure sees the listing (it contradicts an own_rent: own claim)", () => {
    expect(renderSolo("loan_tenure")).toContain("Short-term rental listing found on vrbo");
  });

  test("case_quality_and_synthesis sees both — it cannot receive them transitively", () => {
    const prompt = renderSolo("case_quality_and_synthesis");
    expect(prompt).toContain("Short-term rental listing found on vrbo");
    expect(prompt).toContain("source_provider=realtor");
  });

  test("the property type reaches even an unexposed packet (context-level, global)", () => {
    expect(renderSolo("owner_identity_and_mailing")).toContain("single_family");
  });
});
```

- [ ] **Step 3: Run the test, verify it passes**

Run: `bun test test/external_evidence_exposure.test.ts`
Expected: PASS (13 tests). If any negative assertion fails, **stop**: the scope filter is broken,
not the test.

- [ ] **Step 4: Prove the guard actually bites**

```bash
# temporarily add "str_scan" to owner_identity_and_mailing's input_sources in src/heuristics/packets.ts
bun test test/external_evidence_exposure.test.ts
git checkout src/heuristics/packets.ts
```
Expected: FAIL on "solo prompt, compact profile" **and** on `test/packets_exposure_map.test.ts`.
Then revert and re-run: PASS. **A guard you have not seen fail is not a guard.**

- [ ] **Step 5: Commit**

```bash
git add test/support/fixtures.ts test/external_evidence_exposure.test.ts
git commit -m "test: the critical negative test — owner_identity never sees str_scan"
```

---

### Task 11: Orchestrator — fold the payload into the context

**Files:**
- Modify: `src/agents/orchestrator.ts` (imports; `preflight`; `_evidence_map`)
- Test: `test/preflight_external.test.ts`

> **Correction 2 (spec) is load-bearing here.** `property_types` is set on
> `ResolvedAddressContext` **only**; `evidence_map.property_types` stays `[]`. `adapters.ts:81`
> copies the evidence-map field into `AddressEvidence` and `_has_portfolio_hint`
> (`atomic_eval.ts:1184-1191`) fires on `"multi"`/`"portfolio"`, flipping
> `portfolio_primary_comparison_analysis` from skip to run (`atomic_eval.ts:1049`) — a packet that
> **scores** (1, cap 5). Both prompt builders prefer the context value; `evaluate_packet_gates`
> reads only the evidence-map one. Prompts see the type; the gate stays blind.

- [ ] **Step 1: Extract the shared test subagent (a refactor; the E2E stays green)**

Create `test/support/subagents.ts` with a `FakeSubagent` (schema-valid `not_triggered` result
echoing the packet id) and a `PromptRecordingSubagent extends FakeSubagent` that records
`toolset.user_prompt(input, toolset.build_context(input))` into a `Map<string, string>` keyed by
packet id, plus an `all()` helper joining every recorded prompt.

In `test/e2e/orchestrator.e2e.test.ts`, delete the local `FakeSubagent` class and its now-unused
`HeuristicAgentResultSchema` import; import from `../support/subagents.ts` instead.

Run: `bun test test/e2e && bun run typecheck`
Expected: PASS (2 tests) — a pure move, no behavior change.

```bash
git add test/support/subagents.ts test/e2e/orchestrator.e2e.test.ts
git commit -m "test: share the deterministic subagents from test/support"
```

- [ ] **Step 2: Write the failing test**

```ts
// test/preflight_external.test.ts
import { describe, expect, test } from "bun:test";
import { GraphQLHttpTool } from "../src/agents/graphql_tool.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import { FixtureGraphQLServer } from "./support/fixture_graphql.ts";
import { externalEvidenceFixture, loadPreflight1104 } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

async function preflight(external_evidence: unknown) {
  const server = new FixtureGraphQLServer(loadPreflight1104());
  try {
    const orch = new AgentOrchestrator({ graphql: new GraphQLHttpTool(server.url), subagent: new FakeSubagent() });
    return await orch.preflight(
      AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        graphql_url: server.url,
        external_evidence,
      }),
    );
  } finally {
    server.close();
  }
}

describe("preflight folds the payload into the context", () => {
  test("no payload: everything stays empty — byte-identical to today", async () => {
    const context = await preflight(null);
    expect(context.property_types).toEqual([]);
    expect(context.evidence_map.property_types).toEqual([]);
    expect(context.evidence_map.rental_market_summary).toEqual([]);
    expect(context.evidence_map.evidence_refs.every((r) => r.source === "tax")).toBe(true);
  });

  test("a payload fills the CONTEXT property_types and the listing channel", async () => {
    const context = await preflight(externalEvidenceFixture());
    expect(context.property_types).toEqual(["single_family"]);
    expect(context.evidence_map.rental_market_summary[0]).toContain("Short-term rental listing found on vrbo");
  });

  test("CORRECTION 2: evidence_map.property_types stays EMPTY so the portfolio gate stays blind", async () => {
    // adapters.ts:81 copies this field into AddressEvidence and _has_portfolio_hint
    // (atomic_eval.ts:1184) fires on "multi"/"portfolio", flipping a SCORING packet from skip to
    // run. Enrichment must move the score through reasoning, never through a gate flip.
    const context = await preflight({ property_facts: { source_provider: "redfin", home_type: "multi_family" } });
    expect(context.property_types).toEqual(["multi_family"]);   // prompts see it
    expect(context.evidence_map.property_types).toEqual([]);     // the gate does not
  });

  test("external refs are emitted FIRST so they survive the ref cap downstream", async () => {
    const context = await preflight(externalEvidenceFixture());
    expect(context.evidence_map.evidence_refs.map((r) => r.source).slice(0, 2)).toEqual(["str_scan", "property_facts"]);
    expect(context.evidence_map.evidence_refs.some((r) => r.source === "tax")).toBe(true);
  });

  test("an empty-but-present payload is negative evidence with no refs", async () => {
    const context = await preflight({ scan_id: "scan_9" });
    expect(context.evidence_map.rental_market_summary).toEqual([
      "All platforms scanned; no short-term rental listings matched this property.",
    ]);
    expect(context.evidence_map.evidence_refs.every((r) => r.source === "tax")).toBe(true);
    expect(context.property_types).toEqual([]);
  });

  test("source_counts never gains an external key — the deterministic weights are untouched", async () => {
    const context = await preflight(externalEvidenceFixture());
    expect(Object.keys(context.evidence_map.source_counts).sort()).toEqual([
      "auto", "base", "criminal", "drive", "loan", "tax", "trace", "utility", "voter",
    ]);
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `bun test test/preflight_external.test.ts`
Expected: FAIL — "a payload fills the CONTEXT property_types…": received `[]`, expected
`["single_family"]`.

- [ ] **Step 4: Minimal implementation**

In `src/agents/orchestrator.ts`, after the `./models.ts` import block:

```ts
import type { ExternalEvidence } from "./external_evidence.ts";
import {
  external_evidence_refs,
  property_types_from_external,
  rental_market_summary_lines,
} from "./external_evidence_map.ts";
```

In `preflight`, replace the `property_types` / `_evidence_map` lines:

```ts
    const source_counts = _source_counts((address_data ?? {}) as Record<string, any>);
    // Absent payload => empty, exactly as today: the blind (benchmarking) configuration.
    const external_evidence = request.external_evidence ?? null;
    // CONTEXT-level only. evidence_map.property_types stays [] — see _evidence_map below.
    const property_types = property_types_from_external(external_evidence);
    const evidence_map = _evidence_map(
      (address_data ?? {}) as Record<string, any>,
      selected,
      source_counts,
      external_evidence,
    );
```

Change `_evidence_map`'s signature — note `property_types` is **removed** as a parameter, because
the evidence map must never carry it:

```ts
function _evidence_map(
  address_data: Record<string, any>,
  selected: AddressCandidate | null,
  source_counts: Record<string, number>,
  external_evidence: ExternalEvidence | null = null,
): CaseEvidenceMap {
```
```ts
  // External refs are built first so they lead the list: compact_evidence_map's refs.slice(0, 8)
  // caps AFTER scope filtering, and the ordering is what keeps a citation a heuristic needs from
  // being crowded out. (compact_evidence_map re-asserts the ordering; this is where they enter.)
  const refs = [
    ...external_evidence_refs(external_evidence),
    ..._source_refs(address_data, "taxProperties", "tax", 5),
  ];
```
```ts
    // Deliberately EMPTY even with a payload: adapters.ts copies this into AddressEvidence and
    // _has_portfolio_hint flips a SCORING packet on "multi"/"portfolio". The property type reaches
    // prompts via ResolvedAddressContext.property_types, which both prompt builders prefer.
    property_types: [],
    rental_market_summary: rental_market_summary_lines(external_evidence),
```

**Do not touch `source_counts`** — the new sources must never enter it; it feeds the data-density
gate and the deterministic weights.

- [ ] **Step 5: Run the test, verify it passes**

Run: `bun test test/preflight_external.test.ts && bun test && bun run typecheck && bun run lint`
Expected: PASS (6 tests); full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/agents/orchestrator.ts test/preflight_external.test.ts
git commit -m "feat(agents): fold the external evidence payload into the resolved context"
```

---

### Task 12: `--evidence-file` and exit 2

**Files:**
- Modify: `cli/run_address.ts`
- Test: `test/run_address_evidence.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/run_address_evidence.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvidenceFile } from "../cli/run_address.ts";

const dir = mkdtempSync(join(tmpdir(), "oe-evidence-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, { encoding: "utf-8" });
  return path;
}

describe("readEvidenceFile", () => {
  test("parses a valid payload", () => {
    const path = write("ok.json", JSON.stringify({ scan_id: "s1", str_listings: [{ platform: "airbnb", address_match_pct: 91 }] }));
    expect(readEvidenceFile(path).str_listings[0]!.platform).toBe("airbnb");
  });

  test("a missing file throws — never a silent fallback to blind", () => {
    // Running blind when evidence was meant to arrive produces a plausible, confident, wrong
    // investigation whose failure mode is indistinguishable from a legitimate clean result.
    expect(() => readEvidenceFile(join(dir, "nope.json"))).toThrow(/could not be read/);
  });

  test("malformed JSON throws", () => {
    expect(() => readEvidenceFile(write("bad.json", "{not json"))).toThrow(/not valid JSON/);
  });

  test("a schema-violating payload throws", () => {
    expect(() => readEvidenceFile(write("wrong.json", JSON.stringify({ str_listings: [{ platform: "airbnb" }] })))).toThrow(
      /external evidence contract/,
    );
  });

  test("an unknown key throws — strict() makes structural drift loud", () => {
    expect(() => readEvidenceFile(write("extra.json", JSON.stringify({ scan_id: "s1", verdict: "risk" })))).toThrow(
      /external evidence contract/,
    );
  });

  test("an empty-but-present payload is valid (negative evidence)", () => {
    expect(readEvidenceFile(write("empty.json", JSON.stringify({ scan_id: "s2" }))).str_listings).toEqual([]);
  });
});

describe("cli exit codes", () => {
  test("a bad --evidence-file exits 2 before any investigation runs", async () => {
    const proc = Bun.spawn(
      [
        "bun", "run", "cli/run_address.ts",
        "--address", "1104 SPRING RUN RD",
        // an unroutable port: if we ever reached the investigation this would fail differently
        "--graphql-url", "http://127.0.0.1:9/graphql",
        "--evidence-file", join(dir, "nope.json"),
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("--evidence-file could not be read");
  });

  test("a schema-violating --evidence-file exits 2", async () => {
    const path = write("cli_wrong.json", JSON.stringify({ str_listings: [{ platform: "airbnb" }] }));
    const proc = Bun.spawn(
      ["bun", "run", "cli/run_address.ts", "--address", "x", "--graphql-url", "http://127.0.0.1:9/graphql", "--evidence-file", path],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("external evidence contract");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test test/run_address_evidence.test.ts`
Expected: FAIL — `Export named 'readEvidenceFile' not found in module '.../cli/run_address.ts'`

- [ ] **Step 3: Minimal implementation**

In `cli/run_address.ts`, extend the `node:fs` import with `readFileSync`, import
`ExternalEvidenceSchema` + `type ExternalEvidence`, and add after `reportDestination`:

```ts
/**
 * Read + validate the --evidence-file payload.
 *
 * Throws on a missing, unreadable, non-JSON or schema-violating file. The caller turns that into
 * exit 2 — never a silent fallback to blind. An ABSENT flag is the blind configuration and is
 * always fine; a flag that was meant to carry evidence and didn't must fail loudly, because a
 * blind run's wrong answer is indistinguishable downstream from a legitimate clean result.
 */
export function readEvidenceFile(path: string): ExternalEvidence {
  let raw: string;
  try {
    raw = readFileSync(path, { encoding: "utf-8" });
  } catch (exc) {
    throw new Error(`--evidence-file could not be read: ${path}: ${(exc as Error).message ?? exc}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (exc) {
    throw new Error(`--evidence-file is not valid JSON: ${path}: ${(exc as Error).message ?? exc}`);
  }
  const result = ExternalEvidenceSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`--evidence-file does not match the external evidence contract: ${path}: ${result.error.message}`);
  }
  return result.data;
}
```

Add the option `"evidence-file": { type: "string" },` to `parseArgs`; after the `--graphql-url`
check and before the request parse:

```ts
  let externalEvidence: ExternalEvidence | null = null;
  if (values["evidence-file"]) {
    try {
      externalEvidence = readEvidenceFile(values["evidence-file"]);
    } catch (exc) {
      process.stderr.write(`${(exc as Error).message ?? exc}\n`);
      return 2;
    }
  }
```

and `external_evidence: externalEvidence,` to the `AgentInvestigationRequestSchema.parse({...})` call.

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test test/run_address_evidence.test.ts && bun run typecheck && bun run lint`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add cli/run_address.ts test/run_address_evidence.test.ts
git commit -m "feat(cli): --evidence-file with hard exit 2 on missing or invalid payloads"
```

---

### Task 13: THE E2E PARITY GUARD (E2E-3)

**Files:**
- Modify: `test/e2e/orchestrator.e2e.test.ts`

This proves the blind default is genuinely untouched — which is what protects the benchmarking
configuration, the whole reason the data was removed originally.

- [ ] **Step 1: Write the test**

Append to `test/e2e/orchestrator.e2e.test.ts`, extending the imports with `PromptRecordingSubagent`:

```ts
describe("E2E-3: the parity guard — no payload, behavior unchanged", () => {
  test("investigate() with no payload exposes no external evidence anywhere", async () => {
    const server = new FixtureGraphQLServer(loadPreflight1104());
    const subagent = new PromptRecordingSubagent();
    try {
      const orch = new AgentOrchestrator({ graphql: new GraphQLHttpTool(server.url), subagent });
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        graphql_url: server.url,
      });
      expect(request.external_evidence).toBeNull(); // the absent payload IS the blind switch

      const a = await orch.investigate(request);

      // 1. everything stays exactly as empty as it is today
      expect(a.resolved_address.property_types).toEqual([]);
      expect(a.resolved_address.evidence_map.property_types).toEqual([]);
      expect(a.resolved_address.evidence_map.rental_market_summary).toEqual([]);

      // 2. no external source reaches any evidence surface
      const sources = [
        ...a.resolved_address.evidence_map.evidence_refs.map((r) => r.source),
        ...a.evidence_pack.map((r) => r.source),
      ];
      expect(sources.some((s) => s === "str_scan" || s === "property_facts")).toBe(false);
      expect(Object.keys(a.resolved_address.evidence_map.source_counts)).not.toContain("str_scan");

      // 3. no external CONTENT reaches any rendered packet prompt.
      //    Note: the bare token "str_scan" DOES appear in the exposed packets' "Context scope:" /
      //    "Expected sources:" lines even blind — input_sources is static, and that is pinned by
      //    the exposure map. What must never appear with no payload is the evidence itself.
      expect(subagent.all()).not.toContain("Rental Market");
      expect(subagent.all()).not.toContain("Short-term rental listing");
      expect(subagent.all()).not.toContain("str_scan; platform=");
      expect(subagent.all()).not.toContain("property_facts; source_provider=");
      expect(subagent.all()).not.toContain("not a probability that the property is a rental");

      // 4. and the assessment still assembles exactly as E2E-1 asserts
      expect(a.resolved_address.selected).not.toBeNull();
      expect(a.heuristics.length).toBeGreaterThan(0);
      expect(a.heuristics.every((h: any) => h.status !== "error")).toBe(true);
      expect(a.adjudication.verdict_band).toBeTruthy();
      expect(a.report.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun run e2e`
Expected: PASS (3 tests). If it fails, the blind default has been perturbed — **fix the source,
never the guard.**

- [ ] **Step 3: Prove the guard bites**

```bash
# temporarily make rental_market_summary_lines(null) return ["probe"] in src/agents/external_evidence_map.ts
bun run e2e
git checkout src/agents/external_evidence_map.ts
```
Expected: FAIL on the `rental_market_summary` assertion, then PASS after revert.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/orchestrator.e2e.test.ts
git commit -m "test(e2e): parity guard — no payload leaves blind behavior untouched"
```

---

### Task 14: E2E enriched (E2E-4)

**Files:**
- Modify: `test/e2e/orchestrator.e2e.test.ts`

- [ ] **Step 1: Write the test**

Append to `test/e2e/orchestrator.e2e.test.ts`, extending the fixtures import with
`externalEvidenceFixture`:

```ts
describe("E2E-4: enriched — a payload reaches exactly the exposed packets", () => {
  test("investigate() folds the payload in and exposes it selectively", async () => {
    const server = new FixtureGraphQLServer(loadPreflight1104());
    const subagent = new PromptRecordingSubagent();
    try {
      const orch = new AgentOrchestrator({ graphql: new GraphQLHttpTool(server.url), subagent });
      const a = await orch.investigate(
        AgentInvestigationRequestSchema.parse({
          address: "1104 SPRING RUN RD",
          zip: "40514",
          graphql_url: server.url,
          external_evidence: externalEvidenceFixture(),
        }),
      );

      // the payload landed, external refs leading; the gate-facing field stayed empty
      expect(a.resolved_address.property_types).toEqual(["single_family"]);
      expect(a.resolved_address.evidence_map.property_types).toEqual([]);
      expect(a.resolved_address.evidence_map.rental_market_summary.length).toBeGreaterThan(0);
      expect(a.resolved_address.evidence_map.evidence_refs.map((r) => r.source).slice(0, 2)).toEqual([
        "str_scan",
        "property_facts",
      ]);
      // the full structured detail survives for audit
      expect(a.resolved_address.evidence_map.evidence_refs[0]!.data["listing_url"]).toBe("https://www.vrbo.com/1234567");

      // case_quality_and_synthesis always runs (its gate returns run or run_for_absence), so it is
      // the one packet we can anchor on regardless of what the fixture gates in.
      expect(subagent.prompts.has("case_quality_and_synthesis")).toBe(true);
      expect(subagent.prompts.get("case_quality_and_synthesis")!).toContain("Short-term rental listing found on vrbo");
      expect(subagent.prompts.get("case_quality_and_synthesis")!).toContain("source_provider=realtor");

      // and every packet that DID run obeys the exposure map. Solo dispatch (FakeSubagent has no
      // run_group), so this asserts the per-packet scope, not the bucket union — which
      // test/external_evidence_exposure.test.ts covers.
      const STR_EXPOSED = new Set(["subject_occupancy_surfaces", "loan_tenure", "case_quality_and_synthesis"]);
      const FACTS_EXPOSED = new Set(["property_tax_context", "case_quality_and_synthesis"]);
      for (const [packet_id, prompt] of subagent.prompts) {
        if (STR_EXPOSED.has(packet_id)) {
          expect([packet_id, prompt.includes("Short-term rental listing found on vrbo")]).toEqual([packet_id, true]);
        } else {
          expect([packet_id, prompt.includes("Short-term rental listing")]).toEqual([packet_id, false]);
          expect([packet_id, prompt.includes("vrbo")]).toEqual([packet_id, false]);
        }
        expect([packet_id, prompt.includes("source_provider=realtor")]).toEqual([packet_id, FACTS_EXPOSED.has(packet_id)]);
      }

      expect(a.heuristics.every((h: any) => h.status !== "error")).toBe(true);
      expect(a.adjudication.verdict_band).toBeTruthy();
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun run e2e`
Expected: PASS (4 tests). The `[packet_id, bool]` tuple form is deliberate: a failure names the
offending packet instead of printing `false !== true`.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/orchestrator.e2e.test.ts
git commit -m "test(e2e): enriched run exposes external evidence per the pinned map"
```

---

### Task 15: Gates, ledger, journal, PR

**Files:**
- Modify: `feature_list.json`, `PROGRESS.md`

- [ ] **Step 1: Run the real gate**

Run: `bun run verify`
Expected: typecheck clean, lint clean, `bun test` green. **Record the exact pass/fail counts from
the output** — `evidence` must be what the terminal said, not what you expect it to say.

- [ ] **Step 2: Prove the E2E runs with no credentials, and under the prose flag**

```bash
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY bun test test/e2e
OE_PROSE_REDACT=1 bun run verify
```
Expected: PASS (4 E2E tests), no network, no key; green under the prose scrubber.

- [ ] **Step 3: Add the feature_list entry**

Insert before `batch-cli` (keep priorities ordered; at most one `in_progress`). Flip to `"passing"`
only after Step 1 is green **with recorded output**:

```json
  {
    "id": "external-evidence-wiring",
    "priority": 7,
    "area": "agents",
    "title": "External evidence wiring (STR scan results + property facts)",
    "user_visible_behavior": "bun run run-address --evidence-file <json> feeds STR scan results and property facts to the packets that can reason with them; with no --evidence-file the engine runs blind exactly as before.",
    "status": "passing",
    "verification": "bun run verify; test/external_evidence_exposure.test.ts (the critical negative test); test/prose_external_evidence.test.ts (scrubber survival); test/e2e E2E-3 (parity guard) + E2E-4 (enriched); env -u ANTHROPIC_API_KEY bun test test/e2e; OE_PROSE_REDACT=1 bun run verify.",
    "evidence": "<paste the real counts from bun run verify and bun run e2e>",
    "notes": "Contract in src/agents/external_evidence.ts; exposure map locked by test/packets_exposure_map.test.ts. str_scan/property_facts are deliberately NOT in SUBSTANTIVE_SOURCES. evidence_map.property_types stays EMPTY on purpose — it feeds _has_portfolio_hint, a SCORING gate."
  },
```

Renumber `batch-cli`/`judge-package`/`observability-summaries` to 8/9/10.

Run: `bun test test/feature_list.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Append the PROGRESS.md Session Record**

Under `<!-- newest first; one entry per working session -->`:

```md
### 2026-07-17 — External evidence wiring
- **Goal:** Feed STR scan results + property facts to the packets that can reason with them, without disturbing the blind (benchmarking) configuration.
- **Completed:** `ExternalEvidenceSchema` contract + `--evidence-file` (exit 2 on any failure); payload folded into the resolved context (`rental_market_summary` gated, external refs first, `property_types` context-only); scope gating closed in BOTH prompt profiles; `render_context_sections` renders the gated channel (it never read the slot before — the last mile was missing); exposure map on 4 of 7 packets; `EXTERNAL_EVIDENCE_SOURCES` + note in `policy.ts`, stale `WITHHELD_EXTERNAL_EVIDENCE_NOTE` deleted.
- **Verification run:** `bun run verify`; `bun run e2e`; `env -u ANTHROPIC_API_KEY bun test test/e2e`; `OE_PROSE_REDACT=1 bun run verify`.
- **Evidence:** <real counts>. The critical negative test (owner_identity_and_mailing never sees str_scan — solo, grouped, both profiles) and the E2E parity guard (no payload => blind unchanged) both green; both verified to FAIL when deliberately broken.
- **Commits:** branch `feat/external-evidence` (base `main`, after the X-008/X-009 stack fast-forwarded).
- **Known consequences (decisions of record, not bugs):** (1) `input_sources` is static, so exposed packets' prompts name `str_scan` in "Context scope"/"Expected sources" even blind — no evidence content leaks (E2E-3 asserts it). (2) The BUCKET is the unit of exposure: `_union_source_scope` means `owner_identity_and_mailing` sees `property_facts` and `legal_address_presence` sees `str_scan` via their bucket-mates; the collapse-critical exclusions (owner_identity <- str_scan, portfolio <- both) survive and are asserted. (3) `evidence_map.property_types` is deliberately empty — filling it would flip `_has_portfolio_hint` and move the score through a gate rather than through reasoning.
- **Next best action:** merge to `main`, then bump the backend's engine submodule pointer and land backend B2-B4.
```

- [ ] **Step 5: Final gate + clean tree**

```bash
bun run verify
git status --short
```
Expected: green; clean except the two staged docs.

- [ ] **Step 6: Commit and open the PR against `main`**

```bash
git add feature_list.json PROGRESS.md
git commit -m "docs: feature_list + PROGRESS session record for external evidence wiring"
git push -u origin feat/external-evidence
```

PR base **`main`** (never `staging`). Body: link the umbrella plan + spec; name the acceptance
signals — the critical negative test, the E2E parity guard, the prose-scrubber survival test — plus
the three Known Consequences above.

---

## Verification / Definition of Done

- [ ] `bun run verify` green, run in place (typecheck + lint + `bun test`, which includes the E2E)
- [ ] `env -u ANTHROPIC_API_KEY bun test test/e2e` green — no API, no live server
- [ ] `OE_PROSE_REDACT=1 bun run verify` green — the scrubber does not eat this feature's evidence
- [ ] **The critical negative test** green, and observed FAILING when `str_scan` is temporarily added to `owner_identity_and_mailing`
- [ ] **The E2E parity guard** green, and observed FAILING when the blind path is temporarily perturbed
- [ ] `str_scan` / `property_facts` appear in **no** `SUBSTANTIVE_SOURCES`, `SOURCE_RELIABILITY_WEIGHTS`, `RANKED_SOURCE_ORDER`, `_SOURCE_TOKEN_BY_PATH`, or `source_counts`
- [ ] `evidence_map.property_types` is empty even with a payload — the portfolio gate stays blind
- [ ] `case_quality_and_synthesis.input_sources` / `gate.source_scope` are copies, never mutations
- [ ] `WITHHELD_EXTERNAL_EVIDENCE_NOTE` gone from `atomic.ts`; `EXTERNAL_EVIDENCE_NOTE` lives beside `SUBSTANTIVE_SOURCES`
- [ ] `scripts/capture_preflight_fixture.ts` untouched — the payload fixture is built **through** `ExternalEvidenceSchema`, not declared as a second copy of the contract
- [ ] No Python-referencing names or comments in anything added
- [ ] `feature_list.json` entry `passing` with **real** recorded evidence; `PROGRESS.md` Session Record appended; `git status` clean
- [ ] PR base is `main`

**Deferred to the umbrella (not this repo's DoD):** the live full-stack run and the blind control.
Until the backend passes `--evidence-file`, this branch's new path is dormant (`external_evidence`
defaults to `null`) — which is exactly why the parity guard makes it safe to merge first.

---

## Risks and known consequences

1. **Blind prompts gain source tokens without evidence.** `input_sources` / `gate.source_scope` are
   static, so `str_scan` appears in exposed packets' `Context scope:` lines even with no payload.
   Forced by the pinned exposure map; no evidence *content* leaks (E2E-3 asserts it). If the
   reviewer wants byte-identical blind prompts, that is an exposure-map change and belongs upstream
   in the umbrella — **do not improvise it here.**
2. **The bucket is the unit of exposure.** `owner_identity_and_mailing` sees `property_facts` and
   `legal_address_presence` sees `str_scan` via `_union_source_scope`. Accepted and re-pinned
   per-bucket by user decision (2026-07-17); the collapse-critical exclusions survive and are
   asserted at both levels.
3. **External refs can crowd out tax refs.** With external refs first, an exposed packet with 3+
   listings plus `property_facts` pushes tax refs past `slice(0, 8)`. Accepted per the spec (refs
   are prompt context; the agent still fetches rows via its tools). The backend already drops
   listings below 50% match, which bounds it.
4. **The master adjudicator/planner see everything.** They call `prompt_context` with
   `source_scope = null`, and an empty scope means "no scope supplied ⇒ see everything" — unchanged
   semantics, consistent with `case_quality_and_synthesis` being exposed. Not a regression; noted so
   nobody mistakes it for one.
5. **Bun 1.3.10 `toMatchObject` with asymmetric matchers mutates the received object**, so later
   assertions pass vacuously. Every test here uses explicit `toEqual` / `toContain` / `typeof`
   checks — **do not "simplify" them into `toMatchObject`.**
