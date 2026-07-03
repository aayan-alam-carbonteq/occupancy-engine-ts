// Telemetry record types for the metrics recorder.
// These are internal telemetry records built by our own recorder (never parsed from untrusted
// input), so they are plain TS types with default factories rather than zod schemas.

export type MetricEventType =
  | "span"
  | "llm_call"
  | "tool_call"
  | "graphql_call"
  | "error"
  | "counter";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  reasoning_output_tokens: number;
  audio_input_tokens: number;
  audio_output_tokens: number;
  raw_usage: Record<string, unknown>;
  raw_response_metadata: Record<string, unknown>;
}

export function makeTokenUsage(partial: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_output_tokens: 0,
    audio_input_tokens: 0,
    audio_output_tokens: 0,
    raw_usage: {},
    raw_response_metadata: {},
    ...partial,
  };
}

export interface CostEstimate {
  input_cost_usd: number | null;
  output_cost_usd: number | null;
  total_cost_usd: number | null;
  pricing_status: string;
  pricing_version: string;
}

export function makeCostEstimate(partial: Partial<CostEstimate> = {}): CostEstimate {
  return {
    input_cost_usd: null,
    output_cost_usd: null,
    total_cost_usd: null,
    pricing_status: "unknown_model",
    pricing_version: "",
    ...partial,
  };
}

export interface MetricEvent {
  event_id: string;
  event_type: MetricEventType;
  run_id: string;
  batch_id: string;
  investigation_id: string;
  address_key: string;
  address: string;
  zip: string;
  phase: string;
  agent_id: string;
  heuristic_id: string;
  provider: string;
  model: string;
  prompt_profile: string;
  include_shortcuts: boolean;
  span_id: string;
  parent_span_id: string;
  langchain_run_id: string;
  langchain_parent_run_id: string;
  started_at: string;
  ended_at: string;
  latency_ms: number | null;
  status: string;
  error_type: string;
  error_message: string;
  name: string;
  metadata: Record<string, unknown>;
  token_usage: TokenUsage | null;
  cost_estimate: CostEstimate | null;
}

/** MetricEvent.now() — UTC ISO timestamp with millisecond precision. */
export function metricEventNow(): string {
  // toISOString() is UTC with milliseconds, e.g. 2026-07-03T08:47:03.648Z
  return new Date().toISOString();
}

export function makeMetricEvent(partial: Partial<MetricEvent> & Pick<MetricEvent, "event_id" | "event_type" | "run_id">): MetricEvent {
  return {
    batch_id: "",
    investigation_id: "",
    address_key: "",
    address: "",
    zip: "",
    phase: "",
    agent_id: "",
    heuristic_id: "",
    provider: "",
    model: "",
    prompt_profile: "",
    include_shortcuts: false,
    span_id: "",
    parent_span_id: "",
    langchain_run_id: "",
    langchain_parent_run_id: "",
    started_at: "",
    ended_at: "",
    latency_ms: null,
    status: "ok",
    error_type: "",
    error_message: "",
    name: "",
    metadata: {},
    token_usage: null,
    cost_estimate: null,
    ...partial,
  };
}

export interface RunMetricsSummary {
  run_id: string;
  batch_id: string;
  investigation_id: string;
  address_key: string;
  address: string;
  zip: string;
  provider: string;
  model: string;
  prompt_profile: string;
  include_shortcuts: boolean;
  event_count: number;
  latency_ms: number | null;
  llm_call_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  reasoning_output_tokens: number;
  estimated_cost_usd: number | null;
  tool_call_count: number;
  graphql_query_count: number;
  graphql_validation_count: number;
  graphql_schema_tool_call_count: number;
  graphql_error_count: number;
  error_count: number;
  phase_counts: Record<string, number>;
  agent_counts: Record<string, number>;
  heuristic_counts: Record<string, number>;
}

export function makeRunMetricsSummary(partial: Partial<RunMetricsSummary> = {}): RunMetricsSummary {
  return {
    run_id: "",
    batch_id: "",
    investigation_id: "",
    address_key: "",
    address: "",
    zip: "",
    provider: "",
    model: "",
    prompt_profile: "",
    include_shortcuts: false,
    event_count: 0,
    latency_ms: null,
    llm_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    reasoning_output_tokens: 0,
    estimated_cost_usd: null,
    tool_call_count: 0,
    graphql_query_count: 0,
    graphql_validation_count: 0,
    graphql_schema_tool_call_count: 0,
    graphql_error_count: 0,
    error_count: 0,
    phase_counts: {},
    agent_counts: {},
    heuristic_counts: {},
    ...partial,
  };
}
