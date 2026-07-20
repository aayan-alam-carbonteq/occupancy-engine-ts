// Shared transport contract for the CLI and the HTTP service: the NDJSON progress-line format, the
// terminal report payload (assessment minus telemetry), and the request-body parse. One copy so the
// wire never drifts between callers.
import {
  AgentInvestigationRequestSchema,
  type AgentInvestigationRequest,
  type OccupancyAgentAssessment,
} from "./models.ts";
import type { MetricEvent } from "../observability/models.ts";

/** One NDJSON line for a metric event — the exact object the backend progress translator consumes. */
export function formatProgressLine(event: MetricEvent): string {
  const launched = event.metadata["launched_subagents"];
  const workersTotal = event.metadata["workers_total"];
  const workerIndex = event.metadata["worker_index"];
  // span_start times the open; every other event type times its completion.
  const ts = event.event_type === "span_start" ? event.started_at : event.ended_at;
  return JSON.stringify({
    progress: {
      seq: event.seq,
      event_id: event.event_id,
      span_id: event.span_id,
      parent_span_id: event.parent_span_id || null,
      ts,
      event_type: event.event_type,
      phase: event.phase,
      agent_id: event.agent_id,
      heuristic_id: event.heuristic_id,
      name: event.name,
      workers_total: typeof workersTotal === "number" ? workersTotal : null,
      worker_index: typeof workerIndex === "number" ? workerIndex : null,
      status: event.status,
      ...(typeof launched === "number" ? { count: launched } : {}),
    },
  });
}

/**
 * The serializable report payload: the assessment with the telemetry buffer removed. metrics_events is
 * dropped from output (it is the raw event log); every other field is preserved in order.
 */
export function assessment_report_payload(
  assessment: OccupancyAgentAssessment,
): Record<string, unknown> {
  const { metrics_events, ...rest } = assessment as OccupancyAgentAssessment & { metrics_events?: unknown };
  void metrics_events;
  return rest;
}

export type RequestParseResult =
  | { ok: true; request: AgentInvestigationRequest }
  | { ok: false; issues: string[] };

/** Parse a raw request body into an AgentInvestigationRequest. The schema is already .strict(), so
 *  unknown keys fail here. On failure the issues carry the zod path (for a 400 response). */
export function parse_investigation_request(raw: unknown): RequestParseResult {
  const result = AgentInvestigationRequestSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, request: result.data };
  }
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, issues };
}
