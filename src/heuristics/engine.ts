// Top-level packet evaluation: runs the atomic engine, packet gates, per-packet
// rollups, and the weighted synthesis into a single HeuristicsEvaluationReport.

import { asdict } from "./atomic.ts";
import { _evidence_from_report, _evidence_from_report_dict } from "./adapters.ts";
import {
  build_evidence,
  evaluate_atomic_evidence,
  evaluate_gates,
  isAddressEvidence,
  type AddressEvidence,
  type GateEvaluation,
} from "./atomic_eval.ts";
import { evaluate_packet_gate } from "./packet_gates.ts";
import { PACKETS } from "./packets.ts";
import { weighted_synthesis } from "./synthesis.ts";
import type {
  HeuristicsEvaluationReport,
  PacketDefinition,
  PacketEvaluation,
  PacketGateEvaluation,
} from "./types.ts";

interface EvidenceBuildOptions {
  zip?: string | null;
  db_path?: string;
  limit_per_source?: number;
}

export function evaluate_address(
  address: string,
  opts: EvidenceBuildOptions = {},
): Record<string, unknown> {
  const evidence = build_evidence(address, opts);
  return asdict(evaluate_evidence(evidence)) as Record<string, unknown>;
}

export function evaluate_evidence(
  evidence: AddressEvidence | Record<string, unknown>,
): HeuristicsEvaluationReport {
  const atomic_report_obj = evaluate_atomic_evidence(evidence);
  const atomic_report = asdict(atomic_report_obj) as Record<string, unknown>;
  let evidence_obj: AddressEvidence;
  if (isAddressEvidence(evidence)) {
    evidence_obj = evidence;
  } else if (isPlainRecord(evidence) && "source_counts" in evidence) {
    evidence_obj = _evidence_from_report_dict(evidence);
  } else {
    evidence_obj = _evidence_from_report(atomic_report);
  }
  const atomic_gates = evaluate_gates(evidence_obj);
  const gate_by_id: Record<string, GateEvaluation> = {};
  for (const gate of atomic_gates) {
    gate_by_id[gate.heuristic_id] = gate;
  }
  const packet_gates = PACKETS.map((packet) =>
    evaluate_packet_gate(packet, evidence_obj, gate_by_id),
  );
  const packet_gate_by_id: Record<string, PacketGateEvaluation> = {};
  for (const gate of packet_gates) {
    packet_gate_by_id[gate.packet_id] = gate;
  }
  const atomic_heuristics = (asArray(atomic_report["heuristics"]) ??
    []) as Record<string, unknown>[];
  const atomic_by_id: Record<string, Record<string, unknown>> = {};
  for (const item of atomic_heuristics) {
    if (isPlainRecord(item)) {
      atomic_by_id[String(item["heuristic_id"])] = item;
    }
  }
  const packet_evaluations = PACKETS.map((packet) => {
    const gate = packet_gate_by_id[packet.id];
    if (gate === undefined) {
      throw new Error(`Missing packet gate evaluation: ${packet.id}`);
    }
    return _evaluate_packet(packet, gate, atomic_by_id);
  });
  const atomic_synthesis = asRecord(atomic_report["synthesis"]) ?? {};
  const final_synthesis = weighted_synthesis({
    atomic_synthesis,
    atomic_heuristics,
    evidence: evidence_obj,
  });
  const query = asRecord(atomic_report["query"]) ?? {};
  return {
    query: {
      address: query["address"],
      normalized_address: query["normalized_address"],
      zip: query["zip"],
      run_at: _now_iso_seconds(),
      engine: "heuristics",
    },
    packet_gate_evaluations: packet_gates,
    packet_evaluations,
    atomic_heuristics,
    triggered_paths: (asArray(atomic_report["triggered_paths"]) ?? []).map((v) =>
      String(v),
    ),
    synthesis: final_synthesis,
    caveats: (asArray(atomic_report["caveats"]) ?? []).map((v) => String(v)),
  };
}

function _evaluate_packet(
  packet: PacketDefinition,
  gate: PacketGateEvaluation,
  atomic_by_id: Record<string, Record<string, unknown>>,
): PacketEvaluation {
  const atomics: Record<string, unknown>[] = [];
  for (const heuristic_id of packet.atomic_heuristic_ids) {
    const atomic = atomic_by_id[heuristic_id];
    if (atomic !== undefined) {
      atomics.push(atomic);
    }
  }
  const triggered_paths: string[] = [];
  for (const atomic of atomics) {
    for (const path of asArray(atomic["path_results"]) ?? []) {
      if (!isPlainRecord(path)) {
        continue;
      }
      const status = path["status"];
      const pathId = path["path_id"];
      if (_isActive(status) && pathId) {
        triggered_paths.push(String(pathId));
      }
    }
  }
  const triggered_atomic: string[] = [];
  for (const atomic of atomics) {
    if (_isActive(atomic["status"])) {
      triggered_atomic.push(String(atomic["heuristic_id"]));
    }
  }
  let status: string;
  if (gate.decision === "skip") {
    status = "skipped";
  } else if (triggered_paths.length > 0 || triggered_atomic.length > 0) {
    status = "triggered";
  } else {
    status = "inconclusive";
  }
  return {
    packet_id: packet.id,
    status,
    atomic_heuristic_ids: packet.atomic_heuristic_ids,
    triggered_paths,
    triggered_atomic_heuristics: triggered_atomic,
    gate,
    reason: gate.reason,
  };
}

// ---------------------------------------------------------------------------
// Helpers

function _isActive(status: unknown): boolean {
  return (
    status === "triggered" ||
    status === "context" ||
    status === "mitigation" ||
    status === "quality"
  );
}

// ISO-8601 timestamp truncated to whole seconds, with an explicit UTC offset.
function _now_iso_seconds(): string {
  return `${new Date().toISOString().slice(0, 19)}+00:00`;
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
