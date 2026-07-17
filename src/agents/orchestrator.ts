// Top-level investigation orchestration: preflight address resolution + evidence-map build,
// deterministic packet gating, the master planner LLM, per-group subagent dispatch (bucketing +
// budget-scaled CountingGraphQLTool + shared QueryCache + a concurrency limiter + per-bucket timeout),
// scoring, the master adjudicator LLM (with retries + fallback), conflict/evidence dedup, and the
// final assessment assembly. The submit_* tools are stubs that return {}: the loop routes by tool
// name and reads the tool_call args directly, so a tool's own func is never invoked.
import { Buffer } from "node:buffer";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { selected_heuristics } from "./catalog.ts";
import { CountingGraphQLTool, GraphQLHttpTool } from "./graphql_tool.ts";
import { createChatModel, resolveProvider, type LlmProvider } from "./llm.ts";
import {
  AddressCandidateSchema,
  CASE_ARCHETYPE_VALUES,
  CaseAdjudicationSchema,
  CaseInvestigationPlanSchema,
  EvidenceReferenceSchema,
  HeuristicPlanSchema,
  OwnerEvidenceSummarySchema,
  ResolvedAddressContextSchema,
  ScoreAdjustmentSchema,
  VERDICT_BAND,
  runTimestamp,
  type AddressCandidate,
  type AgentInvestigationRequest,
  type CaseAdjudication,
  type CaseEvidenceMap,
  type CaseInvestigationPlan,
  type ConflictSummary,
  type EvidenceReference,
  type HeuristicAgentInput,
  type HeuristicAgentResult,
  type HeuristicPlan,
  type OccupancyAgentAssessment,
  type OwnerEvidenceSummary,
  type PersonEvidenceSummary,
  type ResolvedAddressContext,
  type ScoreBreakdown,
  type VerdictBand,
} from "./models.ts";
import type { ExternalEvidence } from "./external_evidence.ts";
import {
  external_evidence_refs,
  property_types_from_external,
  rental_market_summary_lines,
} from "./external_evidence_map.ts";
import {
  MASTER_ADJUDICATION_SYSTEM_PROMPT,
  master_adjudication_user_prompt,
  master_planning_user_prompt,
  prompt_context,
} from "./prompts.ts";
import { QueryCache } from "./query_cache.ts";
import { scoreResults } from "./scoring.ts";
import { RetrievalHeuristicSubagent, error_result, type HeuristicSubagent } from "./subagents.ts";
import { make_toolset } from "./toolsets/index.ts";
import { makeInvestigationTrace, runnableConfig, type InvestigationTrace } from "./tracing.ts";
import { evaluate_packet_gates } from "../heuristics/index.ts";
import { MetricsRecorder, currentRecorder, runWithRecorder } from "../observability/index.ts";
import {
  count_prose_leaks,
  proseRedactEnabled,
  sanitize_adjudication_prose,
  sanitize_result_prose,
} from "./prose_redaction.ts";
import type { MetricEvent } from "../observability/models.ts";

const PREFLIGHT_QUERY = `
query AgentAddressPreflight($query: String!, $zip: String) {
  searchAddresses(query: $query, zip: $zip, limit: 5) {
    totalCount
    nodes {
      matchScore
      matchedFields
      relationCount
      address { id normAddress zip5 streetNumber streetName unit city state county }
    }
  }
  addressByText(query: $query, zip: $zip) {
    id
    normAddress
    zip5
    streetNumber
    streetName
    unit
    city
    state
    county
    residents(limit: 10) { totalCount nodes { id firstname lastname fullName } }
    utilityRecords(limit: 10) { totalCount nodes { table rowid data } }
    taxProperties(limit: 5) { totalCount nodes { table rowid data } }
    traceRecords(limit: 10) { totalCount nodes { table rowid data } }
    autoRecords(limit: 10) { totalCount nodes { table rowid data } }
    loanRecords(limit: 10) { totalCount nodes { table rowid data } }
    driveRecords(limit: 10) { totalCount nodes { table rowid data } }
    voterRecords(limit: 10) { totalCount nodes { table rowid data } }
    criminalRecords { totalCount }
  }
}
`;

const ADDRESS_BY_ID_QUERY = `
query AgentAddressById($id: Int!) {
  address(id: $id) {
    id
    normAddress
    zip5
    streetNumber
    streetName
    unit
    city
    state
    county
    residents(limit: 10) { totalCount nodes { id firstname lastname fullName } }
    utilityRecords(limit: 10) { totalCount nodes { table rowid data } }
    taxProperties(limit: 5) { totalCount nodes { table rowid data } }
    traceRecords(limit: 10) { totalCount nodes { table rowid data } }
    autoRecords(limit: 10) { totalCount nodes { table rowid data } }
    loanRecords(limit: 10) { totalCount nodes { table rowid data } }
    driveRecords(limit: 10) { totalCount nodes { table rowid data } }
    voterRecords(limit: 10) { totalCount nodes { table rowid data } }
    criminalRecords { totalCount }
  }
}
`;

// ── Master submit tools (native tool calls) ──

const SubmitCaseAdjudicationArgs = z
  .object({
    raw_score: z
      .number()
      .int()
      .describe("Raw deterministic worker score. Must equal raw_score.final_score from the prompt."),
    calibrated_score: z.number().int().min(0).max(20).describe("Master-calibrated case score from 0 to 20."),
    clarity_score: z.number().int().min(0).max(10).describe("Evidence clarity from 0 to 10."),
    verdict_band: z
      .enum(VERDICT_BAND)
      .describe("One of: low_evidence, monitor, review, high_priority_review, manual_verification."),
    case_archetype: z.enum(CASE_ARCHETYPE_VALUES).describe(`One of: ${CASE_ARCHETYPE_VALUES.join(", ")}.`),
    score_adjustments: z.array(ScoreAdjustmentSchema).default([]),
    reasoning_summary: z
      .string()
      .min(1)
      .describe("Concise explanation for the calibrated score and verdict band."),
    why_not_higher: z.array(z.string()).default([]).describe("Reasons the case was not assigned a higher score/band."),
    why_not_lower: z.array(z.string()).default([]).describe("Reasons the case was not assigned a lower score/band."),
  })
  .describe("Submit the final master CaseAdjudication.");

const SubmitInvestigationPlanArgs = z
  .object({
    selected: z.array(HeuristicPlanSchema).default([]).describe("Heuristics to run or run_for_absence."),
    skipped: z.array(HeuristicPlanSchema).default([]).describe("Heuristics to skip with reasons."),
    global_case_questions: z
      .array(z.string())
      .default([])
      .describe("Case-level questions the adjudicator should revisit after subagents report."),
  })
  .describe("Submit the master investigation plan.");

export const submit_case_adjudication = tool(async () => ({}), {
  name: "submit_case_adjudication",
  description: "Submit the final master CaseAdjudication.",
  schema: SubmitCaseAdjudicationArgs,
});

export const submit_investigation_plan = tool(async () => ({}), {
  name: "submit_investigation_plan",
  description: "Submit the master investigation plan.",
  schema: SubmitInvestigationPlanArgs,
});

// ── Orchestrator ──

export class AgentOrchestrator {
  graphql: GraphQLHttpTool;
  subagent: HeuristicSubagent;
  master_llm: any | null;
  max_concurrency: number;
  agent_timeout_seconds: number;
  on_metric_event: ((event: MetricEvent) => void) | null;

  constructor(opts: {
    graphql: GraphQLHttpTool;
    subagent: HeuristicSubagent;
    master_llm?: any | null;
    max_concurrency?: number;
    agent_timeout_seconds?: number;
    on_metric_event?: (event: MetricEvent) => void;
  }) {
    this.graphql = opts.graphql;
    this.subagent = opts.subagent;
    this.master_llm = opts.master_llm ?? null;
    this.max_concurrency = opts.max_concurrency ?? 8;
    this.agent_timeout_seconds = opts.agent_timeout_seconds ?? 120.0;
    this.on_metric_event = opts.on_metric_event ?? null;
  }

  async investigate(request: AgentInvestigationRequest): Promise<OccupancyAgentAssessment> {
    const trace = makeInvestigationTrace(request.address, request.zip, request.trace_id);
    const recorder = new MetricsRecorder(
      {
        run_id: trace.investigation_id,
        batch_id: request.batch_id || "",
        investigation_id: trace.investigation_id,
        address_key: trace.address_key,
        address: request.address,
        zip: request.zip,
        provider: _report_provider(request.provider),
        model: request.model || "",
        prompt_profile: request.prompt_profile,
        include_shortcuts: request.include_shortcuts,
      },
      {
        enabled: request.metrics_enabled,
        debug_payloads: request.metrics_debug_payloads,
        on_event: this.on_metric_event ?? undefined,
      },
    );

    const run_investigation = async (_: Record<string, any>): Promise<OccupancyAgentAssessment> => {
      void _;
      return await runWithRecorder(recorder, async () => {
        const assessment = await recorder.span(
          "investigation",
          { name: `investigation:${request.address}`, agent_id: "orchestrator" },
          async () => await this._investigate(request, trace),
        );
        const metrics_summary = recorder.summary();
        assessment.metrics = metrics_summary as unknown as Record<string, unknown>;
        assessment.metrics_events = recorder.events() as unknown as Record<string, unknown>[];
        Object.assign(assessment.agent_metrics, {
          llm_call_count: metrics_summary.llm_call_count ?? 0,
          input_tokens: metrics_summary.input_tokens ?? 0,
          output_tokens: metrics_summary.output_tokens ?? 0,
          total_tokens: metrics_summary.total_tokens ?? 0,
          estimated_cost_usd: metrics_summary.estimated_cost_usd,
          tool_call_count: metrics_summary.tool_call_count ?? 0,
        });
        return assessment;
      });
    };

    const runnable = RunnableLambda.from<Record<string, any>, OccupancyAgentAssessment>(run_investigation);
    return await runWithRecorder(recorder, async () =>
      runnable.invoke(
        {},
        runnableConfig(
          `investigation:${request.address}`,
          {
            provider: _report_provider(request.provider),
            model: request.model || "",
            phase: "investigation",
            agent_id: "orchestrator",
            batch_id: request.batch_id || "",
          },
          ["orchestrator"],
          trace,
        ),
      ),
    );
  }

  async _investigate(request: AgentInvestigationRequest, trace: InvestigationTrace): Promise<OccupancyAgentAssessment> {
    const recorder = currentRecorder();
    const context = await recorder.span(
      "preflight",
      { agent_id: "orchestrator" },
      async () => await this.preflight(request),
    );
    let candidate_heuristics = selected_heuristics(request.heuristic_allowlist, request.heuristic_blocklist) as Record<
      string,
      any
    >[];
    const candidate_count = candidate_heuristics.length;
    const [gated_heuristics, gate_skips, absence_notes] = await recorder.span(
      "heuristic_gating",
      { agent_id: "orchestrator", metadata: { candidate_packets: candidate_count } },
      () => _gate_candidate_heuristics(context, candidate_heuristics),
    );
    candidate_heuristics = gated_heuristics;
    const investigation_plan = await recorder.span(
      "master_planner",
      { agent_id: "master_planner", metadata: { candidate_packets: candidate_heuristics.length } },
      async () => {
        const plan = await this._plan_case(context, candidate_heuristics, request, trace, {
          gate_skips,
          absence_notes,
        });
        return _suppress_absence_workers(plan);
      },
    );
    const heuristic_by_id = new Map<string, Record<string, any>>(
      candidate_heuristics.map((item) => [String(item["id"]), item]),
    );
    const run_plans = investigation_plan.selected.filter(
      (plan) =>
        (plan.decision === "run" || plan.decision === "run_for_absence") && heuristic_by_id.has(plan.heuristic_id),
    );
    const heuristics = run_plans.map((plan) => heuristic_by_id.get(plan.heuristic_id)!);
    context.selected_heuristic_ids = run_plans.map((plan) => plan.heuristic_id);
    // The streamed worker unit is the bucket (one heuristic_worker span per bucket), so the
    // up-front total the UI counts against is buckets.length, not heuristics.length.
    const buckets = _bucket_by_group(heuristics);
    const results = await recorder.span(
      "heuristic_workers",
      {
        agent_id: "orchestrator",
        metadata: { launched_subagents: heuristics.length, workers_total: buckets.length },
      },
      async () => await this._run_subagents(heuristics, context, request, trace, run_plans, buckets),
    );
    const scoring = await recorder.span("scoring", { agent_id: "orchestrator" }, () => {
      const conflicts = detect_conflicts(results);
      const evidence_pack = dedupe_evidence(results);
      const score_breakdown = scoreResults(results);
      return { conflicts, evidence_pack, score_breakdown };
    });
    const adjudication = await recorder.span(
      "master_adjudicator",
      { agent_id: "master_adjudicator", metadata: { raw_score: scoring.score_breakdown.final_score } },
      async () =>
        await this._adjudicate_case(context, scoring.score_breakdown, results, scoring.conflicts, request, trace),
    );
    // Finalization: humanize the human-facing prose (gated by OE_PROSE_REDACT) AFTER adjudication
    // and BEFORE the report is assembled. Running it after adjudication keeps it a pure output
    // filter that never perturbs the adjudicator's inputs (so the redact-only experiment arm is
    // verdict-neutral); running it before build_report lets the derived report inherit clean text.
    const finalResults = proseRedactEnabled() ? results.map((r) => sanitize_result_prose(r)) : results;
    const finalAdjudication = proseRedactEnabled() ? sanitize_adjudication_prose(adjudication) : adjudication;

    const caveats = [...new Set(finalResults.flatMap((result) => result.caveats))].sort();
    caveats.push(..._global_caveats(context, finalResults));
    const report = await recorder.span("report_build", { agent_id: "orchestrator" }, () =>
      build_report(finalAdjudication, scoring.score_breakdown.final_score, finalResults, scoring.conflicts),
    );
    const agent_metrics = _agent_metrics({
      candidate_count,
      gated_count: candidate_heuristics.length,
      workers_total: buckets.length,
      plan: investigation_plan,
      results: finalResults,
      adjudication: finalAdjudication,
      report,
    });
    const metrics_summary = recorder.summary();
    const assessment: OccupancyAgentAssessment = {
      query: {
        address: request.address,
        zip: request.zip,
        graphql_url: request.graphql_url,
        provider: _report_provider(request.provider),
        model: request.model,
        retrieval_mode: request.retrieval_mode,
        run_at: runTimestamp(),
        investigation_id: trace.investigation_id,
        thread_id: trace.thread_id,
        address_key: trace.address_key,
      },
      resolved_address: context,
      score_breakdown: scoring.score_breakdown,
      adjudication: finalAdjudication,
      investigation_plan,
      heuristics: finalResults,
      evidence_pack: scoring.evidence_pack,
      conflicts: scoring.conflicts,
      caveats: [...new Set(caveats)].sort(),
      report,
      agent_metrics,
      metrics: metrics_summary as unknown as Record<string, unknown>,
      metrics_events: recorder.events() as unknown as Record<string, unknown>[],
    };
    return assessment;
  }

  async preflight(request: AgentInvestigationRequest): Promise<ResolvedAddressContext> {
    const graphql = new CountingGraphQLTool(this.graphql, { max_calls: 3, agent_id: "orchestrator" });
    const schema_guide = "";
    const data = await graphql.query(
      PREFLIGHT_QUERY,
      { query: request.address, zip: request.zip || null },
      { result_summary: "address search and source counts" },
    );
    const search = (data["searchAddresses"] ?? {}) as Record<string, any>;
    const nodes = (search["nodes"] ?? []) as any[];
    const candidates = nodes.map((node) => _candidate(node as Record<string, any>));
    let address_data: Record<string, any> | null = (data["addressByText"] ?? null) as Record<string, any> | null;
    if (address_data === null && candidates.length > 0) {
      const by_id = await graphql.query(
        ADDRESS_BY_ID_QUERY,
        { id: candidates[0]!.id },
        { result_summary: "fallback address by id" },
      );
      address_data = (by_id["address"] ?? null) as Record<string, any> | null;
    }
    const selected = _selected_candidate(address_data, candidates);
    const source_counts = _source_counts((address_data ?? {}) as Record<string, any>);
    // Absent payload => empty, exactly as today: the blind (benchmarking) configuration.
    const external_evidence = request.external_evidence ?? null;
    // CONTEXT-level only. evidence_map.property_types stays [] — see _evidence_map below.
    const property_types = property_types_from_external(external_evidence);
    const evidence_map = _evidence_map(
      (address_data ?? {}) as Record<string, any>,
      selected,
      source_counts,
      external_evidence,
    );
    const ambiguous = selected === null || _is_ambiguous(candidates);
    return ResolvedAddressContextSchema.parse({
      input_address: request.address,
      input_zip: request.zip,
      selected,
      candidates,
      ambiguous,
      source_counts,
      property_types,
      evidence_map,
      schema_guide,
      preflight_queries: graphql.logs,
    });
  }

  async _plan_case(
    context: ResolvedAddressContext,
    heuristics: Record<string, any>[],
    request: AgentInvestigationRequest,
    trace: InvestigationTrace,
    opts: { gate_skips?: HeuristicPlan[] | null; absence_notes?: string[] | null } = {},
  ): Promise<CaseInvestigationPlan> {
    const gate_skips = opts.gate_skips ?? null;
    const absence_notes = opts.absence_notes ?? null;
    const fallback = _fallback_investigation_plan(
      heuristics,
      context,
      "Master planning unavailable; using all selected heuristics.",
      gate_skips,
      absence_notes,
    );
    if (request.disable_master_planning || this.master_llm === null) {
      return fallback;
    }
    if (typeof this.master_llm.bindTools !== "function") {
      return fallback;
    }
    const model = this.master_llm.bindTools([submit_investigation_plan]);
    const messages: any[] = [
      new SystemMessage({
        content:
          "You are the True-Occupancy master case controller. Build an investigation plan for heuristic subagents. " +
          "Use the submit_investigation_plan tool exactly once. Source availability is advisory, not a hard gate.",
      }),
      new HumanMessage({
        content: master_planning_user_prompt(prompt_context(context, request.prompt_profile), heuristics, true),
      }),
    ];
    try {
      const response = await model.invoke(
        messages,
        runnableConfig(
          "master:plan_case",
          {
            candidate_heuristics: heuristics.length,
            phase: "master_planner",
            agent_id: "master_planner",
            provider: _report_provider(request.provider),
            model: request.model || "",
            batch_id: request.batch_id || "",
          },
          ["master-planner"],
          trace,
        ),
      );
      const plan = _investigation_plan_from_tool_calls(response, heuristics, false);
      if (plan === null) {
        return fallback;
      }
      if (gate_skips && gate_skips.length > 0) {
        plan.skipped.push(...gate_skips);
      }
      if (absence_notes && absence_notes.length > 0) {
        for (const note of absence_notes) {
          if (!plan.global_case_questions.includes(note)) {
            plan.global_case_questions.push(note);
          }
        }
      }
      return plan;
    } catch {
      return fallback;
    }
  }

  async _run_subagents(
    heuristics: Record<string, any>[],
    context: ResolvedAddressContext,
    request: AgentInvestigationRequest,
    trace: InvestigationTrace,
    plans: HeuristicPlan[] | null = null,
    buckets: Record<string, any>[][] | null = null,
  ): Promise<HeuristicAgentResult[]> {
    const semaphore = new Semaphore(this.max_concurrency);
    const query_cache = new QueryCache();
    const plan_by_id = new Map<string, HeuristicPlan>((plans ?? []).map((plan) => [plan.heuristic_id, plan]));

    const _agent_input = (heuristic: Record<string, any>): HeuristicAgentInput => {
      const heuristic_id = String(heuristic["id"]);
      return {
        heuristic,
        context,
        max_graphql_calls: request.max_graphql_calls_per_agent,
        max_output_retries: request.max_output_retries,
        max_query_repair_attempts: request.max_query_repair_attempts,
        schema_tool_budget: request.schema_tool_budget,
        prompt_profile: request.prompt_profile,
        plan: plan_by_id.get(heuristic_id) ?? null,
        trace: trace.metadata,
      };
    };

    const run_bucket = async (
      bucket: Record<string, any>[],
      worker_index: number,
      workers_total: number,
    ): Promise<HeuristicAgentResult[]> => {
      const ids = bucket.map((h) => String(h["id"]));
      const solo = bucket.length === 1;
      const firstId = ids[0]!;
      const worker_id = solo ? `heuristic:${firstId}` : `group:${ids.join("+")}`;
      // Budgets scale with bucket size so each grouped packet keeps its full solo allowance.
      const graphql = new CountingGraphQLTool(this.graphql, {
        max_calls: request.max_graphql_calls_per_agent * bucket.length,
        agent_id: worker_id,
        heuristic_id: solo ? firstId : "",
        cache: query_cache,
      });
      const agent_inputs = bucket.map((h) => _agent_input(h));

      const run_worker = async (_: Record<string, any>): Promise<HeuristicAgentResult[]> => {
        void _;
        const rec = currentRecorder();
        return await rec.span(
          "heuristic_worker",
          {
            agent_id: worker_id,
            heuristic_id: solo ? firstId : ids.join("+"),
            metadata: _worker_span_metadata(bucket, worker_index, workers_total),
          },
          async () => await _dispatch_bucket(this.subagent, agent_inputs, graphql),
        );
      };

      const runnable = RunnableLambda.from<Record<string, any>, HeuristicAgentResult[]>(run_worker);
      await semaphore.acquire();
      try {
        return await withTimeout(
          runnable.invoke(
            {},
            runnableConfig(
              `subagent:${worker_id}`,
              {
                heuristic_id: ids.join("+"),
                phase: "heuristic_worker",
                agent_id: worker_id,
                provider: _report_provider(request.provider),
                model: request.model || "",
                batch_id: request.batch_id || "",
              },
              ["heuristic-subagent", worker_id],
              trace,
            ),
          ),
          request.agent_timeout_seconds * bucket.length * 1000,
        );
      } catch (exc) {
        // Any failure (including a bucket timeout) is reported as structured error results.
        return bucket.map((h) => error_result(h, errStr(exc), graphql));
      } finally {
        semaphore.release();
      }
    };

    const resolved_buckets = buckets ?? _bucket_by_group(heuristics);
    const workers_total = resolved_buckets.length;
    const bucket_results = await Promise.all(
      resolved_buckets.map((bucket, worker_index) => run_bucket(bucket, worker_index, workers_total)),
    );
    const by_id = new Map<string, HeuristicAgentResult>();
    for (const results of bucket_results) {
      for (const result of results) {
        by_id.set(result.heuristic_id, result);
      }
    }
    const ordered: HeuristicAgentResult[] = [];
    for (const heuristic of heuristics) {
      // hid is always present: run_group validates submitted ids against the bucket and error_fills the
      // rest, and the run() fallback sets heuristic_id from the input.
      const hid = String(heuristic["id"]);
      if (by_id.has(hid)) {
        ordered.push(by_id.get(hid)!);
      }
    }
    return ordered;
  }

  async _adjudicate_case(
    context: ResolvedAddressContext,
    raw_score: ScoreBreakdown,
    results: HeuristicAgentResult[],
    conflicts: ConflictSummary[],
    request: AgentInvestigationRequest,
    trace: InvestigationTrace,
  ): Promise<CaseAdjudication> {
    if (this.master_llm === null) {
      return fallback_adjudication(raw_score, "No master LLM configured; using raw heuristic score as calibrated score.");
    }

    const messages: any[] = [
      new SystemMessage({ content: MASTER_ADJUDICATION_SYSTEM_PROMPT }),
      new HumanMessage({
        content: master_adjudication_user_prompt(
          prompt_context(context, request.prompt_profile),
          raw_score,
          results.map((result) => _compact_worker_result(result, false)),
          conflicts.map((conflict) => ({ ...conflict })),
          true,
        ),
      }),
    ];
    if (typeof this.master_llm.bindTools !== "function") {
      return fallback_adjudication(raw_score, "Master LLM does not support required native tool calls.");
    }
    const model = this.master_llm.bindTools([submit_case_adjudication]);
    messages.push(
      new HumanMessage({
        content:
          "Use the submit_case_adjudication tool exactly once for the final answer. " +
          "Do not write free-form JSON or prose in message text.",
      }),
    );
    for (let attempt = 0; attempt <= request.max_output_retries; attempt++) {
      try {
        const response = await model.invoke(
          messages,
          runnableConfig(
            "master:adjudicate_case",
            {
              raw_score: raw_score.final_score,
              phase: "master_adjudicator",
              agent_id: "master_adjudicator",
              provider: _report_provider(request.provider),
              model: request.model || "",
              batch_id: request.batch_id || "",
            },
            ["master-adjudicator"],
            trace,
          ),
        );
        const tool_result = _case_adjudication_from_tool_calls(response, raw_score.final_score);
        if (tool_result !== null && !("ok" in tool_result)) {
          return tool_result as CaseAdjudication;
        }
        if (tool_result !== null) {
          messages.push(response);
          messages.push(
            new ToolMessage({
              content: JSON.stringify(tool_result),
              tool_call_id: String(tool_result["tool_call_id"]),
              name: "submit_case_adjudication",
            }),
          );
          throw new ValueError(String(tool_result["error"]));
        }
        throw new ValueError("Master adjudication response did not use submit_case_adjudication.");
      } catch (exc) {
        if (exc instanceof ValueError) {
          if (attempt >= request.max_output_retries) {
            return fallback_adjudication(raw_score, `Master adjudication failed validation: ${exc.message}`);
          }
          messages.push(
            new HumanMessage({
              content: `Your adjudication response was invalid: ${exc.message}. Retry with exactly one submit_case_adjudication tool call.`,
            }),
          );
        } else {
          // Preserve investigation output if master fails.
          return fallback_adjudication(raw_score, `Master adjudication failed: ${errStr(exc)}`);
        }
      }
    }
    return fallback_adjudication(raw_score, "Master adjudication exhausted retry budget.");
  }
}

export async function investigate_address(
  request: AgentInvestigationRequest,
  subagent: HeuristicSubagent | null = null,
  hooks: { on_metric_event?: (event: MetricEvent) => void } = {},
): Promise<OccupancyAgentAssessment> {
  const graphql = new GraphQLHttpTool(request.graphql_url, {
    timeout_seconds: request.graphql_timeout_seconds,
    max_response_bytes: request.max_response_bytes,
  });
  let master_llm: any | null;
  let resolvedSubagent: HeuristicSubagent;
  if (subagent === null) {
    const llm = createChatModel({
      provider: request.provider,
      model: request.model,
      base_url: request.base_url,
      timeout_seconds: request.agent_timeout_seconds,
    });
    const toolset = make_toolset(request.retrieval_mode, request.include_shortcuts);
    resolvedSubagent = new RetrievalHeuristicSubagent(llm, toolset);
    master_llm = llm;
  } else {
    resolvedSubagent = subagent;
    master_llm = null;
  }
  const orchestrator = new AgentOrchestrator({
    graphql,
    subagent: resolvedSubagent,
    master_llm,
    max_concurrency: request.max_concurrency,
    agent_timeout_seconds: request.agent_timeout_seconds,
    on_metric_event: hooks.on_metric_event,
  });
  return await orchestrator.investigate(request);
}

// ── Evidence dedup + conflict detection ──

export function dedupe_evidence(results: HeuristicAgentResult[]): EvidenceReference[] {
  const seen = new Set<string>();
  const evidence: EvidenceReference[] = [];
  for (const result of results) {
    for (const ref of result.evidence_refs) {
      const key = JSON.stringify([ref.source, ref.table ?? null, ref.rowid ?? null, ref.record_id ?? null]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      evidence.push(ref);
    }
  }
  return evidence;
}

export function detect_conflicts(results: HeuristicAgentResult[]): ConflictSummary[] {
  const triggered = new Set<string>();
  for (const result of results) {
    if (["triggered", "mitigation", "quality"].includes(result.status) && result.score !== 0) {
      triggered.add(result.heuristic_id);
    }
  }
  const conflicts: ConflictSummary[] = [];
  if (triggered.has("owner_legal_presence")) {
    conflicts.push({
      id: "owner_legal_presence_mixed",
      title: "Owner legal presence may be mixed",
      heuristic_ids: ["owner_legal_presence"],
      summary:
        "Owner-linked legal records may include both subject and non-subject address evidence; review evidence_for and evidence_against carefully.",
      severity: "medium",
    });
  }
  const nonownerFamily = ["nonowner_legal_presence", "utility_occupancy", "loan_tenure_claims"].some((id) =>
    triggered.has(id),
  );
  if (triggered.has("case_quality") && nonownerFamily) {
    const heuristic_ids = ["case_quality", "nonowner_legal_presence", "utility_occupancy", "loan_tenure_claims"]
      .filter((id) => triggered.has(id))
      .sort();
    conflicts.push({
      id: "unit_ambiguity_with_nonowner_evidence",
      title: "Non-owner evidence may be unit-level",
      heuristic_ids,
      summary: "Condo, unit, or multifamily ambiguity can make address-level non-owner evidence less conclusive.",
      severity: "high",
    });
  }
  return conflicts;
}

// ── Master planning helpers ──

function _investigation_plan_from_tool_calls(
  response: any,
  heuristics: Record<string, any>[],
  add_omitted = true,
): CaseInvestigationPlan | null {
  const tool_calls = _response_tool_calls(response);
  if (tool_calls.length === 0) {
    return null;
  }
  const allowed_ids = new Set(heuristics.map((item) => String(item["id"])));
  for (const call of tool_calls) {
    if (String(call["name"] || "") !== "submit_investigation_plan") {
      return null;
    }
    const args = isRecord(call["args"]) ? call["args"] : {};
    let plan: CaseInvestigationPlan;
    try {
      plan = CaseInvestigationPlanSchema.parse({ ...args, planner: "master" });
    } catch (exc) {
      if (exc instanceof z.ZodError) {
        return null;
      }
      throw exc;
    }
    const selected = plan.selected.filter(
      (item) => allowed_ids.has(item.heuristic_id) && (item.decision === "run" || item.decision === "run_for_absence"),
    );
    const skipped = plan.skipped.filter((item) => allowed_ids.has(item.heuristic_id) && item.decision === "skip");
    const planned_ids = new Set([...selected, ...skipped].map((item) => item.heuristic_id));
    if (add_omitted) {
      for (const heuristic of heuristics) {
        const heuristic_id = String(heuristic["id"]);
        if (planned_ids.has(heuristic_id)) {
          continue;
        }
        selected.push(
          _default_plan_for_heuristic(heuristic, "Master plan omitted this allowed heuristic; running by fallback."),
        );
      }
    }
    return {
      selected,
      skipped,
      global_case_questions: plan.global_case_questions,
      planner: "master",
    };
  }
  return null;
}

function _fallback_investigation_plan(
  heuristics: Record<string, any>[],
  context: ResolvedAddressContext,
  reason: string,
  skipped: HeuristicPlan[] | null = null,
  global_case_questions: string[] | null = null,
): CaseInvestigationPlan {
  const selected = heuristics.map((item) => _default_plan_for_heuristic(item, reason, context));
  const questions = ["Adjudicate all selected heuristic submissions against the shared evidence map."];
  questions.push(...(global_case_questions ?? []));
  return {
    selected,
    skipped: [...(skipped ?? [])],
    global_case_questions: [...new Set(questions)],
    planner: "fallback",
  };
}

function _default_plan_for_heuristic(
  heuristic: Record<string, any>,
  reason: string,
  context: ResolvedAddressContext | null = null,
): HeuristicPlan {
  const sources = ((heuristic["input_sources"] ?? []) as any[]).map((item) => String(item));
  let gaps: string[] = [];
  if (context !== null) {
    gaps = sources.filter((source) => (context.source_counts[source] ?? 0) === 0);
  }
  const decision: "run" | "run_for_absence" =
    gaps.length > 0 && gaps.length === sources.length && sources.length > 0 ? "run_for_absence" : "run";
  const title = String(heuristic["title"] || heuristic["id"]);
  return {
    heuristic_id: String(heuristic["id"]),
    decision,
    priority: "medium",
    reason,
    expected_sources: sources,
    known_data_gaps: gaps,
    mission: `Evaluate ${title}. Document supporting evidence, contradicting evidence, and unavailable evidence.`,
  };
}

// ── Bucketing + dispatch ──

/**
 * Span metadata for one heuristic_worker (bucket): its ids/size plus the fixed bucket total
 * and this worker's 0-based index. workers_total + worker_index reach the --progress wire.
 */
export function _worker_span_metadata(
  bucket: Record<string, any>[],
  worker_index: number,
  workers_total: number,
): Record<string, unknown> {
  return {
    group_size: bucket.length,
    heuristic_ids: bucket.map((h) => String(h["id"])),
    workers_total,
    worker_index,
  };
}

/**
 * Bucket running heuristics by their packet group, preserving first-seen order.
 *
 * Heuristics with no group (group unset or absent) each become a singleton bucket, so a solo packet
 * dispatches exactly as before.
 */
export function _bucket_by_group(heuristics: Record<string, any>[]): Record<string, any>[][] {
  const buckets: Record<string, any>[][] = [];
  const index_by_group = new Map<string, number>();
  for (const heuristic of heuristics) {
    const group = heuristic["group"];
    if (!group) {
      buckets.push([heuristic]);
      continue;
    }
    const groupKey = String(group);
    if (!index_by_group.has(groupKey)) {
      index_by_group.set(groupKey, buckets.length);
      buckets.push([]);
    }
    buckets[index_by_group.get(groupKey)!]!.push(heuristic);
  }
  return buckets;
}

async function _dispatch_bucket(
  subagent: HeuristicSubagent,
  agent_inputs: HeuristicAgentInput[],
  graphql: CountingGraphQLTool,
): Promise<HeuristicAgentResult[]> {
  // Use the grouped path when available; fall back to sequential run() for subagents that predate
  // run_group (the HeuristicSubagent interface and run-only test fakes).
  const run_group = (subagent as any).run_group;
  if (typeof run_group === "function") {
    return await (subagent as any).run_group(agent_inputs, graphql);
  }
  const results: HeuristicAgentResult[] = [];
  for (const ai of agent_inputs) {
    results.push(await subagent.run(ai, graphql));
  }
  return results;
}

// ── Gating ──

function _gate_candidate_heuristics(
  context: ResolvedAddressContext,
  heuristics: Record<string, any>[],
): [Record<string, any>[], HeuristicPlan[], string[]] {
  const gate_by_id = new Map(
    evaluate_packet_gates(context.evidence_map as Record<string, unknown>).map((gate) => [gate.packet_id, gate] as const),
  );
  const runnable: Record<string, any>[] = [];
  const skipped: HeuristicPlan[] = [];
  const absence_notes: string[] = [];
  for (const heuristic of heuristics) {
    const heuristic_id = String(heuristic["id"]);
    const gate = gate_by_id.get(heuristic_id);
    if (gate === undefined) {
      runnable.push(heuristic);
      continue;
    }
    const expected_sources = gate.expected_sources.map((source) => String(source));
    const missing_sources = gate.missing_sources.map((source) => String(source));
    if (gate.decision === "run" || (heuristic_id === "case_quality_and_synthesis" && gate.decision === "run_for_absence")) {
      runnable.push(heuristic);
      if (gate.decision === "run_for_absence") {
        absence_notes.push(`${heuristic_id}: ${gate.reason}`);
      }
      continue;
    }
    skipped.push({
      heuristic_id,
      decision: "skip",
      priority: "low",
      reason: `Deterministic packet gate skipped this packet: ${gate.reason}`,
      expected_sources,
      known_data_gaps: missing_sources,
      mission: "Skipped before master planning because no included path had populated first-pass evidence.",
    });
    if (missing_sources.length > 0) {
      absence_notes.push(`${heuristic_id}: missing ${missing_sources.join(", ")}.`);
    }
  }
  return [runnable, skipped, [...new Set(absence_notes)]];
}

function _suppress_absence_workers(plan: CaseInvestigationPlan): CaseInvestigationPlan {
  const selected: HeuristicPlan[] = [];
  const skipped: HeuristicPlan[] = [...plan.skipped];
  for (const item of plan.selected) {
    if (item.decision !== "run_for_absence" || item.heuristic_id === "case_quality_and_synthesis") {
      selected.push(item);
      continue;
    }
    skipped.push({
      heuristic_id: item.heuristic_id,
      decision: "skip",
      priority: item.priority,
      reason: `Canonical heuristics record absence deterministically instead of launching a run_for_absence worker. Original reason: ${item.reason}`,
      expected_sources: item.expected_sources,
      known_data_gaps: item.known_data_gaps,
      mission: item.mission,
    });
  }
  return { selected, skipped, global_case_questions: plan.global_case_questions, planner: plan.planner };
}

// ── Master adjudication tool-call parsing ──

function _case_adjudication_from_tool_calls(
  response: any,
  raw_score: number,
): CaseAdjudication | Record<string, any> | null {
  const tool_calls = _response_tool_calls(response);
  if (tool_calls.length === 0) {
    return null;
  }
  for (const call of tool_calls) {
    const name = String(call["name"] || "");
    const tool_call_id = String(call["id"] || "submit_case_adjudication");
    if (name !== "submit_case_adjudication") {
      return {
        ok: false,
        tool_call_id,
        error: `Unknown master tool: ${name}. Use submit_case_adjudication.`,
      };
    }
    const rawArgs = isRecord(call["args"]) ? call["args"] : {};
    const args: Record<string, any> = { ...rawArgs };
    if (!("raw_score" in args)) {
      args["raw_score"] = raw_score;
    }
    try {
      return CaseAdjudicationSchema.parse(args);
    } catch (exc) {
      if (!(exc instanceof z.ZodError)) {
        throw exc;
      }
      return {
        ok: false,
        tool_call_id,
        error: zodErrorText(exc),
        instruction: "Retry submit_case_adjudication with fields matching CaseAdjudication exactly.",
        required_literals: {
          verdict_band: ["low_evidence", "monitor", "review", "high_priority_review", "manual_verification"],
          case_archetype: [...CASE_ARCHETYPE_VALUES],
        },
      };
    }
  }
  return null;
}

function _response_tool_calls(response: any): Record<string, any>[] {
  const tool_calls = response?.tool_calls;
  if (Array.isArray(tool_calls)) {
    return tool_calls.filter((call) => isRecord(call)).map((call) => ({ ...call }));
  }
  const additional_kwargs = response?.additional_kwargs ?? {};
  const raw_calls = additional_kwargs["tool_calls"];
  if (!Array.isArray(raw_calls)) {
    return [];
  }
  const parsed: Record<string, any>[] = [];
  for (const call of raw_calls) {
    if (!isRecord(call)) {
      continue;
    }
    const func = isRecord(call["function"]) ? call["function"] : {};
    let args: any = func["arguments"] || {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    parsed.push({ id: call["id"], name: func["name"] || call["name"], args });
  }
  return parsed;
}

export function fallback_adjudication(raw_score: any, reason: string): CaseAdjudication {
  const score = Math.trunc(Number(raw_score?.final_score)) || 0;
  const band: VerdictBand = (raw_score?.band ?? "low_evidence") as VerdictBand;
  return {
    raw_score: score,
    calibrated_score: score,
    clarity_score: score ? 5 : 2,
    verdict_band: band,
    case_archetype: score ? "mixed_evidence" : "insufficient_ownership_data",
    score_adjustments: [],
    reasoning_summary: reason,
    why_not_higher: [reason],
    why_not_lower: score ? [] : ["No positive raw heuristic score was available."],
  };
}

// ── Report assembly ──

export function build_report(
  adjudication: CaseAdjudication,
  raw_score: number,
  results: HeuristicAgentResult[],
  conflicts: ConflictSummary[],
): string {
  const active = results.filter((result) => result.score > 0 && result.status !== "error");
  const mitigations = results.filter((result) => result.score < 0 && result.status !== "error");
  const errors = results.filter((result) => result.status === "error");
  const lines = [
    `Verdict band: ${adjudication.verdict_band}. Calibrated score: ${adjudication.calibrated_score}. Raw score: ${raw_score}.`,
    `Case archetype: ${adjudication.case_archetype}. Clarity score: ${adjudication.clarity_score}.`,
    `Master adjudication: ${adjudication.reasoning_summary}`,
  ];
  if (active.length > 0) {
    lines.push("Primary risk signals: " + active.slice(0, 5).map((result) => result.finding).join("; "));
  }
  if (mitigations.length > 0) {
    lines.push("Mitigations: " + mitigations.slice(0, 5).map((result) => result.finding).join("; "));
  }
  if (conflicts.length > 0) {
    lines.push("Conflicts requiring review: " + conflicts.map((conflict) => conflict.title).join("; "));
  }
  if (errors.length > 0) {
    lines.push(`${errors.length} heuristic agents failed and were excluded from scoring.`);
  }
  return lines.join(" ");
}

function _compact_worker_result(result: HeuristicAgentResult, include_data = true): Record<string, any> {
  return {
    heuristic_id: result.heuristic_id,
    status: result.status,
    direction: result.direction,
    local_score: result.score,
    confidence: result.confidence,
    finding: result.finding,
    interpretation: result.interpretation,
    evidence_for: result.evidence_for.slice(0, 8).map((ref) => _compact_evidence_reference(ref, include_data)),
    evidence_against: result.evidence_against.slice(0, 8).map((ref) => _compact_evidence_reference(ref, include_data)),
    missing_evidence: result.missing_evidence,
    caveats: result.caveats,
    evidence_refs: result.evidence_refs.slice(0, 8).map((ref) => _compact_evidence_reference(ref, include_data)),
    tool_errors: result.tool_errors,
    validation_errors: result.validation_errors,
  };
}

function _compact_evidence_reference(ref: EvidenceReference, include_data: boolean): Record<string, any> {
  const payload: Record<string, any> = {
    source: ref.source,
    table: ref.table,
    rowid: ref.rowid,
    record_id: ref.record_id,
    summary: ref.summary,
  };
  if (include_data) {
    payload["data"] = ref.data;
  }
  return payload;
}

function _agent_metrics(opts: {
  candidate_count: number;
  gated_count: number;
  workers_total: number;
  plan: CaseInvestigationPlan;
  results: HeuristicAgentResult[];
  adjudication: CaseAdjudication;
  report: string;
}): Record<string, any> {
  const { candidate_count, gated_count, workers_total, plan, results, adjudication, report } = opts;
  // Always measured (both flags on and off) so the A/B can read leakage before vs after.
  const prose_texts = [
    ...results.flatMap((r) => [r.finding, ...r.caveats, ...r.missing_evidence]),
    adjudication.reasoning_summary,
    ...adjudication.why_not_higher,
    ...adjudication.why_not_lower,
    ...adjudication.score_adjustments.map((sa) => sa.reason),
    report,
  ];
  return {
    candidate_packets: candidate_count,
    gated_packets: gated_count,
    skipped_packets: plan.skipped.length,
    launched_subagents: results.length,
    workers_total,
    graphql_query_count: results.reduce((acc, result) => acc + result.graphql_queries.length, 0),
    tool_error_count: results.reduce((acc, result) => acc + result.tool_errors.length, 0),
    validation_error_count: results.reduce((acc, result) => acc + result.validation_errors.length, 0),
    query_repair_attempts: results.reduce((acc, result) => acc + result.query_repair_attempts, 0),
    evidence_refs_count: results.reduce((acc, result) => acc + result.evidence_refs.length, 0),
    report_bytes_estimate: Buffer.byteLength(report, "utf8"),
    prose_leak_count: count_prose_leaks(prose_texts),
  };
}

// ── Preflight builders ──

function _candidate(node: Record<string, any>): AddressCandidate {
  const address = isRecord(node["address"]) ? node["address"] : {};
  return AddressCandidateSchema.parse({
    id: Math.trunc(Number(address["id"])) || 0,
    norm_address: address["normAddress"] || "",
    zip5: address["zip5"] || "",
    match_score: Number(node["matchScore"] || 0),
    relation_count: Math.trunc(Number(node["relationCount"])) || 0,
    matched_fields: [...(Array.isArray(node["matchedFields"]) ? node["matchedFields"] : [])],
  });
}

function _report_provider(provider: string): string {
  try {
    return resolveProvider(provider as LlmProvider);
  } catch {
    // Injected test subagents may not require LLM credentials.
    return provider;
  }
}

function _selected_candidate(
  address_data: Record<string, any> | null,
  candidates: AddressCandidate[],
): AddressCandidate | null {
  if (address_data !== null && Object.keys(address_data).length > 0) {
    const ad = address_data as Record<string, any>;
    return AddressCandidateSchema.parse({
      id: Math.trunc(Number(ad["id"])) || 0,
      norm_address: ad["normAddress"] || "",
      zip5: ad["zip5"] || "",
      match_score: 1.0,
      relation_count: 0,
      matched_fields: ["address"],
    });
  }
  return candidates.length > 0 ? candidates[0]! : null;
}

function _is_ambiguous(candidates: AddressCandidate[]): boolean {
  if (candidates.length === 0) {
    return true;
  }
  if (candidates.length === 1) {
    return false;
  }
  return candidates[0]!.match_score < 1.0 || candidates[1]!.match_score === candidates[0]!.match_score;
}

function _source_counts(address_data: Record<string, any>): Record<string, number> {
  const mapping: Record<string, string> = {
    base: "residents",
    utility: "utilityRecords",
    tax: "taxProperties",
    trace: "traceRecords",
    auto: "autoRecords",
    loan: "loanRecords",
    drive: "driveRecords",
    voter: "voterRecords",
    criminal: "criminalRecords",
  };
  const counts: Record<string, number> = {};
  for (const [source, field] of Object.entries(mapping)) {
    const value = address_data[field] ?? {};
    counts[source] = Math.trunc(Number(value["totalCount"])) || 0;
  }
  return counts;
}

function _evidence_map(
  address_data: Record<string, any>,
  selected: AddressCandidate | null,
  source_counts: Record<string, number>,
  external_evidence: ExternalEvidence | null = null,
): CaseEvidenceMap {
  const normalized_address = (selected ? selected.norm_address : address_data["normAddress"]) || "";
  const zip5 = (selected ? selected.zip5 : address_data["zip5"]) || "";
  const owners = _owner_summaries(address_data, normalized_address);
  const people = _people_at_address_summaries(address_data, owners);
  // External refs are built first so they lead the list: compact_evidence_map's refs.slice(0, 8)
  // caps AFTER scope filtering, and the ordering is what keeps a citation a heuristic needs from
  // being crowded out. (compact_evidence_map re-asserts the ordering; this is where they enter.)
  const refs = [
    ...external_evidence_refs(external_evidence),
    ..._source_refs(address_data, "taxProperties", "tax", 5),
  ];
  const owner_presence_hints = _owner_presence_hints(address_data, owners, normalized_address);
  const nonowner_hints = _nonowner_occupancy_hints(address_data, owners);
  const data_gaps = Object.entries(source_counts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .filter(([, count]) => count === 0)
    .map(([source]) => `No ${source} rows found at selected address.`);
  const freshness_hints = _freshness_hints(address_data);
  let address_id: number | null;
  if (selected) {
    address_id = selected.id;
  } else if (address_data["id"] !== null && address_data["id"] !== undefined) {
    address_id = Math.trunc(Number(address_data["id"])) || 0;
  } else {
    address_id = null;
  }
  return {
    address_id,
    normalized_address,
    zip5,
    source_counts,
    // Deliberately EMPTY even with a payload: adapters.ts copies this into AddressEvidence and
    // _has_portfolio_hint flips a SCORING packet on "multi"/"portfolio". The property type reaches
    // prompts via ResolvedAddressContext.property_types, which both prompt builders prefer.
    property_types: [],
    rental_market_summary: rental_market_summary_lines(external_evidence),
    owner_summaries: owners,
    people_at_address: people,
    owner_presence_hints,
    owner_elsewhere_hints: _owner_elsewhere_hints(owners, normalized_address),
    nonowner_occupancy_hints: nonowner_hints,
    freshness_hints,
    data_gaps,
    evidence_refs: refs,
  };
}

function _owner_summaries(address_data: Record<string, any>, normalized_address: string): OwnerEvidenceSummary[] {
  const summaries: OwnerEvidenceSummary[] = [];
  const seen = new Set<string>();
  for (const node of _source_nodes(address_data, "taxProperties").slice(0, 5)) {
    const data = node["data"] ?? {};
    const owner = String(data["ownername"] || "Unknown owner").trim();
    if (!owner || seen.has(owner)) {
      continue;
    }
    seen.add(owner);
    const mailing_parts = [data["owneraddressline1"], data["ownercity"], data["ownerstate"], data["ownerzipcode"]];
    const mailing = mailing_parts
      .filter((part) => Boolean(part))
      .map((part) => String(part).trim())
      .join(" ");
    const mailing_line = String(data["owneraddressline1"] || "").trim();
    const mailing_matches =
      mailing_line && normalized_address ? _same_address_text(mailing_line, normalized_address) : null;
    const bits = [`owner=${owner}`];
    if (mailing) {
      bits.push(`mailing=${mailing}`);
    }
    for (const key of ["residential", "condo", "lendername", "totalliencount", "totallienbalance", "ownerrescount", "recordingdate"]) {
      if (data[key] !== null && data[key] !== undefined && data[key] !== "") {
        bits.push(`${key}=${data[key]}`);
      }
    }
    summaries.push(
      OwnerEvidenceSummarySchema.parse({
        owner_name: owner,
        mailing_address: mailing,
        mailing_matches_subject: mailing_matches,
        summaries: [bits.join("; ")],
      }),
    );
  }
  return summaries;
}

function _people_at_address_summaries(
  address_data: Record<string, any>,
  owners: OwnerEvidenceSummary[],
): PersonEvidenceSummary[] {
  const owner_tokens = _owner_name_tokens(owners);
  const grouped = new Map<string, PersonEvidenceSummary>();
  const fields: [string, string][] = [
    ["residents", "base"],
    ["driveRecords", "drive"],
    ["voterRecords", "voter"],
    ["autoRecords", "auto"],
    ["loanRecords", "loan"],
    ["traceRecords", "trace"],
    ["utilityRecords", "utility"],
  ];
  for (const [field, source] of fields) {
    const nodes = _source_nodes(address_data, field).slice(0, 10);
    for (const node of nodes) {
      // Use the nested `data` blob when it has fields; otherwise fall back to the node's own fields.
      const rawData = node["data"];
      const data = isRecord(rawData) && Object.keys(rawData).length > 0 ? rawData : node;
      const name = _person_name(data);
      if (!name) {
        continue;
      }
      let current = grouped.get(name);
      if (current === undefined) {
        current = {
          name,
          relationship_to_owner: _relationship_to_owner(name, owner_tokens),
          sources: [],
          summaries: [],
        };
        grouped.set(name, current);
      }
      if (!current.sources.includes(source)) {
        current.sources.push(source);
      }
      const summary_bits = [source];
      for (const key of ["own_rent", "ownRent", "address", "zip", "dob", "dob_year", "year", "make", "model"]) {
        if (data[key] !== null && data[key] !== undefined && data[key] !== "") {
          summary_bits.push(`${key}=${data[key]}`);
        }
      }
      current.summaries.push(summary_bits.join("; "));
    }
  }
  return [...grouped.values()].slice(0, 20);
}

function _owner_presence_hints(
  address_data: Record<string, any>,
  owners: OwnerEvidenceSummary[],
  normalized_address: string,
): string[] {
  const hints: string[] = [];
  if (owners.some((owner) => Boolean(owner.mailing_matches_subject))) {
    hints.push("At least one tax owner mailing address matches the selected address.");
  }
  for (const person of _people_at_address_summaries(address_data, owners)) {
    if (person.relationship_to_owner === "owner") {
      hints.push(`Owner-like name appears in ${person.sources.join(", ")}: ${person.name}.`);
    }
  }
  if (normalized_address && hints.length === 0) {
    hints.push("No compact preflight owner-presence hint found; subagents should verify with targeted queries.");
  }
  return hints.slice(0, 8);
}

function _owner_elsewhere_hints(owners: OwnerEvidenceSummary[], _normalized_address: string): string[] {
  void _normalized_address;
  const hints: string[] = [];
  for (const owner of owners) {
    if (owner.mailing_matches_subject === false && owner.mailing_address) {
      hints.push(`Owner mailing differs from selected address: ${owner.owner_name} -> ${owner.mailing_address}.`);
    }
  }
  return hints.slice(0, 8);
}

function _nonowner_occupancy_hints(address_data: Record<string, any>, owners: OwnerEvidenceSummary[]): string[] {
  const hints: string[] = [];
  for (const person of _people_at_address_summaries(address_data, owners)) {
    if (["likely_family", "unrelated", "unknown"].includes(person.relationship_to_owner)) {
      hints.push(`${person.relationship_to_owner} person at address via ${person.sources.join(", ")}: ${person.name}.`);
    }
  }
  return hints.slice(0, 10);
}

function _freshness_hints(address_data: Record<string, any>): string[] {
  const hints: string[] = [];
  for (const node of _source_nodes(address_data, "taxProperties").slice(0, 5)) {
    const data = node["data"] ?? {};
    if (data["recordingdate"]) {
      hints.push(`Tax recordingdate=${data["recordingdate"]}`);
    }
  }
  return hints.slice(0, 10);
}

function _source_refs(
  address_data: Record<string, any>,
  field: string,
  source: string,
  limit: number,
): EvidenceReference[] {
  const refs: EvidenceReference[] = [];
  for (const node of _source_nodes(address_data, field).slice(0, limit)) {
    const data = node["data"] ?? {};
    const dataSubset: Record<string, any> = {};
    for (const key of Object.keys(data).slice(0, 12)) {
      dataSubset[key] = data[key];
    }
    refs.push(
      EvidenceReferenceSchema.parse({
        source,
        table: node["table"] || source,
        rowid: node["rowid"] ?? null,
        summary: _short_source_summary(source, data),
        data: dataSubset,
      }),
    );
  }
  return refs;
}

function _source_nodes(address_data: Record<string, any>, field: string): Record<string, any>[] {
  const value = address_data[field] ?? {};
  const nodes = isRecord(value) ? value["nodes"] : null;
  const list = Array.isArray(nodes) ? nodes : [];
  return list.filter((node) => isRecord(node));
}

function _short_source_summary(source: string, data: Record<string, any>): string {
  const parts = [source];
  for (const key of ["ownername", "firstname", "firstName", "lastname", "lastName", "address", "status", "own_rent", "ownRent"]) {
    if (data[key]) {
      parts.push(`${key}=${data[key]}`);
    }
  }
  return parts.join("; ");
}

function _person_name(data: Record<string, any>): string {
  if (data["fullName"]) {
    return String(data["fullName"]).trim().toUpperCase();
  }
  const first = data["firstname"] || data["firstName"];
  const last = data["lastname"] || data["lastName"];
  const name = [first, last]
    .filter((part) => Boolean(part))
    .map((part) => String(part).trim())
    .join(" ");
  return name.toUpperCase();
}

function _owner_name_tokens(owners: OwnerEvidenceSummary[]): Set<string> {
  const tokens = new Set<string>();
  for (const owner of owners) {
    const normalized = owner.owner_name.replaceAll(";", " ").replaceAll(",", " ");
    for (const token of normalized.toUpperCase().split(/\s+/)) {
      if (token.length > 1) {
        tokens.add(token);
      }
    }
  }
  return tokens;
}

function _relationship_to_owner(
  name: string,
  owner_tokens: Set<string>,
): "owner" | "likely_family" | "unrelated" | "unknown" {
  const tokens = new Set<string>(name.toUpperCase().split(/\s+/).filter((token) => token.length > 1));
  if (tokens.size > 0 && [...tokens].every((token) => owner_tokens.has(token))) {
    return "owner";
  }
  if ([...tokens].some((token) => owner_tokens.has(token))) {
    return "likely_family";
  }
  return owner_tokens.size > 0 ? "unrelated" : "unknown";
}

function _same_address_text(left: string, right: string): boolean {
  return _address_key(left) === _address_key(right);
}

function _address_key(value: string): string {
  return [...value.toUpperCase()].filter((ch) => _isAlnum(ch)).join("");
}

function _isAlnum(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

function _global_caveats(context: ResolvedAddressContext, results: HeuristicAgentResult[]): string[] {
  const caveats = ["Agent results are investigative leads only and are not fraud determinations."];
  if (context.ambiguous) {
    caveats.push("Address resolution is ambiguous; review selected address and candidates.");
  }
  if (results.some((result) => result.status === "error")) {
    caveats.push("One or more heuristic agents failed and were excluded from scoring.");
  }
  return caveats;
}

// ── Concurrency + timeout primitives ──

// A minimal FIFO permit limiter. acquire() takes a permit or queues a resolver; release() hands the
// permit directly to the next waiter (FIFO) or returns it to the pool.
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = Math.max(0, permits);
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    } else {
      this.permits += 1;
    }
  }
}

// Race the work against a timer. On timeout, reject with Error("") so the caller's `errStr` yields ""
// and error_result falls back to its default message via the generic bucket catch.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

// ── Local helpers ──

/** A distinguishable error for the adjudication retry path. */
class ValueError extends Error {}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Message text of an error (no "Error: " prefix), or a stringified non-error value. */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// A readable "<path>: <message>" rendering, used for the corrective error text handed back to the
// master LLM on a failed adjudication tool call (informational only).
function zodErrorText(exc: unknown): string {
  if (exc instanceof z.ZodError) {
    return exc.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
  }
  return String(exc);
}
