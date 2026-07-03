// Port of occupancy_engine/heuristics/types.py.
// @dataclass(frozen=True) -> readonly interface fields + builder functions that
// apply the same defaults Python's dataclass field defaults provide.

export type PacketDecision = "run" | "skip" | "run_for_absence";

export type VerdictBandCandidate =
  | "low_evidence"
  | "monitor"
  | "review"
  | "high_priority_review"
  | "manual_verification";

export type CaseArchetypeCandidate =
  | "clear_absentee_rental"
  | "family_household_rental"
  | "owner_present_with_rental_indicators"
  | "ambiguous_nonowner_occupancy"
  | "non_rental_absentee_owner"
  | "mixed_evidence"
  | "insufficient_ownership_data"
  | "low_evidence_owner_occupied";

export interface PacketGate {
  readonly source_scope: readonly string[];
  readonly minimum_viability: string;
  readonly absence_sensitive: boolean;
}

export function makePacketGate(init: {
  source_scope: readonly string[];
  minimum_viability: string;
  absence_sensitive?: boolean;
}): PacketGate {
  return {
    source_scope: init.source_scope,
    minimum_viability: init.minimum_viability,
    absence_sensitive: init.absence_sensitive ?? false,
  };
}

export interface PacketDefinition {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly atomic_heuristic_ids: readonly string[];
  readonly input_sources: readonly string[];
  readonly output_fields: readonly string[];
  readonly agent_guidance: string;
  readonly gate: PacketGate;
  readonly group: string | null;
  readonly category: string;
  readonly confidence: string;
  readonly score: number;
  readonly score_cap: number;
}

export function makePacketDefinition(init: {
  id: string;
  title: string;
  description: string;
  atomic_heuristic_ids: readonly string[];
  input_sources: readonly string[];
  output_fields: readonly string[];
  agent_guidance: string;
  gate: PacketGate;
  group?: string | null;
  category?: string;
  confidence?: string;
  score?: number;
  score_cap?: number;
}): PacketDefinition {
  return {
    id: init.id,
    title: init.title,
    description: init.description,
    atomic_heuristic_ids: init.atomic_heuristic_ids,
    input_sources: init.input_sources,
    output_fields: init.output_fields,
    agent_guidance: init.agent_guidance,
    gate: init.gate,
    group: init.group ?? null,
    category: init.category ?? "risk",
    confidence: init.confidence ?? "medium",
    score: init.score ?? 2,
    score_cap: init.score_cap ?? 6,
  };
}

export interface PacketGateEvaluation {
  readonly packet_id: string;
  readonly decision: PacketDecision;
  readonly reason: string;
  readonly expected_sources: readonly string[];
  readonly present_sources: readonly string[];
  readonly missing_sources: readonly string[];
  readonly atomic_gate_decisions: ReadonlyArray<Record<string, unknown>>;
  readonly field_presence: Record<string, unknown>;
  readonly missing_core_fields: readonly string[];
  readonly deterministic_notes: readonly string[];
}

export function makePacketGateEvaluation(init: {
  packet_id: string;
  decision: PacketDecision;
  reason: string;
  expected_sources: readonly string[];
  present_sources: readonly string[];
  missing_sources: readonly string[];
  atomic_gate_decisions: ReadonlyArray<Record<string, unknown>>;
  field_presence?: Record<string, unknown>;
  missing_core_fields?: readonly string[];
  deterministic_notes?: readonly string[];
}): PacketGateEvaluation {
  return {
    packet_id: init.packet_id,
    decision: init.decision,
    reason: init.reason,
    expected_sources: init.expected_sources,
    present_sources: init.present_sources,
    missing_sources: init.missing_sources,
    atomic_gate_decisions: init.atomic_gate_decisions,
    field_presence: init.field_presence ?? {},
    missing_core_fields: init.missing_core_fields ?? [],
    deterministic_notes: init.deterministic_notes ?? [],
  };
}

export interface PacketFieldGateSignal {
  readonly should_run: boolean;
  readonly reason: string;
  readonly field_presence: Record<string, unknown>;
  readonly missing_core_fields: readonly string[];
  readonly deterministic_notes: readonly string[];
}

export function makePacketFieldGateSignal(init: {
  should_run: boolean;
  reason: string;
  field_presence?: Record<string, unknown>;
  missing_core_fields?: readonly string[];
  deterministic_notes?: readonly string[];
}): PacketFieldGateSignal {
  return {
    should_run: init.should_run,
    reason: init.reason,
    field_presence: init.field_presence ?? {},
    missing_core_fields: init.missing_core_fields ?? [],
    deterministic_notes: init.deterministic_notes ?? [],
  };
}

export interface PacketEvaluation {
  readonly packet_id: string;
  readonly status: string;
  readonly atomic_heuristic_ids: readonly string[];
  readonly triggered_paths: readonly string[];
  readonly triggered_atomic_heuristics: readonly string[];
  readonly gate: PacketGateEvaluation;
  readonly reason: string;
}

export interface HeuristicsEvaluationReport {
  readonly query: Record<string, unknown>;
  readonly packet_gate_evaluations: readonly PacketGateEvaluation[];
  readonly packet_evaluations: readonly PacketEvaluation[];
  readonly atomic_heuristics: ReadonlyArray<Record<string, unknown>>;
  readonly triggered_paths: readonly string[];
  readonly synthesis: Record<string, unknown>;
  readonly caveats: readonly string[];
}

export interface SourceWeightAdjustment {
  readonly path_id: string;
  readonly base_score: number;
  readonly weighted_score: number;
  readonly applied_source: string | null;
  readonly reliability_weight: number;
  readonly reason: string;
}
