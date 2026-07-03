// Port of occupancy_engine/heuristics/adapters.py.
// Small adapters between GateEvaluation objects and the evidence-dict shapes the
// packet gate + engine layers consume.

import {
  makeAddressEvidence,
  type AddressEvidence,
  type GateEvaluation,
} from "./atomic_eval.ts";
import { SUBSTANTIVE_SOURCES } from "./policy.ts";

export function _atomic_gate_summary(gate: GateEvaluation): Record<string, unknown> {
  return {
    heuristic_id: gate.heuristic_id,
    decision: gate.decision,
    reason: gate.reason,
    present_sources: gate.present_sources,
    missing_sources: gate.missing_sources,
    triggered_gate_paths: gate.triggered_gate_paths,
  };
}

export function _evidence_from_report(
  atomic_report: Record<string, unknown>,
): AddressEvidence {
  const query = asRecord(atomic_report["query"]) ?? {};
  const rows: Record<string, readonly Record<string, unknown>[]> = {};
  for (const source of SUBSTANTIVE_SOURCES) {
    rows[source] = [];
  }
  return makeAddressEvidence({
    address: String(pyOr(query["address"], "")),
    normalized_address: String(pyOr(query["normalized_address"], "")),
    zip: String(pyOr(query["zip"], "")),
    rows,
    owner_ids: [],
    owner_name_keys: [],
    source_counts: {},
    owner_summaries: [],
  });
}

export function _evidence_from_report_dict(
  evidence: Record<string, unknown>,
): AddressEvidence {
  const source_counts_raw = asRecord(evidence["source_counts"]) ?? {};
  const evidenceRows = asRecord(evidence["rows"]) ?? {};
  const rows: Record<string, readonly Record<string, unknown>[]> = {};
  for (const source of SUBSTANTIVE_SOURCES) {
    rows[source] = (asArray(evidenceRows[source]) ?? []) as Record<string, unknown>[];
  }
  const source_counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(source_counts_raw)) {
    source_counts[String(key)] = Math.trunc(Number(pyOr(value, 0)));
  }
  return makeAddressEvidence({
    address: String(pyOr(evidence["address"], "")),
    normalized_address: String(pyOr(evidence["normalized_address"], "")),
    zip: String(pyOr(evidence["zip"], "")),
    rows,
    owner_ids: (asArray(evidence["owner_ids"]) ?? []).map((v) => String(v)),
    owner_name_keys: (asArray(evidence["owner_name_keys"]) ?? []).map((item) => {
      const arr = asArray(item) ?? [];
      return [String(arr[0] ?? ""), String(arr[1] ?? "")] as [string, string];
    }),
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

// PORT NOTE: `a or b`/truthiness helpers matching Python semantics.
function pyBool(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function pyOr(a: unknown, b: unknown): unknown {
  return pyBool(a) ? a : b;
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
