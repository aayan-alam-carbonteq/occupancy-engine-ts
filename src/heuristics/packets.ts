// Port of occupancy_engine/heuristics/packets.py.
// PacketDefinition catalog (incl. the `group` field and the two group
// assignments occupancy_presence / owner_property_context) plus the catalog
// accessors the agent layer consumes.

import { asdict } from "./atomic.ts";
import { ATOMIC_HEURISTICS } from "./atomic_eval.ts";
import {
  SUBSTANTIVE_SOURCES,
  source_reliability_policy as _source_reliability_policy,
} from "./policy.ts";
import {
  makePacketDefinition,
  makePacketGate,
  type PacketDefinition,
} from "./types.ts";

export const PACKETS: readonly PacketDefinition[] = [
  makePacketDefinition({
    id: "property_tax_context",
    title: "Property tax context",
    description:
      "Review property exposure context: residential subject, lien/mortgage exposure, " +
      "foreclosure/distress, entity/trust ownership, single-family context, and owner portfolio count.",
    atomic_heuristic_ids: [
      "residential_tax_subject",
      "liened_residential_subject",
      "base_mortgage_or_refi_at_subject",
      "foreclosure_or_distress_marker",
      "company_or_trust_owner",
      "single_family_clean_address_context",
      "tax_ownerrescount_portfolio_pattern",
    ],
    input_sources: ["tax", "base"],
    output_fields: [
      "residential_subject",
      "lien_exposure",
      "base_mortgage_or_refi_exposure",
      "distress_markers",
      "entity_or_trust_owner",
      "single_family_context",
      "ownerrescount_context",
    ],
    agent_guidance:
      "Inspect the tax rows once and separate context, risk, and mitigation. " +
      "Do not infer rental use from tax rows alone; identify whether the property is a viable residential subject " +
      "and whether ownership/exposure makes later occupancy evidence more important.",
    gate: makePacketGate({
      source_scope: ["tax", "base"],
      minimum_viability:
        "Run when tax or base mortgage/refi rows exist at the selected address.",
    }),
    group: "owner_property_context",
    category: "context",
    score: 0,
    score_cap: 3,
  }),
  makePacketDefinition({
    id: "owner_identity_and_mailing",
    title: "Owner identity and mailing",
    description:
      "Compare tax owner identity, mailing-vs-situs address, and base person alignment at the subject.",
    atomic_heuristic_ids: [
      "owner_identity_and_cross_source_context",
      "tax_mailing_situs_analysis",
      "base_subject_owner_alignment",
    ],
    input_sources: ["tax", "base", "drive", "voter", "auto", "loan", "trace", "utility"],
    output_fields: [
      "tax_owner_identity",
      "mailing_situs_relationship",
      "base_owner_alignment",
      "same_surname_or_family_context",
      "owner_present_vs_absent_context",
    ],
    agent_guidance:
      "Resolve owner names from tax first, then compare mailing/situs and base rows. " +
      "Call out same-surname family context separately from unrelated non-owner evidence.",
    gate: makePacketGate({
      source_scope: [
        "tax",
        "base",
        "drive",
        "voter",
        "auto",
        "loan",
        "trace",
        "utility",
      ],
      minimum_viability:
        "Run when tax owner rows exist and at least one identity or comparison path is relevant.",
    }),
    group: "owner_property_context",
    category: "risk",
    score: 2,
    score_cap: 6,
  }),
  makePacketDefinition({
    id: "subject_occupancy_surfaces",
    title: "Subject occupancy surfaces",
    description:
      "Review trace and utility subject-address occupancy evidence and their trace-only/utility-only discounts.",
    atomic_heuristic_ids: [
      "trace_address_subject_analysis",
      "utility_subject_occupancy_analysis",
      "utility_only_no_dates_discount",
      "trace_only_presence_discount",
    ],
    input_sources: ["trace", "utility", "tax", "drive", "voter", "auto", "loan"],
    output_fields: [
      "owner_trace_or_utility_at_subject",
      "nonowner_trace_or_utility_at_subject",
      "multiple_nonowner_names",
      "trace_only_discount",
      "utility_only_discount",
    ],
    agent_guidance:
      "Use trace and utility rows as occupancy signals, but explicitly discount them when they are isolated " +
      "or undated. Separate owner-present utility/trace from non-owner utility/trace. Non-owner utility " +
      "rows with no service dates and no corroboration from base, trace, drive, voter, auto, or loan should " +
      "be treated as ambiguous or historical occupancy evidence rather than strong current rental evidence. " +
      "High risk requires dated/current non-owner utility evidence or corroboration from a stronger/current " +
      "source; owner utility plus tax/base/trace owner alignment is mitigating context.",
    gate: makePacketGate({
      source_scope: ["trace", "utility", "tax", "drive", "voter", "auto", "loan"],
      minimum_viability:
        "Run when trace or utility rows exist, including trace-only/utility-only cases.",
    }),
    group: "occupancy_presence",
    category: "risk",
    score: 2,
    score_cap: 6,
  }),
  makePacketDefinition({
    id: "legal_address_presence",
    title: "Legal address presence",
    description:
      "Review drive, voter, and auto address evidence for owner/non-owner presence, conflicts, and auto-only caveats.",
    atomic_heuristic_ids: [
      "drive_address_subject_analysis",
      "voter_address_subject_analysis",
      "auto_address_subject_analysis",
      "owner_legal_records_conflict",
      "auto_only_owner_elsewhere_discount",
      "drive_voter_conflict_same_person",
      "auto_at_subject_but_stronger_legal_elsewhere",
    ],
    input_sources: ["drive", "voter", "auto", "tax"],
    output_fields: [
      "owner_legal_at_subject",
      "owner_legal_elsewhere",
      "nonowner_legal_at_subject",
      "drive_voter_conflicts",
      "auto_only_or_auto_discount",
    ],
    agent_guidance:
      "Treat drive and voter as stronger legal-address evidence than auto. " +
      "Explain whether legal rows support owner presence, owner elsewhere, or unrelated non-owner presence.",
    gate: makePacketGate({
      source_scope: ["drive", "voter", "auto", "tax"],
      minimum_viability: "Run when any drive, voter, or auto rows exist.",
    }),
    group: "occupancy_presence",
    category: "risk",
    score: 2,
    score_cap: 7,
  }),
  makePacketDefinition({
    id: "loan_tenure",
    title: "Loan tenure",
    description:
      "Review loan own/rent claims at the subject and owner loan records elsewhere.",
    atomic_heuristic_ids: ["loan_tenure_subject_analysis", "owner_loan_elsewhere"],
    input_sources: ["loan", "tax"],
    output_fields: [
      "owner_loan_own_at_subject",
      "owner_loan_rent_conflict",
      "nonowner_loan_renter_at_subject",
      "nonowner_loan_owner_claim_at_subject",
      "owner_loan_elsewhere",
    ],
    agent_guidance:
      "Use loan own/rent values as explicit tenure claims, but check identity against tax owner before assigning " +
      "owner vs non-owner meaning.",
    gate: makePacketGate({
      source_scope: ["loan", "tax"],
      minimum_viability:
        "Run when loan rows exist; tax rows improve owner/non-owner classification.",
    }),
    category: "risk",
    score: 2,
    score_cap: 7,
  }),
  makePacketDefinition({
    id: "portfolio_and_primary_comparison",
    title: "Portfolio and primary comparison",
    description:
      "Review multi-property ownership and whether strongest owner-primary evidence appears away from the subject.",
    atomic_heuristic_ids: [
      "portfolio_primary_comparison_analysis",
      "tax_ownerrescount_portfolio_pattern",
    ],
    input_sources: ["tax", "base", "drive", "voter", "auto"],
    output_fields: [
      "owner_multiple_properties",
      "strongest_owner_primary_elsewhere",
      "portfolio_with_nonowner_occupancy",
    ],
    agent_guidance:
      "Focus on portfolio context only when ownerrescount, multiple liened properties, or owner-primary evidence " +
      "elsewhere materially changes the case.",
    gate: makePacketGate({
      source_scope: ["tax", "base", "drive", "voter", "auto"],
      minimum_viability:
        "Run when tax rows exist and portfolio or owner-primary comparison evidence is available.",
    }),
    category: "risk",
    score: 1,
    score_cap: 5,
  }),
  makePacketDefinition({
    id: "case_quality_and_synthesis",
    title: "Case quality and synthesis",
    description:
      "Reconcile all packet findings, evidence sparsity, ambiguity, and deterministic atomic synthesis into a final case view.",
    atomic_heuristic_ids: ["evidence_quality_and_synthesis"],
    input_sources: SUBSTANTIVE_SOURCES,
    output_fields: [
      "data_density",
      "date_or_identity_gaps",
      "address_or_unit_ambiguity",
      "why_not_higher",
      "why_not_lower",
      "recommended_archetype",
    ],
    agent_guidance:
      "Do not reread every source from scratch. Reconcile packet findings, highlight ambiguity and missing evidence, " +
      "and compare the agent-visible case against the deterministic atomic synthesis.",
    gate: makePacketGate({
      source_scope: SUBSTANTIVE_SOURCES,
      minimum_viability:
        "Always run when any substantive source exists, and run for absence when evidence is sparse.",
      absence_sensitive: true,
    }),
    category: "quality",
    confidence: "medium",
    score: 0,
    score_cap: 0,
  }),
];

export function get_packet_catalog(): Array<Record<string, unknown>> {
  return PACKETS.map((packet) => asdict(packet) as Record<string, unknown>);
}

export function get_heuristic_catalog(): Array<Record<string, unknown>> {
  return PACKETS.map((packet) => _packet_for_agent(packet));
}

export function packet_ids(): readonly string[] {
  return PACKETS.map((packet) => packet.id);
}

export function atomic_coverage(): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const packet of PACKETS) {
    out[packet.id] = packet.atomic_heuristic_ids;
  }
  return out;
}

export function group_for_packet(packet_id: string): string | null {
  for (const packet of PACKETS) {
    if (packet.id === packet_id) {
      return packet.group;
    }
  }
  return null;
}

function _packet_for_agent(packet: PacketDefinition): Record<string, unknown> {
  const atomic_items = ATOMIC_HEURISTICS.filter((item) =>
    packet.atomic_heuristic_ids.includes(item.id),
  );
  const reasoning_paths: Array<Record<string, unknown>> = [];
  for (const item of atomic_items) {
    for (const path of item.reasoning_paths) {
      reasoning_paths.push(asdict(path) as Record<string, unknown>);
    }
  }
  let subquestions: readonly unknown[] = reasoning_paths
    .map((path) => pyOr(path["predicate"], path["title"], path["id"]))
    .filter((path) => pyBool(path));
  if (subquestions.length === 0) {
    subquestions = packet.output_fields;
  }
  return {
    id: packet.id,
    title: packet.title,
    description: packet.description,
    required_evidence_packs: packet.input_sources,
    input_sources: packet.input_sources,
    executor: null,
    score: packet.score,
    score_cap: packet.score_cap,
    confidence: packet.confidence,
    caveats: [],
    category: packet.category,
    execution_mode: "agent",
    agent_guidance: packet.agent_guidance,
    amplifiers: [],
    amplifier_score: 0,
    subquestions,
    output_fields: packet.output_fields,
    scoring_guidance: _packet_scoring_guidance(packet),
    context_scope: packet.input_sources,
    packet: true,
    group: packet.group,
    atomic_heuristic_ids: packet.atomic_heuristic_ids,
    atomic_reasoning_paths: reasoning_paths,
    packet_gate: asdict(packet.gate),
    source_reliability_policy: _source_reliability_policy(),
  };
}

function _packet_scoring_guidance(packet: PacketDefinition): string {
  const ladder =
    "tax > drive > loan > auto > voter == utility; base is canonical context; trace is unranked corroboration";
  if (packet.id === "case_quality_and_synthesis") {
    return (
      "Use score 0. This packet reconciles quality, ambiguity, why-not-higher/lower, " +
      "and deterministic atomic synthesis rather than adding risk points. " +
      `Apply this reliability ladder in reasoning: ${ladder}.`
    );
  }
  if (packet.category === "context") {
    return (
      "Use score 0 unless the packet uncovers a concrete risk or mitigation path; " +
      "tax context alone is not rental-use proof. " +
      `Apply this reliability ladder in reasoning: ${ladder}.`
    );
  }
  return (
    "Score only concrete, locally supported evidence. Preserve nuance across included atomic paths and " +
    "separate risk evidence from caveats or mitigations. " +
    `Apply this reliability ladder in reasoning: ${ladder}.`
  );
}

// PORT NOTE: Python truthiness / `a or b or c` used by _packet_for_agent.
function pyBool(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function pyOr(...values: unknown[]): unknown {
  for (let i = 0; i < values.length; i += 1) {
    if (i === values.length - 1) return values[i];
    if (pyBool(values[i])) return values[i];
  }
  return undefined;
}
