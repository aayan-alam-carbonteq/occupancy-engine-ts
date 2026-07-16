# Design — Human-Readable, Gated Prose for the Occupancy Engine

Date: 2026-07-15
Status: Approved (pending spec review) → next step: implementation plan
Branch context: `feat/synth-reasoning-augment`

## Problem

The agent's user-facing prose is not fit for the product. The case assessment is
formalized in the UI and shown to a business user, but the generated prose:

1. **Is not written for human readability** — it reads like an internal analyst dump.
2. **Exposes the underlying data surface** — it names internal data tables / GraphQL
   fields (e.g. `utilityRecords`, `taxProperties`, `driveRecords`). This is a
   **security concern**: it reveals the shape of the backing data.
3. **Quotes raw database values** — it narrates literal column/value pairs
   (e.g. "the own/rent column has 0", "ownerrescount = 3").

We must optimize the prose for the business use case and gate the underlying
implementation, **without changing data coverage**.

## Root cause

All three problems share one root cause: the agent's entire working vocabulary is
the data layer.

- The subagent's schema guide is built from GraphQL field/table names
  (`src/agents/prompts.ts` `schema_context_for_heuristic`, `ADDRESS_SOURCE_FIELDS`,
  `PERSON_SOURCE_FIELDS`).
- The evidence map is rendered into the prompt as literal `key=value` bit-strings —
  `own_rent=0`, `ownerrescount=2`, `residential=...`, `totalliencount=...` — in
  `src/agents/orchestrator.ts` (`_people_at_address_summaries`, `_short_source_summary`,
  `_owner_summaries`) and surfaced via `render_context_sections` /
  `render_worker_sections` in `prompts.ts`.
- The prompts explicitly instruct citing `source/table/rowid`, and the
  `OE_SYNTH_AUGMENT` augmentation pushes explicit enumeration of technical
  `output_fields`.

The model then parrots that vocabulary into the free-prose fields.

## Key insight (why coverage is safe)

**Data coverage is driven by _dimension enumeration_ — does the finding explicitly
conclude on each `output_field`/sub-signal — not by _vocabulary_ — whether it names a
table or a plain-English record type.**

Therefore we can change the writing register (vocabulary + readability) while leaving
the enumeration pressure that `OE_SYNTH_AUGMENT` added fully intact. The gated
experiment exists to prove this separation empirically before shipping.

## Architecture recap (as-built)

Pipeline: preflight → deterministic packet gating → master planner (off by default) →
field-analyst subagents → deterministic scoring → Lead Case Adjudicator →
`build_report` (deterministic).

### Free-prose fields that reach a human (in scope)

- Subagent (`HeuristicAgentResult`): `finding`, `caveats[]`, `missing_evidence[]`
- Adjudicator (`CaseAdjudication`): `reasoning_summary`, `why_not_higher[]`, `why_not_lower[]`
- `report` (string) — deterministically assembled by `build_report` from
  `reasoning_summary` + `finding` snippets + conflict titles. **No LLM report path
  exists** (`ORCHESTRATOR_REPORT_PROMPT` is dead code). If its inputs are clean, the
  report is clean automatically; no direct action needed on it.

### Out of scope (untouched)

- `interpretation` — fully enum-structured, never free prose.
- `evidence_for` / `evidence_against` / `evidence_refs` — structured citations
  (`source/table/rowid/record_id`). These are **stripped before display**, so leaking
  internal identifiers there is acceptable and they must be preserved exactly (they are
  the machine anchors and coverage evidence).
- Scores, gating, verdict bands, case archetypes — no change.

## Decisions

| Decision | Choice |
| --- | --- |
| Mechanism | **Prompts + deterministic scrub** (persona/register rules primary, deterministic scrubber as security backstop) |
| Prose scope | **All prose surfaces** (subagents + adjudicator; report derived) — safe regardless of final UI scope |
| Coverage gate | **Offline judge** (existing Python `judge/` package) scores dimension coverage before/after |
| Gating | Two independent env flags, both **default off** |

## Solution — two coordinated levers

### Lever A — Prose register rules (primary, prompt-level)

Injected through the **user-prompt builders**, mirroring the existing
`_reasoning_augmentation_lines` pattern (gated additive lines appended to briefs /
submission requirements) — **not** by editing the static system-prompt consts. Hook
points:

- `heuristic_user_prompt` (solo packet submission requirements)
- `grouped_heuristic_user_prompt` (grouped submission requirements)
- `master_adjudication_user_prompt` (adjudication requirements)

Register rules (wording finalized during implementation):

1. Write prose for a non-technical decision-maker (the Director of Risk). Plain,
   professional English.
2. Never name internal structures in prose — no GraphQL/field/table names, no
   source-bucket codes, no DB column names.
3. Never quote raw cell values or `column=value`. Translate to meaning
   ("the mortgage application lists the occupant as a renter", not "own_rent = 0").
4. Keep citing precisely in the **structured** fields (`evidence_for`, etc.) — that
   separation is the mechanism: cite precisely in structured fields (stripped later),
   narrate cleanly in `finding`.
5. **Coverage guard (restated inline):** humanizing must not drop or merge any required
   dimension / sub-signal — still explicitly conclude on every `output_field`.

Plus a **source → human glossary** constant used by the prompt (and reused by the
scrubber) for consistent replacement language:

| Source code | Human phrase (default; tunable) |
| --- | --- |
| tax | property-tax record |
| base | identity / residence record |
| utility | utility service record |
| drive | driver's-license record |
| voter | voter-registration record |
| auto | vehicle-registration record |
| loan | mortgage / loan application record |
| trace | address-history record |
| criminal | criminal record |

Gated by `OE_PROSE_REGISTER`.

### Lever B — Deterministic scrubber (backstop, security guarantee)

New module `src/agents/prose_redaction.ts`. Contract: it is a **security backstop, not a
beautifier**. It guarantees no internal identifier survives in prose and is
**coverage-neutral by construction** — token substitution only, never clause deletion;
never runs on investigation prompts or on structured citation fields.

Two rule classes:

1. **Known-token map** — exact schema tokens → human phrase (`utilityRecords` →
   "utility record", `taxProperties` → "property-tax record", `ownerrescount` → "owner
   property count", …). Built from `ADDRESS_SOURCE_FIELDS` + `PERSON_SOURCE_FIELDS` +
   the schema-guide root/association fields (`resolveAddress`, `personAssociations`,
   `propertyAssociations`, `addressAssociations`, `sourceRecord`, `sourceRecords`,
   `searchAddresses`, `addressByText`, `person`) + the known column set used in
   `orchestrator.ts` (`own_rent`, `ownRent`, `ownername`, `owneraddressline1`,
   `ownercity`, `ownerstate`, `ownerzipcode`, `residential`, `condo`, `lendername`,
   `totalliencount`, `totallienbalance`, `ownerrescount`, `recordingdate`,
   `foreclosecode`, `forecloserecorddate`, …).
2. **Identifier catch-all** — any residual `camelCase` or `snake_case` token →
   neutral phrase ("an internal record field"). Future-proofs against schema tokens we
   didn't enumerate. Safe because human prose essentially never contains those token
   shapes → near-zero false positives. This rule also collapses `identifier = value`
   into the dimension phrase, **dropping the raw value** — this kills the
   "own/rent column has 0" class even on a backstop hit, while still naming the
   dimension (so coverage grading still sees the dimension stated).

**Not touched:** bare concept-words ("tax", "loan", "voter", "auto", "drive", "trace")
— they are ordinary English in phrases like "property tax record" and are not
identifiers. Only identifier-shaped tokens are sensitive.

**Where it runs:** a single finalization choke point in `orchestrator._investigate`.
Sanitize `results[].finding/caveats/missing_evidence` and `adjudication.*` prose
**before** `build_report`, so the derived report inherits clean text. One pass, outside
the investigation loop. The adjudicator having consumed pre-scrub findings is fine — any
identifier it echoes is caught by the same finalization pass over its own prose.

Gated by `OE_PROSE_REDACT`.

## Gating & the gated experiment

Two **independent** env flags (same parse idiom as `OE_SYNTH_AUGMENT` /
`OE_PROMPT_CACHE`: `["1","true","yes","on"].includes((process.env.X ?? "").trim().toLowerCase())`),
both **default off** (zero behavior change until explicitly enabled):

- `OE_PROSE_REDACT` — Lever B only (coverage-neutral by construction)
- `OE_PROSE_REGISTER` — Lever A (the lever with real coverage risk)

Independent flags let the experiment attribute any coverage change to the right lever.

### Metrics

- **Coverage** — the external offline `judge/` package's dimension-coverage score
  (the metric behind the prior "n=12, ~0.10 data coverage" numbers).
- **Band / archetype match rate** — must not move; a shift is a regression, not an
  accepted cost.
- **`prose_leak_count`** — new in-repo metric: run the scrubber's detector in
  detect-only mode over the prose fields and count surviving internal identifiers.
  Surfaced in run metrics (`_agent_metrics`) so the security objective is measurable
  here without the external judge.

### Protocol (fixed case set, temperature 0, a few repeats to separate signal from noise)

1. **Baseline** (both flags off) → record judge coverage, band/archetype match, leak count.
2. **Redact-only** (`OE_PROSE_REDACT=on`) → expect coverage ≈ baseline; leak count → 0.
   Validates the security fix in isolation.
3. **Full** (both on) → **ship gate:** aggregate coverage within the agreed tolerance
   band of baseline **AND** band/archetype match unchanged **AND** leak count 0.

**Ship-gate tolerance (default, tunable):** no single packet loses a dimension;
aggregate coverage within ±1 dimension across the set. Once validated, flip defaults
to on (or keep the flags for continued A/B).

## Files touched

- `src/agents/prompts.ts` — glossary const + `_prose_register_lines()` gated by
  `OE_PROSE_REGISTER`, wired into the three user-prompt builders.
- `src/agents/prose_redaction.ts` (new) — lexicon, `detect_leaks`, `redact_prose`,
  `sanitize_result_prose`, `sanitize_adjudication_prose`.
- `src/agents/orchestrator.ts` — gated finalization scrub pass in `_investigate` +
  `prose_leak_count` in `_agent_metrics`.
- `test/prose_redaction.test.ts` (new) — known tokens, catch-all, `column=value`,
  **no false positives on clean prose**, structured fields untouched.

## Non-goals / risks

- No change to scores, gating, verdict bands, archetypes, or evidence citations.
- The prompt lever is probabilistic — that is precisely why the deterministic scrubber
  is the actual security guarantee, not the prompt.
- On a backstop hit, the scrubber may drop a raw value (acceptable vs. leaking it); the
  prompt lever is what makes prose genuinely readable in the common path.
- If band/archetype match moves in step 3, treat as a regression and investigate before
  shipping.

## Open knobs (defaults chosen; revisit during implementation)

- (a) Exact human phrasing in the glossary.
- (b) Coverage tolerance band for the ship gate (default above).
- (c) Flag names (`OE_PROSE_REGISTER` / `OE_PROSE_REDACT`).
