# Realtor Listing Signals → AI Layer (engine) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Landmine (carried from X-011/X-012): Bun 1.3.10
> `toMatchObject` with asymmetric matchers (`expect.any`) **mutates** the received object and can
> pass vacuously — every test below uses explicit `toEqual` / `toContain` / `typeof` checks only.
> **Do not "simplify" them into `toMatchObject`.**

**Goal:** Forward realtor's most direct occupancy signals — rental-listing history plus last-sale
recency, list date, and distress flags — to the AI investigation engine by widening the mirrored
`.strict()` `ExternalEvidence` contract and folding the new fields into the two channels that already
carry external evidence to the packets, entirely additively.

**Architecture:** Two engine files change. `src/agents/external_evidence.ts` (the contract) gains a
new `RentalListingSchema`, four `PropertyFactsSchema` transaction fields, and a top-level
`rental_listings` array. `src/agents/external_evidence_map.ts` folds `rental_listings` into the
existing `rental_market_summary_lines` (the rental-market channel, gated behind the existing
`str_scan` token) and folds the four transaction fields into `_facts_summary` (the `property_facts`
ref). Both new arrays carry `.default([])`, so an ExternalEvidence-absent run is byte-identical to
today. The exposure map (`src/heuristics/packets.ts`) is **not touched** — the new fields ride the
existing `str_scan` / `property_facts` gates with **no new scope token**.

**Tech Stack:** Bun 1.3.10 + TypeScript + zod 3 (`.strict()`); `bun test`; Biome.

**Spec:** `../../../../docs/superpowers/specs/2026-07-20-realtor-listing-signals-design.md` — approved.

**Umbrella:** `../../../../docs/superpowers/plans/2026-07-20-realtor-listing-signals.md` — owns **the
pinned contract** (§ "The pinned contract"). Honor it exactly: `rental_listings` is a **flat array of
the most-recent-2** rental events (NOT `{count, recent[]}`); the total count stays backend-internal
and does not cross. Mirror this plan's contract additions in the X-012 pattern
(`docs/superpowers/plans/2026-07-17-engine-external-evidence-wiring.md`).

**Branch:** `feat/realtor-listing-signals`, cut from **`main`** (`scripts/repo-branch.sh engine` →
`main`; engine `main` is already X-013-complete at tip `2a9a095` — a clean cut, no stacking). Every
`git checkout` / PR base / merge targets `main`.

**Conventions:** `src/**` uses snake_case functions + PascalCase schemas. `.strict()` on every
object schema. Native TS only — no Python-referencing names or comments. All work is **additive**:
nothing existing changes shape.

**Gates (engine DoD):**
- `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify` — the gitignored `.env` sets
  `OE_PROSE_*=on` and Bun auto-loads it, producing **2 pre-existing tautological prose-test
  failures** (`proseRedactEnabled > is off by default` and `_prose_register_lines (gated) > is empty
  by default`). Do **not** fix those two; the env-prefixed command is the true baseline.
- `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e`

Recorded baseline (X-013 tip `2a9a095`): `verify` = typecheck clean, lint 0 errors (3 pre-existing
warnings), **152 pass / 0 fail / 619 expect() across 28 files**; `e2e` = **6 pass / 0 fail / 71
expect() across 2 files**. Record the real post-change counts in `feature_list.json`.

---

### Task 0: Cut the branch from `main`

**Files:** none (git only).

- [ ] **Step 1: Confirm the base from config — never hardcode**

Run: `bash ../scripts/repo-branch.sh engine`
Expected: `main`

- [ ] **Step 2: Confirm `main` is X-013-complete and the tree is clean**

```bash
git checkout main
git fetch origin
git log -1 --oneline            # expect: 2a9a095 docs: record the coordinator live gates for the engine HTTP service
git status --short              # expect: empty
```

- [ ] **Step 3: Check out the branch (it may already exist carrying this plan file)**

```bash
# If the branch already exists (created at planning time with this plan doc), rebase it onto main:
git checkout feat/realtor-listing-signals && git rebase main
# ELSE, if it does not exist, cut it fresh from main:
#   git checkout -b feat/realtor-listing-signals main
```
Expected: on `feat/realtor-listing-signals`, based on `main` (`2a9a095`), tree clean.

- [ ] **Step 4: Record the pre-change baseline (must be green before a line changes)**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify`
Expected: typecheck clean, lint clean, **152 pass / 0 fail** (the .env-default `bun test` without the
prefix would show 150 pass / 2 fail — the two pre-existing tautological prose tests; that is expected
and not this plan's to fix).

---

### Task 1: Contract widening — `src/agents/external_evidence.ts`

**Files:**
- Modify: `src/agents/external_evidence.ts` (add `RentalListingSchema`; 4 `PropertyFactsSchema`
  fields; top-level `rental_listings`)
- Test: `test/external_evidence.test.ts`

- [ ] **Step 1: Write the failing tests**

Extend the existing import in `test/external_evidence.test.ts` to add `RentalListingSchema`:

```ts
import {
  ExternalEvidenceSchema,
  PropertyFactsSchema,
  RentalListingSchema,
  StrListingSchema,
} from "../src/agents/external_evidence.ts";
```

Append this describe block:

```ts
describe("X-014: RentalListingSchema + property_facts / rental_listings widening", () => {
  test("RentalListingSchema parses a full event; date is the only required field", () => {
    const parsed = RentalListingSchema.parse({ date: "2026-05-02", price: 2300, source: "AppfolioUnits" });
    expect(parsed.date).toBe("2026-05-02");
    expect(parsed.price).toBe(2300);
    expect(parsed.source).toBe("AppfolioUnits");
    // price/source are nullish
    expect(RentalListingSchema.parse({ date: "2025-03-20" }).price ?? null).toBeNull();
    // date is required
    expect(() => RentalListingSchema.parse({ price: 2300 })).toThrow();
  });

  test("RentalListingSchema is strict — an unknown key is rejected", () => {
    expect(() => RentalListingSchema.parse({ date: "2026-05-02", event_name: "Listed for rent" })).toThrow();
  });

  test("rental_listings is a top-level array defaulting to [] (blind parity)", () => {
    expect(ExternalEvidenceSchema.parse({}).rental_listings).toEqual([]);
    const parsed = ExternalEvidenceSchema.parse({
      rental_listings: [
        { date: "2026-05-02", price: 2300, source: "AppfolioUnits" },
        { date: "2025-03-20", price: 2195, source: "AppfolioUnits" },
      ],
    });
    expect(parsed.rental_listings).toHaveLength(2);
    expect(parsed.rental_listings[0]!.date).toBe("2026-05-02");
  });

  test("property_facts gains the four transaction fields; flags defaults [] when absent", () => {
    const facts = PropertyFactsSchema.parse({
      source_provider: "realtor",
      listing_status: "for_rent",
      last_sold_date: "2018-10-25",
      last_sold_price: 195000,
      list_date: "2026-05-02",
    });
    expect(facts.last_sold_date).toBe("2018-10-25");
    expect(facts.last_sold_price).toBe(195000);
    expect(facts.list_date).toBe("2026-05-02");
    expect(facts.flags).toEqual([]); // the clean case adds nothing
  });

  test("property_facts.flags accepts a string[]; both objects stay strict", () => {
    expect(PropertyFactsSchema.parse({ source_provider: "realtor", flags: ["foreclosure"] }).flags).toEqual([
      "foreclosure",
    ]);
    expect(() => ExternalEvidenceSchema.parse({ rental_listings: [{ date: "x" }], bogus: 1 })).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/external_evidence.test.ts`
Expected: FAIL — `Export named 'RentalListingSchema' not found in module '.../src/agents/external_evidence.ts'`
(the whole file fails to import).

- [ ] **Step 3: Minimal implementation**

In `src/agents/external_evidence.ts`, insert `RentalListingSchema` immediately after `StrListingSchema`
/ its `export type` (before `PropertyFactsSchema`):

```ts
export const RentalListingSchema = z
  .object({
    // A realtor property_history "Listed for rent" event. Flat + .strict(), structurally parallel
    // to StrListingSchema: the most-recent-2 events cross the contract as a flat array (NOT
    // {count, recent[]}); the total count stays a backend-internal derivation value and never
    // crosses. Introduces (with property_facts.flags) the first array shapes into this contract.
    date: z.string(), // realtor event date, ISO-ish as returned, e.g. "2026-05-02"
    price: z.number().nullish(), // monthly rent when present
    source: z.string().nullish(), // event source_name, e.g. "AppfolioUnits" (a property manager)
  })
  .strict();
export type RentalListing = z.infer<typeof RentalListingSchema>;
```

In `PropertyFactsSchema`, insert the four fields immediately after the existing `listing_status`
line (leaving `property_url` last):

```ts
    listing_status: z.string().nullish(),
    // X-014 transaction context (additive; the original 9 fields are unchanged): ownership-change
    // recency, on-market recency, and distress state. flags is truthy labels only and defaults []
    // so the clean case is 0 tokens and an absent payload stays byte-identical.
    last_sold_date: z.string().nullish(),
    last_sold_price: z.number().nullish(),
    list_date: z.string().nullish(),
    flags: z.array(z.string()).default([]),
    property_url: z.string().nullish(),
```

In `ExternalEvidenceSchema`, insert `rental_listings` immediately after the `str_listings` line:

```ts
    str_listings: z.array(StrListingSchema).default([]),
    // X-014: realtor rental-listing history, sibling to str_listings and riding the same
    // rental_market channel to the occupancy packets. Flat array of the most-recent-2 events.
    // .default([]) preserves blind parity — an absent payload yields [].
    rental_listings: z.array(RentalListingSchema).default([]),
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/external_evidence.test.ts && bun run typecheck`
Expected: PASS (11 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/external_evidence.ts test/external_evidence.test.ts
git commit -m "feat(agents): widen ExternalEvidence contract for realtor listing signals (rental_listings + transaction facts)"
```

---

### Task 2: Rental channel — fold `rental_listings` into `rental_market_summary_lines`

**Files:**
- Modify: `src/agents/external_evidence_map.ts` (import `RentalListing`; add rental helpers;
  restructure `rental_market_summary_lines`)
- Test: `test/external_evidence_map.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/external_evidence_map.test.ts` (the file already imports `ExternalEvidenceSchema`,
`rental_market_summary_lines`, `external_evidence_refs`):

```ts
describe("rental_market_summary_lines folds realtor rental_listings (X-014)", () => {
  test("emits the pinned realtor-history line beside the STR listing", () => {
    const evidence = ExternalEvidenceSchema.parse({
      str_listings: [{ platform: "vrbo", bedrooms: 3, baths: 2, guests: 6, address_match_pct: 92 }],
      address_match_confidence: 83,
      rental_listings: [
        { date: "2026-05-02", price: 2300, source: "AppfolioUnits" },
        { date: "2025-03-20", price: 2195, source: "AppfolioUnits" },
      ],
    });
    const lines = rental_market_summary_lines(evidence);
    expect(lines).toContain(
      "Property listed for rent (realtor history): 2026-05 $2300, 2025-03 $2195 — source AppfolioUnits.",
    );
    // the STR line and semantics are unchanged
    expect(lines[0]).toBe("Short-term rental listing found on vrbo: 3 bd / 2 ba / sleeps 6. Address match 92%.");
    expect(lines.some((l) => l.includes("not a probability that the property is a rental"))).toBe(true);
  });

  test("realtor history is emitted even when no STR listing matched — the 1104 case", () => {
    const evidence = ExternalEvidenceSchema.parse({
      rental_listings: [{ date: "2026-05-02", price: 2300, source: "AppfolioUnits" }],
    });
    // the STR-negative line AND the realtor-positive line coexist (two independent facts)
    expect(rental_market_summary_lines(evidence)).toEqual([
      "All platforms scanned; no short-term rental listings matched this property.",
      "Property listed for rent (realtor history): 2026-05 $2300 — source AppfolioUnits.",
    ]);
  });

  test("a rental event with no price renders the year-month alone; no source omits the suffix", () => {
    const evidence = ExternalEvidenceSchema.parse({ rental_listings: [{ date: "2024-11-01" }] });
    expect(rental_market_summary_lines(evidence)).toContain(
      "Property listed for rent (realtor history): 2024-11.",
    );
  });

  test("empty rental_listings adds nothing — the existing empty-payload behavior is byte-identical", () => {
    expect(rental_market_summary_lines(ExternalEvidenceSchema.parse({ scan_id: "scan_9" }))).toEqual([
      "All platforms scanned; no short-term rental listings matched this property.",
    ]);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/external_evidence_map.test.ts`
Expected: FAIL on "emits the pinned realtor-history line…": the current fold ignores `rental_listings`,
so `lines` does not contain the realtor-history line.

- [ ] **Step 3: Minimal implementation**

In `src/agents/external_evidence_map.ts`, extend the type import to add `RentalListing`:

```ts
import type { ExternalEvidence, PropertyFacts, RentalListing, StrListing } from "./external_evidence.ts";
```

Add these helpers immediately after `_listing_line` (before `rental_market_summary_lines`):

```ts
/** Trim a realtor event date to year-month for the summary line: "2026-05-02" -> "2026-05". */
function _year_month(date: string): string {
  return date.slice(0, 7);
}

/** One realtor rental event: "2026-05 $2300", or "2026-05" when no price is present. */
function _rental_event(listing: RentalListing): string {
  const ym = _year_month(listing.date);
  return typeof listing.price === "number" ? `${ym} $${listing.price}` : ym;
}

/**
 * The realtor rental-history line, folded into rental_market_summary beside the STR-scan listings:
 * both are rental-market signals gated behind the SAME str_scan token, so a realtor "Listed for
 * rent" event lands next to the Airbnb/Vrbo line as a second, independent source corroborating
 * "rented". The source is the property-manager name (e.g. AppfolioUnits); when several events share
 * it, it is cited once.
 */
function _rental_history_line(listings: RentalListing[]): string {
  const events = listings.map((listing) => _rental_event(listing)).join(", ");
  const sources: string[] = [];
  for (const listing of listings) {
    if (typeof listing.source === "string" && listing.source !== "" && !sources.includes(listing.source)) {
      sources.push(listing.source);
    }
  }
  const suffix = sources.length > 0 ? ` — source ${sources.join(", ")}` : "";
  return `Property listed for rent (realtor history): ${events}${suffix}.`;
}
```

Replace `rental_market_summary_lines` with the restructured version (folds `rental_listings`
regardless of `str_listings`, preserving every existing output):

```ts
/** The rental_market_summary lines — the listing channel, gated behind str_scan scope. */
export function rental_market_summary_lines(evidence: ExternalEvidence | null): string[] {
  if (evidence === null) {
    return [];
  }
  const lines: string[] =
    evidence.str_listings.length === 0
      ? [NO_LISTINGS_LINE]
      : evidence.str_listings.map((listing) => _listing_line(listing));
  if (evidence.str_listings.length > 0) {
    lines.push(ADDRESS_MATCH_SEMANTICS);
    if (typeof evidence.address_match_confidence === "number") {
      lines.push(
        `Scan-level address-match confidence ${_num(evidence.address_match_confidence)}% (0-100, same semantics).`,
      );
    }
  }
  // Realtor rental history: an INDEPENDENT rental-market source, folded regardless of str_listings
  // (the 1104 case has realtor history but no matched STR listing). Rides the same str_scan gate.
  if (evidence.rental_listings.length > 0) {
    lines.push(_rental_history_line(evidence.rental_listings));
  }
  return lines;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/external_evidence_map.test.ts && bun run typecheck`
Expected: PASS (12 tests so far: 8 pre-existing + 4 new); typecheck clean. The four pre-existing
`rental_market_summary_lines` tests still pass unchanged (empty/null/no-detail cases preserved).

- [ ] **Step 5: Commit**

```bash
git add src/agents/external_evidence_map.ts test/external_evidence_map.test.ts
git commit -m "feat(agents): fold realtor rental_listings into the rental_market_summary channel"
```

---

### Task 3: Property-facts channel — render the four transaction fields in `_facts_summary`

**Files:**
- Modify: `src/agents/external_evidence_map.ts` (`_facts_summary`)
- Test: `test/external_evidence_map.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/external_evidence_map.test.ts`:

```ts
describe("_facts_summary renders the X-014 transaction fields (via external_evidence_refs)", () => {
  test("the property_facts ref summary includes last_sold_*, list_date, and flags", () => {
    const evidence = ExternalEvidenceSchema.parse({
      scan_id: "scan_123",
      property_facts: {
        source_provider: "realtor",
        listing_status: "for_rent",
        last_sold_date: "2018-10-25",
        last_sold_price: 195000,
        list_date: "2026-05-02",
        flags: ["foreclosure"],
      },
    });
    const factsRef = external_evidence_refs(evidence).find((r) => r.source === "property_facts")!;
    expect(factsRef.summary).toContain("last_sold_date=2018-10-25");
    expect(factsRef.summary).toContain("last_sold_price=195000");
    expect(factsRef.summary).toContain("list_date=2026-05-02");
    expect(factsRef.summary).toContain("flags=foreclosure");
  });

  test("empty flags renders nothing — the clean case adds 0 tokens", () => {
    const evidence = ExternalEvidenceSchema.parse({
      scan_id: "scan_123",
      property_facts: { source_provider: "realtor", flags: [] },
    });
    const factsRef = external_evidence_refs(evidence).find((r) => r.source === "property_facts")!;
    expect(factsRef.summary).not.toContain("flags=");
  });

  test("multiple flags are comma-joined; rental_listings NEVER appears in the facts channel", () => {
    const evidence = ExternalEvidenceSchema.parse({
      scan_id: "scan_123",
      rental_listings: [{ date: "2026-05-02", price: 2300, source: "AppfolioUnits" }],
      property_facts: { source_provider: "realtor", flags: ["foreclosure", "short_sale"] },
    });
    const factsRef = external_evidence_refs(evidence).find((r) => r.source === "property_facts")!;
    expect(factsRef.summary).toContain("flags=foreclosure,short_sale");
    // rental history belongs ONLY to the rental channel, never the property_facts ref
    expect(factsRef.summary).not.toContain("AppfolioUnits");
    expect(factsRef.summary).not.toContain("listed for rent");
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/external_evidence_map.test.ts`
Expected: FAIL on "the property_facts ref summary includes last_sold_*…": `_facts_summary` does not
yet render the new fields, so `summary` lacks `last_sold_date=2018-10-25`.

- [ ] **Step 3: Minimal implementation**

In `src/agents/external_evidence_map.ts`, replace `_facts_summary` with the widened version (adds the
three scalar transaction fields to the generic `fields` loop, and renders `flags` separately because
it is an array — the generic `value !== ""` guard would emit an empty `flags=`):

```ts
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
    ["last_sold_date", facts.last_sold_date],
    ["last_sold_price", facts.last_sold_price],
    ["list_date", facts.list_date],
    ["property_url", facts.property_url],
  ];
  for (const [key, value] of fields) {
    if (value !== null && value !== undefined && value !== "") {
      parts.push(`${key}=${value}`);
    }
  }
  // flags is an array (default []); render only when non-empty so the clean case adds nothing.
  if (facts.flags.length > 0) {
    parts.push(`flags=${facts.flags.join(",")}`);
  }
  return parts.join("; ");
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/external_evidence_map.test.ts && bun run typecheck && bun run lint`
Expected: PASS (15 tests); typecheck + lint clean. The pre-existing `external_evidence_refs` test
still passes (its payload has no new fields; `data` now also carries `flags: []`, which it does not
assert against).

- [ ] **Step 5: Commit**

```bash
git add src/agents/external_evidence_map.ts test/external_evidence_map.test.ts
git commit -m "feat(agents): render realtor transaction facts in the property_facts summary"
```

---

### Task 4: Widen the shared exposure/E2E fixture

**Files:**
- Modify: `test/support/fixtures.ts` (`externalEvidenceFixture`)

The exposure guard and both E2E suites consume `externalEvidenceFixture()`. Widening it here — through
`ExternalEvidenceSchema.parse` (so it can never become a second copy of the contract) — is a pure
additive change: the existing suites must stay green **before** any new assertion is added, which is
itself the additive proof.

- [ ] **Step 1: Widen the fixture, grounded in the real 1104 probe**

In `test/support/fixtures.ts`, inside `externalEvidenceFixture()`'s `ExternalEvidenceSchema.parse({...})`,
add `rental_listings` (sibling to `str_listings`) and the four transaction fields inside
`property_facts`:

```ts
    address_match_confidence: 83,
    // realtor rental history for 1104 (two "Listed for rent" events via a property manager)
    rental_listings: [
      { date: "2026-05-02", price: 2300, source: "AppfolioUnits" },
      { date: "2025-03-20", price: 2195, source: "AppfolioUnits" },
    ],
    property_facts: {
      source_provider: "realtor",
      home_type: "single_family",
      year_built: 1998,
      bedrooms: 3,
      baths: 2,
      area_sqft: 1840,
      lot_sqft: 7200,
      listing_status: "for_rent",
      // X-014 transaction context (from the 1104 probe: sold 2018-10-25 for $195k, listed 2026-05-02)
      last_sold_date: "2018-10-25",
      last_sold_price: 195000,
      list_date: "2026-05-02",
      flags: [],
      property_url: "https://www.realtor.com/realestateandhomes-detail/1104-Spring-Run-Rd",
    },
```

(Place `rental_listings` beside `address_match_confidence` — key order in the object literal is
irrelevant; `ExternalEvidenceSchema.parse` normalizes it.)

- [ ] **Step 2: Prove the existing suites stay green with the wider fixture**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/external_evidence_exposure.test.ts test/e2e`
Expected: PASS — the existing 13 exposure tests + 6 E2E tests all still pass. This confirms the
fixture widening is additive: the new `rental_listings` line contains neither `"Short-term rental
listing"` nor `"vrbo"` (so the property-facts-only and unexposed negatives hold), and the new
transaction fields sit inside the same `property_facts` ref whose presence the tests already gate on
`source_provider=realtor`.

- [ ] **Step 3: Commit**

```bash
git add test/support/fixtures.ts
git commit -m "test: widen the external-evidence fixture with realtor rental_listings + transaction facts"
```

---

### Task 5: The X-012 critical negative test — extend it for the rental channel

**Files:**
- Modify: `test/external_evidence_exposure.test.ts`

This guards the whole selective-exposure design for the new fields: `owner_identity_and_mailing` must
see **neither** the realtor rental history **nor** the new `property_facts` transaction fields in a
solo prompt, under **both** prompt profiles (`profile=full` early-returns unfiltered context, so the
full-profile assertion is the one that proves selective exposure actually holds). Pure test work —
every source change it needs landed in Tasks 1-4.

- [ ] **Step 1: Add the new marker constants**

In `test/external_evidence_exposure.test.ts`, immediately after the existing `STR_MARKERS`
declaration:

```ts
// rental_listings rides the SAME str_scan gate as the STR line, so it is excluded from
// owner_identity at EVERY level (solo, full, and the production group).
const RENTAL_MARKERS = ["Property listed for rent (realtor history)", "AppfolioUnits"];
// the X-014 property_facts transaction fields. Excluded from a SOLO owner_identity prompt (which
// gets no property_facts at all); they DO reach its GROUP prompt via property_tax_context — a
// decision of record asserted below.
const FACTS_TXN_MARKERS = ["last_sold_date", "last_sold_price", "list_date"];
```

- [ ] **Step 2: Replace the "CRITICAL NEGATIVE TEST" describe block with the widened assertions**

```ts
describe("THE CRITICAL NEGATIVE TEST: owner_identity_and_mailing never sees the rental channel", () => {
  test("solo prompt, compact profile — no STR, no realtor history, no transaction facts", () => {
    const prompt = renderSolo("owner_identity_and_mailing");
    for (const marker of [...STR_MARKERS, ...RENTAL_MARKERS, ...FACTS_TXN_MARKERS]) {
      expect(prompt).not.toContain(marker);
    }
  });

  test("solo prompt, full profile — profile is verbosity, not authorization", () => {
    const prompt = renderSolo("owner_identity_and_mailing", "full");
    for (const marker of [...STR_MARKERS, ...RENTAL_MARKERS, ...FACTS_TXN_MARKERS]) {
      expect(prompt).not.toContain(marker);
    }
  });

  test("its PRODUCTION group prompt — the bucket union carries property_facts but NOT the rental channel", () => {
    // _bucket_by_group pairs it with property_tax_context and run_group unions their scopes. The
    // union carries property_facts (so the transaction facts DO appear — see KNOWN CONSEQUENCES)
    // but NOT str_scan, so the realtor rental history is withheld here too.
    const prompt = renderGroup(["property_tax_context", "owner_identity_and_mailing"]);
    for (const marker of [...STR_MARKERS, ...RENTAL_MARKERS]) {
      expect(prompt).not.toContain(marker);
    }
  });
});
```

- [ ] **Step 3: Add the known-consequence assertion (group prompt sees the facts) and the positive exposures**

Append this test to the existing `describe("KNOWN CONSEQUENCES of the bucket union …")` block:

```ts
  test("owner_identity_and_mailing DOES see the transaction facts via its bucket-mate", () => {
    // Same decision of record as source_provider=realtor: property facts are not the smoking gun,
    // and the packet is excluded for having no owner identity to reason with — not for collapse risk.
    const prompt = renderGroup(["property_tax_context", "owner_identity_and_mailing"]);
    expect(prompt).toContain("last_sold_date=2018-10-25");
    expect(prompt).toContain("list_date=2026-05-02");
  });
```

Append these two tests to the existing `describe("the exposed packets do see their sources")` block:

```ts
  test("subject_occupancy_surfaces sees the realtor rental history beside the STR line", () => {
    const prompt = renderSolo("subject_occupancy_surfaces");
    expect(prompt).toContain(
      "Property listed for rent (realtor history): 2026-05 $2300, 2025-03 $2195 — source AppfolioUnits.",
    );
  });

  test("property_tax_context sees the transaction facts but NOT the rental channel", () => {
    const prompt = renderSolo("property_tax_context");
    expect(prompt).toContain("last_sold_date=2018-10-25");
    expect(prompt).toContain("list_date=2026-05-02");
    expect(prompt).not.toContain("Property listed for rent");
    expect(prompt).not.toContain("AppfolioUnits");
  });
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/external_evidence_exposure.test.ts`
Expected: PASS (16 tests). If any negative assertion fails, **stop**: the exposure routing is broken,
not the test.

- [ ] **Step 5: Prove the guard actually bites**

```bash
# Temporarily add "str_scan" to owner_identity_and_mailing's input_sources AND gate.source_scope
# in src/heuristics/packets.ts (the exact leak this guard exists to catch), then:
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/external_evidence_exposure.test.ts test/packets_exposure_map.test.ts
git checkout src/heuristics/packets.ts
```
Expected: FAIL on "solo prompt, compact profile" (the realtor-history line leaks into
`owner_identity_and_mailing`) **and** on `test/packets_exposure_map.test.ts`. Then revert and re-run:
PASS. **A guard you have not seen fail is not a guard.**

- [ ] **Step 6: Commit**

```bash
git add test/external_evidence_exposure.test.ts
git commit -m "test: owner_identity never sees the realtor rental channel (solo/full/group)"
```

---

### Task 6: Blind-parity guard + enriched exposure — the E2E suite

**Files:**
- Modify: `test/e2e/orchestrator.e2e.test.ts` (E2E-3 blind, E2E-4 enriched)

- [ ] **Step 1: Extend E2E-3 (the blind parity guard) with the new content**

Inside E2E-3's `describe(... "no payload, behavior unchanged")`, in section "3. no external CONTENT
reaches any rendered packet prompt", add two assertions after the existing `expect(subagent.all())`
lines:

```ts
      expect(subagent.all()).not.toContain("Property listed for rent");
      expect(subagent.all()).not.toContain("last_sold_date=");
```

This asserts the `.default([])` blind guarantee for the new fields: with no payload, neither the
realtor-history line nor the transaction facts appear in any rendered prompt.

- [ ] **Step 2: Extend E2E-4 (enriched) with the new content and per-packet routing**

Inside E2E-4's `describe(... "a payload reaches exactly the exposed packets")`, after the two existing
`case_quality_and_synthesis` assertions, add:

```ts
      // the realtor rental history reaches the synthesis packet beside the STR line
      expect(subagent.prompts.get("case_quality_and_synthesis")!).toContain(
        "Property listed for rent (realtor history): 2026-05 $2300, 2025-03 $2195 — source AppfolioUnits.",
      );
      expect(subagent.prompts.get("case_quality_and_synthesis")!).toContain("last_sold_date=2018-10-25");
```

Then, inside the existing `for (const [packet_id, prompt] of subagent.prompts)` loop, add the rental
line and transaction-fact checks so they ride the same gates as the STR line / property_facts (append
these inside the loop body, after the existing `source_provider=realtor` assertion):

```ts
        if (STR_EXPOSED.has(packet_id)) {
          expect([packet_id, prompt.includes("Property listed for rent (realtor history)")]).toEqual([packet_id, true]);
        } else {
          expect([packet_id, prompt.includes("Property listed for rent")]).toEqual([packet_id, false]);
          expect([packet_id, prompt.includes("AppfolioUnits")]).toEqual([packet_id, false]);
        }
        expect([packet_id, prompt.includes("last_sold_date=2018-10-25")]).toEqual([
          packet_id,
          FACTS_EXPOSED.has(packet_id),
        ]);
```

(The `[packet_id, bool]` tuple form is deliberate house style: a failure names the offending packet
instead of printing `false !== true`.)

- [ ] **Step 3: Run the E2E suite, verify it passes**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e`
Expected: PASS — **6 pass / 0 fail** (E2E test count unchanged; only assertions added). If E2E-3
fails, the blind default was perturbed — **fix the source, never the guard.**

- [ ] **Step 4: Prove the blind guard bites**

```bash
# Temporarily make rental_market_summary_lines(null) return ["probe"] in src/agents/external_evidence_map.ts
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e
git checkout src/agents/external_evidence_map.ts
```
Expected: FAIL on the E2E-3 `rental_market_summary` / content assertions, then PASS after revert.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/orchestrator.e2e.test.ts
git commit -m "test(e2e): blind parity + enriched routing for realtor listing signals"
```

---

### Task 7: Prose-scrubber survival test for the realtor vocabulary

**Files:**
- Modify: `test/prose_external_evidence.test.ts`
- (Conditional) Modify: `src/agents/prose_redaction.ts` — **only if the survival test fails** (it does
  not; see below)

`OE_PROSE_REDACT` redacts identifier-shaped tokens from the model's **output prose** (findings). The
realtor-history line this feature emits is deliberately prose (`Property listed for rent (realtor
history): 2026-05 $2300 … source AppfolioUnits.`) and lives in the **prompt context**, which is never
redacted. The residual risk is only if the model **echoes** the new evidence vocabulary in a finding.
Verified (via `OE_PROSE_REDACT=on` against `detect_leaks`/`redact_prose`): the source name
`AppfolioUnits` is PascalCase (not matched by `CAMEL_RE`, which requires a lowercase first char) and
survives; `listed for rent`, `foreclosure`, dates and `$`-prices are ordinary prose and survive;
`realtor`/`for_rent` are already in `EXTERNAL_EVIDENCE_VOCABULARY` (`prose_redaction.ts`). The only
tokens the scrubber humanizes are the snake_case **field names** `last_sold_date` / `last_sold_price`
/ `list_date` — which is **correct and consistent** with the existing `home_type` / `year_built`
treatment (data-surface names, not evidence content; their values survive). So **no
`prose_redaction.ts` change is required**; this task locks that in as a regression guard.

- [ ] **Step 1: Write the survival tests**

Append to `test/prose_external_evidence.test.ts`:

```ts
const REALTOR_FINDING =
  "Realtor history shows the home was listed for rent in 2026-05 ($2300) and 2025-03 ($2195), " +
  "sourced from AppfolioUnits; a foreclosure flag was present on the listing.";

describe("the prose scrubber must not eat realtor rental-history evidence (X-014)", () => {
  test("the property-manager source name and rental prose survive redaction intact", () => {
    const scrubbed = redact_prose(REALTOR_FINDING);
    expect(scrubbed).toContain("AppfolioUnits");
    expect(scrubbed).toContain("listed for rent");
    expect(scrubbed).toContain("foreclosure");
    expect(scrubbed).toContain("$2300");
  });

  test("none of that evidence content is reported as a leak", () => {
    const leaks = detect_leaks(REALTOR_FINDING).join(" ");
    expect(leaks).not.toContain("AppfolioUnits");
    expect(leaks).not.toContain("foreclosure");
    expect(leaks).not.toContain("listed");
  });
});
```

- [ ] **Step 2: Run the survival tests**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/prose_external_evidence.test.ts`
Expected: PASS (5 tests: 3 pre-existing + 2 new). The survival tests pass without any
`prose_redaction.ts` change — record that in the commit. **If they had failed**, the fix would be to
add the offending vocabulary to `EXTERNAL_EVIDENCE_VOCABULARY` in `src/agents/prose_redaction.ts` (the
same controlled-vocabulary mechanism commits `6a885ba` / `87817f4` used for `for_rent`), never a
second mechanism.

- [ ] **Step 3: Verify under the real flag (the configuration the risk lives in)**

Run: `OE_PROSE_REDACT=on bun test test/prose_external_evidence.test.ts`
Expected: PASS — a green suite with the flag off proves nothing about the scrubber.

- [ ] **Step 4: Commit**

```bash
git add test/prose_external_evidence.test.ts
git commit -m "test: realtor rental-history vocabulary survives the prose scrubber"
```

---

### Task 8: Confirm the exposure map — `src/heuristics/packets.ts` needs NO change

**Files:**
- Read-only verification: `src/heuristics/packets.ts`, `test/packets_exposure_map.test.ts`

**This is a confirmation task, not a change.** The new fields ride the **existing** gates with **no
new scope token**:
- `rental_market_summary` (which now also carries the realtor rental history) already reaches the
  occupancy packets via the existing `str_scan` token: `subject_occupancy_surfaces`
  (`input_sources` include `str_scan`), `loan_tenure` (`str_scan`), and
  `case_quality_and_synthesis` (`[...SUBSTANTIVE_SOURCES, "str_scan", "property_facts"]`).
- The four `property_facts` transaction fields already reach `property_tax_context` (`property_facts`)
  and `case_quality_and_synthesis` (`property_facts`) via the existing `property_facts` ref.

No `input_sources`, no `gate.source_scope`, and no `SUBSTANTIVE_SOURCES` entry are touched;
`evidence_map.property_types` stays `[]`.

- [ ] **Step 1: Confirm the existing tokens are already present (read-only)**

Run: `grep -n 'str_scan\|property_facts' src/heuristics/packets.ts`
Expected: `str_scan` appears in `subject_occupancy_surfaces` (`input_sources` + `gate.source_scope`),
`loan_tenure` (both), and `case_quality_and_synthesis` (both); `property_facts` appears in
`property_tax_context` (both) and `case_quality_and_synthesis` (both). Exactly the four packets the
exposure map pins.

- [ ] **Step 2: Confirm `packets.ts` is unmodified and its guard is green**

```bash
git diff --stat src/heuristics/packets.ts        # expect: no output (untouched)
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/packets_exposure_map.test.ts
```
Expected: no diff for `packets.ts`; `test/packets_exposure_map.test.ts` PASS (5 tests). No commit —
nothing changed.

---

### Task 9: Full gate, feature_list, PROGRESS, PR

**Files:**
- Modify: `feature_list.json`, `PROGRESS.md`

- [ ] **Step 1: Run the real gates and record the exact counts**

```bash
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e
```
Expected: `verify` — typecheck clean, lint clean (3 pre-existing warnings), **169 pass / 0 fail**
(baseline 152 + 17 new: contract 5, map 7, exposure 3, prose 2 — E2E adds assertions, not tests);
`e2e` — **6 pass / 0 fail**. **Record the real terminal counts** — `evidence` must be what the
terminal said. (Without the env prefix, the .env-default `bun test` shows 167 pass / 2 fail — the two
pre-existing tautological prose tests; do not fix them.)

- [ ] **Step 2: Add the feature_list.json entry**

Append this entry (unique `id`, `priority` 12; `feature_list.test.ts` requires all nine fields, a
valid status, unique ids, and at most one `in_progress`). Set `status` to `in_progress` while
working; flip to `passing` only after Step 1 is green **with recorded output**:

```json
  {
    "id": "realtor-listing-signals",
    "priority": 12,
    "area": "agents",
    "title": "Realtor listing signals -> AI layer (rental_listings + transaction facts)",
    "user_visible_behavior": "When an external-evidence payload carries realtor rental-listing history and transaction facts, the engine folds the rental history into the rental_market_summary channel (reaching subject_occupancy_surfaces / loan_tenure / case_quality_and_synthesis beside the STR scan) and folds last_sold_date/last_sold_price/list_date/flags into property_facts (reaching property_tax_context + synthesis). With no payload the engine runs blind exactly as before.",
    "status": "passing",
    "verification": "OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify; OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e; test/external_evidence_exposure.test.ts (owner_identity never sees the rental channel - solo/full/group); test/e2e E2E-3 (blind parity) + E2E-4 (enriched routing); test/prose_external_evidence.test.ts (scrubber survival).",
    "evidence": "<paste the real counts from verify and e2e>",
    "notes": "Additive widening of the .strict() ExternalEvidence mirror: RentalListingSchema + top-level rental_listings (flat most-recent-2, NO count field) + 4 property_facts transaction fields. Rides the EXISTING str_scan / property_facts gates - no new scope token, src/heuristics/packets.ts unchanged. .default([]) on both new arrays preserves blind byte-parity. AppfolioUnits/foreclosure/'listed for rent' survive the prose scrubber; field-name tokens (last_sold_date) are humanized like home_type - values survive."
  }
```

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/feature_list.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Append the PROGRESS.md Session Record**

Under `<!-- newest first; one entry per working session -->`:

```md
### 2026-07-20 — Realtor listing signals -> AI layer (X-014)
- **Goal:** Forward realtor rental-listing history + transaction facts (last_sold_date/price, list_date, flags) to the AI layer by widening the .strict() ExternalEvidence contract and folding the new fields into the existing rental-market + property-facts channels, entirely additively.
- **Completed (branch `feat/realtor-listing-signals`, cut from `main` @2a9a095):** RentalListingSchema + top-level rental_listings (flat most-recent-2) + 4 property_facts transaction fields in external_evidence.ts; rental_listings folded into rental_market_summary_lines (emits "Property listed for rent (realtor history): 2026-05 $2300, 2025-03 $2195 — source AppfolioUnits.", folded regardless of str_listings so the 1104 case surfaces); transaction fields rendered in _facts_summary; shared fixture widened from the real 1104 probe.
- **Verification run:** `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify`; `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e`; scrubber survival under `OE_PROSE_REDACT=on`.
- **Evidence:** <real counts>. The X-012 guards stay green and were both observed FAILING when deliberately broken: the critical negative test (owner_identity never sees the rental channel — solo/full/group; str_scan temporarily added to its input_sources leaked the rental line) and the E2E blind-parity guard (rental_market_summary_lines(null) temporarily returning ["probe"]).
- **Known consequences (decisions of record, not bugs):** (1) No new scope token — rental_listings rides the existing str_scan gate; packets.ts unchanged. (2) The BUCKET is the unit of exposure: owner_identity_and_mailing sees the transaction facts via its property_tax_context bucket-mate (same as source_provider=realtor today), but NEVER the rental channel (str_scan excluded from that union). (3) Field-name tokens (last_sold_date) are humanized by the prose scrubber exactly like home_type; the evidence content (AppfolioUnits, foreclosure, dates, prices) survives.
- **Next best action:** merge to `main` (push engine first per the umbrella merge order), then the backend widens the mirror + splits in toExternalEvidence and bumps the submodule pointer.
```

- [ ] **Step 4: Final gate + clean tree**

```bash
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify
git status --short
```
Expected: green; clean except the two staged docs.

- [ ] **Step 5: Commit and open the PR against `main`**

```bash
git add feature_list.json PROGRESS.md
git commit -m "docs: feature_list + PROGRESS session record for realtor listing signals"
git push -u origin feat/realtor-listing-signals
```

PR base **`main`** (never `staging`). Body: link the umbrella plan + spec; name the acceptance
signals — the X-012 critical negative test (owner_identity never sees the rental channel), the E2E
blind-parity guard, and the prose-scrubber survival test; note that `packets.ts` is deliberately
untouched (no new scope token) and that merging waits on X-013 per the umbrella merge order.

---

## Verification / Definition of Done

- [ ] `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify` green in place (typecheck + lint +
      `bun test`, which includes the E2E) — real counts recorded (expected 169 pass / 0 fail)
- [ ] `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e` green (6 pass / 0 fail)
- [ ] The two pre-existing tautological prose tests are the **only** failures under the .env-default
      run; they were **not** touched, and `.env` was **not** edited
- [ ] **X-012 guard 1 — the critical negative test:** `owner_identity_and_mailing` sees neither the
      realtor rental history nor the transaction facts in its solo prompt under **both** profiles
      (`compact` + `full`), and neither the rental channel in its production group prompt; observed
      FAILING when `str_scan` is temporarily added to its `input_sources`
- [ ] **X-012 guard 2 — the blind-parity guard:** an ExternalEvidence-absent E2E run exposes no
      `rental_listings` and no new `property_facts` content anywhere (`.default([])` preserves
      byte-parity); observed FAILING when the blind path is temporarily perturbed
- [ ] `rental_listings` is a flat most-recent-2 array (no `count` field on the engine side); the
      pinned line renders exactly `Property listed for rent (realtor history): 2026-05 $2300, 2025-03
      $2195 — source AppfolioUnits.`
- [ ] `src/heuristics/packets.ts` unchanged (no new scope token); `evidence_map.property_types` stays
      `[]`; `str_scan` / `property_facts` are **not** in `SUBSTANTIVE_SOURCES`
- [ ] Prose-scrubber survival test green under `OE_PROSE_REDACT=on`; no `prose_redaction.ts` change
      needed (confirmed) — or, if it had failed, only `EXTERNAL_EVIDENCE_VOCABULARY` extended
- [ ] `feature_list.json` entry `passing` with **real** recorded evidence; `PROGRESS.md` Session
      Record appended; `git status` clean; PR base is `main`

**Deferred to the umbrella (not this repo's DoD):** the live full-stack run on 1104 (AI cites the
rental history) and the blind control. Until the backend maps `rental_listings` + transaction fields
into the wider mirror, this branch's new path is dormant (both arrays default `[]`) — which is exactly
why the blind-parity guard makes it safe to merge to engine `main` first.
