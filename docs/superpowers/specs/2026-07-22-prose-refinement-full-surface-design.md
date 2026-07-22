# Design — Full-Surface Prose Refinement for the Occupancy Engine

Date: 2026-07-22
Status: Approved (pending spec review) → next step: implementation plan
Branch context: `feat/prose-refinement-full-surface` (engine, cut from `main`)
Supersedes scope of: [2026-07-15-humanize-agent-prose-design.md](./2026-07-15-humanize-agent-prose-design.md)
(extends it; does not replace the two levers it shipped)

## Problem

The end-of-investigation assessment is presented to human investigators, but the
served JSON still leaks internal data-surface vocabulary into the fields a human
reads. A baseline run (`demo_response.json`, both prior flags off) shows, in
human-facing strings:

- **Source-tag citations** — `TAX:68344`, `LOAN:74141-74144`, `BASE:81239`,
  `TRACE:267914`, `UTILITY:1296784`.
- **Row / record ids** — `rowid 1296784`, `rowid 1157430`, trace codes like `cd113530`.
- **Bare `column=value` pairs** — `residential=True`, `condo=False`, `own_rent=U`,
  `totalliencount=1`, `ownerrescount=1`, `dob_year=1975`.
- **Raw enum values embedded in free text** — `likely_family person at address via
  trace: …`, `not_applicable`, `ambiguous_nonowner_occupancy`.
- **Table/source names as adjectives** — `via base`, `in trace`, `loan record`.
- **Obscure jargon** — `situs` / `situs address`.

The prior cycle (2026-07-15) shipped two coverage-neutral-vs-risky levers but left
them **off by default**, and — critically — scoped only the model's *free prose*. Two
things are therefore still broken:

1. **Coverage gaps in the scrubber** — even with `OE_PROSE_REDACT` on, the scrubber
   only catches identifier-*shaped* tokens (`camelCase`/`snake_case`). Source-tag
   citations (`TAX:68344`), `rowid N`, trace codes (`cd113530`), bare `word=value`
   (`residential=True`), and jargon (`situs`) all survive.
2. **The deterministic evidence strings were never in scope** — the preflight
   `evidence_map` strings (`owner_summaries`, `people_at_address`,
   `nonowner_occupancy_hints`) are template-built by engine code, rendered raw to the
   frontend, and touched by neither lever. This is where most of the reported
   `likely_family` / `own_rent` / `BASE…` examples actually originate.

## Scope decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| Surfaces | **Everything a human sees** — model prose **and** the deterministic evidence strings. |
| Domain jargon | **Fix obscure, keep standard** — replace `situs`; keep `LTV` / `CLTV` (mortgage/risk-professional reader). |
| Rollout | **Ship the coverage-neutral parts default-on; keep the prompt-register lever (`OE_PROSE_REGISTER`) gated** until the offline coverage A/B validates it. |

## Key constraint — the evidence_map is double-duty

`_owner_summaries` / `_people_at_address_summaries` / `_nonowner_occupancy_hints` /
`_short_source_summary` (`src/agents/orchestrator.ts` ~1301–1520) build the evidence_map
strings. The **same object** is then:

1. Rendered into subagent prompts as grounding context
   (`prompts.ts` `render_context_sections`, ~782–789), and
2. Serialized into `result.resolved_address.evidence_map` and sent to the frontend.

The model needs the precise `own_rent=U` / `residential=True` form for grounding.
Therefore humanization must apply to a **display projection** of the result, produced at
finalization — never to the copy fed to prompts. Because finalization runs after all
model work, this is **coverage-neutral by construction**.

## Architecture — one finalization humanization pass, two input classes

```
                 investigation completes
                          │
                          ▼
        ┌─────────── finalize() ───────────┐
        │                                   │
   model prose                     deterministic evidence strings
   (finding, reasoning_summary,    (owner_summaries, people_at_address,
    why_not_*, caveats,             nonowner_occupancy_hints)
    score_adjustments[].reason)
        │                                   │
   Lever B scrubber (extended)      display humanizer (NEW, value-aware)
   string→string, coverage-neutral  runs on a DISPLAY COPY
        │                                   │
        └───────────► clean result ◄────────┘
                          │
                  build_report + serialize to client
```

Two hard boundaries (unchanged guarantees):

- **Prompt-grounding copy is never mutated.** We humanize a projection onto the
  serialized result only.
- **Structured citations stay exact.** `evidence_for` / `evidence_against` /
  `evidence_refs` (`source/table/rowid/record_id`) are machine anchors, stripped before
  display — untouched.

## Component A — extend the deterministic scrubber (Lever B)

Module: `src/agents/prose_redaction.ts`. Adds leak classes as pure token/pattern
substitution; controlled-vocabulary allowlist retained. **Default-on.**

| New class | Example | Handling |
| --- | --- | --- |
| Source-tag citations | `TAX:68344`, `LOAN:74141-74144`, `BASE:81239` | Strip the inline `(SOURCE:id)` citation token (anchor lives in structured fields). Pattern: `\b(TAX\|LOAN\|BASE\|TRACE\|UTILITY\|VOTER\|DRIVE\|AUTO\|CRIMINAL):\d[\d-]*\b`, case-insensitive. |
| Row / record ids | `rowid 1296784`, `cd113530` | Drop `rowid\s+\d+`; drop trace-code shape `\bcd\d{4,}\b`. |
| Bare `word=value` | `residential=True`, `condo=False` | Collapse `word=value` → the plain word, dropping `=value`, even when the left side is a bare dictionary word (current `ASSIGN_RE` only fires on identifier-shaped left sides). |
| Obscure jargon | `situs`, `situs address` | Map → "the subject property" / "the subject address". **Keep `LTV` / `CLTV`.** |

Retained: the `CONTROLLED_VOCABULARY` allowlist (verdict bands, archetypes, engine field
names, packet/heuristic ids) is never mangled or counted as a leak; the existing
false-positive guards (owner names like "McDonald", `Object.prototype` members like
"constructor") stay.

## Component B — evidence_map display humanizer (NEW module)

The deterministic strings are semi-structured and carry values a generic scrubber has
already lost. A small **value-aware** translator rebuilds them as clean sentences on the
display copy. Reuses the existing source→phrase glossary (`SOURCE_HUMAN_PHRASES`) and an
enum→phrase map so wording matches Lever A. **Default-on.**

| Raw (grounding copy — untouched) | Humanized (display copy) |
| --- | --- |
| `unrelated person at address via base: DONALD R CAIN` | "Unrelated person at the address in identity/residence records: Donald R Cain" |
| `likely_family person at address via trace: JEREHMY WINKFIELD` | "Likely a family member, in address-history records: Jerehmy Winkfield" |
| `loan; own_rent=U; address=…; dob_year=1975` | "Mortgage/loan record; tenure not stated" |
| `own_rent=0` / `own_rent=1` | "listed as a renter" / "listed as owner-occupant" |
| `owner=…; residential=True; condo=False; lendername=NOT AVAILABLE; totalliencount=1; totallienbalance=83000.0; ownerrescount=1` | "Owner …; residential property; 1 lien totaling $83,000; owner linked to 1 property" |

Enum→phrase map (applied wherever these values appear in human-facing strings):
`likely_family` → "likely a family member"; `unrelated` → "unrelated"; `not_applicable`
→ dropped/"not applicable". (The frontend already label-maps the *structured* enum
fields — `verdict_band`, `case_archetype`, `relationship_to_owner` — via `labels.ts`;
this map covers the same values when embedded in free text.)

Rationale for a separate module (not more scrubber patterns): B needs the original
structured values to say "1 lien totaling $83,000", which the string-in/string-out
scrubber no longer has when it runs.

## Metrics

`prose_leak_count` (in `_agent_metrics`) remains the primary in-repo gate, extended:

- **Detector coverage** — teach `detect_leaks` the new patterns (source-tag citations,
  `rowid`/`cd` ids, bare `word=value`, `situs`), so it counts what we now fix. (Today it
  under-reports the baseline.)
- **Field coverage** — run the detector over the *superset* of human-facing fields,
  including the evidence-map **display** strings, not just model prose. Target on the
  display projection: **0**.

Register lever (A) is still validated by the external offline `judge/` package for
dimension coverage + band/archetype match, per the 2026-07-15 protocol — unchanged.

## Testing (pure-function; no live model required)

- Component A: one unit test per new class + retained false-positive guards
  (owner names, `constructor`, `LTV`/`CLTV` preserved).
- Component B: table-driven raw→humanized cases, including value-aware ones
  (`own_rent=0/1/U`, lien math, `likely_family`/`unrelated`/`not_applicable`, `via
  base/trace/loan`).
- **Grounding-integrity test:** the evidence_map fed to prompts is byte-identical
  before/after finalization — the proof that only the display copy was humanized.
- Detector test: `prose_leak_count` over the demo's human-facing fields → 0 after the
  pass; > 0 before.

## Rollout

| Piece | Flag | Default |
| --- | --- | --- |
| Component A — extended scrubber | `OE_PROSE_REDACT` (existing) | **ON** |
| Component B — display humanizer | (folded into the same finalization path) | **ON** |
| Lever A — prompt register | `OE_PROSE_REGISTER` (existing) | **gated** (awaits offline coverage A/B) |

Net: the reported example leaks (`likely_family`, `own_rent`, `BASE:81239`,
`residential=True`, `situs`) disappear from the served JSON **by default**, with no risk
to analytical quality, while the probabilistic prompt improvement stays behind its flag
until proven coverage-neutral.

## Files touched (anticipated)

- `src/agents/prose_redaction.ts` — new pattern classes in `detect_leaks` / `redact_prose`;
  jargon map; bare `word=value` collapse.
- `src/agents/prose_display.ts` (new) — value-aware evidence_map display humanizer.
- `src/agents/orchestrator.ts` — finalization: build the display projection of
  `resolved_address.evidence_map` (Component B) alongside the existing prose scrub
  (Component A); extend `prose_leak_count` field set. Grounding copy untouched.
- `test/prose_redaction.test.ts` — new classes + false-positive guards.
- `test/prose_display.test.ts` (new) — raw→humanized table + grounding-integrity assertion.

## Out of scope (verified not human-visible)

- **The assembled `result.report` string.** The frontend does not render it: the
  presenter (`true-occupancy-app/.../presenter.ts`) rebuilds the view from the structured
  fields, and `ReportBody.tsx` reads those. Its raw enum header
  (`Case archetype: ambiguous_nonowner_occupancy`) is therefore not shown to a human, and
  its prose inputs (`reasoning_summary`, `finding`s) are already cleaned by Component A.
  This matches the 2026-07-15 spec's deferred build_report decision — left to the UI.
- **Structured enum fields** (`verdict_band`, `case_archetype`, `relationship_to_owner`)
  — already label-mapped in the frontend (`labels.ts`); no engine change needed.
- **Contract enum values ECHOED into free-form MODEL prose** (e.g. a `finding` that writes
  `likely_family` or `ambiguous_nonowner_occupancy` because the model was grounded on those
  tokens). These are deliberately NOT rewritten by the deterministic layer: they are engine
  *contract vocabulary* (allowlisted in `CONTROLLED_VOCABULARY`), and the scrubber must
  preserve them verbatim so the `report` string's build_report-embedded enums keep
  `prose_leak_count == 0`. Component B humanizes these values where they appear in the
  **deterministic** evidence_map strings, and the frontend label-maps the **structured**
  enum fields — so the user-visible occurrences are covered. A raw enum echoed into model
  free-prose is owned by the gated **prompt-register lever** (`OE_PROSE_REGISTER`), which
  instructs the model not to emit raw tokens; that lever stays gated pending the coverage
  A/B, consistent with the rollout decision. Revisit only if the register A/B is abandoned.

## Non-goals / risks

- No change to scores, gating, verdict bands, archetypes, or evidence citations.
- No change to the prompt-grounding evidence_map (asserted by the integrity test).
- Trace-code redaction (`cd\d{4,}`) is a targeted shape; if real prose collisions appear,
  narrow the pattern — false positives here only over-redact a display string, never
  affect analysis.
- Lever A remains probabilistic and gated; Components A/B are the deterministic guarantee.

## Open knobs (defaults chosen; revisit during implementation)

- (a) Exact humanized phrasing for evidence_map strings (glossary reuse keeps it aligned).
- (b) Whether to drop vs. translate low-value columns (`address`, `dob_year`, `condo=False`)
  in Component B — default: drop redundant/PII-ish, translate risk-bearing ones.
- (c) `situs` replacement wording ("the subject property" vs. "the property address").
