// Agent input/output schemas. Strict zod objects reject unknown keys; validators run via .superRefine.
import { z } from "zod";

export const HEURISTIC_STATUS = ["triggered", "not_triggered", "inconclusive", "context", "mitigation", "quality", "error"] as const;
export const HEURISTIC_DIRECTION = ["risk", "mitigation", "context", "quality"] as const;
export const CONFIDENCE = ["low", "medium", "high"] as const;
export const VERDICT_BAND = ["low_evidence", "monitor", "review", "high_priority_review", "manual_verification"] as const;
export const SIGNAL_STRENGTH = ["none", "weak", "moderate", "strong"] as const;
export const SIGNAL_DIRECTNESS = ["direct", "circumstantial", "context"] as const;
export const RELATIONSHIP_TO_OWNER = ["owner", "likely_family", "unrelated", "unknown", "not_applicable"] as const;
export const OWNER_PRESENCE_CONTEXT = ["owner_present", "owner_absent", "owner_elsewhere", "mixed", "unknown", "not_applicable"] as const;
export const RENTAL_MARKET_CONTEXT = ["active_rental", "rental_language", "no_rental_market_evidence", "unknown", "not_applicable"] as const;
export const ABSENTEE_OWNER_CONTEXT = ["absentee", "owner_mailing_at_subject", "unknown", "not_applicable"] as const;
export const RISK_LEVEL = ["low", "medium", "high", "unknown"] as const;
export const AMBIGUITY_RISK = ["low", "medium", "high"] as const;
export const RECOMMENDED_WEIGHT = ["ignore", "low", "medium", "high"] as const;
export const CASE_ARCHETYPE_VALUES = [
  "clear_absentee_rental",
  "family_household_rental",
  "owner_present_with_rental_indicators",
  "ambiguous_nonowner_occupancy",
  "non_rental_absentee_owner",
  "low_evidence_owner_occupied",
  "insufficient_ownership_data",
  "mixed_evidence",
] as const;

export type HeuristicStatus = (typeof HEURISTIC_STATUS)[number];
export type HeuristicDirection = (typeof HEURISTIC_DIRECTION)[number];
export type Confidence = (typeof CONFIDENCE)[number];
export type VerdictBand = (typeof VERDICT_BAND)[number];
export type CaseArchetype = (typeof CASE_ARCHETYPE_VALUES)[number];

const jsonRecord = z.record(z.string(), z.unknown());

export const EvidenceReferenceSchema = z
  .object({
    source: z.string(),
    table: z.string().nullish().default(null),
    rowid: z.number().int().nullish().default(null),
    record_id: z.string().nullish().default(null),
    summary: z.string().default(""),
    data: jsonRecord.default({}),
  })
  .strict();
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const GraphQLQueryLogSchema = z
  .object({
    query_name: z.string(),
    variables: jsonRecord.default({}),
    result_summary: z.string().default(""),
    error: z.string().nullish().default(null),
  })
  .strict();
export type GraphQLQueryLog = z.infer<typeof GraphQLQueryLogSchema>;

export const PersonEvidenceSummarySchema = z
  .object({
    name: z.string(),
    relationship_to_owner: z.enum(RELATIONSHIP_TO_OWNER).default("unknown"),
    sources: z.array(z.string()).default([]),
    summaries: z.array(z.string()).default([]),
  })
  .strict();
export type PersonEvidenceSummary = z.infer<typeof PersonEvidenceSummarySchema>;

export const OwnerEvidenceSummarySchema = z
  .object({
    owner_name: z.string(),
    mailing_address: z.string().default(""),
    mailing_matches_subject: z.boolean().nullish().default(null),
    source: z.string().default("tax"),
    summaries: z.array(z.string()).default([]),
  })
  .strict();
export type OwnerEvidenceSummary = z.infer<typeof OwnerEvidenceSummarySchema>;

export const CaseEvidenceMapSchema = z
  .object({
    address_id: z.number().int().nullish().default(null),
    normalized_address: z.string().default(""),
    zip5: z.string().default(""),
    source_counts: z.record(z.string(), z.number().int()).default({}),
    property_types: z.array(z.string()).default([]),
    rental_market_summary: z.array(z.string()).default([]),
    owner_summaries: z.array(OwnerEvidenceSummarySchema).default([]),
    people_at_address: z.array(PersonEvidenceSummarySchema).default([]),
    owner_presence_hints: z.array(z.string()).default([]),
    owner_elsewhere_hints: z.array(z.string()).default([]),
    nonowner_occupancy_hints: z.array(z.string()).default([]),
    freshness_hints: z.array(z.string()).default([]),
    data_gaps: z.array(z.string()).default([]),
    evidence_refs: z.array(EvidenceReferenceSchema).default([]),
  })
  .strict();
export type CaseEvidenceMap = z.infer<typeof CaseEvidenceMapSchema>;
export const emptyCaseEvidenceMap = (): CaseEvidenceMap => CaseEvidenceMapSchema.parse({});

export const HeuristicInterpretationSchema = z
  .object({
    signal_strength: z.enum(SIGNAL_STRENGTH).default("none"),
    signal_directness: z.enum(SIGNAL_DIRECTNESS).default("context"),
    relationship_to_owner: z.enum(RELATIONSHIP_TO_OWNER).default("not_applicable"),
    owner_presence_context: z.enum(OWNER_PRESENCE_CONTEXT).default("unknown"),
    rental_market_context: z.enum(RENTAL_MARKET_CONTEXT).default("unknown"),
    absentee_owner_context: z.enum(ABSENTEE_OWNER_CONTEXT).default("unknown"),
    staleness_risk: z.enum(RISK_LEVEL).default("unknown"),
    ambiguity_risk: z.enum(AMBIGUITY_RISK).default("medium"),
    recommended_weight: z.enum(RECOMMENDED_WEIGHT).default("low"),
  })
  .strict();
export type HeuristicInterpretation = z.infer<typeof HeuristicInterpretationSchema>;
export const emptyHeuristicInterpretation = (): HeuristicInterpretation => HeuristicInterpretationSchema.parse({});

export const AddressCandidateSchema = z
  .object({
    id: z.number().int(),
    norm_address: z.string(),
    zip5: z.string().default(""),
    match_score: z.number().min(0).max(1),
    relation_count: z.number().int().min(0).default(0),
    matched_fields: z.array(z.string()).default([]),
  })
  .strict();
export type AddressCandidate = z.infer<typeof AddressCandidateSchema>;

export const ResolvedAddressContextSchema = z
  .object({
    input_address: z.string(),
    input_zip: z.string().default(""),
    selected: AddressCandidateSchema.nullish().default(null),
    candidates: z.array(AddressCandidateSchema).default([]),
    ambiguous: z.boolean().default(false),
    source_counts: z.record(z.string(), z.number().int()).default({}),
    property_types: z.array(z.string()).default([]),
    evidence_map: CaseEvidenceMapSchema.default(() => emptyCaseEvidenceMap()),
    schema_guide: z.string().default(""),
    selected_heuristic_ids: z.array(z.string()).default([]),
    preflight_queries: z.array(GraphQLQueryLogSchema).default([]),
  })
  .strict();
export type ResolvedAddressContext = z.infer<typeof ResolvedAddressContextSchema>;

export const HeuristicPlanSchema = z
  .object({
    heuristic_id: z.string(),
    decision: z.enum(["run", "skip", "run_for_absence"]),
    priority: z.enum(["low", "medium", "high"]).default("medium"),
    reason: z.string(),
    expected_sources: z.array(z.string()).default([]),
    known_data_gaps: z.array(z.string()).default([]),
    mission: z.string(),
  })
  .strict();
export type HeuristicPlan = z.infer<typeof HeuristicPlanSchema>;

export const CaseInvestigationPlanSchema = z
  .object({
    selected: z.array(HeuristicPlanSchema).default([]),
    skipped: z.array(HeuristicPlanSchema).default([]),
    global_case_questions: z.array(z.string()).default([]),
    planner: z.enum(["master", "fallback"]).default("fallback"),
  })
  .strict();
export type CaseInvestigationPlan = z.infer<typeof CaseInvestigationPlanSchema>;
export const emptyCaseInvestigationPlan = (): CaseInvestigationPlan => CaseInvestigationPlanSchema.parse({});

export const AgentInvestigationRequestSchema = z
  .object({
    address: z.string(),
    zip: z.string().default(""),
    graphql_url: z.string(),
    provider: z.enum(["auto", "openai", "gemini", "anthropic"]).default("auto"),
    model: z.string().nullish().default(null),
    base_url: z.string().nullish().default(null),
    heuristic_allowlist: z.array(z.string()).nullish().default(null),
    heuristic_blocklist: z.array(z.string()).default([]),
    max_concurrency: z.number().int().min(1).default(8),
    max_graphql_calls_per_agent: z.number().int().min(1).default(8),
    graphql_timeout_seconds: z.number().gt(0).default(30.0),
    agent_timeout_seconds: z.number().gt(0).default(120.0),
    max_response_bytes: z.number().int().min(10_000).default(1_000_000),
    max_output_retries: z.number().int().min(0).default(2),
    max_query_repair_attempts: z.number().int().min(0).default(3),
    schema_tool_budget: z.number().int().min(0).default(8),
    trace_id: z.string().nullish().default(null),
    disable_master_planning: z.boolean().default(false),
    prompt_profile: z.enum(["compact", "full"]).default("compact"),
    retrieval_mode: z.enum(["tools", "typed_tools"]).default("tools"),
    include_shortcuts: z.boolean().default(false),
    metrics_enabled: z.boolean().default(true),
    metrics_debug_payloads: z.boolean().default(false),
    metrics_output_dir: z.string().nullish().default(null),
    batch_id: z.string().nullish().default(null),
  })
  .strict();
export type AgentInvestigationRequest = z.infer<typeof AgentInvestigationRequestSchema>;

export const HeuristicAgentInputSchema = z
  .object({
    heuristic: jsonRecord,
    context: ResolvedAddressContextSchema,
    max_graphql_calls: z.number().int(),
    max_output_retries: z.number().int().default(2),
    max_query_repair_attempts: z.number().int().default(3),
    schema_tool_budget: z.number().int().default(8),
    prompt_profile: z.enum(["compact", "full"]).default("compact"),
    plan: HeuristicPlanSchema.nullish().default(null),
    trace: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type HeuristicAgentInput = z.infer<typeof HeuristicAgentInputSchema>;

export const HeuristicAgentResultSchema = z
  .object({
    heuristic_id: z.string(),
    status: z.enum(HEURISTIC_STATUS),
    direction: z.enum(HEURISTIC_DIRECTION),
    score: z.number().int().min(-10).max(10),
    confidence: z.enum(CONFIDENCE),
    finding: z.string().refine((v) => v.trim().length > 0, { message: "must not be empty" }),
    interpretation: HeuristicInterpretationSchema.default(() => emptyHeuristicInterpretation()),
    evidence_for: z.array(EvidenceReferenceSchema).default([]),
    evidence_against: z.array(EvidenceReferenceSchema).default([]),
    missing_evidence: z.array(z.string()).default([]),
    evidence_refs: z.array(EvidenceReferenceSchema).default([]),
    graphql_queries: z.array(GraphQLQueryLogSchema).default([]),
    tool_errors: z.array(z.string()).default([]),
    validation_errors: z.array(z.string()).default([]),
    query_repair_attempts: z.number().int().min(0).default(0),
    raw_model_failures: z.array(z.string()).default([]),
    caveats: z.array(z.string()).default([]),
    needs_second_pass: z.boolean().default(false),
    error: z.string().nullish().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.status === "triggered" && v.evidence_for.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "triggered heuristic results require evidence_for" });
    }
    if (v.status === "not_triggered" && v.evidence_against.length === 0 && v.missing_evidence.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "not_triggered heuristic results require evidence_against or missing_evidence" });
    }
    if (
      v.status === "inconclusive" &&
      v.missing_evidence.length === 0 &&
      v.validation_errors.length === 0 &&
      v.tool_errors.length === 0 &&
      !v.error
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconclusive heuristic results require missing_evidence, tool/validation errors, or error context" });
    }
    if (v.status === "inconclusive" && v.score !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "inconclusive heuristic results must have score 0" });
    }
  });
export type HeuristicAgentResult = z.infer<typeof HeuristicAgentResultSchema>;

export const ConflictSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    heuristic_ids: z.array(z.string()),
    summary: z.string(),
    severity: z.enum(CONFIDENCE),
  })
  .strict();
export type ConflictSummary = z.infer<typeof ConflictSummarySchema>;

export const ScoreBreakdownSchema = z
  .object({
    risk_points: z.number().int(),
    mitigation_points: z.number().int(),
    quality_points: z.number().int(),
    final_score: z.number().int(),
    band: z.enum(VERDICT_BAND),
  })
  .strict();
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const ScoreAdjustmentSchema = z
  .object({
    heuristic_ids: z.array(z.string()).default([]),
    delta: z.number().int().min(-10).max(10),
    reason: z.string(),
  })
  .strict();
export type ScoreAdjustment = z.infer<typeof ScoreAdjustmentSchema>;

export const CaseAdjudicationSchema = z
  .object({
    raw_score: z.number().int(),
    calibrated_score: z.number().int().min(0).max(20),
    clarity_score: z.number().int().min(0).max(10),
    verdict_band: z.enum(VERDICT_BAND),
    case_archetype: z.enum(CASE_ARCHETYPE_VALUES),
    score_adjustments: z.array(ScoreAdjustmentSchema).default([]),
    reasoning_summary: z.string(),
    why_not_higher: z.array(z.string()).default([]),
    why_not_lower: z.array(z.string()).default([]),
  })
  .strict();
export type CaseAdjudication = z.infer<typeof CaseAdjudicationSchema>;

// metrics_events is excluded from serialization. We keep it on the type and strip it when writing
// JSON (see cli serialization).
export const OccupancyAgentAssessmentSchema = z
  .object({
    query: jsonRecord,
    resolved_address: ResolvedAddressContextSchema,
    score_breakdown: ScoreBreakdownSchema,
    adjudication: CaseAdjudicationSchema,
    investigation_plan: CaseInvestigationPlanSchema.default(() => emptyCaseInvestigationPlan()),
    heuristics: z.array(HeuristicAgentResultSchema),
    evidence_pack: z.array(EvidenceReferenceSchema),
    conflicts: z.array(ConflictSummarySchema),
    caveats: z.array(z.string()),
    report: z.string(),
    agent_metrics: jsonRecord.default({}),
    metrics: jsonRecord.default({}),
    metrics_events: z.array(jsonRecord).default([]),
  })
  .strict();
export type OccupancyAgentAssessment = z.infer<typeof OccupancyAgentAssessmentSchema>;

export function runTimestamp(): string {
  // ISO timestamp truncated to seconds precision (drops the milliseconds).
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
