// Source-reliability-weighted synthesis layered on top of the atomic synthesis.

import { asdict } from "./atomic.ts";
import type { AddressEvidence } from "./atomic_eval.ts";
import {
  RANKED_SOURCE_ORDER,
  SOURCE_RELIABILITY_WEIGHTS,
  UNRANKED_CONTEXT_SOURCES,
  _SOURCE_ALIASES,
  _SOURCE_TOKEN_BY_PATH,
  source_reliability_policy as _source_reliability_policy,
} from "./policy.ts";
import type {
  CaseArchetypeCandidate,
  SourceWeightAdjustment,
  VerdictBandCandidate,
} from "./types.ts";

export function weighted_synthesis(args: {
  atomic_synthesis: Record<string, unknown>;
  atomic_heuristics: readonly Record<string, unknown>[];
  evidence: AddressEvidence;
}): Record<string, unknown> {
  const { atomic_synthesis, atomic_heuristics, evidence } = args;
  const active_paths = new Set<string>();
  for (const path of _path_results(atomic_heuristics)) {
    const status = path["status"];
    const pathId = path["path_id"];
    if (
      (status === "triggered" ||
        status === "context" ||
        status === "mitigation" ||
        status === "quality") &&
      Boolean(pathId)
    ) {
      active_paths.add(String(pathId));
    }
  }
  const adjustments = _path_results(atomic_heuristics)
    .filter((path) => _base_path_score(path) > 0)
    .map((path) => _source_weight_adjustment(path));
  const weighted_score = round2(
    adjustments.reduce((total, item) => total + item.weighted_score, 0),
  );
  const source_scores: Record<string, number> = {};
  for (const item of adjustments) {
    if (item.applied_source) {
      source_scores[item.applied_source] =
        (source_scores[item.applied_source] ?? 0) + item.weighted_score;
    }
  }
  const dominant_sources = Object.entries(source_scores)
    .sort(([aSource, aScore], [bSource, bScore]) => {
      if (aScore !== bScore) {
        return bScore - aScore;
      }
      const rankDiff = _source_rank(aSource) - _source_rank(bSource);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return aSource < bSource ? -1 : aSource > bSource ? 1 : 0;
    })
    .map(([source]) => source);
  const discountFilter = new Set([...UNRANKED_CONTEXT_SOURCES, "voter", "utility"]);
  const discountedSet = new Set<string>();
  for (const item of adjustments) {
    for (const source of _path_sources_by_ref_or_name(item.path_id, [])) {
      if (discountFilter.has(source)) {
        discountedSet.add(String(source));
      }
    }
  }
  const discounted_sources = [...discountedSet].sort();
  const archetype = _weighted_archetype(active_paths, evidence);
  const band = _weighted_band({
    weighted_score,
    archetype,
    active_paths,
    adjustments,
  });
  const existingSurface = asRecord(atomic_synthesis["evidence_surface_summary"]) ?? {};
  return {
    ...atomic_synthesis,
    raw_signal_score: weighted_score,
    verdict_band_candidate: band,
    case_archetype_candidate: archetype,
    atomic_raw_signal_score: atomic_synthesis["raw_signal_score"] ?? 0,
    atomic_verdict_band_candidate: atomic_synthesis["verdict_band_candidate"],
    atomic_case_archetype_candidate: atomic_synthesis["case_archetype_candidate"],
    weighted_signal_score: weighted_score,
    source_reliability_policy: _source_reliability_policy(),
    source_weight_adjustments: adjustments.map((item) => asdict(item)),
    dominant_sources,
    discounted_sources,
    why_not_higher: _weighted_why_not_higher({
      band,
      archetype,
      active_paths,
      adjustments,
      atomic_synthesis,
    }),
    why_not_lower: adjustments
      .slice(0, 5)
      .filter((item) => item.weighted_score > 0)
      .map(
        (item) =>
          `Weighted deterministic path: ${item.path_id} via ${
            item.applied_source || "unranked"
          }`,
      ),
    evidence_surface_summary: {
      ...existingSurface,
      source_reliability_policy: _source_reliability_policy(),
      dominant_sources,
      discounted_sources,
    },
    atomic_synthesis,
  };
}

function _path_results(
  atomic_heuristics: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const heuristic of atomic_heuristics) {
    for (const path of asArray(heuristic["path_results"]) ?? []) {
      if (isPlainRecord(path)) {
        out.push(path);
      }
    }
  }
  return out;
}

function _source_weight_adjustment(
  path: Record<string, unknown>,
): SourceWeightAdjustment {
  const base_score = _base_path_score(path);
  const sources = _path_sources(path);
  const ranked_sources = sources.filter(
    (source) => source in SOURCE_RELIABILITY_WEIGHTS,
  );
  if (ranked_sources.length === 0) {
    return {
      path_id: String(path["path_id"] ?? ""),
      base_score,
      weighted_score: 0.0,
      applied_source: null,
      reliability_weight: 0.0,
      reason: "No ranked reliability source supports this risk path.",
    };
  }
  const applied = [...ranked_sources].sort((a, b) => {
    const rankDiff = _source_rank(a) - _source_rank(b);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  })[0]!;
  const weight = SOURCE_RELIABILITY_WEIGHTS[applied]!;
  return {
    path_id: String(path["path_id"] ?? ""),
    base_score,
    weighted_score: round2(base_score * weight),
    applied_source: applied,
    reliability_weight: weight,
    reason: `Applied ${applied} reliability weight ${weight}.`,
  };
}

function _base_path_score(path: Record<string, unknown>): number {
  if (path["status"] !== "triggered" || path["role"] !== "risk") {
    return 0;
  }
  const weights: Record<string, number> = {
    none: 0,
    weak: 1,
    moderate: 2,
    strong: 3,
  };
  return weights[String(path["signal_strength"] || "none")] ?? 0;
}

function _path_sources(path: Record<string, unknown>): readonly string[] {
  return _path_sources_by_ref_or_name(
    String(path["path_id"] ?? ""),
    asArray(path["evidence_refs"]) ?? [],
  );
}

function _path_sources_by_ref_or_name(
  path_id: string,
  evidence_refs: readonly unknown[],
): readonly string[] {
  const sources = new Set<string>();
  for (const ref of evidence_refs) {
    let source: string | null;
    if (isPlainRecord(ref)) {
      source = _normalize_source(ref["source"]);
    } else {
      source = _normalize_source(
        ref !== null && typeof ref === "object"
          ? (ref as Record<string, unknown>)["source"]
          : undefined,
      );
    }
    if (source) {
      sources.add(source);
    }
  }
  for (const [token, source] of _SOURCE_TOKEN_BY_PATH) {
    if (path_id.includes(token)) {
      sources.add(source);
    }
  }
  return [...sources].sort();
}

function _normalize_source(value: unknown): string | null {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return null;
  }
  return _SOURCE_ALIASES[raw] ?? raw;
}

function _source_rank(source: string): number {
  const index = RANKED_SOURCE_ORDER.indexOf(source);
  return index === -1 ? RANKED_SOURCE_ORDER.length + 1 : index;
}

function _weighted_archetype(
  active_paths: ReadonlySet<string>,
  evidence: AddressEvidence,
): CaseArchetypeCandidate {
  if (!((evidence.source_counts["tax"] ?? 0) > 0)) {
    return "insufficient_ownership_data";
  }
  if (_has_family_rental_context(active_paths)) {
    return "family_household_rental";
  }
  if (
    _has_clear_absentee_context(active_paths) &&
    !_owner_present_dominates(active_paths)
  ) {
    return "clear_absentee_rental";
  }
  if (_has_owner_present_rental_context(active_paths)) {
    return "owner_present_with_rental_indicators";
  }
  if (_has_non_rental_absentee_context(active_paths)) {
    return "non_rental_absentee_owner";
  }
  if (_has_nonowner_occupancy(active_paths)) {
    return "ambiguous_nonowner_occupancy";
  }
  if (_has_owner_present_context(active_paths)) {
    return "low_evidence_owner_occupied";
  }
  return "mixed_evidence";
}

function _weighted_band(args: {
  weighted_score: number;
  archetype: CaseArchetypeCandidate;
  active_paths: ReadonlySet<string>;
  adjustments: readonly SourceWeightAdjustment[];
}): VerdictBandCandidate {
  const { weighted_score, archetype, active_paths, adjustments } = args;
  if (
    active_paths.has("unit_collapsed_address_ambiguity") ||
    active_paths.has("malformed_address_equivalence")
  ) {
    return "manual_verification";
  }
  if (_lower_tier_nonowner_only(adjustments)) {
    return weighted_score >= 2 ? "monitor" : "low_evidence";
  }
  if (weighted_score >= 8 && archetype === "clear_absentee_rental") {
    return "high_priority_review";
  }
  if (weighted_score >= 5) {
    return "review";
  }
  if (weighted_score >= 2) {
    return "monitor";
  }
  return "low_evidence";
}

function _has_clear_absentee_context(active_paths: ReadonlySet<string>): boolean {
  const direct_drive_pair =
    active_paths.has("owner_drive_elsewhere") &&
    active_paths.has("nonowner_drive_at_subject");
  const legal_pair =
    active_paths.has("owner_voter_elsewhere") &&
    active_paths.has("nonowner_voter_at_subject");
  const absentee_owner_context = _intersects(
    [
      "owner_drive_elsewhere",
      "owner_voter_elsewhere",
      "owner_auto_elsewhere",
      "tax_owner_mailing_differs_from_situs",
    ],
    active_paths,
  );
  const ranked_nonowner_context = _intersects(
    [
      "nonowner_drive_at_subject",
      "nonowner_loan_renter_at_subject",
      "unrelated_nonowner_legal_presence",
    ],
    active_paths,
  );
  return (
    direct_drive_pair ||
    legal_pair ||
    (absentee_owner_context && ranked_nonowner_context)
  );
}

function _has_absentee_owner_context(active_paths: ReadonlySet<string>): boolean {
  return _intersects(
    [
      "owner_drive_elsewhere",
      "owner_voter_elsewhere",
      "owner_auto_elsewhere",
      "owner_loan_elsewhere",
      "owner_trace_elsewhere",
      "tax_owner_mailing_differs_from_situs",
      "tax_mailing_subject_but_owner_legal_elsewhere",
      "owner_primary_comparison_elsewhere",
    ],
    active_paths,
  );
}

function _has_strong_rental_use_context(active_paths: ReadonlySet<string>): boolean {
  return _intersects(
    [
      "nonowner_drive_at_subject",
      "nonowner_voter_at_subject",
      "nonowner_auto_at_subject",
      "nonowner_loan_renter_at_subject",
      "unrelated_nonowner_legal_presence",
      "repeated_nonowner_cross_source_corroboration",
    ],
    active_paths,
  );
}

function _has_non_rental_absentee_context(active_paths: ReadonlySet<string>): boolean {
  return (
    _has_absentee_owner_context(active_paths) &&
    !_has_owner_present_context(active_paths) &&
    !_has_strong_rental_use_context(active_paths)
  );
}

function _has_family_rental_context(active_paths: ReadonlySet<string>): boolean {
  return (
    active_paths.has("same_surname_family_household_context") &&
    _intersects(
      ["nonowner_loan_renter_at_subject", "nonowner_drive_at_subject"],
      active_paths,
    )
  );
}

function _has_owner_present_rental_context(active_paths: ReadonlySet<string>): boolean {
  return _intersects(
    [
      "owner_present_plus_nonowner_renter_context",
      "owner_utility_plus_nonowner_utility_context",
    ],
    active_paths,
  );
}

function _has_nonowner_occupancy(active_paths: ReadonlySet<string>): boolean {
  return _intersects(
    [
      "nonowner_drive_at_subject",
      "nonowner_voter_at_subject",
      "nonowner_auto_at_subject",
      "nonowner_loan_renter_at_subject",
      "nonowner_utility_at_subject",
      "nonowner_trace_at_subject",
    ],
    active_paths,
  );
}

function _has_owner_present_context(active_paths: ReadonlySet<string>): boolean {
  return _intersects(
    [
      "owner_drive_at_subject",
      "owner_voter_at_subject",
      "owner_auto_at_subject",
      "owner_loan_own_at_subject",
      "owner_utility_at_subject",
      "owner_trace_at_subject",
      "tax_owner_mailing_matches_situs",
      "owner_base_primary_at_subject",
    ],
    active_paths,
  );
}

function _owner_present_dominates(active_paths: ReadonlySet<string>): boolean {
  if (!_has_owner_present_context(active_paths)) {
    return false;
  }
  return !_intersects(
    [
      "owner_drive_elsewhere",
      "nonowner_drive_at_subject",
      "nonowner_loan_renter_at_subject",
      "unrelated_nonowner_legal_presence",
    ],
    active_paths,
  );
}

function _lower_tier_nonowner_only(
  adjustments: readonly SourceWeightAdjustment[],
): boolean {
  const positive = adjustments.filter((item) => item.weighted_score > 0);
  if (positive.length === 0) {
    return false;
  }
  const sources = new Set<string>();
  for (const item of positive) {
    if (item.applied_source) {
      sources.add(item.applied_source);
    }
  }
  if (sources.size === 0) {
    return false;
  }
  return [...sources].every((source) => source === "voter" || source === "utility");
}

function _weighted_why_not_higher(args: {
  band: VerdictBandCandidate;
  archetype: CaseArchetypeCandidate;
  active_paths: ReadonlySet<string>;
  adjustments: readonly SourceWeightAdjustment[];
  atomic_synthesis: Record<string, unknown>;
}): readonly string[] {
  const { band, archetype, active_paths, adjustments, atomic_synthesis } = args;
  let reasons: string[] = [];
  if (band !== "high_priority_review") {
    if (archetype !== "clear_absentee_rental") {
      reasons.push("Weighted source policy did not support clear absentee rental.");
    }
    if (!_has_clear_absentee_context(active_paths)) {
      reasons.push("No ranked owner-elsewhere plus ranked non-owner/renter combination.");
    }
    if (_lower_tier_nonowner_only(adjustments)) {
      reasons.push("Non-owner evidence is limited to lower-tier voter/utility sources.");
    }
  }
  if (reasons.length === 0) {
    reasons = (asArray(atomic_synthesis["why_not_higher"]) ?? []).map((v) => String(v));
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Helpers

function _intersects(candidates: readonly string[], set: ReadonlySet<string>): boolean {
  return candidates.some((item) => set.has(item));
}

// Round to 2 decimals via scaling. Every product/sum here is already a
// 2-decimal-exact value, so no half-way tie-breaking ambiguity arises.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
