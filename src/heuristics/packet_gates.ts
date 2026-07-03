// Port of occupancy_engine/heuristics/packet_gates.py.
// Packet-level gating with field-aware (row-level) inspection. The
// case_quality_and_synthesis special-casing is preserved exactly.

import { _atomic_gate_summary, _evidence_from_report_dict } from "./adapters.ts";
import {
  evaluate_gates,
  isAddressEvidence,
  type AddressEvidence,
  type GateEvaluation,
} from "./atomic_eval.ts";
import { PACKETS } from "./packets.ts";
import { SUBSTANTIVE_SOURCES } from "./policy.ts";
import {
  makePacketFieldGateSignal,
  makePacketGateEvaluation,
  type PacketDecision,
  type PacketDefinition,
  type PacketFieldGateSignal,
  type PacketGateEvaluation,
} from "./types.ts";

export function evaluate_packet_gates(
  evidence: AddressEvidence | Record<string, unknown>,
): PacketGateEvaluation[] {
  const evidence_obj = isAddressEvidence(evidence)
    ? evidence
    : _evidence_from_report_dict(evidence);
  const gate_by_id: Record<string, GateEvaluation> = {};
  for (const gate of evaluate_gates(evidence_obj)) {
    gate_by_id[gate.heuristic_id] = gate;
  }
  return PACKETS.map((packet) =>
    evaluate_packet_gate(packet, evidence_obj, gate_by_id),
  );
}

export function evaluate_packet_gate(
  packet: PacketDefinition,
  evidence: AddressEvidence,
  atomic_gate_by_id: Record<string, GateEvaluation>,
): PacketGateEvaluation {
  const counts = evidence.source_counts;
  const present = packet.gate.source_scope.filter(
    (source) => (counts[source] ?? 0) > 0,
  );
  const missing = packet.gate.source_scope.filter(
    (source) => (counts[source] ?? 0) <= 0,
  );
  const atomics: Array<Record<string, unknown>> = [];
  for (const heuristic_id of packet.atomic_heuristic_ids) {
    const gate = atomic_gate_by_id[heuristic_id];
    if (gate !== undefined) {
      atomics.push(_atomic_gate_summary(gate));
    }
  }
  const field_signal = _evaluate_packet_field_gate(packet, evidence);

  if (packet.id === "case_quality_and_synthesis") {
    let decision: PacketDecision;
    let reason: string;
    if (present.length > 0 && (counts["tax"] ?? 0) > 0) {
      decision = "run";
      reason =
        field_signal.reason || `Substantive evidence exists: ${present.join(", ")}.`;
    } else {
      decision = "run_for_absence";
      reason =
        field_signal.reason ||
        "Sparse evidence or missing tax ownership must be documented during synthesis.";
    }
    return makePacketGateEvaluation({
      packet_id: packet.id,
      decision,
      reason,
      expected_sources: packet.gate.source_scope,
      present_sources: present,
      missing_sources: missing,
      atomic_gate_decisions: atomics,
      field_presence: field_signal.field_presence,
      missing_core_fields: field_signal.missing_core_fields,
      deterministic_notes: field_signal.deterministic_notes,
    });
  }

  const runnable = atomics.filter((item) => item["decision"] === "run");
  let reason: string;
  let decision: PacketDecision;
  if (field_signal.should_run) {
    reason = field_signal.reason;
    decision = "run";
  } else if (_has_no_row_payload(evidence) && runnable.length > 0) {
    reason =
      "At least one included atomic path has populated relevant evidence; " +
      "row-level field inspection was unavailable.";
    decision = "run";
  } else {
    reason =
      field_signal.reason ||
      "No included canonical packet paths have enough populated field-level evidence " +
        "for a first-pass worker.";
    decision = "skip";
  }
  return makePacketGateEvaluation({
    packet_id: packet.id,
    decision,
    reason,
    expected_sources: packet.gate.source_scope,
    present_sources: present,
    missing_sources: missing,
    atomic_gate_decisions: atomics,
    field_presence: field_signal.field_presence,
    missing_core_fields: field_signal.missing_core_fields,
    deterministic_notes: field_signal.deterministic_notes,
  });
}

function _evaluate_packet_field_gate(
  packet: PacketDefinition,
  evidence: AddressEvidence,
): PacketFieldGateSignal {
  if (packet.id === "property_tax_context") {
    return _field_gate_property_tax_context(evidence);
  }
  if (packet.id === "owner_identity_and_mailing") {
    return _field_gate_owner_identity_and_mailing(evidence);
  }
  if (packet.id === "subject_occupancy_surfaces") {
    return _field_gate_subject_occupancy_surfaces(evidence);
  }
  if (packet.id === "legal_address_presence") {
    return _field_gate_legal_address_presence(evidence);
  }
  if (packet.id === "loan_tenure") {
    return _field_gate_loan_tenure(evidence);
  }
  if (packet.id === "portfolio_and_primary_comparison") {
    return _field_gate_portfolio_and_primary_comparison(evidence);
  }
  if (packet.id === "case_quality_and_synthesis") {
    return _field_gate_case_quality_and_synthesis(evidence);
  }
  return makePacketFieldGateSignal({
    should_run: false,
    reason: "No canonical field-aware gate policy is defined for this packet.",
  });
}

function _field_gate_property_tax_context(
  evidence: AddressEvidence,
): PacketFieldGateSignal {
  const tax_rows = _rows(evidence, "tax");
  const base_rows = _rows(evidence, "base");
  const tax_context_rows = _count_rows_with(tax_rows, (row) =>
    _has_any(row, [
      "residential",
      "condo",
      "propertytype",
      "property_type",
      "buildingarea",
      "yearbuilt",
      "totalmarketvalue",
      "assessedvalue",
      "lendername",
      "totalliencount",
      "totallienbalance",
      "foreclosecode",
      "forecloserecorddate",
      "ownercompany",
      "ownerrescount",
    ]),
  );
  const base_mortgage_rows = _count_rows_with(base_rows, (row) =>
    _has_any(row, [
      "mortgageamountinthousands",
      "mortgagelendername",
      "refiamountinthousands",
      "refilendername",
      "homepurchaseprice",
      "homepurchasedate",
    ]),
  );
  const presence: Record<string, unknown> = {
    tax_rows: tax_rows.length,
    tax_context_rows,
    base_rows: base_rows.length,
    base_mortgage_or_refi_rows: base_mortgage_rows,
  };
  const notes = _ownerrescount_notes(tax_rows);
  if (tax_context_rows || base_mortgage_rows) {
    return makePacketFieldGateSignal({
      should_run: true,
      reason:
        "Tax/base rows include property context fields needed for residential, " +
        "lien, distress, entity-owner, or owner-count review.",
      field_presence: presence,
      deterministic_notes: notes,
    });
  }
  return makePacketFieldGateSignal({
    should_run: false,
    reason:
      "Tax/base rows do not contain populated property-context, lien, distress, " +
      "entity-owner, owner-count, mortgage, or refi fields.",
    field_presence: presence,
    missing_core_fields: ["tax.context_fields", "base.mortgage_or_refi_fields"],
    deterministic_notes: notes,
  });
}

function _field_gate_owner_identity_and_mailing(
  evidence: AddressEvidence,
): PacketFieldGateSignal {
  const tax_rows = _rows(evidence, "tax");
  const owner_identity_rows = _count_rows_with(tax_rows, (row) =>
    _has_identity(row, "tax"),
  );
  const mailing_comparison_rows = _count_rows_with(
    tax_rows,
    (row) =>
      _has_any(row, ["owneraddressline1", "owner_address", "mailingaddress"]) &&
      _has_any(row, ["address", "situsaddress", "addressformal"]),
  );
  const base_identity_rows = _count_rows_with(_rows(evidence, "base"), (row) =>
    _has_identity(row, "base"),
  );
  let comparable_rows = 0;
  for (const source of ["drive", "voter", "auto", "loan", "trace", "utility"]) {
    comparable_rows += _count_rows_with(
      _rows(evidence, source),
      (row) => _has_identity(row, source) && _has_address(row, source),
    );
  }
  const hint_count =
    evidence.owner_presence_hints.length +
    evidence.owner_elsewhere_hints.length +
    evidence.nonowner_occupancy_hints.length;
  const presence: Record<string, unknown> = {
    tax_rows: tax_rows.length,
    tax_owner_identity_rows: owner_identity_rows,
    tax_mailing_comparison_rows: mailing_comparison_rows,
    base_identity_rows,
    comparable_person_address_rows: comparable_rows,
    identity_hint_count: hint_count,
  };
  if (
    owner_identity_rows &&
    (mailing_comparison_rows || base_identity_rows || comparable_rows || hint_count)
  ) {
    return makePacketFieldGateSignal({
      should_run: true,
      reason:
        "Tax owner identity plus mailing/base/person comparison fields are " +
        "populated enough for owner identity and mailing review.",
      field_presence: presence,
    });
  }
  const missing: string[] = [];
  if (!owner_identity_rows) {
    missing.push("tax.owner_identity");
  }
  if (
    !(mailing_comparison_rows || base_identity_rows || comparable_rows || hint_count)
  ) {
    missing.push("identity_or_mailing_comparison_surface");
  }
  return makePacketFieldGateSignal({
    should_run: false,
    reason:
      "Owner identity packet lacks tax owner identity or any populated " +
      "mailing/base/person comparison surface.",
    field_presence: presence,
    missing_core_fields: missing,
  });
}

function _field_gate_subject_occupancy_surfaces(
  evidence: AddressEvidence,
): PacketFieldGateSignal {
  const trace_rows = _rows(evidence, "trace");
  const utility_rows = _rows(evidence, "utility");
  const usable_trace = _count_rows_with(
    trace_rows,
    (row) => _has_identity(row, "trace") && _has_address(row, "trace"),
  );
  const usable_utility = _count_rows_with(
    utility_rows,
    (row) => _has_identity(row, "utility") && _has_address(row, "utility"),
  );
  const distinctNames = new Set<string>();
  for (const [source, rows] of [
    ["trace", trace_rows],
    ["utility", utility_rows],
  ] as const) {
    for (const row of rows) {
      const name = _person_name_key(row, source);
      if (name) {
        distinctNames.add(_encodeKey(name));
      }
    }
  }
  const presence: Record<string, unknown> = {
    trace_rows: trace_rows.length,
    usable_trace_person_address_rows: usable_trace,
    utility_rows: utility_rows.length,
    usable_utility_person_address_rows: usable_utility,
    distinct_trace_utility_names: distinctNames.size,
  };
  const notes: string[] = [];
  if (trace_rows.length && !usable_trace) {
    notes.push("Trace rows exist but lack usable identity/address fields.");
  }
  if (utility_rows.length && !usable_utility) {
    notes.push("Utility rows exist but lack usable identity/address fields.");
  }
  if (usable_trace || usable_utility) {
    return makePacketFieldGateSignal({
      should_run: true,
      reason:
        "Trace or utility rows contain usable person identity plus address fields.",
      field_presence: presence,
      deterministic_notes: notes,
    });
  }
  return makePacketFieldGateSignal({
    should_run: false,
    reason:
      "Trace/utility rows do not contain usable person identity plus address " +
      "fields, so occupancy-surface review would be row-count driven only.",
    field_presence: presence,
    missing_core_fields: [
      "trace.person_identity_address",
      "utility.person_identity_address",
    ],
    deterministic_notes: notes,
  });
}

function _field_gate_legal_address_presence(
  evidence: AddressEvidence,
): PacketFieldGateSignal {
  const usable_by_source: Record<string, number> = {};
  for (const source of ["drive", "voter", "auto"]) {
    usable_by_source[source] = _count_rows_with(
      _rows(evidence, source),
      (row) => _has_identity(row, source) && _has_address(row, source),
    );
  }
  const presence: Record<string, unknown> = {
    drive_rows: _rows(evidence, "drive").length,
    usable_drive_person_address_rows: usable_by_source["drive"],
    voter_rows: _rows(evidence, "voter").length,
    usable_voter_person_address_rows: usable_by_source["voter"],
    auto_rows: _rows(evidence, "auto").length,
    usable_auto_person_address_rows: usable_by_source["auto"],
  };
  const notes = ["drive", "voter", "auto"]
    .filter(
      (source) =>
        _rows(evidence, source).length && !(usable_by_source[source] ?? 0),
    )
    .map((source) => `${source} rows exist but lack usable identity/address fields.`);
  if (Object.values(usable_by_source).some((count) => count > 0)) {
    return makePacketFieldGateSignal({
      should_run: true,
      reason:
        "Drive, voter, or auto rows include usable person identity plus address fields.",
      field_presence: presence,
      deterministic_notes: notes,
    });
  }
  return makePacketFieldGateSignal({
    should_run: false,
    reason:
      "Drive/voter/auto rows are absent or lack usable person identity plus " +
      "address fields for legal-address comparison.",
    field_presence: presence,
    missing_core_fields: [
      "drive.person_identity_address",
      "voter.person_identity_address",
      "auto.person_identity_address",
    ],
    deterministic_notes: notes,
  });
}

function _field_gate_loan_tenure(evidence: AddressEvidence): PacketFieldGateSignal {
  const loan_rows = _rows(evidence, "loan");
  const usable_loan = _count_rows_with(
    loan_rows,
    (row) => _has_identity(row, "loan") && _has_address(row, "loan"),
  );
  const tenure_rows = _count_rows_with(loan_rows, (row) =>
    _has_any(row, ["own_rent", "ownRent", "ownrent", "owner_renter"]),
  );
  const tax_owner_rows = _count_rows_with(_rows(evidence, "tax"), (row) =>
    _has_identity(row, "tax"),
  );
  const presence: Record<string, unknown> = {
    loan_rows: loan_rows.length,
    usable_loan_person_address_rows: usable_loan,
    loan_tenure_value_rows: tenure_rows,
    tax_owner_identity_rows: tax_owner_rows,
  };
  const notes: string[] = [];
  if (usable_loan && !tenure_rows) {
    notes.push(
      "Loan rows have identity/address but no populated own/rent tenure value; " +
        "classification is limited to owner/non-owner comparison.",
    );
  }
  if (usable_loan && (tenure_rows || tax_owner_rows)) {
    return makePacketFieldGateSignal({
      should_run: true,
      reason:
        "Loan rows contain usable person/address fields and either an " +
        "own/rent value or tax owner identity for owner/non-owner classification.",
      field_presence: presence,
      deterministic_notes: notes,
    });
  }
  const missing: string[] = [];
  if (!usable_loan) {
    missing.push("loan.person_identity_address");
  }
  if (!(tenure_rows || tax_owner_rows)) {
    missing.push("loan.own_rent_or_tax_owner_identity");
  }
  return makePacketFieldGateSignal({
    should_run: false,
    reason:
      "Loan rows do not contain usable identity/address fields plus either " +
      "own/rent tenure or tax owner identity.",
    field_presence: presence,
    missing_core_fields: missing,
    deterministic_notes: notes,
  });
}

function _field_gate_portfolio_and_primary_comparison(
  evidence: AddressEvidence,
): PacketFieldGateSignal {
  const tax_rows = _rows(evidence, "tax");
  const ownerrescounts: number[] = [];
  for (const row of tax_rows) {
    const value = _int_value(_row_value(row, "ownerrescount", "owner_res_count"));
    if (value !== null) {
      ownerrescounts.push(value);
    }
  }
  const ownerrescount_gt_one = ownerrescounts.filter((value) => value > 1).length;
  const owner_elsewhere_hints = evidence.owner_elsewhere_hints.length;
  let usable_owner_elsewhere_rows = 0;
  for (const source of ["base", "drive", "voter", "auto"]) {
    usable_owner_elsewhere_rows += _count_rows_with(
      _rows(evidence, source),
      (row) =>
        _has_identity(row, source) &&
        _has_address(row, source) &&
        _row_address_differs_from_subject(row, source, evidence),
    );
  }
  const presence: Record<string, unknown> = {
    tax_rows: tax_rows.length,
    ownerrescount_values: ownerrescounts,
    ownerrescount_gt_one_rows: ownerrescount_gt_one,
    owner_elsewhere_hint_count: owner_elsewhere_hints,
    usable_primary_comparison_rows: usable_owner_elsewhere_rows,
  };
  const notes = _ownerrescount_notes(tax_rows);
  if (ownerrescount_gt_one || owner_elsewhere_hints || usable_owner_elsewhere_rows) {
    return makePacketFieldGateSignal({
      should_run: true,
      reason:
        "Portfolio/primary comparison has owner-count, owner-elsewhere, " +
        "or usable primary-address comparison fields.",
      field_presence: presence,
      deterministic_notes: notes,
    });
  }
  return makePacketFieldGateSignal({
    should_run: false,
    reason:
      "Portfolio packet lacks ownerrescount > 1, owner-elsewhere hints, " +
      "or usable primary-address comparison rows.",
    field_presence: presence,
    missing_core_fields: [
      "tax.ownerrescount_gt_one",
      "owner_primary_elsewhere_surface",
    ],
    deterministic_notes: notes,
  });
}

function _field_gate_case_quality_and_synthesis(
  evidence: AddressEvidence,
): PacketFieldGateSignal {
  const substantive_sources = SUBSTANTIVE_SOURCES.filter(
    (source) => (evidence.source_counts[source] ?? 0) > 0,
  );
  const presence: Record<string, unknown> = {
    substantive_sources,
    source_counts: { ...evidence.source_counts },
    data_gap_count: evidence.data_gaps.length,
  };
  if (substantive_sources.length > 0 && (evidence.source_counts["tax"] ?? 0) > 0) {
    return makePacketFieldGateSignal({
      should_run: true,
      reason: `Substantive evidence exists: ${substantive_sources.join(", ")}.`,
      field_presence: presence,
    });
  }
  return makePacketFieldGateSignal({
    should_run: true,
    reason:
      "Sparse evidence or missing tax ownership must be documented during synthesis.",
    field_presence: presence,
    deterministic_notes: evidence.data_gaps,
  });
}

// ---------------------------------------------------------------------------
// Field helpers

function _rows(
  evidence: AddressEvidence,
  source: string,
): readonly Record<string, unknown>[] {
  return evidence.rows[source] ?? [];
}

function _has_no_row_payload(evidence: AddressEvidence): boolean {
  return !SUBSTANTIVE_SOURCES.some((source) => (evidence.rows[source] ?? []).length > 0);
}

function _count_rows_with(
  rows: readonly Record<string, unknown>[],
  predicate: (row: Record<string, unknown>) => boolean,
): number {
  return rows.filter((row) => predicate(row)).length;
}

function _has_any(row: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.some((field_name) => _is_populated(_row_value(row, field_name)));
}

function _row_value(row: Record<string, unknown>, ...fields: string[]): unknown {
  if (!row || Object.keys(row).length === 0) {
    return null;
  }
  for (const field_name of fields) {
    if (field_name in row) {
      return row[field_name];
    }
  }
  const lowered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    lowered[String(key).toLowerCase()] = value;
  }
  for (const field_name of fields) {
    const value = lowered[field_name.toLowerCase()];
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function _is_populated(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const text = String(value).trim();
  return text.length > 0 && !["none", "null", "nan"].includes(text.toLowerCase());
}

function _has_identity(row: Record<string, unknown>, source: string): boolean {
  if (source === "tax") {
    return (
      _has_any(row, ["ownername", "ownercompany"]) ||
      (_is_populated(_row_value(row, "firstname", "first_name", "firstName")) &&
        _is_populated(_row_value(row, "lastname", "last_name", "lastName")))
    );
  }
  return _person_name_key(row, source) !== null;
}

function _has_address(row: Record<string, unknown>, source: string): boolean {
  if (source === "tax") {
    return _has_any(row, [
      "address",
      "situsaddress",
      "addressformal",
      "owneraddressline1",
    ]);
  }
  if (source === "base") {
    return _has_any(row, ["primaryaddress", "address"]);
  }
  return _has_any(row, ["address", "primaryaddress"]);
}

function _row_address_differs_from_subject(
  row: Record<string, unknown>,
  source: string,
  evidence: AddressEvidence,
): boolean {
  let value: unknown;
  if (source === "base") {
    value = _row_value(row, "primaryaddress", "address");
  } else if (source === "tax") {
    value = _row_value(row, "address", "situsaddress", "addressformal");
  } else {
    value = _row_value(row, "address", "primaryaddress");
  }
  const row_key = _simple_address_key(value);
  const subject_key = _simple_address_key(
    evidence.normalized_address || evidence.address,
  );
  return Boolean(row_key && subject_key && row_key !== subject_key);
}

function _simple_address_key(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/,/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function _person_name_key(
  row: Record<string, unknown>,
  source: string,
): [string, string] | null {
  if (source === "tax") {
    const owner = String(_row_value(row, "ownername", "ownercompany") || "").trim();
    if (owner) {
      return [owner.toLowerCase(), ""];
    }
  }
  const first = String(
    _row_value(row, "firstname", "first_name", "firstName", "first") || "",
  ).trim();
  const last = String(
    _row_value(row, "lastname", "last_name", "lastName", "last") || "",
  ).trim();
  if (first || last) {
    return [first.toLowerCase(), last.toLowerCase()];
  }
  const name = String(_row_value(row, "name", "fullname", "full_name") || "").trim();
  if (name) {
    return [name.toLowerCase(), ""];
  }
  return null;
}

function _int_value(value: unknown): number | null {
  if (!_is_populated(value)) {
    return null;
  }
  const parsed = Number(String(value).trim());
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function _ownerrescount_notes(
  tax_rows: readonly Record<string, unknown>[],
): readonly string[] {
  const notes: string[] = [];
  const values: number[] = [];
  for (const row of tax_rows) {
    const value = _int_value(_row_value(row, "ownerrescount", "owner_res_count"));
    if (value !== null) {
      values.push(value);
    }
  }
  if (values.length > 0 && Math.max(...values) <= 1) {
    notes.push(
      "Tax ownerrescount is populated but does not indicate multiple properties.",
    );
  }
  return notes;
}

// Encodes a (first, last) name key injectively (null-byte delimiter) to match
// Python's tuple-keyed set membership for distinct-name counting.
function _encodeKey(key: readonly [string, string]): string {
  return `${key[0]}\u0000${key[1]}`;
}
