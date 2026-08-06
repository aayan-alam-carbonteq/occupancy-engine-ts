// The atomic evaluation logic: per-heuristic gate decisions, deterministic
// reasoning-path executors, and case-level synthesis. Behavioral-critical.
// Modeled as readonly interfaces + make* builders (default field values are
// applied inside the builders).

import { Database } from "bun:sqlite";

import {
  ATOMIC_HEURISTICS as _ATOMIC_DEFINITIONS,
  DEFAULT_OUTPUT_FIELDS,
  asdict,
} from "./atomic.ts";
import type {
  AtomicHeuristicDefinition,
  Confidence,
  ReasoningPath,
  SignalRole,
  SourceFieldRef,
  VerdictContribution,
} from "./atomic.ts";
import { normalize_address_value } from "./normalize.ts";
import type { CaseArchetypeCandidate, VerdictBandCandidate } from "./types.ts";

export type GateDecision = "run" | "skip" | "run_for_absence";
export type PathStatus =
  | "triggered"
  | "not_triggered"
  | "inconclusive"
  | "context"
  | "mitigation"
  | "quality"
  | "skipped";
export type SignalStrength = "none" | "weak" | "moderate" | "strong";
export type RecommendedWeight = "ignore" | "low" | "medium" | "high";

// VerdictBandCandidate / CaseArchetypeCandidate could be narrower here (the
// archetype set produced in this module excludes "non_rental_absentee_owner"),
// but we reuse the wider types.ts aliases — every value produced here is a
// member of them, so behavior is unchanged.

// ---------------------------------------------------------------------------
// Readonly interfaces + builders

export interface HeuristicGate {
  readonly required_sources: readonly string[];
  readonly optional_sources: readonly string[];
  readonly absence_sensitive_sources: readonly string[];
  readonly owner_identity_required: boolean;
  readonly minimum_viability: string;
  readonly skip_reason: string;
  readonly run_for_absence_reason: string;
}

export function makeHeuristicGate(init: {
  required_sources?: readonly string[];
  optional_sources?: readonly string[];
  absence_sensitive_sources?: readonly string[];
  owner_identity_required?: boolean;
  minimum_viability?: string;
  skip_reason?: string;
  run_for_absence_reason?: string;
}): HeuristicGate {
  return {
    required_sources: init.required_sources ?? [],
    optional_sources: init.optional_sources ?? [],
    absence_sensitive_sources: init.absence_sensitive_sources ?? [],
    owner_identity_required: init.owner_identity_required ?? false,
    minimum_viability: init.minimum_viability ?? "",
    skip_reason:
      init.skip_reason ?? "No populated evidence surface for this heuristic family.",
    run_for_absence_reason:
      init.run_for_absence_reason ??
      "Absence is itself relevant for this heuristic family.",
  };
}

export interface GateEvaluation {
  readonly heuristic_id: string;
  readonly decision: GateDecision;
  readonly reason: string;
  readonly expected_sources: readonly string[];
  readonly missing_sources: readonly string[];
  readonly present_sources: readonly string[];
  readonly triggered_gate_paths: readonly string[];
}

export function makeGateEvaluation(init: {
  heuristic_id: string;
  decision: GateDecision;
  reason: string;
  expected_sources?: readonly string[];
  missing_sources?: readonly string[];
  present_sources?: readonly string[];
  triggered_gate_paths?: readonly string[];
}): GateEvaluation {
  return {
    heuristic_id: init.heuristic_id,
    decision: init.decision,
    reason: init.reason,
    expected_sources: init.expected_sources ?? [],
    missing_sources: init.missing_sources ?? [],
    present_sources: init.present_sources ?? [],
    triggered_gate_paths: init.triggered_gate_paths ?? [],
  };
}

export interface EvidenceRef {
  readonly source: string;
  readonly rowid: number | null;
  readonly summary: string;
  readonly data: Record<string, unknown> | null;
}

export function makeEvidenceRef(init: {
  source: string;
  rowid?: number | null;
  summary?: string;
  data?: Record<string, unknown> | null;
}): EvidenceRef {
  return {
    source: init.source,
    rowid: init.rowid ?? null,
    summary: init.summary ?? "",
    data: init.data ?? null,
  };
}

export interface PathEvaluation {
  readonly path_id: string;
  readonly status: PathStatus;
  readonly role: SignalRole;
  readonly confidence: Confidence;
  readonly signal_strength: SignalStrength;
  readonly recommended_weight: RecommendedWeight;
  readonly reason: string;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly caveats: readonly string[];
  readonly verdict_contributions: readonly VerdictContribution[];
}

export function makePathEvaluation(init: {
  path_id: string;
  status: PathStatus;
  role: SignalRole;
  confidence: Confidence;
  signal_strength: SignalStrength;
  recommended_weight: RecommendedWeight;
  reason: string;
  evidence_refs?: readonly EvidenceRef[];
  caveats?: readonly string[];
  verdict_contributions?: readonly VerdictContribution[];
}): PathEvaluation {
  return {
    path_id: init.path_id,
    status: init.status,
    role: init.role,
    confidence: init.confidence,
    signal_strength: init.signal_strength,
    recommended_weight: init.recommended_weight,
    reason: init.reason,
    evidence_refs: init.evidence_refs ?? [],
    caveats: init.caveats ?? [],
    verdict_contributions: init.verdict_contributions ?? [],
  };
}

export interface HeuristicEvaluation {
  readonly heuristic_id: string;
  readonly gate: GateEvaluation;
  readonly status: PathStatus;
  readonly path_results: readonly PathEvaluation[];
  readonly triggered_paths: readonly string[];
  readonly reason: string;
  readonly evidence_refs: readonly EvidenceRef[];
  readonly caveats: readonly string[];
}

export function makeHeuristicEvaluation(init: {
  heuristic_id: string;
  gate: GateEvaluation;
  status: PathStatus;
  path_results: readonly PathEvaluation[];
  triggered_paths: readonly string[];
  reason: string;
  evidence_refs?: readonly EvidenceRef[];
  caveats?: readonly string[];
}): HeuristicEvaluation {
  return {
    heuristic_id: init.heuristic_id,
    gate: init.gate,
    status: init.status,
    path_results: init.path_results,
    triggered_paths: init.triggered_paths,
    reason: init.reason,
    evidence_refs: init.evidence_refs ?? [],
    caveats: init.caveats ?? [],
  };
}

export interface CaseSynthesis {
  readonly raw_signal_score: number;
  readonly verdict_band_candidate: VerdictBandCandidate;
  readonly case_archetype_candidate: CaseArchetypeCandidate;
  readonly why_not_higher: readonly string[];
  readonly why_not_lower: readonly string[];
  readonly evidence_surface_summary: Record<string, unknown>;
}

export interface AtomicEvaluationReport {
  readonly query: Record<string, unknown>;
  readonly gate_evaluations: readonly GateEvaluation[];
  readonly heuristics: readonly HeuristicEvaluation[];
  readonly triggered_paths: readonly string[];
  readonly synthesis: CaseSynthesis;
  readonly caveats: readonly string[];
}

// AddressEvidence is distinguished from a plain evidence object at runtime via a
// Symbol brand, which does this without leaking into asdict/JSON output (Object.keys
// skips symbol keys).
const ADDRESS_EVIDENCE_BRAND = Symbol("AddressEvidence");

export interface AddressEvidence {
  readonly address: string;
  readonly normalized_address: string;
  readonly zip: string;
  readonly rows: Record<string, readonly Record<string, unknown>[]>;
  readonly owner_ids: readonly string[];
  readonly owner_name_keys: readonly (readonly [string, string])[];
  readonly source_counts: Record<string, number>;
  readonly owner_summaries: readonly Record<string, unknown>[];
  readonly people_at_address: readonly Record<string, unknown>[];
  readonly owner_presence_hints: readonly string[];
  readonly owner_elsewhere_hints: readonly string[];
  readonly nonowner_occupancy_hints: readonly string[];
  readonly freshness_hints: readonly string[];
  readonly data_gaps: readonly string[];
  readonly property_types: readonly string[];
  readonly evidence_refs: readonly EvidenceRef[];
}

export function makeAddressEvidence(init: {
  address: string;
  normalized_address: string;
  zip: string;
  rows: Record<string, readonly Record<string, unknown>[]>;
  owner_ids: readonly string[];
  owner_name_keys: readonly (readonly [string, string])[];
  source_counts: Record<string, number>;
  owner_summaries: readonly Record<string, unknown>[];
  people_at_address?: readonly Record<string, unknown>[];
  owner_presence_hints?: readonly string[];
  owner_elsewhere_hints?: readonly string[];
  nonowner_occupancy_hints?: readonly string[];
  freshness_hints?: readonly string[];
  data_gaps?: readonly string[];
  property_types?: readonly string[];
  evidence_refs?: readonly EvidenceRef[];
}): AddressEvidence {
  const evidence: AddressEvidence = {
    address: init.address,
    normalized_address: init.normalized_address,
    zip: init.zip,
    rows: init.rows,
    owner_ids: init.owner_ids,
    owner_name_keys: init.owner_name_keys,
    source_counts: init.source_counts,
    owner_summaries: init.owner_summaries,
    people_at_address: init.people_at_address ?? [],
    owner_presence_hints: init.owner_presence_hints ?? [],
    owner_elsewhere_hints: init.owner_elsewhere_hints ?? [],
    nonowner_occupancy_hints: init.nonowner_occupancy_hints ?? [],
    freshness_hints: init.freshness_hints ?? [],
    data_gaps: init.data_gaps ?? [],
    property_types: init.property_types ?? [],
    evidence_refs: init.evidence_refs ?? [],
  };
  Object.defineProperty(evidence, ADDRESS_EVIDENCE_BRAND, {
    value: true,
    enumerable: false,
  });
  return evidence;
}

export function isAddressEvidence(value: unknown): value is AddressEvidence {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<symbol, unknown>)[ADDRESS_EVIDENCE_BRAND] === true
  );
}

const ATOMIC_HEURISTIC_BRAND = Symbol("AtomicHeuristic");

export interface AtomicHeuristic {
  readonly id: string;
  readonly title: string;
  readonly role: SignalRole;
  readonly description: string;
  readonly input_fields: readonly SourceFieldRef[];
  readonly reasoning: string;
  readonly positive_indicators: readonly string[];
  readonly negative_indicators: readonly string[];
  readonly caveats: readonly string[];
  readonly verdict_contributions: readonly VerdictContribution[];
  readonly confidence: Confidence;
  readonly output_fields: readonly string[];
  readonly group: string;
  readonly reasoning_paths: readonly ReasoningPath[];
  readonly gate: HeuristicGate;
}

function makeAtomicHeuristic(init: AtomicHeuristic): AtomicHeuristic {
  const heuristic: AtomicHeuristic = { ...init };
  Object.defineProperty(heuristic, ATOMIC_HEURISTIC_BRAND, {
    value: true,
    enumerable: false,
  });
  return heuristic;
}

function isAtomicHeuristic(value: unknown): value is AtomicHeuristic {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<symbol, unknown>)[ATOMIC_HEURISTIC_BRAND] === true
  );
}

// ---------------------------------------------------------------------------
// Source families (declared locally here, not via policy).

const SUBSTANTIVE_SOURCES: readonly string[] = [
  "tax",
  "base",
  "loan",
  "drive",
  "voter",
  "auto",
  "trace",
  "utility",
];
const STRONG_OCCUPANCY_SOURCES: readonly string[] = [
  "drive",
  "voter",
  "auto",
  "loan",
  "trace",
  "utility",
];
const STRONGER_THAN_UTILITY: readonly string[] = [
  "drive",
  "voter",
  "auto",
  "loan",
  "trace",
];
const STRONGER_THAN_TRACE: readonly string[] = [
  "drive",
  "voter",
  "auto",
  "loan",
  "utility",
];

// ---------------------------------------------------------------------------
// Gate table

function _gate(init: {
  required_sources?: readonly string[];
  optional_sources?: readonly string[];
  absence_sensitive_sources?: readonly string[];
  owner_identity_required?: boolean;
  minimum_viability: string;
  skip_reason?: string;
  run_for_absence_reason?: string;
}): HeuristicGate {
  return makeHeuristicGate(init);
}

const GATES: Record<string, HeuristicGate> = {
  residential_tax_subject: _gate({
    required_sources: ["tax"],
    minimum_viability: "Run when tax rows exist at the selected address.",
  }),
  liened_residential_subject: _gate({
    required_sources: ["tax"],
    minimum_viability:
      "Run when tax rows exist; lien fields are inspected inside the heuristic.",
  }),
  base_mortgage_or_refi_at_subject: _gate({
    required_sources: ["base"],
    minimum_viability: "Run when base rows exist at the selected address.",
  }),
  foreclosure_or_distress_marker: _gate({
    required_sources: ["tax"],
    minimum_viability:
      "Run when tax rows exist; distress fields are inspected inside the heuristic.",
  }),
  company_or_trust_owner: _gate({
    required_sources: ["tax"],
    minimum_viability: "Run when tax ownership rows exist.",
  }),
  evidence_quality_and_synthesis: _gate({
    optional_sources: SUBSTANTIVE_SOURCES,
    absence_sensitive_sources: ["tax"],
    minimum_viability:
      "Always run when any substantive source exists; run for absence when no substantive evidence or tax is missing.",
    run_for_absence_reason:
      "Sparse evidence or missing tax ownership is itself relevant to quality and final synthesis.",
  }),
  owner_identity_and_cross_source_context: _gate({
    required_sources: ["tax"],
    optional_sources: STRONG_OCCUPANCY_SOURCES,
    absence_sensitive_sources: ["tax"],
    owner_identity_required: true,
    minimum_viability:
      "Run when tax owner identity exists and another source or owner/non-owner hint can be compared.",
    run_for_absence_reason:
      "Missing tax ownership blocks owner/non-owner classification.",
  }),
  tax_mailing_situs_analysis: _gate({
    required_sources: ["tax"],
    minimum_viability:
      "Run when tax rows include situs and owner mailing fields to compare.",
  }),
  base_subject_owner_alignment: _gate({
    required_sources: ["tax", "base"],
    owner_identity_required: true,
    minimum_viability: "Run when both tax ownership and base person rows exist.",
  }),
  loan_tenure_subject_analysis: _gate({
    required_sources: ["loan"],
    optional_sources: ["tax"],
    minimum_viability:
      "Run when loan rows exist. Missing tax adds a quality caveat but does not suppress loan-tenure analysis.",
  }),
  owner_loan_elsewhere: _gate({
    required_sources: ["loan", "tax"],
    owner_identity_required: true,
    minimum_viability: "Run when loan rows and tax owner identity both exist.",
  }),
  drive_address_subject_analysis: _gate({
    required_sources: ["drive"],
    optional_sources: ["tax"],
    minimum_viability: "Run when driver license rows exist.",
  }),
  voter_address_subject_analysis: _gate({
    required_sources: ["voter"],
    optional_sources: ["tax"],
    minimum_viability: "Run when voter rows exist.",
  }),
  auto_address_subject_analysis: _gate({
    required_sources: ["auto"],
    optional_sources: ["tax"],
    minimum_viability: "Run when auto registration rows exist.",
  }),
  owner_legal_records_conflict: _gate({
    required_sources: ["drive", "voter", "auto"],
    optional_sources: ["tax"],
    minimum_viability: "Run when at least two of drive, voter, and auto have rows.",
  }),
  auto_only_owner_elsewhere_discount: _gate({
    required_sources: ["auto"],
    optional_sources: ["drive", "voter", "tax"],
    minimum_viability:
      "Run when auto rows exist and both drive and voter rows are absent.",
  }),
  trace_address_subject_analysis: _gate({
    required_sources: ["trace"],
    optional_sources: ["tax"],
    minimum_viability: "Run when trace rows exist.",
  }),
  utility_subject_occupancy_analysis: _gate({
    required_sources: ["utility"],
    optional_sources: ["tax"],
    minimum_viability: "Run when utility rows exist.",
  }),
  utility_only_no_dates_discount: _gate({
    required_sources: ["utility"],
    optional_sources: STRONGER_THAN_UTILITY,
    minimum_viability: "Run when utility is the only populated occupancy surface.",
  }),
  trace_only_presence_discount: _gate({
    required_sources: ["trace"],
    optional_sources: STRONGER_THAN_TRACE,
    minimum_viability: "Run when trace is the only populated occupancy surface.",
  }),
  drive_voter_conflict_same_person: _gate({
    required_sources: ["drive", "voter"],
    minimum_viability: "Run only when both driver license and voter rows exist.",
  }),
  auto_at_subject_but_stronger_legal_elsewhere: _gate({
    required_sources: ["auto"],
    optional_sources: ["drive", "voter"],
    minimum_viability:
      "Run when auto rows exist and at least one of drive or voter also exists.",
  }),
  single_family_clean_address_context: _gate({
    required_sources: ["tax"],
    minimum_viability: "Run when tax property rows exist.",
  }),
  portfolio_primary_comparison_analysis: _gate({
    required_sources: ["tax"],
    optional_sources: ["base", "drive", "voter", "auto"],
    minimum_viability:
      "Run when tax rows suggest multi-property context or comparable owner-primary evidence.",
  }),
  tax_ownerrescount_portfolio_pattern: _gate({
    required_sources: ["tax"],
    minimum_viability:
      "Run when tax rows exist; ownerrescount is inspected inside the heuristic.",
  }),
};

function _with_gate(config: AtomicHeuristicDefinition): AtomicHeuristic {
  const gate = GATES[config.id];
  if (gate === undefined) {
    throw new Error(`Unknown heuristic gate: ${config.id}`);
  }
  return makeAtomicHeuristic({
    id: config.id,
    title: config.title,
    role: config.role,
    description: config.description,
    input_fields: config.input_fields,
    reasoning: config.reasoning,
    positive_indicators: config.positive_indicators,
    negative_indicators: config.negative_indicators,
    caveats: config.caveats,
    verdict_contributions: config.verdict_contributions,
    confidence: config.confidence,
    output_fields:
      config.output_fields.length > 0 ? config.output_fields : DEFAULT_OUTPUT_FIELDS,
    group: config.group,
    reasoning_paths: config.reasoning_paths,
    gate,
  });
}

export const ATOMIC_HEURISTICS: readonly AtomicHeuristic[] = _ATOMIC_DEFINITIONS.map(
  (config) => _with_gate(config),
);

export function get_heuristic_catalog(): Array<Record<string, unknown>> {
  return ATOMIC_HEURISTICS.map((config) => asdict(config) as Record<string, unknown>);
}

export function get_heuristic_by_id(heuristic_id: string): AtomicHeuristic {
  for (const config of ATOMIC_HEURISTICS) {
    if (config.id === heuristic_id) {
      return config;
    }
  }
  throw new Error(`Unknown heuristic: ${heuristic_id}`);
}

export function heuristic_ids(): readonly string[] {
  return ATOMIC_HEURISTICS.map((config) => config.id);
}

export function reasoning_path_ids(): readonly string[] {
  const out: string[] = [];
  for (const config of ATOMIC_HEURISTICS) {
    for (const p of config.reasoning_paths) {
      out.push(p.id);
    }
  }
  return out;
}

export function runnable_heuristics(evidence_map: unknown): AtomicHeuristic[] {
  const evaluations: Record<string, GateEvaluation> = {};
  for (const item of evaluate_gates(evidence_map)) {
    evaluations[item.heuristic_id] = item;
  }
  return ATOMIC_HEURISTICS.filter((config) => {
    const evaluation = evaluations[config.id];
    return (
      evaluation !== undefined &&
      (evaluation.decision === "run" || evaluation.decision === "run_for_absence")
    );
  });
}

// ---------------------------------------------------------------------------
// Evidence construction (SQLite-backed).

const DEFAULT_DB_PATH = "data/indexes/occupancy_engine.sqlite";

interface EvidenceBuildOptions {
  zip?: string | null;
  db_path?: string;
  limit_per_source?: number;
}

export function build_evidence(
  address: string,
  opts: EvidenceBuildOptions = {},
): AddressEvidence {
  const db_path = opts.db_path ?? DEFAULT_DB_PATH;
  const limit_per_source = opts.limit_per_source ?? 100;
  const normalized_address = _normalize_address(address);
  const zip_code = (opts.zip || "").trim();
  const connection = new Database(db_path);
  let rows: Record<string, readonly Record<string, unknown>[]>;
  let owner_ids: readonly string[];
  let owner_name_keys: readonly (readonly [string, string])[];
  let owner_summaries: readonly Record<string, unknown>[];
  let source_counts: Record<string, number>;
  let data_gaps: readonly string[];
  let property_types: readonly string[];
  let owner_presence_hints: readonly string[];
  let owner_elsewhere_hints: readonly string[];
  let nonowner_hints: readonly string[];
  try {
    const subject_rows: Record<string, readonly Record<string, unknown>[]> = {};
    for (const source of SUBSTANTIVE_SOURCES) {
      subject_rows[source] = _address_rows(
        connection,
        source,
        normalized_address,
        zip_code,
        limit_per_source,
      );
    }
    const ownerIdSet = new Set<string>();
    for (const row of subject_rows["tax"] ?? []) {
      if (hasContent(row["id"])) {
        ownerIdSet.add(String(firstTruthy(row["id"], "")));
      }
    }
    owner_ids = [...ownerIdSet].sort();
    rows = { ...subject_rows };
    for (const source of ["base", "loan", "drive", "voter", "auto", "trace"]) {
      rows[source] = _dedupe_rows([
        ...(rows[source] ?? []),
        ..._id_rows(connection, source, owner_ids, limit_per_source),
      ]);
    }
    owner_name_keys = _owner_name_keys(rows["tax"] ?? []).sort(_compareStringTuple);
    owner_summaries = (rows["tax"] ?? [])
      .slice(0, 5)
      .map((row) => _owner_summary(row, normalized_address));
    source_counts = {};
    for (const [source, source_rows] of Object.entries(rows)) {
      source_counts[source] = source_rows.length;
    }
    data_gaps = Object.entries(source_counts)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .filter(([, count]) => count === 0)
      .map(([source]) => `No ${source} rows found at selected address.`);
    property_types = (rows["tax"] ?? [])
      .filter((row) => _truthy(row["condo"]))
      .map(() => "condo");
    owner_presence_hints = _owner_presence_hints(rows, owner_ids, owner_name_keys);
    owner_elsewhere_hints = _owner_elsewhere_hints(
      connection,
      normalized_address,
      owner_ids,
      rows["tax"] ?? [],
      limit_per_source,
    );
    nonowner_hints = _nonowner_hints(rows, owner_ids, owner_name_keys);
  } finally {
    connection.close();
  }
  return makeAddressEvidence({
    address,
    normalized_address,
    zip: zip_code,
    rows,
    owner_ids,
    owner_name_keys,
    source_counts,
    owner_summaries,
    owner_presence_hints,
    owner_elsewhere_hints,
    nonowner_occupancy_hints: nonowner_hints,
    data_gaps,
    property_types,
  });
}

export function evaluate_address_atomic(
  address: string,
  opts: EvidenceBuildOptions = {},
): Record<string, unknown> {
  const evidence = build_evidence(address, opts);
  return asdict(evaluate_atomic_evidence(evidence)) as Record<string, unknown>;
}

export function evaluate_atomic_evidence(
  evidence: AddressEvidence | Record<string, unknown>,
): AtomicEvaluationReport {
  const evidence_obj = _coerce_evidence(evidence);
  const gates = evaluate_gates(evidence_obj);
  const gate_by_id: Record<string, GateEvaluation> = {};
  for (const gate of gates) {
    gate_by_id[gate.heuristic_id] = gate;
  }
  const heuristics = ATOMIC_HEURISTICS.map((config) => {
    const gate = gate_by_id[config.id];
    if (gate === undefined) {
      throw new Error(`Missing gate evaluation: ${config.id}`);
    }
    return _evaluate_heuristic(config, evidence_obj, gate);
  });
  const triggered_paths: string[] = [];
  for (const result of heuristics) {
    for (const path of result.path_results) {
      if (ACTIVE_STATUSES.has(path.status)) {
        triggered_paths.push(path.path_id);
      }
    }
  }
  const synthesis = _synthesize_case(evidence_obj, heuristics);
  const caveatSet = new Set<string>();
  for (const result of heuristics) {
    for (const caveat of result.caveats) {
      caveatSet.add(caveat);
    }
  }
  const caveats = [...caveatSet].sort();
  return {
    query: {
      address: evidence_obj.address,
      normalized_address: evidence_obj.normalized_address,
      zip: evidence_obj.zip,
      run_at: _now_iso_seconds(),
      engine: "heuristics_atomic_experimental",
    },
    gate_evaluations: gates,
    heuristics,
    triggered_paths,
    synthesis,
    caveats,
  };
}

export function compare_atomic_to_agent_report(
  atomic_report: AtomicEvaluationReport | Record<string, unknown>,
  agent_report: Record<string, unknown>,
): Record<string, unknown> {
  const atomic = (
    _isAtomicReport(atomic_report)
      ? (asdict(atomic_report) as Record<string, unknown>)
      : atomic_report
  ) as Record<string, unknown>;
  const agent_adjudication = (asRecord(agent_report["adjudication"]) ?? {}) as Record<
    string,
    unknown
  >;
  const agent_heuristics = (asArray(agent_report["heuristics"]) ?? []) as unknown[];
  const atomic_gate_rows = (asArray(atomic["gate_evaluations"]) ??
    []) as Record<string, unknown>[];
  const atomic_heuristics = (asArray(atomic["heuristics"]) ?? []) as unknown[];
  const atomic_synthesis = (asRecord(atomic["synthesis"]) ?? {}) as Record<
    string,
    unknown
  >;
  const agent_statuses: Record<string, unknown> = {};
  for (const item of agent_heuristics) {
    if (item !== null && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const key = String(firstTruthy(rec["heuristic_id"], rec["id"]));
      agent_statuses[key] = rec["status"];
    }
  }
  const atomicQuery = (asRecord(atomic["query"]) ?? {}) as Record<string, unknown>;
  const agentQuery = (asRecord(agent_report["query"]) ?? {}) as Record<string, unknown>;
  return {
    address: firstTruthy(atomicQuery["address"], agentQuery["address"]),
    zip: firstTruthy(atomicQuery["zip"], agentQuery["zip"]),
    atomic_runnable_heuristics: atomic_gate_rows
      .filter(
        (row) => row["decision"] === "run" || row["decision"] === "run_for_absence",
      )
      .map((row) => row["heuristic_id"]),
    atomic_skipped_heuristics: atomic_gate_rows
      .filter((row) => row["decision"] === "skip")
      .map((row) => row["heuristic_id"]),
    atomic_triggered_paths: asArray(atomic["triggered_paths"]) ?? [],
    agent_heuristic_statuses: agent_statuses,
    agent_triggered_heuristics: Object.entries(agent_statuses)
      .filter(([, value]) => value === "triggered")
      .map(([key]) => key),
    atomic_verdict_band_candidate: atomic_synthesis["verdict_band_candidate"],
    agent_verdict_band: agent_adjudication["verdict_band"],
    atomic_case_archetype_candidate: atomic_synthesis["case_archetype_candidate"],
    agent_case_archetype: agent_adjudication["case_archetype"],
    band_match:
      atomic_synthesis["verdict_band_candidate"] ===
      agent_adjudication["verdict_band"],
    archetype_match:
      atomic_synthesis["case_archetype_candidate"] ===
      agent_adjudication["case_archetype"],
    evidence_surface_summary:
      asRecord(atomic_synthesis["evidence_surface_summary"]) ?? {},
    atomic_family_statuses: Object.fromEntries(
      atomic_heuristics
        .filter((row): row is Record<string, unknown> => isPlainRecord(row))
        .map((row) => [row["heuristic_id"], row["status"]]),
    ),
  };
}

export function summarize_atomic_agent_comparison(
  comparisons: Record<string, unknown>[],
): Record<string, unknown> {
  const total = comparisons.length;
  const band_matches = comparisons.filter((item) => hasContent(item["band_match"])).length;
  const archetype_matches = comparisons.filter((item) =>
    hasContent(item["archetype_match"]),
  ).length;
  const skipped_counter: Record<string, number> = {};
  const triggered_counter: Record<string, number> = {};
  for (const item of comparisons) {
    for (const heuristic_id of asArray(item["atomic_skipped_heuristics"]) ?? []) {
      const key = String(heuristic_id);
      skipped_counter[key] = (skipped_counter[key] ?? 0) + 1;
    }
    for (const path_id of asArray(item["atomic_triggered_paths"]) ?? []) {
      const key = String(path_id);
      triggered_counter[key] = (triggered_counter[key] ?? 0) + 1;
    }
  }
  return {
    total_cases: total,
    exact_band_matches: band_matches,
    exact_archetype_matches: archetype_matches,
    band_match_rate: total ? band_matches / total : 0.0,
    archetype_match_rate: total ? archetype_matches / total : 0.0,
    common_atomic_skipped_heuristics: _top_counts(skipped_counter),
    common_atomic_triggered_paths: _top_counts(triggered_counter),
  };
}

// ---------------------------------------------------------------------------
// Gate evaluation

export function evaluate_gates(evidence_map: unknown): GateEvaluation[] {
  return ATOMIC_HEURISTICS.map((config) => evaluate_gate(config, evidence_map));
}

export function evaluate_gate(
  heuristic: AtomicHeuristic | Record<string, unknown>,
  evidence_map: unknown,
): GateEvaluation {
  const config = _coerce_heuristic(heuristic);
  const counts = _source_counts(evidence_map);
  const owner_count = _owner_count(evidence_map);
  const hint_count = _hint_count(evidence_map);
  const property_types = _property_types(evidence_map);
  const expected = _expected_sources(config.gate);
  const present = expected.filter((source) => (counts[source] ?? 0) > 0);
  const missing = expected.filter((source) => (counts[source] ?? 0) <= 0);

  const [decision, baseReason, paths] = _gate_decision(
    config,
    counts,
    owner_count,
    hint_count,
    property_types,
  );
  let reason = baseReason;
  if (
    config.id === "loan_tenure_subject_analysis" &&
    (counts["loan"] ?? 0) > 0 &&
    (counts["tax"] ?? 0) === 0
  ) {
    reason = `${reason} Tax rows are missing, so owner/non-owner classification requires a quality caveat.`;
  }

  return makeGateEvaluation({
    heuristic_id: config.id,
    decision,
    reason,
    expected_sources: expected,
    missing_sources: missing,
    present_sources: present,
    triggered_gate_paths: paths,
  });
}

function _coerce_heuristic(
  heuristic: AtomicHeuristic | Record<string, unknown>,
): AtomicHeuristic {
  if (isAtomicHeuristic(heuristic)) {
    return heuristic;
  }
  return get_heuristic_by_id(String((heuristic as Record<string, unknown>)["id"]));
}

function _gate_decision(
  config: AtomicHeuristic,
  counts: Record<string, number>,
  owner_count: number,
  hint_count: number,
  property_types: readonly string[],
): [GateDecision, string, readonly string[]] {
  const heuristic_id = config.id;

  if (heuristic_id === "evidence_quality_and_synthesis") {
    const substantive_present = SUBSTANTIVE_SOURCES.filter(
      (source) => (counts[source] ?? 0) > 0,
    );
    if (substantive_present.length > 0 && (counts["tax"] ?? 0) > 0) {
      return [
        "run",
        `Substantive evidence exists: ${substantive_present.join(", ")}.`,
        ["substantive_evidence_present"],
      ];
    }
    return [
      "run_for_absence",
      config.gate.run_for_absence_reason,
      ["sparse_or_missing_tax"],
    ];
  }

  if (heuristic_id === "owner_identity_and_cross_source_context") {
    if ((counts["tax"] ?? 0) === 0 || owner_count === 0) {
      return [
        "run_for_absence",
        config.gate.run_for_absence_reason,
        ["missing_owner_identity"],
      ];
    }
    const comparable_sources = STRONG_OCCUPANCY_SOURCES.filter(
      (source) => (counts[source] ?? 0) > 0,
    );
    if (comparable_sources.length > 0 || hint_count) {
      return [
        "run",
        "Tax owner identity and comparable cross-source evidence or hints are present.",
        ["owner_context_comparable"],
      ];
    }
    return [
      "skip",
      "Tax owner exists, but no non-tax rows or hints exist to compare.",
      [],
    ];
  }

  if (heuristic_id === "loan_tenure_subject_analysis") {
    return _run_if_any(config, counts, "loan", "loan_rows_present");
  }

  if (heuristic_id === "owner_legal_records_conflict") {
    const legal_sources = ["drive", "voter", "auto"].filter(
      (source) => (counts[source] ?? 0) > 0,
    );
    if (legal_sources.length >= 2) {
      return [
        "run",
        `At least two legal/vehicle sources are present: ${legal_sources.join(", ")}.`,
        ["legal_source_comparison"],
      ];
    }
    return [
      "skip",
      "Fewer than two legal/vehicle source surfaces exist to compare.",
      [],
    ];
  }

  if (heuristic_id === "auto_only_owner_elsewhere_discount") {
    if (
      (counts["auto"] ?? 0) > 0 &&
      (counts["drive"] ?? 0) === 0 &&
      (counts["voter"] ?? 0) === 0
    ) {
      return [
        "run",
        "Auto rows exist while drive and voter rows are absent.",
        ["auto_only"],
      ];
    }
    return ["skip", "Auto-only discount is not applicable.", []];
  }

  if (heuristic_id === "utility_only_no_dates_discount") {
    if (
      (counts["utility"] ?? 0) > 0 &&
      !STRONGER_THAN_UTILITY.some((source) => (counts[source] ?? 0) > 0)
    ) {
      return [
        "run",
        "Utility is the only populated occupancy surface.",
        ["utility_only"],
      ];
    }
    return [
      "skip",
      "Utility is absent or corroborated by stronger occupancy sources.",
      [],
    ];
  }

  if (heuristic_id === "trace_only_presence_discount") {
    if (
      (counts["trace"] ?? 0) > 0 &&
      !STRONGER_THAN_TRACE.some((source) => (counts[source] ?? 0) > 0)
    ) {
      return ["run", "Trace is the only populated occupancy surface.", ["trace_only"]];
    }
    return [
      "skip",
      "Trace is absent or corroborated by stronger occupancy sources.",
      [],
    ];
  }

  if (heuristic_id === "drive_voter_conflict_same_person") {
    if ((counts["drive"] ?? 0) > 0 && (counts["voter"] ?? 0) > 0) {
      return [
        "run",
        "Both driver license and voter rows exist.",
        ["drive_voter_compare"],
      ];
    }
    return [
      "skip",
      "Driver license and voter rows are both required for this conflict check.",
      [],
    ];
  }

  if (heuristic_id === "auto_at_subject_but_stronger_legal_elsewhere") {
    if (
      (counts["auto"] ?? 0) > 0 &&
      ((counts["drive"] ?? 0) > 0 || (counts["voter"] ?? 0) > 0)
    ) {
      return [
        "run",
        "Auto rows and at least one stronger legal source are present.",
        ["auto_plus_legal"],
      ];
    }
    return ["skip", "Requires auto rows plus driver or voter rows.", []];
  }

  if (heuristic_id === "portfolio_primary_comparison_analysis") {
    if ((counts["tax"] ?? 0) === 0) {
      return ["skip", config.gate.skip_reason, []];
    }
    if ((counts["tax"] ?? 0) > 1 || _has_portfolio_hint(property_types, owner_count)) {
      return [
        "run",
        "Tax rows or owner hints suggest multi-property/portfolio context.",
        ["portfolio_context"],
      ];
    }
    return ["skip", "No preflight multi-property or portfolio context is visible.", []];
  }

  if (heuristic_id === "base_subject_owner_alignment") {
    if ((counts["tax"] ?? 0) > 0 && (counts["base"] ?? 0) > 0) {
      return [
        "run",
        "Both tax and base rows exist for ownership alignment review.",
        ["tax_base_alignment"],
      ];
    }
    return [
      "skip",
      "Requires both tax and base rows; missing-side quality is covered by synthesis.",
      [],
    ];
  }

  if (heuristic_id === "owner_loan_elsewhere") {
    if ((counts["tax"] ?? 0) > 0 && (counts["loan"] ?? 0) > 0 && owner_count > 0) {
      return [
        "run",
        "Tax owner identity and loan rows exist.",
        ["owner_loan_comparison"],
      ];
    }
    return ["skip", "Requires tax owner identity and loan rows.", []];
  }

  if (
    heuristic_id === "residential_tax_subject" ||
    heuristic_id === "liened_residential_subject" ||
    heuristic_id === "foreclosure_or_distress_marker" ||
    heuristic_id === "company_or_trust_owner" ||
    heuristic_id === "tax_mailing_situs_analysis" ||
    heuristic_id === "single_family_clean_address_context" ||
    heuristic_id === "tax_ownerrescount_portfolio_pattern"
  ) {
    return _run_if_any(config, counts, "tax", "tax_rows_present");
  }

  const single_source_gates: Record<string, readonly [string, string]> = {
    base_mortgage_or_refi_at_subject: ["base", "base_rows_present"],
    drive_address_subject_analysis: ["drive", "drive_rows_present"],
    voter_address_subject_analysis: ["voter", "voter_rows_present"],
    auto_address_subject_analysis: ["auto", "auto_rows_present"],
    trace_address_subject_analysis: ["trace", "trace_rows_present"],
    utility_subject_occupancy_analysis: ["utility", "utility_rows_present"],
  };
  const single = single_source_gates[heuristic_id];
  if (single !== undefined) {
    const [source, path_id] = single;
    return _run_if_any(config, counts, source, path_id);
  }

  return _default_gate_decision(config, counts);
}

function _run_if_any(
  config: AtomicHeuristic,
  counts: Record<string, number>,
  source: string,
  path_id: string,
): [GateDecision, string, readonly string[]] {
  if ((counts[source] ?? 0) > 0) {
    return ["run", `${source} rows are present.`, [path_id]];
  }
  return ["skip", config.gate.skip_reason, []];
}

function _default_gate_decision(
  config: AtomicHeuristic,
  counts: Record<string, number>,
): [GateDecision, string, readonly string[]] {
  const missing = config.gate.required_sources.filter(
    (source) => (counts[source] ?? 0) <= 0,
  );
  if (missing.length > 0) {
    return ["skip", config.gate.skip_reason, []];
  }
  return ["run", config.gate.minimum_viability, ["required_sources_present"]];
}

function _expected_sources(gate: HeuristicGate): readonly string[] {
  return [
    ...new Set([
      ...gate.required_sources,
      ...gate.optional_sources,
      ...gate.absence_sensitive_sources,
    ]),
  ];
}

function _source_counts(evidence_map: unknown): Record<string, number> {
  const raw = _get_value(evidence_map, "source_counts", {});
  const dict =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, number> = {};
  for (const [source, count] of Object.entries(dict)) {
    out[String(source)] = Math.trunc(Number(firstTruthy(count, 0)));
  }
  return out;
}

function _owner_count(evidence_map: unknown): number {
  const value = _get_value(evidence_map, "owner_summaries", []);
  return (asArray(value) ?? []).length;
}

function _hint_count(evidence_map: unknown): number {
  let count = 0;
  for (const key of [
    "owner_presence_hints",
    "owner_elsewhere_hints",
    "nonowner_occupancy_hints",
    "freshness_hints",
  ]) {
    count += (asArray(_get_value(evidence_map, key, [])) ?? []).length;
  }
  return count;
}

function _property_types(evidence_map: unknown): readonly string[] {
  const value = asArray(_get_value(evidence_map, "property_types", [])) ?? [];
  return value.map((item) => String(item).toLowerCase());
}

function _has_portfolio_hint(
  property_types: readonly string[],
  owner_count: number,
): boolean {
  if (owner_count > 1) {
    return true;
  }
  return property_types.some(
    (item) => item.includes("portfolio") || item.includes("multi"),
  );
}

function _get_value(obj: unknown, key: string, def: unknown): unknown {
  if (obj !== null && typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    if (key in rec) {
      return rec[key];
    }
  }
  return def;
}

// ---------------------------------------------------------------------------
// Heuristic evaluation

const ACTIVE_STATUSES: ReadonlySet<PathStatus> = new Set([
  "triggered",
  "context",
  "mitigation",
  "quality",
]);

function _evaluate_heuristic(
  config: AtomicHeuristic,
  evidence: AddressEvidence,
  gate: GateEvaluation,
): HeuristicEvaluation {
  if (gate.decision === "skip") {
    return makeHeuristicEvaluation({
      heuristic_id: config.id,
      gate,
      status: "skipped",
      path_results: [],
      triggered_paths: [],
      reason: gate.reason,
    });
  }
  let paths: readonly ReasoningPath[] =
    config.reasoning_paths.length > 0
      ? config.reasoning_paths
      : [_synthetic_path_for(config)];
  if (gate.decision === "run_for_absence") {
    paths = paths.filter(
      (path) =>
        path.role === "quality" || path.role === "synthesis" || path.role === "context",
    );
  }
  const results = paths.map((path) => _evaluate_path(path, evidence));
  const triggered = results
    .filter((item) => ACTIVE_STATUSES.has(item.status))
    .map((item) => item.path_id);
  const refs: EvidenceRef[] = [];
  for (const item of results) {
    for (const ref of item.evidence_refs) {
      refs.push(ref);
    }
  }
  const caveatSet = new Set<string>();
  for (const item of results) {
    for (const caveat of item.caveats) {
      caveatSet.add(caveat);
    }
  }
  const caveats = [...caveatSet].sort();
  return makeHeuristicEvaluation({
    heuristic_id: config.id,
    gate,
    status: _rollup_status(results),
    path_results: results,
    triggered_paths: triggered,
    reason: _rollup_reason(config, results, gate),
    evidence_refs: refs,
    caveats,
  });
}

function _evaluate_path(
  reasoning_path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const executor = PATH_EXECUTORS[reasoning_path.id];
  if (executor === undefined) {
    return _path_result(
      reasoning_path,
      "inconclusive",
      "No deterministic executor is registered for this path.",
    );
  }
  return executor(reasoning_path, evidence);
}

function _synthetic_path_for(config: AtomicHeuristic): ReasoningPath {
  return {
    id: config.id,
    title: config.title,
    role: config.role,
    predicate: config.reasoning,
    positive_indicators: config.positive_indicators,
    negative_indicators: config.negative_indicators,
    caveats: config.caveats,
    verdict_contributions: config.verdict_contributions,
    confidence: config.confidence,
    output_fields: config.output_fields,
  };
}

function _rollup_status(results: readonly PathEvaluation[]): PathStatus {
  if (results.length === 0) {
    return "skipped";
  }
  if (results.some((item) => item.status === "triggered")) {
    return "triggered";
  }
  if (results.some((item) => item.status === "mitigation")) {
    return "mitigation";
  }
  if (results.some((item) => item.status === "quality")) {
    return "quality";
  }
  if (results.some((item) => item.status === "context")) {
    return "context";
  }
  if (results.some((item) => item.status === "inconclusive")) {
    return "inconclusive";
  }
  return "not_triggered";
}

function _rollup_reason(
  config: AtomicHeuristic,
  results: readonly PathEvaluation[],
  gate: GateEvaluation,
): string {
  const active = results.filter((item) => ACTIVE_STATUSES.has(item.status));
  if (active.length > 0) {
    return `${config.title}: ${active
      .slice(0, 4)
      .map((item) => item.reason)
      .join("; ")}`;
  }
  if (results.length > 0) {
    return `${config.title}: no deterministic paths triggered.`;
  }
  return gate.reason;
}

function _path_result(
  reasoning_path: ReasoningPath,
  status: PathStatus,
  reason: string,
  opts: {
    refs?: readonly EvidenceRef[];
    caveats?: readonly string[];
    strength?: SignalStrength;
    weight?: RecommendedWeight;
  } = {},
): PathEvaluation {
  return makePathEvaluation({
    path_id: reasoning_path.id,
    status,
    role: reasoning_path.role,
    confidence: reasoning_path.confidence,
    signal_strength: opts.strength ?? "none",
    recommended_weight: opts.weight ?? "ignore",
    reason,
    evidence_refs: opts.refs ?? [],
    caveats: [...reasoning_path.caveats, ...(opts.caveats ?? [])],
    verdict_contributions: reasoning_path.verdict_contributions,
  });
}

function _trigger(
  reasoning_path: ReasoningPath,
  reason: string,
  refs: readonly EvidenceRef[] = [],
  opts: { strength?: SignalStrength; weight?: RecommendedWeight } = {},
): PathEvaluation {
  let status: PathStatus = "triggered";
  if (reasoning_path.role === "context" || reasoning_path.role === "support") {
    status = "context";
  } else if (reasoning_path.role === "mitigation") {
    status = "mitigation";
  } else if (reasoning_path.role === "quality") {
    status = "quality";
  }
  return _path_result(reasoning_path, status, reason, {
    refs,
    strength: opts.strength ?? "moderate",
    weight: opts.weight ?? "medium",
  });
}

function _not_triggered(reasoning_path: ReasoningPath, reason: string): PathEvaluation {
  return _path_result(reasoning_path, "not_triggered", reason);
}

// ---------------------------------------------------------------------------
// Path executors

function _residential_tax_subject(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "tax").filter((row) => _truthy(row["residential"]));
  if (rows.length > 0) {
    return _trigger(
      path,
      `${rows.length} residential tax row(s) match the subject.`,
      _refs("tax", rows),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No residential tax row matched the subject.");
}

function _liened_residential_subject(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "tax").filter(
    (row) => _truthy(row["residential"]) && _tax_lien_present(row),
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      `${rows.length} residential tax row(s) have lien/lender evidence.`,
      _refs("tax", rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No liened residential tax row matched the subject.");
}

function _base_mortgage_or_refi_at_subject(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "base").filter((row) => _base_mortgage_present(row));
  if (rows.length > 0) {
    return _trigger(
      path,
      `${rows.length} base row(s) at subject have mortgage/refi fields.`,
      _refs("base", rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No base mortgage/refi row at subject.");
}

function _foreclosure_or_distress_marker(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "tax").filter(
    (row) => hasContent(row["foreclosecode"]) || hasContent(row["forecloserecorddate"]),
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      `${rows.length} tax row(s) carry foreclosure/distress markers.`,
      _refs("tax", rows),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No foreclosure/distress marker found in tax rows.");
}

function _company_or_trust_owner(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const terms = ["llc", "inc", "trust", "estate", "corp", "company"];
  const rows = rowsOf(evidence, "tax").filter(
    (row) =>
      hasContent(row["ownercompany"]) ||
      terms.some((term) => _norm(row["ownername"]).includes(term)),
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      "Tax owner appears to be an entity, trust, or estate.",
      _refs("tax", rows),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No entity/trust owner marker found.");
}

function _tax_owner_identity_present(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  if (evidence.owner_ids.length > 0 || evidence.owner_name_keys.length > 0) {
    return _trigger(
      path,
      "Tax rows establish owner identity.",
      _refs("tax", rowsOf(evidence, "tax")),
      { strength: "weak", weight: "low" },
    );
  }
  return _path_result(path, "inconclusive", "No tax owner identity is available.");
}

function _tax_owner_mailing_matches_situs(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "tax").filter(
    (row) => _normalize_address(row["owneraddressline1"]) === evidence.normalized_address,
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      "Tax owner mailing address matches the subject.",
      _refs("tax", rows),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No tax owner mailing-at-subject match.");
}

function _tax_owner_mailing_differs_from_situs(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "tax").filter((row) => {
    const mailing = _normalize_address(row["owneraddressline1"]);
    return mailing !== "" && mailing !== evidence.normalized_address;
  });
  if (rows.length > 0) {
    return _trigger(
      path,
      "Tax owner mailing address differs from the subject.",
      _refs("tax", rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No differing tax owner mailing address found.");
}

function _tax_mailing_subject_but_owner_legal_elsewhere(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  if (_tax_owner_mailing_matches_situs(path, evidence).status !== "context") {
    return _not_triggered(path, "Tax mailing does not match the subject.");
  }
  const elsewhere = _owner_elsewhere_rows(evidence, ["drive", "voter", "auto"]);
  if (elsewhere.length > 0) {
    return _trigger(
      path,
      "Tax mailing matches subject but owner legal records point elsewhere.",
      _refs_multi(elsewhere),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No owner legal records elsewhere.");
}

function _base_person_not_tax_owner_at_subject(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "base").filter((row) => !_is_owner_row(row, evidence));
  if (rows.length > 0) {
    return _trigger(
      path,
      "Base person at subject is not resolved as a tax owner.",
      _refs("base", rows),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No non-owner base person at subject.");
}

function _owner_base_primary_at_subject(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "base").filter((row) => _is_owner_row(row, evidence));
  if (rows.length > 0) {
    return _trigger(
      path,
      "Tax owner has base primary-address evidence at subject.",
      _refs("base", rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No owner base primary-address row at subject.");
}

function _loan_owner_claim_not_supported_by_tax(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "loan").filter(
    (row) => _own_rent(row) === "own" && !_is_owner_row(row, evidence),
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      "Loan OWN claim at subject is not supported by tax ownership.",
      _refs("loan", rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No non-owner OWN loan claim at subject.");
}

function _owner_loan_rent_conflict(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "loan").filter(
    (row) => _own_rent(row) === "rent" && _is_owner_row(row, evidence),
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      "Tax owner loan row reports RENT at the owned subject.",
      _refs("loan", rows),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No owner RENT loan conflict.");
}

function _owner_loan_own_at_subject(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "loan").filter(
    (row) => _own_rent(row) === "own" && _is_owner_row(row, evidence),
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      "Tax owner loan row reports OWN at subject.",
      _refs("loan", rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No owner OWN loan row at subject.");
}

function _nonowner_loan_renter_at_subject(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  if (evidence.owner_ids.length === 0 && evidence.owner_name_keys.length === 0) {
    return _path_result(
      path,
      "inconclusive",
      "Loan RENT rows exist, but tax ownership is missing for owner/non-owner classification.",
      {
        refs: _refs("loan", rowsOf(evidence, "loan")),
        caveats: ["Missing tax owner identity."],
      },
    );
  }
  const rows = rowsOf(evidence, "loan").filter(
    (row) => _own_rent(row) === "rent" && !_is_owner_row(row, evidence),
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      "Non-owner loan row reports RENT at subject.",
      _refs("loan", rows),
      { strength: "strong", weight: "high" },
    );
  }
  return _not_triggered(path, "No non-owner RENT loan row at subject.");
}

function _nonowner_loan_owner_claim_at_subject(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  return _loan_owner_claim_not_supported_by_tax(path, evidence);
}

function _owner_loan_elsewhere(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = _owner_related_rows_by_id(evidence, "loan").filter(
    (row) =>
      _normalize_address(firstTruthy(row["address"], row["primaryaddress"])) !==
      evidence.normalized_address,
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      "Owner-linked loan rows point to a non-subject address.",
      _refs("loan", rows),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No owner loan address elsewhere.");
}

function _owner_source_at_subject(source: string): Executor {
  return (path, evidence) => {
    const rows = rowsOf(evidence, source).filter((row) => _is_owner_row(row, evidence));
    if (rows.length > 0) {
      return _trigger(
        path,
        `Owner-like ${source} row appears at subject.`,
        _refs(source, rows),
        { strength: "moderate", weight: "medium" },
      );
    }
    return _not_triggered(path, `No owner-like ${source} row at subject.`);
  };
}

function _owner_source_elsewhere(source: string): Executor {
  return (path, evidence) => {
    const rows = _owner_related_rows_by_id(evidence, source).filter((row) => {
      const norm = _normalize_address(row["address"]);
      return norm !== "" && norm !== evidence.normalized_address;
    });
    if (rows.length > 0) {
      const strong = source === "drive" || source === "voter";
      return _trigger(
        path,
        `Owner-linked ${source} row points away from subject.`,
        _refs(source, rows),
        {
          strength: strong ? "strong" : "moderate",
          weight: strong ? "high" : "medium",
        },
      );
    }
    return _not_triggered(path, `No owner-linked ${source} row elsewhere.`);
  };
}

function _nonowner_source_at_subject(source: string): Executor {
  return (path, evidence) => {
    if (evidence.owner_ids.length === 0 && evidence.owner_name_keys.length === 0) {
      return _path_result(
        path,
        "inconclusive",
        `${source} rows exist, but tax ownership is missing for owner/non-owner classification.`,
        {
          refs: _refs(source, rowsOf(evidence, source)),
          caveats: ["Missing tax owner identity."],
        },
      );
    }
    const rows = rowsOf(evidence, source).filter((row) => !_is_owner_row(row, evidence));
    if (rows.length > 0) {
      const strong = source === "drive" || source === "voter";
      return _trigger(
        path,
        `Non-owner ${source} row appears at subject.`,
        _refs(source, rows),
        {
          strength: strong ? "strong" : "moderate",
          weight: strong ? "high" : "medium",
        },
      );
    }
    return _not_triggered(path, `No non-owner ${source} row at subject.`);
  };
}

function _owner_legal_records_conflict(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const addresses = new Map<string, Set<string>>();
  const refs: Array<[string, Record<string, unknown>]> = [];
  for (const source of ["drive", "voter", "auto"]) {
    for (const row of rowsOf(evidence, source).filter((r) => _is_owner_row(r, evidence))) {
      const norm = _normalize_address(row["address"]);
      if (norm) {
        if (!addresses.has(norm)) {
          addresses.set(norm, new Set());
        }
        addresses.get(norm)!.add(source);
        refs.push([source, row]);
      }
    }
  }
  if (addresses.size >= 2) {
    return _trigger(
      path,
      `Owner legal/vehicle records point to ${addresses.size} distinct addresses.`,
      _refs_multi(refs),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No owner legal-record address conflict.");
}

function _auto_only_owner_elsewhere_discount(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const owner_auto = _owner_source_elsewhere("auto")(path, evidence);
  const has_drive_voter_elsewhere =
    _owner_elsewhere_rows(evidence, ["drive", "voter"]).length > 0;
  if (owner_auto.status === "triggered" && !has_drive_voter_elsewhere) {
    return _trigger(
      path,
      "Owner elsewhere evidence is auto-only.",
      owner_auto.evidence_refs,
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "Owner elsewhere evidence is not auto-only.");
}

function _owner_utility_at_subject(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "utility").filter((row) =>
    _is_owner_name_row(row, evidence),
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      "Owner utility name appears at subject.",
      _refs("utility", rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No owner utility name at subject.");
}

function _nonowner_utility_at_subject(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "utility").filter(
    (row) => !_is_owner_name_row(row, evidence),
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      "Non-owner utility name appears at subject.",
      _refs("utility", rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No non-owner utility name at subject.");
}

function _multiple_nonowner_utility_names(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "utility").filter(
    (row) => !_is_owner_name_row(row, evidence),
  );
  const keys = new Set<string>();
  for (const row of rows) {
    const key = _person_key(row);
    keys.add(_encodeKey(key));
  }
  keys.delete(_encodeKey(["", ""]));
  if (keys.size >= 2) {
    return _trigger(
      path,
      `${keys.size} distinct non-owner utility names appear at subject.`,
      _refs("utility", rows),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "Fewer than two distinct non-owner utility names.");
}

function _owner_utility_plus_nonowner_utility_context(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const owner_rows = rowsOf(evidence, "utility").filter((row) =>
    _is_owner_name_row(row, evidence),
  );
  const nonowner_rows = rowsOf(evidence, "utility").filter(
    (row) => !_is_owner_name_row(row, evidence),
  );
  if (owner_rows.length > 0 && nonowner_rows.length > 0) {
    return _trigger(
      path,
      "Utility records include both owner and non-owner names.",
      [..._refs("utility", owner_rows), ..._refs("utility", nonowner_rows)],
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No mixed owner/non-owner utility context.");
}

function _utility_only_no_dates_discount(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  if (
    (evidence.source_counts["utility"] ?? 0) > 0 &&
    !STRONGER_THAN_UTILITY.some((source) => (evidence.source_counts[source] ?? 0) > 0)
  ) {
    return _trigger(
      path,
      "Utility is the only populated occupancy surface and lacks service dates.",
      _refs("utility", rowsOf(evidence, "utility")),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "Utility is absent or corroborated by stronger sources.");
}

function _trace_only_presence_discount(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  if (
    (evidence.source_counts["trace"] ?? 0) > 0 &&
    !STRONGER_THAN_TRACE.some((source) => (evidence.source_counts[source] ?? 0) > 0)
  ) {
    return _trigger(
      path,
      "Trace is the only populated occupancy surface.",
      _refs("trace", rowsOf(evidence, "trace")),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "Trace is absent or corroborated by stronger sources.");
}

function _drive_voter_conflict_same_person(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const conflicts: Array<[string, Record<string, unknown>]> = [];
  for (const drive of rowsOf(evidence, "drive")) {
    const dkey = _person_key(drive);
    if (!_anyKey(dkey)) {
      continue;
    }
    for (const voter of rowsOf(evidence, "voter")) {
      if (
        _keysEqual(_person_key(voter), dkey) &&
        _normalize_address(drive["address"]) !== _normalize_address(voter["address"])
      ) {
        conflicts.push(["drive", drive], ["voter", voter]);
      }
    }
  }
  if (conflicts.length > 0) {
    return _trigger(
      path,
      "Driver and voter addresses disagree for the same person.",
      _refs_multi(conflicts),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No same-person drive/voter address conflict.");
}

function _auto_at_subject_but_stronger_legal_elsewhere(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const conflicts: Array<[string, Record<string, unknown>]> = [];
  for (const auto of rowsOf(evidence, "auto")) {
    const akey = _person_key(auto);
    if (!_anyKey(akey)) {
      continue;
    }
    for (const source of ["drive", "voter"]) {
      for (const row of rowsOf(evidence, source)) {
        if (
          _keysEqual(_person_key(row), akey) &&
          _normalize_address(row["address"]) !== evidence.normalized_address
        ) {
          conflicts.push(["auto", auto], [source, row]);
        }
      }
    }
  }
  if (conflicts.length > 0) {
    return _trigger(
      path,
      "Auto is at subject while stronger legal source points elsewhere.",
      _refs_multi(conflicts),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(
    path,
    "No auto-at-subject/stronger-legal-elsewhere conflict.",
  );
}

function _same_surname_family_household_context(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const owner_lasts = new Set<string>();
  for (const [, last] of evidence.owner_name_keys) {
    if (last) {
      owner_lasts.add(last);
    }
  }
  const rows: Array<[string, Record<string, unknown>]> = [];
  for (const source of ["base", "loan", "drive", "voter", "auto", "trace", "utility"]) {
    for (const row of rowsOf(evidence, source)) {
      const key = _person_key(row);
      if (owner_lasts.has(key[1]) && !_is_owner_row(row, evidence)) {
        rows.push([source, row]);
      }
    }
  }
  if (rows.length > 0) {
    return _trigger(
      path,
      "Non-owner evidence appears likely family-linked by surname.",
      _refs_multi(rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No same-surname family context found.");
}

function _repeated_nonowner_cross_source_corroboration(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const by_person = new Map<string, Array<[string, Record<string, unknown>]>>();
  for (const source of ["base", "loan", "drive", "voter", "auto", "trace", "utility"]) {
    for (const row of rowsOf(evidence, source)) {
      if (_is_owner_row(row, evidence)) {
        continue;
      }
      const key = _person_key(row);
      if (_anyKey(key)) {
        const encoded = _encodeKey(key);
        if (!by_person.has(encoded)) {
          by_person.set(encoded, []);
        }
        by_person.get(encoded)!.push([source, row]);
      }
    }
  }
  const matches = [...by_person.values()].filter(
    (items) => new Set(items.map(([source]) => source)).size >= 2,
  );
  if (matches.length > 0) {
    const refs: EvidenceRef[] = [];
    for (const items of matches) {
      for (const ref of _refs_multi(items)) {
        refs.push(ref);
      }
    }
    return _trigger(
      path,
      "Same non-owner appears across multiple source classes.",
      refs,
      { strength: "strong", weight: "high" },
    );
  }
  return _not_triggered(path, "No repeated cross-source non-owner corroboration.");
}

function _unrelated_nonowner_legal_presence(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const owner_lasts = new Set<string>();
  for (const [, last] of evidence.owner_name_keys) {
    if (last) {
      owner_lasts.add(last);
    }
  }
  const rows: Array<[string, Record<string, unknown>]> = [];
  for (const source of ["drive", "voter", "auto"]) {
    for (const row of rowsOf(evidence, source)) {
      const key = _person_key(row);
      if (key[1] && !owner_lasts.has(key[1]) && !_is_owner_row(row, evidence)) {
        rows.push([source, row]);
      }
    }
  }
  if (rows.length > 0) {
    return _trigger(
      path,
      "Unrelated non-owner legal/vehicle records appear at subject.",
      _refs_multi(rows),
      { strength: "strong", weight: "high" },
    );
  }
  return _not_triggered(path, "No unrelated non-owner legal presence.");
}

function _owner_present_plus_nonowner_renter_context(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const owner_present =
    ["drive", "voter", "auto", "loan", "trace"].some((source) =>
      rowsOf(evidence, source).some((row) => _is_owner_row(row, evidence)),
    ) || rowsOf(evidence, "utility").some((row) => _is_owner_name_row(row, evidence));
  const nonowner_renter = rowsOf(evidence, "loan").some(
    (row) => _own_rent(row) === "rent" && !_is_owner_row(row, evidence),
  );
  if (owner_present && nonowner_renter) {
    return _trigger(
      path,
      "Owner-present evidence coexists with non-owner renter evidence.",
      [],
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No owner-present plus non-owner-renter context.");
}

function _portfolio_owner_with_nonowner_occupancy(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const portfolio = _portfolio_rows(evidence);
  const nonowner = ["drive", "voter", "auto", "loan", "trace"].some((source) =>
    rowsOf(evidence, source).some((row) => !_is_owner_row(row, evidence)),
  );
  if (portfolio.length > 0 && nonowner) {
    return _trigger(
      path,
      "Portfolio-like ownership coexists with non-owner occupancy evidence.",
      _refs("tax", portfolio),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No portfolio plus non-owner occupancy pattern.");
}

function _owner_multiple_liened_residential_properties(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "tax").filter(
    (row) => _truthy(row["residential"]) && _tax_lien_present(row),
  );
  if (rows.length >= 2) {
    return _trigger(
      path,
      "Multiple liened residential tax rows are linked to the owner/subject.",
      _refs("tax", rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(
    path,
    "No multiple liened residential property pattern visible.",
  );
}

function _owner_primary_comparison_elsewhere(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = _owner_elsewhere_rows(evidence, ["drive", "voter", "auto"]);
  if (rows.length > 0) {
    return _trigger(
      path,
      "Owner has stronger primary-address evidence away from subject.",
      _refs_multi(rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(path, "No stronger alternate owner primary address visible.");
}

function _tax_ownerrescount_portfolio_pattern(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = _portfolio_rows(evidence);
  if (rows.length > 0) {
    return _trigger(
      path,
      "Tax ownerrescount suggests portfolio-like ownership.",
      _refs("tax", rows),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No ownerrescount portfolio marker found.");
}

function _single_family_clean_address_context(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "tax").filter(
    (row) => _truthy(row["residential"]) && !_truthy(row["condo"]),
  );
  if (rows.length > 0) {
    return _trigger(
      path,
      "Tax rows support clean residential non-condo context.",
      _refs("tax", rows),
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "No clean single-family tax context.");
}

function _missing_dates_confidence_discount(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  if (
    (evidence.source_counts["utility"] ?? 0) > 0 ||
    (evidence.source_counts["loan"] ?? 0) > 0
  ) {
    return _trigger(
      path,
      "Material utility/loan evidence lacks reliable timing fields.",
      [],
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(
    path,
    "No material undated evidence surface requiring discount.",
  );
}

function _stale_or_missing_mortgage_exposure(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  if (
    !rowsOf(evidence, "tax").some((row) => _tax_lien_present(row)) &&
    !rowsOf(evidence, "base").some((row) => _base_mortgage_present(row))
  ) {
    return _trigger(
      path,
      "No lien or base mortgage/refi exposure is visible.",
      [],
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "Mortgage/lien exposure is visible.");
}

function _same_person_name_variant_ambiguity(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const seen = new Map<string, Set<string>>();
  for (const source of ["base", "loan", "drive", "voter", "auto", "trace"]) {
    for (const row of rowsOf(evidence, source)) {
      const row_id = String(firstTruthy(row["id"], ""));
      if (row_id) {
        if (!seen.has(row_id)) {
          seen.set(row_id, new Set());
        }
        seen.get(row_id)!.add(_encodeKey(_person_key(row)));
      }
    }
  }
  if ([...seen.values()].some((keys) => keys.size > 1)) {
    return _trigger(path, "Same id appears with multiple name keys.", [], {
      strength: "weak",
      weight: "low",
    });
  }
  return _not_triggered(path, "No same-person name variant ambiguity detected.");
}

function _malformed_address_equivalence(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  if (
    !evidence.normalized_address ||
    ![...evidence.normalized_address].some((char) => char >= "0" && char <= "9")
  ) {
    return _trigger(
      path,
      "Subject normalized address lacks a clear house number.",
      [],
      { strength: "weak", weight: "low" },
    );
  }
  return _not_triggered(path, "Subject address appears structurally usable.");
}

function _unit_collapsed_address_ambiguity(
  path: ReasoningPath,
  evidence: AddressEvidence,
): PathEvaluation {
  const rows = rowsOf(evidence, "tax").filter((row) => _truthy(row["condo"]));
  if (rows.length > 0) {
    return _trigger(
      path,
      "Tax rows indicate condo/unit ambiguity.",
      _refs("tax", rows),
      { strength: "moderate", weight: "medium" },
    );
  }
  return _not_triggered(
    path,
    "No condo/unit ambiguity detected in atomic internal sources.",
  );
}

function _integrated_internal_occupancy_verdict(
  path: ReasoningPath,
  _evidence: AddressEvidence,
): PathEvaluation {
  return _trigger(
    path,
    "Final deterministic synthesis is computed at case level.",
    [],
    { strength: "weak", weight: "low" },
  );
}

type Executor = (path: ReasoningPath, evidence: AddressEvidence) => PathEvaluation;

const PATH_EXECUTORS: Record<string, Executor> = {
  residential_tax_subject: _residential_tax_subject,
  liened_residential_subject: _liened_residential_subject,
  base_mortgage_or_refi_at_subject: _base_mortgage_or_refi_at_subject,
  foreclosure_or_distress_marker: _foreclosure_or_distress_marker,
  company_or_trust_owner: _company_or_trust_owner,
  stale_or_missing_mortgage_exposure: _stale_or_missing_mortgage_exposure,
  missing_dates_confidence_discount: _missing_dates_confidence_discount,
  same_person_name_variant_ambiguity: _same_person_name_variant_ambiguity,
  malformed_address_equivalence: _malformed_address_equivalence,
  unit_collapsed_address_ambiguity: _unit_collapsed_address_ambiguity,
  integrated_internal_occupancy_verdict: _integrated_internal_occupancy_verdict,
  tax_owner_identity_present: _tax_owner_identity_present,
  repeated_nonowner_cross_source_corroboration:
    _repeated_nonowner_cross_source_corroboration,
  unrelated_nonowner_legal_presence: _unrelated_nonowner_legal_presence,
  same_surname_family_household_context: _same_surname_family_household_context,
  owner_present_plus_nonowner_renter_context:
    _owner_present_plus_nonowner_renter_context,
  portfolio_owner_with_nonowner_occupancy: _portfolio_owner_with_nonowner_occupancy,
  tax_owner_mailing_matches_situs: _tax_owner_mailing_matches_situs,
  tax_owner_mailing_differs_from_situs: _tax_owner_mailing_differs_from_situs,
  tax_mailing_subject_but_owner_legal_elsewhere:
    _tax_mailing_subject_but_owner_legal_elsewhere,
  base_person_not_tax_owner_at_subject: _base_person_not_tax_owner_at_subject,
  owner_base_primary_at_subject: _owner_base_primary_at_subject,
  loan_owner_claim_not_supported_by_tax: _loan_owner_claim_not_supported_by_tax,
  owner_loan_rent_conflict: _owner_loan_rent_conflict,
  owner_loan_own_at_subject: _owner_loan_own_at_subject,
  nonowner_loan_renter_at_subject: _nonowner_loan_renter_at_subject,
  nonowner_loan_owner_claim_at_subject: _nonowner_loan_owner_claim_at_subject,
  owner_loan_elsewhere: _owner_loan_elsewhere,
  owner_drive_at_subject: _owner_source_at_subject("drive"),
  owner_drive_elsewhere: _owner_source_elsewhere("drive"),
  nonowner_drive_at_subject: _nonowner_source_at_subject("drive"),
  owner_voter_at_subject: _owner_source_at_subject("voter"),
  owner_voter_elsewhere: _owner_source_elsewhere("voter"),
  nonowner_voter_at_subject: _nonowner_source_at_subject("voter"),
  owner_auto_at_subject: _owner_source_at_subject("auto"),
  owner_auto_elsewhere: _owner_source_elsewhere("auto"),
  nonowner_auto_at_subject: _nonowner_source_at_subject("auto"),
  owner_legal_records_conflict: _owner_legal_records_conflict,
  auto_only_owner_elsewhere_discount: _auto_only_owner_elsewhere_discount,
  owner_trace_at_subject: _owner_source_at_subject("trace"),
  owner_trace_elsewhere: _owner_source_elsewhere("trace"),
  nonowner_trace_at_subject: _nonowner_source_at_subject("trace"),
  owner_utility_at_subject: _owner_utility_at_subject,
  nonowner_utility_at_subject: _nonowner_utility_at_subject,
  multiple_nonowner_utility_names: _multiple_nonowner_utility_names,
  owner_utility_plus_nonowner_utility_context:
    _owner_utility_plus_nonowner_utility_context,
  utility_only_no_dates_discount: _utility_only_no_dates_discount,
  trace_only_presence_discount: _trace_only_presence_discount,
  drive_voter_conflict_same_person: _drive_voter_conflict_same_person,
  auto_at_subject_but_stronger_legal_elsewhere:
    _auto_at_subject_but_stronger_legal_elsewhere,
  single_family_clean_address_context: _single_family_clean_address_context,
  owner_multiple_liened_residential_properties:
    _owner_multiple_liened_residential_properties,
  owner_primary_comparison_elsewhere: _owner_primary_comparison_elsewhere,
  tax_ownerrescount_portfolio_pattern: _tax_ownerrescount_portfolio_pattern,
};

// ---------------------------------------------------------------------------
// Case synthesis

function _synthesize_case(
  evidence: AddressEvidence,
  heuristics: readonly HeuristicEvaluation[],
): CaseSynthesis {
  const active_paths = new Set<string>();
  for (const heuristic of heuristics) {
    for (const path of heuristic.path_results) {
      if (ACTIVE_STATUSES.has(path.status)) {
        active_paths.add(path.path_id);
      }
    }
  }
  let score = 0;
  for (const heuristic of heuristics) {
    for (const path of heuristic.path_results) {
      score += _path_weight(path);
    }
  }
  const manual =
    active_paths.has("unit_collapsed_address_ambiguity") ||
    active_paths.has("malformed_address_equivalence");

  let archetype: CaseArchetypeCandidate;
  if (!((evidence.source_counts["tax"] ?? 0) > 0)) {
    archetype = "insufficient_ownership_data";
  } else if (
    _intersects(["owner_drive_elsewhere", "nonowner_drive_at_subject"], active_paths) ||
    _subset(["owner_voter_elsewhere", "nonowner_voter_at_subject"], active_paths)
  ) {
    archetype = "clear_absentee_rental";
  } else if (
    (active_paths.has("owner_drive_elsewhere") ||
      active_paths.has("owner_voter_elsewhere") ||
      active_paths.has("tax_owner_mailing_differs_from_situs")) &&
    (active_paths.has("nonowner_loan_renter_at_subject") ||
      active_paths.has("unrelated_nonowner_legal_presence"))
  ) {
    archetype = "clear_absentee_rental";
  } else if (
    active_paths.has("same_surname_family_household_context") &&
    (active_paths.has("nonowner_loan_renter_at_subject") ||
      active_paths.has("nonowner_drive_at_subject"))
  ) {
    archetype = "family_household_rental";
  } else if (
    active_paths.has("owner_present_plus_nonowner_renter_context") ||
    active_paths.has("owner_utility_plus_nonowner_utility_context")
  ) {
    archetype = "owner_present_with_rental_indicators";
  } else if (
    [
      "nonowner_drive_at_subject",
      "nonowner_voter_at_subject",
      "nonowner_auto_at_subject",
      "nonowner_loan_renter_at_subject",
      "nonowner_utility_at_subject",
      "nonowner_trace_at_subject",
    ].some((p) => active_paths.has(p))
  ) {
    archetype = "ambiguous_nonowner_occupancy";
  } else if (
    [
      "owner_drive_at_subject",
      "owner_voter_at_subject",
      "owner_utility_at_subject",
      "tax_owner_mailing_matches_situs",
    ].some((p) => active_paths.has(p))
  ) {
    archetype = "low_evidence_owner_occupied";
  } else {
    archetype = "mixed_evidence";
  }

  let band: VerdictBandCandidate;
  if (manual) {
    band = "manual_verification";
  } else if (score >= 8 && archetype === "clear_absentee_rental") {
    band = "high_priority_review";
  } else if (score >= 5) {
    band = "review";
  } else if (score >= 2) {
    band = "monitor";
  } else {
    band = "low_evidence";
  }

  const reasons = [...active_paths].sort();
  return {
    raw_signal_score: score,
    verdict_band_candidate: band,
    case_archetype_candidate: archetype,
    why_not_higher: _why_not_higher(band, active_paths, evidence),
    why_not_lower: reasons
      .slice(0, 5)
      .map((path) => `Triggered deterministic path: ${path}`),
    evidence_surface_summary: {
      source_counts: evidence.source_counts,
      owner_count: evidence.owner_summaries.length,
      triggered_path_count: active_paths.size,
      manual_verification_flags: [...active_paths]
        .filter(
          (path) =>
            path === "unit_collapsed_address_ambiguity" ||
            path === "malformed_address_equivalence",
        )
        .sort(),
    },
  };
}

function _path_weight(path: PathEvaluation): number {
  if (path.status !== "triggered") {
    return 0;
  }
  if (
    path.role === "mitigation" ||
    path.role === "quality" ||
    path.role === "context" ||
    path.role === "support" ||
    path.role === "synthesis"
  ) {
    return 0;
  }
  const weights: Record<SignalStrength, number> = {
    none: 0,
    weak: 1,
    moderate: 2,
    strong: 3,
  };
  return weights[path.signal_strength];
}

function _why_not_higher(
  band: VerdictBandCandidate,
  active_paths: ReadonlySet<string>,
  evidence: AddressEvidence,
): readonly string[] {
  const reasons: string[] = [];
  if (band !== "high_priority_review") {
    if (
      ![...active_paths].some(
        (path) =>
          path.endsWith("_elsewhere") ||
          path === "tax_owner_mailing_differs_from_situs",
      )
    ) {
      reasons.push("No strong deterministic owner-elsewhere signal.");
    }
    if (
      ![
        "nonowner_loan_renter_at_subject",
        "unrelated_nonowner_legal_presence",
        "nonowner_drive_at_subject",
        "nonowner_voter_at_subject",
      ].some((path) => active_paths.has(path))
    ) {
      reasons.push("No strong deterministic unrelated/non-owner occupant signal.");
    }
    if (!((evidence.source_counts["tax"] ?? 0) > 0)) {
      reasons.push("Tax ownership is missing.");
    }
  }
  return reasons.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Evidence coercion + SQLite helpers

function _coerce_evidence(
  evidence: AddressEvidence | Record<string, unknown>,
): AddressEvidence {
  if (isAddressEvidence(evidence)) {
    return evidence;
  }
  const evidenceRows = asRecord(evidence["rows"]) ?? {};
  const rows: Record<string, readonly Record<string, unknown>[]> = {};
  for (const source of SUBSTANTIVE_SOURCES) {
    rows[source] = (asArray(evidenceRows[source]) ?? []) as Record<string, unknown>[];
  }
  const rawCounts = asRecord(evidence["source_counts"]);
  let source_counts: Record<string, number>;
  if (rawCounts) {
    source_counts = {};
    for (const [key, value] of Object.entries(rawCounts)) {
      source_counts[key] = Number(value);
    }
  } else {
    source_counts = {};
    for (const [source, source_rows] of Object.entries(rows)) {
      source_counts[source] = source_rows.length;
    }
  }
  return makeAddressEvidence({
    address: String(firstTruthy(evidence["address"], "")),
    normalized_address: String(firstTruthy(evidence["normalized_address"], "")),
    zip: String(firstTruthy(evidence["zip"], "")),
    rows,
    owner_ids: (asArray(evidence["owner_ids"]) ?? []).map((v) => String(v)),
    owner_name_keys: (asArray(evidence["owner_name_keys"]) ?? []).map(
      (item) => _toStringTuple(item),
    ),
    source_counts,
    owner_summaries: (asArray(evidence["owner_summaries"]) ??
      []) as Record<string, unknown>[],
    people_at_address: (asArray(evidence["people_at_address"]) ??
      []) as Record<string, unknown>[],
    owner_presence_hints: (asArray(evidence["owner_presence_hints"]) ?? []).map((v) =>
      String(v),
    ),
    owner_elsewhere_hints: (asArray(evidence["owner_elsewhere_hints"]) ?? []).map((v) =>
      String(v),
    ),
    nonowner_occupancy_hints: (asArray(evidence["nonowner_occupancy_hints"]) ?? []).map(
      (v) => String(v),
    ),
    freshness_hints: (asArray(evidence["freshness_hints"]) ?? []).map((v) => String(v)),
    data_gaps: (asArray(evidence["data_gaps"]) ?? []).map((v) => String(v)),
    property_types: (asArray(evidence["property_types"]) ?? []).map((v) => String(v)),
  });
}

function _address_rows(
  connection: Database,
  source: string,
  normalized_address: string,
  zip_code: string,
  limit: number,
): Record<string, unknown>[] {
  if (zip_code) {
    return connection
      .query(
        `SELECT rowid AS __rowid, * FROM "${source}" WHERE __norm_address = ? AND zip = ? LIMIT ?`,
      )
      .all(normalized_address, zip_code, limit) as Record<string, unknown>[];
  }
  return connection
    .query(`SELECT rowid AS __rowid, * FROM "${source}" WHERE __norm_address = ? LIMIT ?`)
    .all(normalized_address, limit) as Record<string, unknown>[];
}

function _id_rows(
  connection: Database,
  source: string,
  ids: readonly string[],
  limit: number,
): Record<string, unknown>[] {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(",");
  return connection
    .query(
      `SELECT rowid AS __rowid, * FROM "${source}" WHERE id IN (${placeholders}) LIMIT ?`,
    )
    .all(...ids, limit) as Record<string, unknown>[];
}

function _dedupe_rows(
  rows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];
  for (const row of rows) {
    const key = JSON.stringify([
      row["__rowid"] ?? null,
      row["id"] ?? null,
      row["address"] ?? null,
      row["primaryaddress"] ?? null,
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function _owner_related_rows_by_id(
  evidence: AddressEvidence,
  source: string,
): Record<string, unknown>[] {
  const ids = new Set(evidence.owner_ids);
  return rowsOf(evidence, source).filter((row) =>
    ids.has(String(firstTruthy(row["id"], ""))),
  );
}

function _owner_elsewhere_rows(
  evidence: AddressEvidence,
  sources: readonly string[],
): Array<[string, Record<string, unknown>]> {
  const rows: Array<[string, Record<string, unknown>]> = [];
  for (const source of sources) {
    for (const row of _owner_related_rows_by_id(evidence, source)) {
      const norm = _normalize_address(firstTruthy(row["address"], row["primaryaddress"]));
      if (norm && norm !== evidence.normalized_address) {
        rows.push([source, row]);
      }
    }
  }
  return rows;
}

function _owner_summary(
  row: Record<string, unknown>,
  normalized_address: string,
): Record<string, unknown> {
  const mailing = _normalize_address(row["owneraddressline1"]);
  return {
    owner_name: firstTruthy(row["ownername"], ""),
    mailing_address: firstTruthy(row["owneraddressline1"], ""),
    mailing_matches_subject: mailing ? mailing === normalized_address : null,
    source: "tax",
  };
}

function _owner_presence_hints(
  rows: Record<string, readonly Record<string, unknown>[]>,
  owner_ids: readonly string[],
  owner_name_keys: readonly (readonly [string, string])[],
): string[] {
  const evidence = makeAddressEvidence({
    address: "",
    normalized_address: "",
    zip: "",
    rows,
    owner_ids,
    owner_name_keys,
    source_counts: {},
    owner_summaries: [],
  });
  const hints: string[] = [];
  for (const source of ["base", "loan", "drive", "voter", "auto", "trace"]) {
    if ((rows[source] ?? []).some((row) => _is_owner_row(row, evidence))) {
      hints.push(`Owner-like row appears in ${source}.`);
    }
  }
  if ((rows["utility"] ?? []).some((row) => _is_owner_name_row(row, evidence))) {
    hints.push("Owner-like row appears in utility.");
  }
  return hints;
}

function _owner_elsewhere_hints(
  connection: Database,
  normalized_address: string,
  owner_ids: readonly string[],
  tax_rows: readonly Record<string, unknown>[],
  limit: number,
): string[] {
  const hints: string[] = [];
  for (const row of tax_rows) {
    const mailing = _normalize_address(row["owneraddressline1"]);
    if (mailing && mailing !== normalized_address) {
      hints.push("Tax owner mailing differs from selected address.");
    }
  }
  if (owner_ids.length === 0) {
    return hints;
  }
  const placeholders = owner_ids.map(() => "?").join(",");
  for (const source of ["drive", "voter", "auto", "trace", "loan"]) {
    const rows = connection
      .query(
        `SELECT rowid AS __rowid, * FROM "${source}" WHERE id IN (${placeholders}) LIMIT ?`,
      )
      .all(...owner_ids, limit) as Record<string, unknown>[];
    for (const row of rows) {
      const norm = _normalize_address(firstTruthy(row["address"], row["primaryaddress"]));
      if (norm && norm !== normalized_address) {
        hints.push(`Owner-linked ${source} row points away from selected address.`);
        break;
      }
    }
  }
  return hints;
}

function _nonowner_hints(
  rows: Record<string, readonly Record<string, unknown>[]>,
  owner_ids: readonly string[],
  owner_name_keys: readonly (readonly [string, string])[],
): string[] {
  const evidence = makeAddressEvidence({
    address: "",
    normalized_address: "",
    zip: "",
    rows,
    owner_ids,
    owner_name_keys,
    source_counts: {},
    owner_summaries: [],
  });
  const hints: string[] = [];
  for (const source of ["base", "loan", "drive", "voter", "auto", "trace", "utility"]) {
    if ((rows[source] ?? []).some((row) => !_is_owner_row(row, evidence))) {
      hints.push(`Non-owner-like row appears in ${source}.`);
    }
  }
  return hints;
}

function _owner_name_keys(
  tax_rows: readonly Record<string, unknown>[],
): Array<[string, string]> {
  const seen = new Map<string, [string, string]>();
  for (const row of tax_rows) {
    const key = _person_key(row);
    if (_anyKey(key)) {
      seen.set(_encodeKey(key), key);
    }
    const ownername_key = _ownername_key(row["ownername"]);
    if (ownername_key) {
      seen.set(_encodeKey(ownername_key), ownername_key);
    }
  }
  return [...seen.values()];
}

function _ownername_key(value: unknown): [string, string] | null {
  const text = String(firstTruthy(value, "")).trim();
  if (!text) {
    return null;
  }
  if (text.includes(",")) {
    const idx = text.indexOf(",");
    const last = text.slice(0, idx);
    const first = text.slice(idx + 1);
    return [_norm(first.split(";")[0]), _norm(last.split(";")[0])];
  }
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return [_norm(parts[0]), _norm(parts[parts.length - 1])];
  }
  return null;
}

function _is_owner_row(
  row: Record<string, unknown>,
  evidence: AddressEvidence,
): boolean {
  const row_id = String(firstTruthy(row["id"], ""));
  if (row_id && evidence.owner_ids.includes(row_id)) {
    return true;
  }
  return _is_owner_name_row(row, evidence);
}

function _is_owner_name_row(
  row: Record<string, unknown>,
  evidence: AddressEvidence,
): boolean {
  const key = _person_key(row);
  return (
    _anyKey(key) &&
    evidence.owner_name_keys.some((k) => k[0] === key[0] && k[1] === key[1])
  );
}

function _person_key(row: Record<string, unknown>): [string, string] {
  const first = firstTruthy(row["firstname"], row["first_name"], row["firstName"], "");
  const last = firstTruthy(row["lastname"], row["last_name"], row["lastName"], "");
  return [_norm(first), _norm(last)];
}

function _portfolio_rows(evidence: AddressEvidence): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const row of rowsOf(evidence, "tax")) {
    let count: number;
    const parsed = Number(String(firstTruthy(row["ownerrescount"], "0")));
    // Parse ownerrescount as an integer, truncating toward zero; unparseable values become 0.
    count = Number.isNaN(parsed) ? 0 : Math.trunc(parsed);
    if (count >= 2) {
      rows.push(row);
    }
  }
  return rows;
}

function _refs(
  source: string,
  rows: readonly Record<string, unknown>[],
): EvidenceRef[] {
  return rows.slice(0, 5).map((row) => _ref(source, row));
}

function _refs_multi(
  rows: readonly [string, Record<string, unknown>][],
): EvidenceRef[] {
  return rows.slice(0, 8).map(([source, row]) => _ref(source, row));
}

function _ref(source: string, row: Record<string, unknown>): EvidenceRef {
  const rowid = row["__rowid"];
  const publicEntries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(row)) {
    if (!String(key).startsWith("__")) {
      publicEntries.push([key, value]);
    }
  }
  const publicData: Record<string, unknown> = Object.fromEntries(publicEntries);
  const digest = new Bun.CryptoHasher("sha1")
    .update(_canonical_json_dumps(publicData))
    .digest("hex")
    .slice(0, 8);
  const nameParts: string[] = [];
  const first = String(
    firstTruthy(publicData["firstname"], publicData["first_name"], publicData["firstName"], ""),
  ).trim();
  const last = String(
    firstTruthy(publicData["lastname"], publicData["last_name"], publicData["lastName"], ""),
  ).trim();
  if (first) {
    nameParts.push(first);
  }
  if (last) {
    nameParts.push(last);
  }
  const name = nameParts.join(" ");
  const summary =
    name ||
    String(
      firstTruthy(
        publicData["ownername"],
        publicData["address"],
        publicData["primaryaddress"],
        digest,
      ),
    );
  return makeEvidenceRef({
    source,
    rowid: rowid !== null && rowid !== undefined ? Math.trunc(Number(rowid)) : null,
    summary,
    data: publicData,
  });
}

function _tax_lien_present(row: Record<string, unknown>): boolean {
  return (
    _truthy(row["totalliencount"]) ||
    hasContent(row["totallienbalance"]) ||
    hasContent(row["lendername"])
  );
}

function _base_mortgage_present(row: Record<string, unknown>): boolean {
  return (
    hasContent(row["mortgageamountinthousands"]) ||
    hasContent(row["mortgagelendername"]) ||
    hasContent(row["refinanceamountinthousands"]) ||
    hasContent(row["refinancelendername"])
  );
}

function _own_rent(row: Record<string, unknown>): string {
  const value = _norm(firstTruthy(row["own_rent"], row["ownRent"]));
  if (value === "own" || value === "owner" || value === "1") {
    return "own";
  }
  if (value === "rent" || value === "renter" || value === "0") {
    return "rent";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Primitive helpers

const POSITIVE_TRUTHY: ReadonlySet<string> = new Set(["1", "true", "t", "yes", "y"]);
const NEGATIVE_TRUTHY: ReadonlySet<string> = new Set([
  "0",
  "false",
  "f",
  "no",
  "n",
  "none",
  "null",
]);

function _truthy(value: unknown): boolean {
  const n = _norm(value);
  if (POSITIVE_TRUTHY.has(n)) {
    return true;
  }
  return hasContent(value) && !NEGATIVE_TRUTHY.has(n);
}

// Coerce to string, collapse internal whitespace to single spaces, trim, and lowercase.
function _norm(value: unknown): string {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function _normalize_address(value: unknown): string {
  return normalize_address_value(String(value || "")).value;
}

// True when the value carries content: null/undefined/""/0/false and empty arrays/objects count as empty.
function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

// Returns the first content-bearing value, else the last argument.
function firstTruthy(...values: unknown[]): unknown {
  for (let i = 0; i < values.length; i += 1) {
    if (i === values.length - 1) {
      return values[i];
    }
    if (hasContent(values[i])) {
      return values[i];
    }
  }
  return undefined;
}

function rowsOf(
  evidence: AddressEvidence,
  source: string,
): readonly Record<string, unknown>[] {
  return evidence.rows[source] ?? [];
}

function _anyKey(key: readonly [string, string]): boolean {
  return key[0].length > 0 || key[1].length > 0;
}

function _keysEqual(a: readonly [string, string], b: readonly [string, string]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

// Null-byte delimiter keeps the (first, last) encoding injective for names
// that contain spaces, so the pair can key a map/set as a single string.
function _encodeKey(key: readonly [string, string]): string {
  return `${key[0]}\u0000${key[1]}`;
}

function _toStringTuple(item: unknown): [string, string] {
  const arr = asArray(item) ?? [];
  return [String(arr[0] ?? ""), String(arr[1] ?? "")];
}

function _compareStringTuple(
  a: readonly [string, string],
  b: readonly [string, string],
): number {
  if (a[0] !== b[0]) {
    return a[0] < b[0] ? -1 : 1;
  }
  if (a[1] !== b[1]) {
    return a[1] < b[1] ? -1 : 1;
  }
  return 0;
}

function _intersects(candidates: readonly string[], set: ReadonlySet<string>): boolean {
  return candidates.some((item) => set.has(item));
}

function _subset(candidates: readonly string[], set: ReadonlySet<string>): boolean {
  return candidates.every((item) => set.has(item));
}

function _top_counts(
  counts: Record<string, number>,
  limit = 10,
): Array<Record<string, unknown>> {
  return Object.entries(counts)
    .sort(([aKey, aCount], [bKey, bCount]) => {
      if (aCount !== bCount) {
        return bCount - aCount;
      }
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    })
    .slice(0, limit)
    .map(([key, value]) => ({ id: key, count: value }));
}

// Current UTC time formatted as "YYYY-MM-DDTHH:MM:SS+00:00" (second precision).
function _now_iso_seconds(): string {
  return `${new Date().toISOString().slice(0, 19)}+00:00`;
}

// Canonical JSON with sorted keys, ASCII-escaped output, and ", "/": " separators.
// Used only to derive the fallback EvidenceRef digest. Whole-number floats render
// without a trailing ".0" (2.0 -> "2"); this only affects the rare all-empty-name
// digest fallback.
function _canonical_json_dumps(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return _canonical_json_string(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => _canonical_json_dumps(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries
      .map(([k, v]) => `${_canonical_json_string(k)}: ${_canonical_json_dumps(v)}`)
      .join(", ")}}`;
  }
  return _canonical_json_string(String(value));
}

function _canonical_json_string(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"') {
      out += '\\"';
    } else if (char === "\\") {
      out += "\\\\";
    } else if (char === "\n") {
      out += "\\n";
    } else if (char === "\r") {
      out += "\\r";
    } else if (char === "\t") {
      out += "\\t";
    } else if (char === "\b") {
      out += "\\b";
    } else if (char === "\f") {
      out += "\\f";
    } else if (code < 0x20 || code > 0x7e) {
      if (code > 0xffff) {
        const high = 0xd800 + ((code - 0x10000) >> 10);
        const low = 0xdc00 + ((code - 0x10000) & 0x3ff);
        out += `\\u${high.toString(16).padStart(4, "0")}`;
        out += `\\u${low.toString(16).padStart(4, "0")}`;
      } else {
        out += `\\u${code.toString(16).padStart(4, "0")}`;
      }
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

// ---------------------------------------------------------------------------
// Small dict/array narrowing helpers

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _isAtomicReport(
  value: AtomicEvaluationReport | Record<string, unknown>,
): value is AtomicEvaluationReport {
  return (
    value !== null &&
    typeof value === "object" &&
    "gate_evaluations" in value &&
    "synthesis" in value &&
    "heuristics" in value &&
    !("packet_evaluations" in value)
  );
}
