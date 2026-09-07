# X-078 — AI corroboration: the `records_read` contract (ENGINE) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Execute this **repo-locally** in
> `occupancy-engine-ts` (`cd occupancy-engine-ts && claude`), not from the workspace root —
> the repo's own hooks and gates only fire in repo-local mode.

**Goal:** Give the case-level `master_adjudicator` one new required output block — `records_read` —
that states what public records say about occupancy (`non_owner_occupancy` / `owner_occupancy` /
`no_signal`, plus how much weight those records carry), so the backend can compare it against the
org's own scan verdict and answer "does the deep investigation corroborate the shallow scan?"

**Architecture:** Additive. One new object on `CaseAdjudicationSchema`, the same shape mirrored on
the `submit_case_adjudication` tool args, prompt instructions that teach the three signals, and a
safe literal default in `fallback_adjudication`. Nothing else in the pipeline moves: heuristic
subagents, scoring, `ExternalEvidenceSchema`, and the report string are untouched. The block reaches
the backend for free — `assessment_report_payload`
(`/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/src/agents/investigation_wire.ts:54-70`)
spreads the whole assessment and only strips `metrics_events`, so no wire change is needed.

**Tech Stack:** Bun 1.3.10 (pinned in `.bun-version`), TypeScript 5.6 (`strict`,
`noUncheckedIndexedAccess`), zod 3, LangChain.js 0.3, `bun test`, Biome 2.5 (linter on, **formatter
off**).

**Spec:** `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/docs/superpowers/specs/2026-09-07-ai-corroboration-design.md`
(§5 the engine contract, §9 why the engine stays blind, §10 fallback/migration/cache, §11 testing)

**Umbrella plan (the pinned contract — honour it exactly):**
`/home/aayan-alam/Work/Helcion/true-occupancy-workspace/docs/superpowers/plans/2026-09-07-ai-corroboration.md` §2.1

**Repo:** `occupancy-engine-ts` — base branch `main` (trunk, no `develop`).
**Feature branch:** `feat/x078-records-read`, cut from `origin/main` **after a fetch** (local `main`
goes stale; see the workspace memory note "Branch from origin/base"). PR base is `main`; the merge
target is `main`. There is no promotion chain in this repo.

**Dependency order (cross-repo):** engine **first**. The backend (`feat/x078-corroboration`) bumps
`submodules/occupancy-engine-ts` to this branch's merged SHA and cannot start meaningfully until
this lands. The frontend is third. Nothing here parallelizes with them.

---

## 0. HARD CONSTRAINTS — state these in every commit message that touches them, and do not violate

1. **`ExternalEvidenceSchema` MUST NOT CHANGE.**
   (`src/agents/external_evidence.ts:64-77` — `scan_id`, `scanned_at`, `str_listings`,
   `rental_listings`, `address_match_confidence`, `property_facts`, `.strict()`.)
   The engine never learns the scan's verdict, conclusivity, or declared intent. This is the
   central architectural decision (spec §9):
   - it preserves **blind/enriched benchmark parity** — the engine's own comment at
     `src/agents/models.ts:200` reads *"Blind (benchmarking) and enriched (prod) run identical
     code"*, and `orchestrator.ts:392` restates it: *"Absent payload => empty, exactly as today: the
     blind (benchmarking) configuration."*;
   - it keeps the backend's AI-report cache key untouched. Adding `scan_claim` forces a lose-lose:
     leave it out of `KEYED_EVIDENCE_FIELDS` and two different verdicts hash identically
     (under-invalidation — serves a wrong report); put it in and a threshold edit forces a full
     engine re-run per property.
   **Task 2 makes this executable** as a guard test rather than a comment.

2. **Heuristic subagents are NOT touched.** Only the case-level `master_adjudicator` changes.
   `_adjudicate_case` (`orchestrator.ts:598-684`) is already its own LLM call after every subagent
   has reported, so this is a change to one existing call, not a new pipeline stage. Do not edit
   `src/heuristics/**`, `src/agents/subagents.ts`, `src/agents/packets*`, or any packet prompt.

3. **`records_read` is NOT relative to any scan claim.** It describes what public records show, full
   stop. The prompt must never say "agree", "corroborate", "the scan", "the listing", or "confirm" —
   the engine has no claim to agree with. The comparison happens server-side in the backend.

4. **Adding a required field to the adjudicator tool schema can shift `calibrated_score` /
   `clarity_score` distributions.** `clarity_score` now feeds the backend's agreement dampener
   (`deriveAgreement`, umbrella §2.2), so a distribution shift changes **every** agreement number
   downstream. Task 10 is a real before/after measurement on live runs, not a footnote.

5. **Parity-first repo rule (`AGENTS.md` "Hard constraints"):** don't change heuristics, scoring or
   report shape without a reason. This plan changes none of them. `build_report`
   (`orchestrator.ts:1102-1129`) is deliberately left alone — the report string keeps its current
   three header lines.

---

## 1. Ground truth — what is actually in this repo (verified 2026-09-07)

Every path below is under
`/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/`.

**The five edit sites**

| # | file:lines | what is there now |
|---|---|---|
| 1 | `src/agents/models.ts:18-27` | `CASE_ARCHETYPE_VALUES` (last `as const` block); the `export type` block follows at `:29-33` |
| 2 | `src/agents/models.ts:297-310` | `CaseAdjudicationSchema` — `.strict()`, 9 keys, `export type CaseAdjudication` at `:310` |
| 3 | `src/agents/orchestrator.ts:83-102` | `SubmitCaseAdjudicationArgs` — the tool-args mirror; bound at `:116-120` |
| 4 | `src/agents/orchestrator.ts:1082-1098` | `fallback_adjudication` — builds the object **literally**, bypassing zod, so `tsc` forces the update |
| 5 | `src/agents/prompts.ts:504-565` | `master_adjudication_user_prompt`; the "Include keys" instruction is `:560-562` |

**Two things that break the moment `records_read` becomes required — expect them, they are the plan**

- `src/agents/orchestrator.ts:1082` — `fallback_adjudication` returns `CaseAdjudication`. `tsc
  --noEmit` fails with a missing-property error. That is the designed forcing function (spec §10).
- `test/prose_redaction.test.ts:269-276` — the only other `CaseAdjudicationSchema.parse(...)` call
  site in the suite. It parses a literal with no `records_read`, so it throws a `ZodError` at
  runtime. Fixed inside Task 3.

Nothing else constructs a `CaseAdjudication`: `grep -rn "CaseAdjudicationSchema" src cli test`
returns only `orchestrator.ts:26,1033`, `models.ts:297,310,319`, and `prose_redaction.test.ts:10,270`.

**The repair channel already exists and should learn the new literals.**
`_case_adjudication_from_tool_calls` (`orchestrator.ts:1009-1049`) parses the tool args through
`CaseAdjudicationSchema`; on a `ZodError` it returns a structured repair object carrying
`required_literals: { verdict_band: [...], case_archetype: [...] }` (`:1043-1046`), which
`_adjudicate_case` feeds back as a `ToolMessage`. Two new enums belong in that list or the model
gets a bare zod message on the very field it is most likely to get wrong.

**The wire needs no change.** `assessment_report_payload` (`investigation_wire.ts:54-70`)
destructures out `metrics_events` and spreads the rest, so `adjudication.records_read` reaches the
backend automatically. `src/server/investigate_server.ts` and `cli/run_address.ts` both go through
it. Confirmed: `grep -n "adjudication" src/agents/investigation_wire.ts src/server/*.ts cli/*.ts`
returns nothing.

**Prose redaction has an uncovered new field.** `sanitize_adjudication_prose`
(`src/agents/prose_redaction.ts:347-364`) redacts `reasoning_summary`, `why_not_higher`,
`why_not_lower` and each `score_adjustments[].reason` — the human-facing prose the frontend renders.
`records_read.reasoning` is exactly that kind of field and would otherwise ship raw internal tokens
(`own_rent=0`, `driveRecords`) to the browser. Task 7 closes this. **This is the one item not in the
handed-down 5-point scope; it is included because omitting it ships a leak the repo's own
`detect_leaks` guard was built to prevent.**

**No LLM benchmark harness exists.** `package.json` declares `"run-batch": "bun run
cli/run_investigation_batch.ts"` but **that file does not exist** — `batch-cli` is the
highest-priority unfinished feature in `feature_list.json` and `PROGRESS.md`'s Current Verified
State names it as such. `test/score_benchmark.test.ts` is a **deterministic heuristic** benchmark
over `evaluate_evidence` (12 fixed cases, no LLM, no network); it measures `weighted_signal_score` /
`verdict_band_candidate`, **not** the adjudicator's `calibrated_score` / `clarity_score`. It is the
right *discipline* to copy (goldens pinned before, re-pinned after, the diff IS the measurement) but
it is the wrong *instrument* for constraint 4. Task 10 therefore builds the measurement out of the
one live runner that does exist, `cli/run_address.ts`.

**Source-hash / cache consequence, for the deploy owner.** `HASHED_ROOTS`
(`src/fingerprint/source_hash.ts:21`) is `["src", "cli", "package.json", "bun.lock"]`. Every edit in
this plan lands under `src/`, so `engine_source_hash()` changes and **every cached AI report
invalidates on deploy** — a one-time re-run wave on first access per property. Intended
(over-invalidation costs a rerun; under-invalidation serves a wrong report), but flag it. No test
pins a literal hash value, so nothing in `test/source_hash.test.ts` breaks. Files added under
`test/` and `docs/` do **not** affect the hash.

---

## 2. The gate, and the `.env` landmine

Per `AGENTS.md` "Definition of done" and `init.sh`, the gate is:

```bash
OE_PROSE_REGISTER=off bun run verify     # = tsc --noEmit && biome check . && bun test
```

Two prose flags pull in opposite directions and the **gitignored `.env` sets both `on`**, which Bun
auto-loads (`env -u` does not clear it):

- `OE_PROSE_REGISTER` must be **off** — with it on,
  `test/prompts_register.test.ts` › `_prose_register_lines (gated) › is empty by default (flag off)`
  fails by construction.
- `OE_PROSE_REDACT` must stay **on** — `test/e2e/orchestrator.e2e.test.ts:57` asserts the humanized
  `owner_summaries` copy (`/^Owner /`, no `=`), which only the redactor produces. **A fresh git
  worktree has no `.env`**, so the flag is unset and E2E-1 fails for an unrelated reason. Task 1
  copies `.env` in; do not skip that step and do not "fix" E2E-1.

`AGENTS.md` also carries a contradictory line telling you to gate with `OE_PROSE_REDACT=off`. That
line is for taking a *raw baseline*, and it is the configuration under which E2E-1 is recorded as
"Known-failing on trunk". **Use `OE_PROSE_REGISTER=off bun run verify` with `.env` present.**

Focused loops used throughout this plan:

```bash
OE_PROSE_REGISTER=off bun test test/models.test.ts
OE_PROSE_REGISTER=off bun test test/adjudication_records_read.test.ts
OE_PROSE_REGISTER=off bun run e2e        # just test/e2e
```

---

### Task 1: Isolated worktree, live baseline

**Files:** none (ops).

- [ ] **Step 1: Check for a parallel agent, then fetch**

The repo working tree is currently on `feat/data-url-single-source` with uncommitted work from
another session — **do not touch it**. Other agents work these repos concurrently.

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts
git worktree list
git fetch origin
git log --oneline -1 origin/main
```
Expected: `git worktree list` shows the main checkout on `feat/data-url-single-source` plus an
existing `.claude/worktrees/stable-main` on `main` (leave both alone). `origin/main` prints a SHA —
record it; it is the branch point.

- [ ] **Step 2: Create the feature worktree from `origin/main`**

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts
git worktree add .claude/worktrees/x078-records-read -b feat/x078-records-read origin/main
```
Expected: `Preparing worktree (new branch 'feat/x078-records-read')` then `HEAD is now at <sha>`
matching Step 1. `.claude/worktrees/` is gitignored (`.gitignore` line 15), so the checkout is never
committed.

- [ ] **Step 3: Carry the env and install**

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts
cp .env .claude/worktrees/x078-records-read/.env
cd .claude/worktrees/x078-records-read
bun install
```
Expected: `.env` present in the worktree (still gitignored there); `bun install` completes against
the committed `bun.lock` with no lockfile change (`git status --short` shows nothing).

**All remaining tasks run from
`/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/.claude/worktrees/x078-records-read`.**

- [ ] **Step 4: Record the baseline gate**

```bash
OE_PROSE_REGISTER=off bun run verify 2>&1 | tail -20
```
Expected: `tsc --noEmit` silent; `biome check .` prints `Checked N files ... No fixes applied.` with
0 errors; `bun test` prints a `N pass / 0 fail` summary. **Write the three numbers down** (files
checked, tests passed, expect() calls) — every later "no new failures" claim is measured against
them. If the baseline is already red, stop and report; do not build on a red trunk.

- [ ] **Step 5: Commit the plan document itself**

```bash
mkdir -p docs/superpowers/plans
# copy this file to docs/superpowers/plans/2026-09-07-ai-corroboration.md
git add docs/superpowers/plans/2026-09-07-ai-corroboration.md
git commit -m "docs(X-078): engine plan — records_read on CaseAdjudication"
```
Expected: one commit. (`docs/` is outside `HASHED_ROOTS`, so this does not perturb the cache key.)

---

### Task 2: Make "the engine stays blind" an executable guard

Constraint 1 is currently only a comment. A comment cannot fail CI. Before adding anything, pin the
shape that must not move.

**Files:**
- Create: `test/external_evidence_blind_contract.test.ts`
- Reference (do not modify): `src/agents/external_evidence.ts:64-77`

- [ ] **Step 1: Write the guard**

```ts
// test/external_evidence_blind_contract.test.ts
import { describe, expect, test } from "bun:test";
import { ExternalEvidenceSchema } from "../src/agents/external_evidence.ts";

/**
 * X-078 constraint 1. The engine is never told the scan's conclusion. `records_read` is the case
 * adjudicator's read of the PUBLIC RECORDS, judged with no knowledge of any scan claim, and the
 * backend does the comparing.
 *
 * Two things depend on that and both fail silently if this schema grows a verdict field:
 *  1. blind/enriched parity — models.ts:200 promises "Blind (benchmarking) and enriched (prod) run
 *     identical code", and the payload is the only variable between the two arms;
 *  2. the backend's AI-report cache key (KEYED_EVIDENCE_FIELDS) — a scan verdict left OUT of the key
 *     makes two different verdicts hash identically and serves a report judged against the wrong
 *     one; a scan verdict put IN the key makes an org's threshold edit force a full engine re-run.
 *
 * So the key set is pinned by name, not merely spot-checked.
 */
describe("X-078: ExternalEvidenceSchema is frozen — the engine stays blind", () => {
  test("carries exactly the six evidence fields and nothing else", () => {
    expect(Object.keys(ExternalEvidenceSchema.shape).sort()).toEqual([
      "address_match_confidence",
      "property_facts",
      "rental_listings",
      "scan_id",
      "scanned_at",
      "str_listings",
    ]);
  });

  test("rejects every shape of scan conclusion by name (the schema is .strict())", () => {
    for (const key of [
      "scan_claim",
      "verdict",
      "scan_verdict",
      "conclusivity",
      "occupancy_status",
      "declared_intent",
      "records_read",
    ]) {
      const result = ExternalEvidenceSchema.safeParse({ [key]: "rented" });
      expect([key, result.success]).toEqual([key, false]);
    }
  });
});
```

- [ ] **Step 2: Run it, and prove it is not vacuous**

```bash
OE_PROSE_REGISTER=off bun test test/external_evidence_blind_contract.test.ts
```
Expected: `2 pass, 0 fail`.

A guard that passes on day one must be shown to be capable of failing. Temporarily add
`scan_claim: z.string().nullish(),` inside `ExternalEvidenceSchema` (`external_evidence.ts:64-76`),
re-run:
Expected: **both** tests fail — the key-set test on an extra `scan_claim` entry, the rejection test
on `["scan_claim", true]`. Then **revert the temporary edit** and re-run:
Expected: `2 pass, 0 fail`, and `git diff src/` is empty.

- [ ] **Step 3: Commit**

```bash
git add test/external_evidence_blind_contract.test.ts
git commit -m "test(X-078): pin ExternalEvidenceSchema — the engine never learns the scan verdict"
```

---

### Task 3: `records_read` on `CaseAdjudicationSchema`

**Files:**
- Modify: `src/agents/models.ts:18-33` (enums + types), `src/agents/models.ts:297-310` (the schema)
- Modify: `test/prose_redaction.test.ts:269-276` (the one literal parse that now needs the field)
- Test: `test/models.test.ts` (new `describe` block, appended)

- [ ] **Step 1: Write the failing tests**

Append to `test/models.test.ts`. Extend the existing import at the top of that file
(`test/models.test.ts:2-8`) to add `CaseAdjudicationSchema`:

```ts
import {
  AgentInvestigationRequestSchema,
  CaseAdjudicationSchema,
  DataCallLogSchema,
  HeuristicAgentResultSchema,
  HeuristicInterpretationSchema,
  EvidenceReferenceSchema,
} from "../src/agents/models.ts";
```

then append:

```ts
// X-078. The case-level roll-up of what PUBLIC RECORDS say about occupancy. Not relative to any
// scan claim — the engine never sees one (test/external_evidence_blind_contract.test.ts).
const adjudicationBase = {
  raw_score: 4,
  calibrated_score: 4,
  clarity_score: 6,
  verdict_band: "review" as const,
  case_archetype: "mixed_evidence" as const,
  reasoning_summary: "Absentee owner with unrelated occupants at the subject.",
};

describe("X-078 CaseAdjudication.records_read", () => {
  test("parses a full block and preserves every field", () => {
    const adj = CaseAdjudicationSchema.parse({
      ...adjudicationBase,
      records_read: {
        occupancy_signal: "non_owner_occupancy",
        strength: "strong",
        reasoning: "Owner mails elsewhere; two unrelated adults hold utility service at the subject.",
        driving_heuristic_ids: ["owner_identity_and_mailing", "subject_occupancy_surfaces"],
      },
    });
    expect(adj.records_read.occupancy_signal).toBe("non_owner_occupancy");
    expect(adj.records_read.strength).toBe("strong");
    expect(adj.records_read.driving_heuristic_ids).toEqual([
      "owner_identity_and_mailing",
      "subject_occupancy_surfaces",
    ]);
  });

  test("driving_heuristic_ids defaults to [] — the UI link-through is optional, the signal is not", () => {
    const adj = CaseAdjudicationSchema.parse({
      ...adjudicationBase,
      records_read: { occupancy_signal: "no_signal", strength: "weak", reasoning: "Records are silent." },
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

  test("all three occupancy signals are accepted, and only those three", () => {
    for (const signal of ["non_owner_occupancy", "owner_occupancy", "no_signal"]) {
      const r = CaseAdjudicationSchema.safeParse({
        ...adjudicationBase,
        records_read: { occupancy_signal: signal, strength: "moderate", reasoning: "r" },
      });
      expect([signal, r.success]).toEqual([signal, true]);
    }
    // "no_signal" must stay distinct from "owner_occupancy": absence of evidence is not evidence of
    // owner occupancy, and the backend maps them to different corroboration states.
    for (const bad of ["none", "unknown", "not_applicable", "owner", "rented"]) {
      const r = CaseAdjudicationSchema.safeParse({
        ...adjudicationBase,
        records_read: { occupancy_signal: bad, strength: "moderate", reasoning: "r" },
      });
      expect([bad, r.success]).toEqual([bad, false]);
    }
  });

  test("strength is weak|moderate|strong — it is NOT the four-value SIGNAL_STRENGTH ladder", () => {
    for (const strength of ["weak", "moderate", "strong"]) {
      const r = CaseAdjudicationSchema.safeParse({
        ...adjudicationBase,
        records_read: { occupancy_signal: "owner_occupancy", strength, reasoning: "r" },
      });
      expect([strength, r.success]).toEqual([strength, true]);
    }
    // SIGNAL_STRENGTH (models.ts:9) carries a fourth value, "none", for per-heuristic use. Reusing
    // it here would give the backend's AGREEMENT_ANCHORS table a key it has no anchor for.
    const r = CaseAdjudicationSchema.safeParse({
      ...adjudicationBase,
      records_read: { occupancy_signal: "owner_occupancy", strength: "none", reasoning: "r" },
    });
    expect(r.success).toBe(false);
  });

  test("the block is strict — an unknown key is a caller bug, not a field to ignore", () => {
    const r = CaseAdjudicationSchema.safeParse({
      ...adjudicationBase,
      records_read: {
        occupancy_signal: "no_signal",
        strength: "weak",
        reasoning: "r",
        confidence: 0.8, // model-self-confidence has no home here; strength is about the RECORDS
      },
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

```bash
OE_PROSE_REGISTER=off bun test test/models.test.ts
```
Expected: FAIL — 6 failures in `X-078 CaseAdjudication.records_read`. The first reads
`Unrecognized key(s) in object: 'records_read'` (the schema is `.strict()`, so the field is rejected
before it exists), and the "required" test fails because a bare `adjudicationBase` currently parses
fine.

- [ ] **Step 3: Add the enums and exported types**

In `src/agents/models.ts`, immediately after the `CASE_ARCHETYPE_VALUES` block that ends
`] as const;` at line 27, insert:

```ts
// X-078. The case-level roll-up of what PUBLIC RECORDS say about occupancy, emitted by the master
// adjudicator. Deliberately NOT relative to any scan claim: the engine never sees one (see
// ExternalEvidenceSchema, which carries no verdict, and test/external_evidence_blind_contract.test.ts).
//
// `no_signal` is its own value and must never be collapsed into `owner_occupancy`. "The records are
// silent" and "the records show the owner living here" are different findings, and the backend maps
// them to different corroboration states — `no_independent_support` vs `contradicted`.
export const OCCUPANCY_SIGNAL = ["non_owner_occupancy", "owner_occupancy", "no_signal"] as const;
// How much weight the RECORDS carry — not how confident the model feels. Distinct from
// SIGNAL_STRENGTH above, which is the per-heuristic four-value ladder including "none".
export const EVIDENCE_STRENGTH = ["weak", "moderate", "strong"] as const;
```

Then, after `export type CaseArchetype = (typeof CASE_ARCHETYPE_VALUES)[number];` (line 33 before
this edit), add:

```ts
export type OccupancySignal = (typeof OCCUPANCY_SIGNAL)[number];
export type EvidenceStrength = (typeof EVIDENCE_STRENGTH)[number];
```

- [ ] **Step 4: Add the block to `CaseAdjudicationSchema`**

In `src/agents/models.ts`, inside `CaseAdjudicationSchema` (was `:297-309`), add `records_read`
after `why_not_lower` and before the closing `})`:

```ts
export const CaseAdjudicationSchema = z
  .object({
    raw_score: z.number().int(),
    calibrated_score: z.number().int().min(0).max(10),
    clarity_score: z.number().int().min(0).max(10),
    verdict_band: z.enum(VERDICT_BAND),
    case_archetype: z.enum(CASE_ARCHETYPE_VALUES),
    score_adjustments: z.array(ScoreAdjustmentSchema).default([]),
    reasoning_summary: z.string(),
    why_not_higher: z.array(z.string()).default([]),
    why_not_lower: z.array(z.string()).default([]),
    // X-078. Required, not nullish: a missing block must fail validation and drive the repair
    // channel (orchestrator.ts:1036-1048), because a silent null reaches the backend as
    // "no corroboration available" on a case that in fact had one.
    records_read: z
      .object({
        occupancy_signal: z.enum(OCCUPANCY_SIGNAL),
        strength: z.enum(EVIDENCE_STRENGTH),
        reasoning: z.string(),
        // Lets the UI link the headline straight to the findings that drove it.
        driving_heuristic_ids: z.array(z.string()).default([]),
      })
      .strict(),
  })
  .strict();
export type CaseAdjudication = z.infer<typeof CaseAdjudicationSchema>;
export type RecordsRead = CaseAdjudication["records_read"];
```

- [ ] **Step 5: Run the tests, verify they pass**

```bash
OE_PROSE_REGISTER=off bun test test/models.test.ts
```
Expected: PASS, 0 fail.

- [ ] **Step 6: Fix the one collateral test — `test/prose_redaction.test.ts:269-276`**

That literal `CaseAdjudicationSchema.parse({...})` now throws. Add the block; keep the deliberately
dirty prose, because the whole point of that test is that `detect_leaks(report)` finds nothing:

```ts
    const adjudication = CaseAdjudicationSchema.parse({
      raw_score: 2,
      calibrated_score: 2,
      clarity_score: 5,
      verdict_band: "review",
      case_archetype: "mixed_evidence",
      reasoning_summary: "driveRecords indicate presence at the subject.",
      records_read: {
        occupancy_signal: "non_owner_occupancy",
        strength: "moderate",
        reasoning: "utilityRecords name a non-owner at the subject.",
        driving_heuristic_ids: ["subject_occupancy_surfaces"],
      },
    });
```

```bash
OE_PROSE_REGISTER=off bun test test/prose_redaction.test.ts
```
Expected: PASS, 0 fail. (`build_report` does not render `records_read`, so `detect_leaks(report)`
is unaffected here — Task 7 is what makes the *field itself* clean.)

- [ ] **Step 7: Confirm the forcing function fired**

```bash
bun run typecheck
```
Expected: **FAIL**, exactly one error, at `src/agents/orchestrator.ts:1087` (the `return {` inside
`fallback_adjudication`): `Property 'records_read' is missing in type '{ raw_score: number; ... }'
but required in type '{ ... records_read: { ... } }'`. That is the designed forcing function from
spec §10 — Task 4 closes it. Do not commit red; go straight to Task 4 and commit them together.

---

### Task 4: `fallback_adjudication` emits the honest default

`fallback_adjudication` (`src/agents/orchestrator.ts:1082-1098`) is what a run gets when there is no
master LLM, when the model does not support native tool calls, when validation fails past the retry
budget, or when the adjudicator throws. It builds the object literally and bypasses schema
validation, so its default has to be chosen, not derived.

`no_signal` + `weak` is the correct choice: it lands the backend's agreement at exactly 50 — *"the
investigation could not tell"* — for every scan verdict. Any other pair would assert a records
finding that no adjudicator ever made.

**Files:**
- Modify: `src/agents/orchestrator.ts:1082-1098`
- Test: `test/adjudication_records_read.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// test/adjudication_records_read.test.ts
import { describe, expect, test } from "bun:test";
import { fallback_adjudication } from "../src/agents/orchestrator.ts";
import { CaseAdjudicationSchema } from "../src/agents/models.ts";

describe("X-078 fallback_adjudication.records_read", () => {
  test("emits the honest 'could not tell' default for a scored run", () => {
    const adj = fallback_adjudication({ final_score: 6, band: "review" }, "Master adjudication failed.");
    expect(adj.records_read.occupancy_signal).toBe("no_signal");
    expect(adj.records_read.strength).toBe("weak");
    expect(adj.records_read.driving_heuristic_ids).toEqual([]);
  });

  test("the reasoning names the absent adjudication rather than claiming a records finding", () => {
    const adj = fallback_adjudication({ final_score: 0, band: "low_evidence" }, "No master LLM configured.");
    // It must not read as "the records were silent" — no adjudicator ever read them.
    expect(adj.records_read.reasoning).toContain("No case-level adjudication");
    expect(adj.records_read.reasoning.length).toBeGreaterThan(0);
  });

  test("the fallback bypasses zod, so assert it would have validated", () => {
    // orchestrator.ts:1082 builds this literally; nothing re-parses it before it reaches the wire.
    for (const raw of [{ final_score: 0, band: "low_evidence" }, { final_score: 14, band: "high_priority_review" }, undefined]) {
      expect(CaseAdjudicationSchema.safeParse(fallback_adjudication(raw, "reason")).success).toBe(true);
    }
  });

  test("no_signal is the default for EVERY scan verdict the backend might compare against", () => {
    // Backend contract: no_signal -> "no_independent_support" -> agreement 50, regardless of
    // strength and regardless of the scan's verdict. That is the only defensible default for a run
    // whose adjudicator never ran.
    const adj = fallback_adjudication({ final_score: 18, band: "high_priority_review" }, "Retry budget exhausted.");
    expect(adj.records_read.occupancy_signal).toBe("no_signal");
    // ...even though the raw heuristics scored high. The heuristics are not a records READ.
    expect(adj.calibrated_score).toBe(10);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

```bash
OE_PROSE_REGISTER=off bun test test/adjudication_records_read.test.ts
```
Expected: FAIL — `TypeError: undefined is not an object (evaluating 'adj.records_read.occupancy_signal')`
on the first three tests, and the fourth failing on the same access.

- [ ] **Step 3: Implement**

Replace `fallback_adjudication` (`src/agents/orchestrator.ts:1082-1098`) with:

```ts
export function fallback_adjudication(raw_score: any, reason: string): CaseAdjudication {
  const score = Math.trunc(Number(raw_score?.final_score)) || 0;
  const band: VerdictBand = (raw_score?.band ?? "low_evidence") as VerdictBand;
  return {
    raw_score: score,
    // calibrated_score now shares clarity's 0-10 scale; the raw worker sum can
    // exceed 10, and this fallback path bypasses schema validation, so clamp it.
    calibrated_score: Math.min(10, score),
    clarity_score: score ? 5 : 2,
    verdict_band: band,
    case_archetype: score ? "mixed_evidence" : "insufficient_ownership_data",
    score_adjustments: [],
    reasoning_summary: reason,
    why_not_higher: [reason],
    why_not_lower: score ? [] : ["No positive raw heuristic score was available."],
    // X-078. There is no case-level read of the records on this path, so the only honest report is
    // "no signal, weak" — which the backend resolves to agreement 50, "the investigation could not
    // tell", for every scan verdict. Deriving a signal from the raw heuristic sum would be an
    // invention: the sum is a risk score, not a directional read of what the records show.
    records_read: {
      occupancy_signal: "no_signal",
      strength: "weak",
      reasoning: `No case-level adjudication was produced for this run: ${reason}`,
      driving_heuristic_ids: [],
    },
  };
}
```

- [ ] **Step 4: Run the tests and the typecheck**

```bash
OE_PROSE_REGISTER=off bun test test/adjudication_records_read.test.ts && bun run typecheck
```
Expected: `4 pass, 0 fail`; `tsc --noEmit` silent (exit 0) — the Task 3 error is gone.

- [ ] **Step 5: Commit Tasks 3 + 4 together**

```bash
git add src/agents/models.ts src/agents/orchestrator.ts \
        test/models.test.ts test/prose_redaction.test.ts test/adjudication_records_read.test.ts
git commit -m "feat(X-078): records_read on CaseAdjudication + honest fallback default

The case-level roll-up of what public records say about occupancy, blind to any
scan claim. ExternalEvidenceSchema is unchanged (see the blind-contract guard);
the backend does the comparing against its own org's scan verdict."
```

---

### Task 5: The tool-args mirror and the repair channel

`SubmitCaseAdjudicationArgs` (`src/agents/orchestrator.ts:83-102`) is what LangChain converts to
JSON schema for the provider — it is the only thing the model actually sees as a contract. Its
`.describe()` strings do more work than the prompt here, because they sit inline with each field.

**Files:**
- Modify: `src/agents/orchestrator.ts:83-102` (args), `src/agents/orchestrator.ts:1043-1046`
  (repair literals)
- Modify: `src/agents/models.ts` import block in `orchestrator.ts:23-51`
- Test: `test/adjudication_records_read.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/adjudication_records_read.test.ts`, and extend its imports:

```ts
import { fallback_adjudication, submit_case_adjudication } from "../src/agents/orchestrator.ts";
import { CaseAdjudicationSchema, EVIDENCE_STRENGTH, OCCUPANCY_SIGNAL } from "../src/agents/models.ts";
```

```ts
describe("X-078 submit_case_adjudication tool args", () => {
  const schema = submit_case_adjudication.schema as any;

  test("the tool exposes records_read, so the model can actually emit it", () => {
    expect(Object.keys(schema.shape)).toContain("records_read");
  });

  test("the tool args and the model schema agree field-for-field", () => {
    // orchestrator.ts:1033 parses the tool args through CaseAdjudicationSchema. A field the tool
    // does not offer can never be supplied, and every run would fall back.
    expect(Object.keys(schema.shape).sort()).toEqual(Object.keys(CaseAdjudicationSchema.shape).sort());
  });

  test("the tool accepts a full block and applies the same default", () => {
    const parsed = schema.parse({
      raw_score: 4,
      calibrated_score: 4,
      clarity_score: 6,
      verdict_band: "review",
      case_archetype: "mixed_evidence",
      reasoning_summary: "s",
      records_read: { occupancy_signal: "owner_occupancy", strength: "moderate", reasoning: "r" },
    });
    expect(parsed.records_read.driving_heuristic_ids).toEqual([]);
  });

  test("every enum value is named in a describe() string the provider will see", () => {
    const described = JSON.stringify(schema.shape.records_read);
    for (const value of [...OCCUPANCY_SIGNAL, ...EVIDENCE_STRENGTH]) {
      expect([value, described.includes(value)]).toEqual([value, true]);
    }
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

```bash
OE_PROSE_REGISTER=off bun test test/adjudication_records_read.test.ts
```
Expected: FAIL — the first test fails (`records_read` absent from the tool shape) and the
field-for-field test reports the two key lists differing by `records_read`.

- [ ] **Step 3: Add `records_read` to the tool args**

In `src/agents/orchestrator.ts`, extend the `./models.ts` import block (`:23-51`) with
`EVIDENCE_STRENGTH,` and `OCCUPANCY_SIGNAL,` (keep the block's existing alphabetical-ish grouping —
values first, `type` imports after):

```ts
import {
  AddressCandidateSchema,
  CASE_ARCHETYPE_VALUES,
  CaseAdjudicationSchema,
  CaseInvestigationPlanSchema,
  EVIDENCE_STRENGTH,
  EvidenceReferenceSchema,
  HeuristicPlanSchema,
  OCCUPANCY_SIGNAL,
  OwnerEvidenceSummarySchema,
  ResolvedAddressContextSchema,
  ScoreAdjustmentSchema,
  VERDICT_BAND,
  runTimestamp,
  // ...the existing `type` imports, unchanged
```

Then add the field to `SubmitCaseAdjudicationArgs`, after `why_not_lower` and before the closing
`})` / `.describe(...)`:

```ts
    records_read: z
      .object({
        occupancy_signal: z
          .enum(OCCUPANCY_SIGNAL)
          .describe(
            "What the PUBLIC RECORDS show about who occupies this property. " +
              "non_owner_occupancy: records point to someone other than the owner living there. " +
              "owner_occupancy: records point to the owner living there. " +
              "no_signal: the records are SILENT — they support neither reading. " +
              "no_signal is not a weak owner_occupancy; use it whenever the records do not speak.",
          ),
        strength: z
          .enum(EVIDENCE_STRENGTH)
          .describe(
            "How much weight the RECORDS themselves carry for that signal — not how confident you " +
              "feel. weak: one thin, stale or low-reliability row. moderate: a clear signal from a " +
              "single source family. strong: the same reading corroborated across independent sources.",
          ),
        reasoning: z
          .string()
          .min(1)
          .describe("At most 2 sentences naming the records that produced the signal. Do not restate reasoning_summary."),
        driving_heuristic_ids: z
          .array(z.string())
          .default([])
          .describe("The heuristic ids whose findings drove this signal. Use ids from the analyst submissions."),
      })
      .strict()
      .describe(
        "What public records say about occupancy at this address, judged on the records alone. " +
          "This is NOT a comparison against any external claim, listing or scan — you have not been " +
          "shown one, and you must not infer one.",
      ),
```

- [ ] **Step 4: Teach the repair channel the new literals**

In `_case_adjudication_from_tool_calls` (`src/agents/orchestrator.ts:1043-1046`), extend
`required_literals` so a rejected submission tells the model the exact allowed strings — the same
service the existing two entries provide:

```ts
        required_literals: {
          verdict_band: ["low_evidence", "monitor", "review", "high_priority_review", "manual_verification"],
          case_archetype: [...CASE_ARCHETYPE_VALUES],
          "records_read.occupancy_signal": [...OCCUPANCY_SIGNAL],
          "records_read.strength": [...EVIDENCE_STRENGTH],
        },
```

- [ ] **Step 5: Run the tests**

```bash
OE_PROSE_REGISTER=off bun test test/adjudication_records_read.test.ts && bun run typecheck && bun run lint
```
Expected: `8 pass, 0 fail`; `tsc` silent; `biome check .` reports 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/agents/orchestrator.ts test/adjudication_records_read.test.ts
git commit -m "feat(X-078): submit_case_adjudication carries records_read; repair channel names its literals"
```

---

### Task 6: Prompt instructions for `records_read`

**Files:**
- Modify: `src/agents/prompts.ts:504-565` (`master_adjudication_user_prompt`)
- Test: `test/prompts_records_read.test.ts` (create)

The system prompt (`prompts.ts:189-203`) stays as it is: it already frames the adjudicator as a case
reviewer and carries an explicit output budget. The new field's instructions belong with the other
per-field requirements in the user prompt, and must respect that budget.

- [ ] **Step 1: Write the failing test**

```ts
// test/prompts_records_read.test.ts
import { describe, expect, test } from "bun:test";
import { master_adjudication_user_prompt } from "../src/agents/prompts.ts";

const PROMPT = master_adjudication_user_prompt(
  { input_address: "1104 SPRING RUN RD", input_zip: "40514", evidence_map: {} },
  { final_score: 4, band: "review" },
  [],
  [],
);

describe("X-078 master adjudication prompt: records_read", () => {
  test("names the field and all three signals", () => {
    expect(PROMPT).toContain("records_read");
    for (const signal of ["non_owner_occupancy", "owner_occupancy", "no_signal"]) {
      expect([signal, PROMPT.includes(signal)]).toEqual([signal, true]);
    }
  });

  test("defines strength as the weight of the RECORDS, not model self-confidence", () => {
    expect(PROMPT).toContain("how much weight the records carry");
    expect(PROMPT).toContain("not how confident you feel");
    for (const strength of ["weak", "moderate", "strong"]) {
      expect([strength, PROMPT.includes(strength)]).toEqual([strength, true]);
    }
  });

  test("distinguishes no_signal from owner_occupancy in as many words", () => {
    // The single most damaging error this feature could make is collapsing "the records are silent"
    // into "the records say owner-occupied". They map to different backend states.
    expect(PROMPT).toContain("silent");
    expect(PROMPT).toContain("no_signal is not a weak owner_occupancy");
  });

  test("never frames the field as agreement with an outside claim", () => {
    // The engine is blind. There is no scan, listing or verdict in its context, and inviting the
    // model to reason about one would have it invent the claim it is supposedly checking.
    const recordsBlock = PROMPT.slice(PROMPT.indexOf("records_read"));
    for (const forbidden of ["the scan", "the listing", "corroborate", "agree with", "confirm the"]) {
      expect([forbidden, recordsBlock.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  test("records_read is in the submit key list", () => {
    const keyLine = PROMPT.slice(PROMPT.indexOf("Include keys:"));
    expect(keyLine).toContain("records_read");
  });

  test("keeps the output budget honest with an explicit length cap", () => {
    expect(PROMPT).toContain("at most 2 sentences");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

```bash
OE_PROSE_REGISTER=off bun test test/prompts_records_read.test.ts
```
Expected: FAIL — 5 of 6 fail (the "never frames it as agreement" test passes vacuously today because
`PROMPT.indexOf("records_read")` is `-1` and `slice(-1)` returns the last character).

- [ ] **Step 3: Add the instructions**

In `src/agents/prompts.ts`, inside `master_adjudication_user_prompt`, insert this block immediately
after the `why_not_higher and why_not_lower: at most 2 terse bullets each...` lines (was `:558-559`)
and **before** the `- Submit using submit_case_adjudication...` lines:

```ts
    "- records_read is your case-level read of what the PUBLIC RECORDS show about occupancy at this",
    "  address. Judge the records on their own terms. You have not been shown any outside claim,",
    "  listing or prior conclusion about this property, and you must not assume one exists.",
    "- records_read.occupancy_signal:",
    "  non_owner_occupancy — the records point to someone other than the owner occupying the subject.",
    "  owner_occupancy — the records point to the owner occupying the subject.",
    "  no_signal — the records are silent; they support neither reading. Thin, stale, absent or",
    "  purely administrative rows are no_signal. no_signal is not a weak owner_occupancy: choose it",
    "  whenever the records do not speak, and never to express uncertainty about a signal you did see.",
    "- records_read.strength is how much weight the records carry for that signal — not how confident",
    "  you feel. weak: one thin, stale or low-reliability row. moderate: a clear reading from a single",
    "  source family. strong: the same reading corroborated across independent sources. Use weak with",
    "  no_signal unless a substantive record positively establishes silence.",
    "- records_read.reasoning: at most 2 sentences naming the records behind the signal. Do not",
    "  restate reasoning_summary.",
    "- records_read.driving_heuristic_ids: the analyst heuristic ids whose findings drove the signal,",
    "  taken from the submissions above. Leave it empty rather than naming an id you did not use.",
    "- records_read is independent of calibrated_score and verdict_band. A high-risk case whose",
    "  records happen to be thin is still no_signal, and a low-risk case with clear owner-occupancy",
    "  records is still owner_occupancy.",
```

Then update the submit-key instruction (was `:560-562`) to name the field:

```ts
    "- Submit using submit_case_adjudication. Include keys: raw_score, calibrated_score,",
    "  clarity_score, verdict_band, case_archetype, score_adjustments, reasoning_summary,",
    "  why_not_higher, why_not_lower, records_read.",
```

And add the new prose field to the writing-register field list (was `:563`) so the humanization
register covers it when `OE_PROSE_REGISTER` is on:

```ts
    ..._prose_register_lines(
      "reasoning_summary, why_not_higher, why_not_lower, records_read.reasoning, and each score_adjustments reason",
    ),
```

- [ ] **Step 4: Run the tests**

```bash
OE_PROSE_REGISTER=off bun test test/prompts_records_read.test.ts
OE_PROSE_REGISTER=off bun test test/prompts_register.test.ts test/prompts_data_surface.test.ts test/prompts_external_scope.test.ts test/prompts_rental_market.test.ts
```
Expected: `6 pass, 0 fail` for the new file; all four existing prompt suites still pass. The register
change is inside `_prose_register_lines(...)`, which returns `[]` while the flag is off, so the
default prompt text is unaffected by that line.

- [ ] **Step 5: Eyeball the rendered prompt once**

```bash
OE_PROSE_REGISTER=off bun -e '
import { master_adjudication_user_prompt } from "./src/agents/prompts.ts";
const p = master_adjudication_user_prompt({ input_address: "1104 SPRING RUN RD", evidence_map: {} }, { final_score: 4, band: "review" }, [], []);
console.log(p.slice(p.indexOf("Adjudication requirements:")));
'
```
Expected: the requirements block prints with the new `records_read` lines between the
`why_not_higher / why_not_lower` bullet and the `Submit using submit_case_adjudication` bullet, and
the key list ends `..., why_not_lower, records_read.`

- [ ] **Step 6: Commit**

```bash
git add src/agents/prompts.ts test/prompts_records_read.test.ts
git commit -m "feat(X-078): teach the adjudicator records_read — records weight, not self-confidence"
```

---

### Task 7: Redact `records_read.reasoning`

`sanitize_adjudication_prose` (`src/agents/prose_redaction.ts:347-364`) is the output filter that
turns internal identifiers into human phrases before the report leaves the process
(`orchestrator.ts:302`, gated by `OE_PROSE_REDACT`). It covers every adjudicator prose field —
`records_read.reasoning` is a new one, and it goes straight to the browser via the backend's
`corroboration.reasoning`. Left uncovered, a sentence like *"utilityRecords show own_rent=0"* renders
verbatim in the frontend.

**Files:**
- Modify: `src/agents/prose_redaction.ts:327-332` (the `AdjudicationProse` interface) and `:347-364`
- Test: `test/prose_redaction.test.ts` (append to the existing
  `describe("sanitize_adjudication_prose")` block, `:110-137`)

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("sanitize_adjudication_prose", ...)` block:

```ts
  test("cleans records_read.reasoning and preserves the block's non-prose fields", () => {
    // X-078: this string reaches the browser as corroboration.reasoning. It is prose, and it is
    // exactly as likely to name a raw column as reasoning_summary is.
    const adj = {
      reasoning_summary: "clean summary",
      why_not_higher: [],
      why_not_lower: [],
      records_read: {
        occupancy_signal: "non_owner_occupancy",
        strength: "moderate",
        reasoning: "utilityRecords show own_rent=0 for the occupant.",
        driving_heuristic_ids: ["loan_tenure"],
      },
    };
    const out = sanitize_adjudication_prose(adj);
    expect(count_prose_leaks([out.records_read.reasoning])).toBe(0);
    expect(out.records_read.occupancy_signal).toBe("non_owner_occupancy");
    expect(out.records_read.strength).toBe("moderate");
    expect(out.records_read.driving_heuristic_ids).toEqual(["loan_tenure"]);
  });

  test("an adjudication with no records_read still sanitizes (the interface stays optional)", () => {
    const out = sanitize_adjudication_prose({
      reasoning_summary: "driveRecords indicate presence.",
      why_not_higher: [],
      why_not_lower: [],
    });
    expect(count_prose_leaks([out.reasoning_summary])).toBe(0);
  });
```

- [ ] **Step 2: Run it, verify it fails**

```bash
OE_PROSE_REGISTER=off bun test test/prose_redaction.test.ts
```
Expected: FAIL — `expect(count_prose_leaks([...])).toBe(0)` receives a non-zero count, because
`records_read.reasoning` is copied through the spread untouched.

- [ ] **Step 3: Implement**

In `src/agents/prose_redaction.ts`, extend the `AdjudicationProse` interface (`:327-332`):

```ts
interface AdjudicationProse {
  reasoning_summary: string;
  why_not_higher: string[];
  why_not_lower: string[];
  score_adjustments?: readonly { reason: string; [key: string]: unknown }[];
  // X-078. Human-facing prose that reaches the browser as corroboration.reasoning. Optional on the
  // interface so the function stays usable on the partial shapes the tests and callers pass.
  records_read?: { reasoning: string; [key: string]: unknown };
}
```

and `sanitize_adjudication_prose` (`:347-364`):

```ts
export function sanitize_adjudication_prose<T extends AdjudicationProse>(adjudication: T): T {
  const out: Record<string, unknown> = {
    ...adjudication,
    reasoning_summary: redact_prose(adjudication.reasoning_summary),
    why_not_higher: adjudication.why_not_higher.map(redact_prose),
    why_not_lower: adjudication.why_not_lower.map(redact_prose),
  };
  if (adjudication.records_read) {
    out["records_read"] = {
      ...adjudication.records_read,
      reasoning: redact_prose(adjudication.records_read.reasoning),
    };
  }
  if (!Array.isArray(adjudication.score_adjustments)) {
    return out as T;
  }
  return {
    ...out,
    score_adjustments: adjudication.score_adjustments.map((sa) => ({
      ...sa,
      reason: redact_prose(sa.reason),
    })),
  } as T;
}
```

- [ ] **Step 4: Run the tests**

```bash
OE_PROSE_REGISTER=off bun test test/prose_redaction.test.ts && bun run typecheck
```
Expected: PASS, 0 fail; `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add src/agents/prose_redaction.ts test/prose_redaction.test.ts
git commit -m "fix(X-078): redact records_read.reasoning — it reaches the browser like every other adjudicator prose field"
```

---

### Task 8: The adjudicator actually emits a valid block (orchestrator-level)

Tasks 3-7 each test one seam. This is the one that proves the seams connect: a real
`AgentOrchestrator` with a scripted master LLM, through the real `_adjudicate_case`, the real
`_case_adjudication_from_tool_calls`, and out to a `records_read` on the assessment.

This is possible with no API and no network because `AgentInvestigationRequestSchema` defaults
`disable_master_planning` to `true` (`models.ts:192`), so a `master_llm` is consulted for
**adjudication only** — exactly one scripted batch.

**Files:**
- Test: `test/e2e/adjudication_records_read.e2e.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// test/e2e/adjudication_records_read.e2e.test.ts
import { describe, expect, test } from "bun:test";
import { AgentOrchestrator } from "../../src/agents/orchestrator.ts";
import { DataHttpClient } from "../../src/agents/data_client.ts";
import { AgentInvestigationRequestSchema } from "../../src/agents/models.ts";
import { assessment_report_payload } from "../../src/agents/investigation_wire.ts";
import { FixtureDataService } from "../support/fixture_data_service.ts";
import { people1104, resolve1104 } from "../support/fixtures.ts";
import { ScriptedChatModel } from "../support/scripted_llm.ts";
import { FakeSubagent } from "../support/subagents.ts";

function fixturePlan() {
  const payload = resolve1104() as any;
  return {
    resolve: payload,
    address_people: people1104(),
    address_records: { records_by_source: payload.records_by_source, unsupported_shapes: [] },
    schema: { tables: [], access_paths: [], caveats: [] },
  };
}

const VALID_ADJUDICATION = {
  raw_score: 0,
  calibrated_score: 3,
  clarity_score: 7,
  verdict_band: "monitor",
  case_archetype: "non_rental_absentee_owner",
  reasoning_summary: "Owner mails elsewhere; no rental-use evidence at the subject.",
  why_not_higher: ["No unrelated-occupant evidence."],
  why_not_lower: ["Owner mailing address is not the subject."],
  records_read: {
    occupancy_signal: "non_owner_occupancy",
    strength: "moderate",
    reasoning: "The property-tax record mails the owner elsewhere and no record places them at the subject.",
    driving_heuristic_ids: ["owner_identity_and_mailing"],
  },
};

function orchestratorWith(batches: any[][], server: FixtureDataService) {
  return new AgentOrchestrator({
    data: new DataHttpClient(server.url),
    subagent: new FakeSubagent(),
    master_llm: new ScriptedChatModel(batches) as any,
  });
}

const REQUEST = () => AgentInvestigationRequestSchema.parse({ address: "1104 SPRING RUN RD", zip: "40514" });

describe("X-078 E2E: the adjudicator emits records_read end to end", () => {
  test("a valid submit_case_adjudication call lands records_read on the assessment", async () => {
    const server = new FixtureDataService(fixturePlan());
    try {
      const orch = orchestratorWith(
        [[{ name: "submit_case_adjudication", args: VALID_ADJUDICATION }]],
        server,
      );
      const a = await orch.investigate(REQUEST());

      expect(a.adjudication.records_read.occupancy_signal).toBe("non_owner_occupancy");
      expect(a.adjudication.records_read.strength).toBe("moderate");
      expect(a.adjudication.records_read.driving_heuristic_ids).toEqual(["owner_identity_and_mailing"]);
      // not the fallback path — the scripted verdict survived
      expect(a.adjudication.verdict_band).toBe("monitor");
      expect(a.adjudication.calibrated_score).toBe(3);
    } finally {
      server.close();
    }
  });

  test("records_read reaches the wire payload with no investigation_wire change", async () => {
    // assessment_report_payload spreads the assessment and strips only metrics_events, so the
    // backend's mapper sees the block for free. Asserted rather than assumed.
    const server = new FixtureDataService(fixturePlan());
    try {
      const orch = orchestratorWith(
        [[{ name: "submit_case_adjudication", args: VALID_ADJUDICATION }]],
        server,
      );
      const payload = assessment_report_payload(await orch.investigate(REQUEST()));
      const adjudication = payload["adjudication"] as Record<string, any>;
      expect(adjudication["records_read"]["occupancy_signal"]).toBe("non_owner_occupancy");
      expect(JSON.parse(JSON.stringify(payload))["adjudication"]["records_read"]["strength"]).toBe("moderate");
    } finally {
      server.close();
    }
  });

  test("an omitted records_read is repaired on retry, not silently accepted", async () => {
    const server = new FixtureDataService(fixturePlan());
    try {
      const { records_read, ...withoutBlock } = VALID_ADJUDICATION;
      void records_read;
      const orch = orchestratorWith(
        [
          [{ name: "submit_case_adjudication", args: withoutBlock }], // rejected by CaseAdjudicationSchema
          [{ name: "submit_case_adjudication", args: VALID_ADJUDICATION }], // repaired
        ],
        server,
      );
      const a = await orch.investigate(REQUEST());
      expect(a.adjudication.records_read.occupancy_signal).toBe("non_owner_occupancy");
      expect(a.adjudication.verdict_band).toBe("monitor");
    } finally {
      server.close();
    }
  });

  test("an unrepaired submission falls back to no_signal rather than to an invented one", async () => {
    // max_output_retries defaults to 2 (models.ts:188), so three bad batches exhaust the budget.
    const server = new FixtureDataService(fixturePlan());
    try {
      const bad = { ...VALID_ADJUDICATION, records_read: { occupancy_signal: "maybe", strength: "strong", reasoning: "r" } };
      const orch = orchestratorWith(
        [
          [{ name: "submit_case_adjudication", args: bad }],
          [{ name: "submit_case_adjudication", args: bad }],
          [{ name: "submit_case_adjudication", args: bad }],
        ],
        server,
      );
      const a = await orch.investigate(REQUEST());
      expect(a.adjudication.records_read.occupancy_signal).toBe("no_signal");
      expect(a.adjudication.records_read.strength).toBe("weak");
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 2: Run it, verify it fails against a stashed implementation, then passes**

```bash
OE_PROSE_REGISTER=off bun test test/e2e/adjudication_records_read.e2e.test.ts
```
Expected: `4 pass, 0 fail` (Tasks 3-5 are already in). To prove the suite is not vacuous, temporarily
change `fallback_adjudication`'s `occupancy_signal` to `"owner_occupancy"` and re-run:
Expected: the fourth test fails with `expected "no_signal", received "owner_occupancy"`. **Revert.**

- [ ] **Step 3: Confirm the pre-existing E2E suite is unaffected**

```bash
OE_PROSE_REGISTER=off bun run e2e
```
Expected: the four original E2E describes (E2E-1..E2E-5) still pass alongside the new file — 11 pass
across 3 files, 0 fail. **E2E-3 is the blind-parity assertion** (spec §11): it drives a full
investigation with no payload and asserts no external source or content reaches any surface. It must
pass unchanged and with no edit — that is the evidence that constraint 1 held.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/adjudication_records_read.e2e.test.ts
git commit -m "test(X-078): E2E — records_read from a scripted adjudicator through to the wire payload"
```

---

### Task 9: Full gate, green

- [ ] **Step 1: Run the gate**

```bash
OE_PROSE_REGISTER=off bun run verify
```
Expected: exit 0. `tsc --noEmit` silent; `biome check .` 0 errors (new files are covered by
`biome.json`'s `test/**` include — the formatter is off, so no formatting churn); `bun test` shows
**0 fail** and a pass count equal to the Task 1 baseline plus the ~24 new assertions across the four
new/extended test files.

- [ ] **Step 2: Confirm no unintended file moved**

```bash
git diff --stat origin/main -- src cli
```
Expected: exactly four `src/` files — `src/agents/models.ts`, `src/agents/orchestrator.ts`,
`src/agents/prompts.ts`, `src/agents/prose_redaction.ts`. **No `cli/` change, no
`src/heuristics/**` change, no `src/agents/external_evidence.ts` change** (constraints 1 and 2).

```bash
git diff origin/main -- src/agents/external_evidence.ts src/heuristics src/agents/subagents.ts | wc -l
```
Expected: `0`.

- [ ] **Step 3: Confirm the deterministic score benchmark did not move**

```bash
OE_PROSE_REGISTER=off bun test test/score_benchmark.test.ts 2>&1 | grep BENCH
```
Expected: all 12 `BENCH` lines identical to the goldens in `test/score_benchmark.test.ts:39-52`
(`no_rows 0`, `tax_only_mailing_elsewhere 2.5`, ..., `loan_only_owner_elsewhere 3.55`). Nothing in
this plan touches `src/heuristics/**`, so any movement here is a bug in this branch.

---

### Task 10: The adjudicator regression measurement (constraint 4)

**This is the task the constraint requires and the only one that needs live API calls.** Adding a
required field to `submit_case_adjudication` changes what the model generates. `clarity_score` now
feeds the backend's agreement dampener, so a shift in its distribution silently changes every
agreement number in the product. Measure it; do not assume neutrality.

**Instrument.** There is no LLM eval harness in this repo (`cli/run_investigation_batch.ts` does not
exist; `test/score_benchmark.test.ts` is deterministic-heuristics-only, no LLM). The measurement is
therefore built from `cli/run_address.ts` run over a fixed address list, twice — once at
`origin/main` in the existing `.claude/worktrees/stable-main` checkout, once on this branch — against
the same data service, the same model, and the same flags. Output lands in `runs/`, which is
gitignored (`.gitignore` line 8) and outside `HASHED_ROOTS`, so nothing here perturbs the cache key.

**Prerequisites:** `ANTHROPIC_API_KEY` and `PARTNER_DSN` (both in the copied `.env`), Docker, and
`jq`. ~24 haiku investigations total; each run also writes an observability sidecar next to its
`--out` file, so token/cost is recoverable from `writeRunMetrics` output.

- [ ] **Step 1: Start the data service once, shared by both arms**

From the **main checkout** (which owns the `services/graph` submodule):

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts
git submodule update --init services/graph
docker compose up -d graph
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/healthz
```
Expected: `200`. (`docker compose config` interpolates and prints secrets to stdout — do not run it
into a log.)

- [ ] **Step 2: Pin the address sample**

Twelve real Lexington addresses, taken deterministically from the backend's committed corpus so both
arms use a byte-identical list. Read-only; nothing is written into that repo.

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/.claude/worktrees/x078-records-read
mkdir -p runs/x078/before runs/x078/after
awk -F',' 'NR>1 && NR<=13 {print $(NF-3) "\t" $NF}' \
  /home/aayan-alam/Work/Helcion/true-occupancy-workspace/mortgage-compliance-monitoring/lexington_addresses_deduped.csv \
  > runs/x078/addresses.tsv
wc -l runs/x078/addresses.tsv && head -3 runs/x078/addresses.tsv
```
Expected: `12 runs/x078/addresses.tsv`, and the first rows read
`214 Habersham Ct<TAB>40517`, `3351 Sutherland Dr<TAB>40517`, `601 Mount Tabor Rd<TAB>40517`.

- [ ] **Step 3: Define the runner once (identical in both arms)**

```bash
cat > runs/x078/run_arm.sh <<'SH'
#!/usr/bin/env bash
# usage: run_arm.sh <engine-checkout-dir> <out-dir> <addresses.tsv>
set -euo pipefail
ENGINE_DIR="$1"; OUT="$2"; LIST="$3"
mkdir -p "$OUT"
while IFS=$'\t' read -r addr zip; do
  slug="$(printf '%s' "$addr" | tr ' ' '_' | tr -cd '[:alnum:]_')"
  ( cd "$ENGINE_DIR" && bun run cli/run_address.ts \
      --address "$addr" --zip "$zip" \
      --data-url http://127.0.0.1:8000 \
      --provider anthropic --model claude-haiku-4-5 \
      --out "$OUT/${slug}.json" ) || echo "FAILED ${slug}" >&2
done < "$LIST"
SH
chmod +x runs/x078/run_arm.sh
```

- [ ] **Step 4: BEFORE arm — at `origin/main`**

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts
git -C .claude/worktrees/stable-main log --oneline -1
cp .env .claude/worktrees/stable-main/.env
cd .claude/worktrees/x078-records-read
./runs/x078/run_arm.sh \
  /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/.claude/worktrees/stable-main \
  "$PWD/runs/x078/before" "$PWD/runs/x078/addresses.tsv"
ls runs/x078/before/*.json | wc -l
```
Expected: `stable-main` is at the same SHA as `origin/main` from Task 1 Step 1 (if not,
`git -C .claude/worktrees/stable-main pull --ff-only` first). 12 JSON files, no `FAILED` lines.

- [ ] **Step 5: AFTER arm — on this branch**

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/.claude/worktrees/x078-records-read
./runs/x078/run_arm.sh "$PWD" "$PWD/runs/x078/after" "$PWD/runs/x078/addresses.tsv"
ls runs/x078/after/*.json | wc -l
```
Expected: 12 JSON files, no `FAILED` lines.

- [ ] **Step 6: Aggregate both arms**

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/.claude/worktrees/x078-records-read
for arm in before after; do
  for f in runs/x078/$arm/*.json; do
    jq -r --arg f "$(basename "$f" .json)" \
      '[$f, .adjudication.calibrated_score, .adjudication.clarity_score,
        .adjudication.verdict_band, .adjudication.case_archetype] | @tsv' "$f"
  done | sort > runs/x078/$arm.tsv
  awk -F'\t' -v a=$arm '{c+=$2; k+=$3; n++} END {printf "%s n=%d mean_calibrated=%.2f mean_clarity=%.2f\n", a, n, c/n, k/n}' runs/x078/$arm.tsv
done
join -t$'\t' runs/x078/before.tsv runs/x078/after.tsv \
  | awk -F'\t' '{printf "%-28s cal %s->%s  clr %s->%s  band %s->%s\n", $1,$2,$6,$3,$7,$4,$8}'
```
Expected: two `mean_calibrated= / mean_clarity=` lines and a 12-row per-address delta table. **Paste
this table verbatim into the PROGRESS.md session record in Task 11** — the diff IS the measurement,
exactly as `test/score_benchmark.test.ts:12-37` records its own.

- [ ] **Step 7: Read the `records_read` distribution (the strength-calibration open item)**

```bash
jq -r '.adjudication.records_read | [.occupancy_signal, .strength, (.driving_heuristic_ids | length)] | @tsv' \
  runs/x078/after/*.json | sort | uniq -c | sort -rn
```
Expected: a 12-row-total histogram over `{non_owner_occupancy, owner_occupancy, no_signal} x {weak,
moderate, strong}`. Record it. This is the sample the spec's open question 2 (strength calibration)
and umbrella §8.2 ask for, and it is the input to whether the backend's `AGREEMENT_ANCHORS` need
tuning before the frontend ships.

- [ ] **Step 8: Judge the result**

Apply this rule and write the verdict into the session record:

- **|Δ mean `clarity_score`| ≤ 0.5 and no address crosses a `verdict_band` boundary** → neutral;
  proceed, and say so explicitly with the numbers.
- **|Δ mean `clarity_score`| > 0.5, or any band crossing** → the prompt change moved the
  distribution. Do **not** silently proceed: record the shifted table, and flag it to the backend
  work as an input to `AGREEMENT_ANCHORS`, because a clarity shift rescales every agreement number.
  Consider trimming the `records_read` prompt block (it competes with the system prompt's output
  budget at `prompts.ts:203`) and re-measuring before merge.
- **A `records_read` histogram that collapses onto one cell** (e.g. all `moderate`) → the strength
  vocabulary is not discriminating; report it against spec open question 2 rather than shipping the
  anchor table as if it were calibrated.

- [ ] **Step 9: Tear down and confirm nothing leaked into git**

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts
docker compose down
cd .claude/worktrees/x078-records-read && git status --short
```
Expected: `docker compose down` removes the `graph` container; `git status --short` is **empty** —
`runs/` is gitignored, and the `.env` copies are too. Never commit `runs/`, `.env`, or an API key.

---

### Task 11: Repo bookkeeping and hand-off

`AGENTS.md`'s Definition of Done requires all three of these; a green gate alone is not done.

- [ ] **Step 1: Add the `feature_list.json` entry**

Append to `feature_list.json` (validated by `test/feature_list.test.ts`: every entry needs `id`,
`priority`, `area`, `title`, `user_visible_behavior`, `status`, `verification`, `evidence`, `notes`;
ids unique; **at most one entry `in_progress`** — set this one to `in_progress` while working and
`passing` at the end, and make sure no other entry is `in_progress`):

```json
  {
    "id": "adjudication-records-read",
    "priority": 12,
    "area": "agents",
    "title": "records_read on CaseAdjudication (X-078 AI corroboration)",
    "user_visible_behavior": "Every assessment's adjudication carries records_read {occupancy_signal, strength, reasoning, driving_heuristic_ids} — the case-level read of what public records say about occupancy, judged blind to any scan verdict. The backend compares it against its own org's scan verdict to derive corroboration.",
    "status": "passing",
    "verification": "OE_PROSE_REGISTER=off bun run verify; test/models.test.ts (schema), test/adjudication_records_read.test.ts (tool args + fallback), test/prompts_records_read.test.ts (prompt), test/e2e/adjudication_records_read.e2e.test.ts (scripted adjudicator end to end), test/external_evidence_blind_contract.test.ts (the blind guard); 12-address live before/after on calibrated_score/clarity_score.",
    "evidence": "<paste the gate summary line and the before/after mean table from Task 10>",
    "notes": "Additive. ExternalEvidenceSchema is unchanged and guarded by test/external_evidence_blind_contract.test.ts — the engine never learns the scan's verdict, which preserves blind/enriched parity and keeps the backend's AI-report cache key untouched (spec section 9). Heuristic subagents untouched; only the case-level master_adjudicator changed. Shipping this changes engine_source_hash(), so every cached AI report invalidates on deploy — a one-time re-run wave, intended."
  }
```

```bash
OE_PROSE_REGISTER=off bun test test/feature_list.test.ts
```
Expected: `4 pass, 0 fail`.

- [ ] **Step 2: Append a PROGRESS.md Session Record**

Newest-first, directly under the `## Session Record` heading (`PROGRESS.md:21-23`), in the house
format — goal / completed / verification run / evidence / commits / risks / next best action.
Include verbatim: the gate summary line, the Task 10 before/after table, the `records_read`
histogram, and the deploy-owner note that this drains the AI-report cache. Also update **Current
Verified State** only if the highest-priority unfinished feature changed (it does not — `batch-cli`
is still top).

```bash
git add feature_list.json PROGRESS.md
git commit -m "docs(X-078): feature_list + session record — records_read shipped, adjudicator regression measured"
```

- [ ] **Step 3: Final gate and clean state**

```bash
OE_PROSE_REGISTER=off bun run verify && git status --short
```
Expected: exit 0 and an **empty** `git status --short`. `services/graph` showing as modified is not
yours to commit — the umbrella sequences the submodule pointer (`AGENTS.md` "Clean state").

- [ ] **Step 4: Push and open the PR against `main`**

```bash
git push -u origin feat/x078-records-read
gh pr create --base main --head feat/x078-records-read \
  --title "X-078: records_read on CaseAdjudication (AI corroboration, engine half)" \
  --body "$(cat <<'BODY'
Adds the `records_read` block to `CaseAdjudicationSchema` — the case-level read of what public
records say about occupancy, emitted by the master adjudicator.

- `occupancy_signal`: non_owner_occupancy | owner_occupancy | no_signal
- `strength`: weak | moderate | strong — the weight the RECORDS carry, not model self-confidence
- `reasoning`, `driving_heuristic_ids`

**`ExternalEvidenceSchema` is unchanged and now guarded by a test.** The engine never learns the
scan's verdict: that preserves blind/enriched benchmark parity and keeps the backend's AI-report
cache key untouched (spec §9). The comparison happens server-side, against the caller org's own
verdict.

Heuristic subagents are untouched — only the case-level `master_adjudicator` changed.
`fallback_adjudication` emits `no_signal` / `weak`, which the backend resolves to agreement 50.

**Deploy note:** this changes `engine_source_hash()`, so every cached AI report invalidates on
deploy — a one-time re-run wave on first access per property. Intended, but plan for it.

Adjudicator regression measured live on 12 addresses, before/after — table in `PROGRESS.md`.
BODY
)"
```
Expected: a PR URL, base `main`.

- [ ] **Step 5: Hand off to the backend**

Report to the coordinator: the merged SHA on `main` (the backend's `submodules/occupancy-engine-ts`
bump target), the Task 10 before/after numbers, and the `records_read` histogram from Task 10 Step 7
— the backend's `AGREEMENT_ANCHORS` calibration depends on it. Then remove the worktree:

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts
git worktree remove .claude/worktrees/x078-records-read
git worktree list
```
Expected: only the main checkout and `stable-main` remain.

---

## Verification / Definition of Done

- [ ] `OE_PROSE_REGISTER=off bun run verify` green (exit 0), with `.env` present so
      `OE_PROSE_REDACT` stays on. Pass count ≥ the Task 1 baseline; **0 fail**.
- [ ] `git diff origin/main -- src/agents/external_evidence.ts src/heuristics src/agents/subagents.ts`
      is **empty** (constraints 1 and 2), and `test/external_evidence_blind_contract.test.ts` passes.
- [ ] E2E-3 (the blind-parity guard, `test/e2e/orchestrator.e2e.test.ts:108-157`) passes **unedited**.
- [ ] `test/score_benchmark.test.ts` reproduces all 12 goldens unchanged.
- [ ] Adjudicator before/after measured on 12 live addresses; Δ mean `calibrated_score` and Δ mean
      `clarity_score` recorded in `PROGRESS.md` with the per-address table, and judged against the
      Task 10 Step 8 rule.
- [ ] `records_read` strength/signal histogram recorded and handed to the backend work.
- [ ] `feature_list.json` entry `passing` with real `evidence`; exactly one or zero entries
      `in_progress`.
- [ ] `PROGRESS.md` Session Record appended, including the cache-invalidation note for the deploy
      owner.
- [ ] `git status --short` empty; `runs/`, `.env` and every credential uncommitted; the feature
      worktree removed.
- [ ] Umbrella `docs/harness/progress.md` and `docs/harness/feature_list.json` updated by the
      coordinator (workspace-level, not from this repo), and the merged SHA handed to the backend
      for its submodule bump.
