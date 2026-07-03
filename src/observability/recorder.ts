// Port of occupancy_engine/observability/recorder.py.
//
// PORT NOTE (naming): the MetricsRecorder public methods keep their Python snake_case names
// (span, record_llm_call, record_tool_call, record_graphql_call, record_counter, record_event,
// events, summary, payload_metadata) so the many call sites across the agent pipeline map 1:1.
// Python keyword-only args ("*, name=..., agent_id=...") become a single options object.
//
// PORT NOTE (context / concurrency): Python uses two contextvars.ContextVar values — one for the
// per-async-task current recorder, one for the current span id. Node's AsyncLocalStorage is the
// faithful equivalent: a value set via `.run(store, fn)` is visible to the whole async subtree
// spawned inside `fn` (propagating across every `await`) and is isolated between concurrent tasks.
//   - `with set_current_recorder(rec): ...`  ->  `runWithRecorder(rec, fn)`
//   - `current_recorder()`                   ->  `currentRecorder()`
// The `with recorder.span(...) as sid: <body>` context manager becomes
// `recorder.span(phase, opts, async (sid) => { <body> })`.
//
// PORT NOTE (locking): Python guards `_events` / `_seen_llm_run_ids` with a threading.Lock because
// LangChain callbacks can fire from worker threads. The JS event loop is single-threaded and these
// mutations are synchronous, so no lock is needed.
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  makeMetricEvent,
  makeRunMetricsSummary,
  metricEventNow,
  type CostEstimate,
  type MetricEvent,
  type MetricEventType,
  type RunMetricsSummary,
  type TokenUsage,
} from "./models.ts";
import { estimateCost } from "./pricing.ts";

export interface RunMetricsContext {
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
}

/** Build a RunMetricsContext with the Python dataclass defaults (run_id is required). */
export function makeRunMetricsContext(
  partial: Partial<RunMetricsContext> & Pick<RunMetricsContext, "run_id">,
): RunMetricsContext {
  return {
    batch_id: "",
    investigation_id: "",
    address_key: "",
    address: "",
    zip: "",
    provider: "",
    model: "",
    prompt_profile: "",
    include_shortcuts: false,
    ...partial,
  };
}

export interface SpanOptions {
  name?: string;
  agent_id?: string;
  heuristic_id?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordLlmCallOptions {
  phase: string;
  agent_id: string;
  heuristic_id?: string;
  name?: string;
  usage?: TokenUsage | null;
  latency_ms?: number | null;
  status?: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
  langchain_run_id?: string;
  langchain_parent_run_id?: string;
}

export interface RecordToolCallOptions {
  tool_name: string;
  phase?: string;
  agent_id?: string;
  heuristic_id?: string;
  latency_ms?: number | null;
  status?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordGraphqlCallOptions {
  call_type: string;
  operation_name: string;
  latency_ms?: number | null;
  status?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  agent_id?: string;
  heuristic_id?: string;
}

export interface RecordCounterOptions {
  phase?: string;
  agent_id?: string;
  heuristic_id?: string;
  metadata?: Record<string, unknown>;
}

export interface PayloadMetadataOptions {
  preview_limit?: number;
}

export type AnyMetricsRecorder = MetricsRecorder | NoopMetricsRecorder;

const recorderStorage = new AsyncLocalStorage<AnyMetricsRecorder>();
const spanStorage = new AsyncLocalStorage<string>();

export function currentRecorder(): AnyMetricsRecorder {
  return recorderStorage.getStore() ?? new NoopMetricsRecorder();
}

/**
 * PORT NOTE: replaces Python's `with set_current_recorder(rec): ...` context manager. Runs `fn`
 * with `rec` installed as the current recorder for the whole async subtree, then restores.
 */
export function runWithRecorder<T>(recorder: AnyMetricsRecorder, fn: () => T): T {
  return recorderStorage.run(recorder, fn);
}

export class MetricsRecorder {
  readonly context: RunMetricsContext;
  enabled: boolean;
  debug_payloads: boolean;
  private readonly _events: MetricEvent[] = [];
  private readonly _seen_llm_run_ids = new Set<string>();

  constructor(context: RunMetricsContext, opts: { enabled?: boolean; debug_payloads?: boolean } = {}) {
    this.context = context;
    this.enabled = opts.enabled ?? true;
    this.debug_payloads = opts.debug_payloads ?? false;
  }

  async span<T>(phase: string, opts: SpanOptions, fn: (spanId: string) => T | Promise<T>): Promise<T> {
    if (!this.enabled) {
      return fn("");
    }
    const spanId = uuidHex();
    const parentSpanId = spanStorage.getStore() ?? "";
    const startedAt = metricEventNow();
    const start = performance.now();
    let status = "ok";
    let errorType = "";
    let errorMessage = "";
    try {
      return await spanStorage.run(spanId, async () => fn(spanId));
    } catch (exc) {
      status = "error";
      errorType = errorTypeName(exc);
      errorMessage = errorMessageOf(exc);
      throw exc;
    } finally {
      this.record_event("span", {
        phase,
        name: opts.name ?? "",
        agent_id: opts.agent_id ?? "",
        heuristic_id: opts.heuristic_id ?? "",
        span_id: spanId,
        parent_span_id: parentSpanId,
        started_at: startedAt,
        ended_at: metricEventNow(),
        latency_ms: elapsedMs(start),
        status,
        error_type: errorType,
        error_message: errorMessage,
        metadata: opts.metadata ?? {},
      });
    }
  }

  record_llm_call(opts: RecordLlmCallOptions): void {
    if (opts.langchain_run_id) {
      if (this._seen_llm_run_ids.has(opts.langchain_run_id)) {
        return;
      }
      this._seen_llm_run_ids.add(opts.langchain_run_id);
    }
    const usage = opts.usage ?? null;
    const cost: CostEstimate | null =
      usage !== null ? estimateCost(this.context.provider, this.context.model, usage) : null;
    const error = opts.error;
    this.record_event("llm_call", {
      phase: opts.phase,
      name: opts.name ?? "",
      agent_id: opts.agent_id,
      heuristic_id: opts.heuristic_id ?? "",
      latency_ms: opts.latency_ms ?? null,
      status: error ? "error" : (opts.status ?? "ok"),
      error_type: error ? errorTypeName(error) : "",
      error_message: error ? errorMessageOf(error) : "",
      metadata: opts.metadata ?? {},
      token_usage: usage,
      cost_estimate: cost,
      langchain_run_id: opts.langchain_run_id ?? "",
      langchain_parent_run_id: opts.langchain_parent_run_id ?? "",
    });
  }

  record_tool_call(opts: RecordToolCallOptions): void {
    this.record_event("tool_call", {
      phase: opts.phase ?? "tool_call",
      name: opts.tool_name,
      agent_id: opts.agent_id ?? "",
      heuristic_id: opts.heuristic_id ?? "",
      latency_ms: opts.latency_ms ?? null,
      status: opts.status ?? "ok",
      error_message: opts.error ?? "",
      metadata: opts.metadata ?? {},
    });
  }

  record_graphql_call(opts: RecordGraphqlCallOptions): void {
    this.record_event("graphql_call", {
      phase: `graphql_${opts.call_type}`,
      name: opts.operation_name,
      agent_id: opts.agent_id ?? "graphql",
      heuristic_id: opts.heuristic_id ?? "",
      latency_ms: opts.latency_ms ?? null,
      status: opts.status ?? "ok",
      error_message: opts.error ?? "",
      metadata: opts.metadata ?? {},
    });
  }

  record_counter(name: string, opts: RecordCounterOptions = {}): void {
    this.record_event("counter", {
      phase: opts.phase ?? "",
      name,
      agent_id: opts.agent_id ?? "",
      heuristic_id: opts.heuristic_id ?? "",
      metadata: opts.metadata ?? {},
    });
  }

  record_event(event_type: MetricEventType, fields: Partial<MetricEvent> = {}): void {
    if (!this.enabled) {
      return;
    }
    const { parent_span_id, started_at, ended_at, ...rest } = fields;
    const event = makeMetricEvent({
      event_id: uuidHex(),
      event_type,
      run_id: this.context.run_id,
      batch_id: this.context.batch_id,
      investigation_id: this.context.investigation_id,
      address_key: this.context.address_key,
      address: this.context.address,
      zip: this.context.zip,
      provider: this.context.provider,
      model: this.context.model,
      prompt_profile: this.context.prompt_profile,
      include_shortcuts: this.context.include_shortcuts,
      parent_span_id: parent_span_id ?? (spanStorage.getStore() ?? ""),
      started_at: started_at ?? metricEventNow(),
      ended_at: ended_at ?? metricEventNow(),
      ...rest,
    });
    this._events.push(event);
  }

  events(): MetricEvent[] {
    return [...this._events];
  }

  summary(): RunMetricsSummary {
    const events = this.events();
    const summary = makeRunMetricsSummary({
      run_id: this.context.run_id,
      batch_id: this.context.batch_id,
      investigation_id: this.context.investigation_id,
      address_key: this.context.address_key,
      address: this.context.address,
      zip: this.context.zip,
      provider: this.context.provider,
      model: this.context.model,
      prompt_profile: this.context.prompt_profile,
      include_shortcuts: this.context.include_shortcuts,
      event_count: events.length,
    });
    const costs: number[] = [];
    for (const event of events) {
      summary.phase_counts[event.phase] = (summary.phase_counts[event.phase] ?? 0) + 1;
      if (event.agent_id) {
        summary.agent_counts[event.agent_id] = (summary.agent_counts[event.agent_id] ?? 0) + 1;
      }
      if (event.heuristic_id) {
        summary.heuristic_counts[event.heuristic_id] = (summary.heuristic_counts[event.heuristic_id] ?? 0) + 1;
      }
      if (event.event_type === "span" && event.phase === "investigation") {
        summary.latency_ms = event.latency_ms;
      }
      if (event.event_type === "llm_call") {
        summary.llm_call_count += 1;
        if (event.token_usage) {
          summary.input_tokens += event.token_usage.input_tokens;
          summary.output_tokens += event.token_usage.output_tokens;
          summary.total_tokens += event.token_usage.total_tokens;
          summary.cache_creation_input_tokens += event.token_usage.cache_creation_input_tokens;
          summary.cache_read_input_tokens += event.token_usage.cache_read_input_tokens;
          summary.reasoning_output_tokens += event.token_usage.reasoning_output_tokens;
        }
        if (event.cost_estimate && event.cost_estimate.total_cost_usd !== null) {
          costs.push(event.cost_estimate.total_cost_usd);
        }
      }
      if (event.event_type === "tool_call") {
        summary.tool_call_count += 1;
      }
      if (event.event_type === "graphql_call") {
        if (event.phase === "graphql_query") {
          summary.graphql_query_count += 1;
        } else if (event.phase === "graphql_validate") {
          summary.graphql_validation_count += 1;
        } else if (event.phase === "graphql_schema") {
          summary.graphql_schema_tool_call_count += 1;
        }
        if (event.status !== "ok") {
          summary.graphql_error_count += 1;
        }
      }
      if (event.status !== "ok") {
        summary.error_count += 1;
      }
    }
    summary.estimated_cost_usd = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
    return summary;
  }

  payload_metadata(value: unknown, opts: PayloadMetadataOptions = {}): Record<string, unknown> {
    const previewLimit = opts.preview_limit ?? 4000;
    const text = typeof value === "string" ? value : pyJsonDumps(value);
    const payload: Record<string, unknown> = {
      chars: codePointLength(text),
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    };
    if (this.debug_payloads) {
      payload["preview"] = sliceByCodePoints(text, previewLimit);
    }
    return payload;
  }
}

export class NoopMetricsRecorder {
  enabled = false;
  debug_payloads = false;

  async span<T>(_phase: string, _opts: SpanOptions, fn: (spanId: string) => T | Promise<T>): Promise<T> {
    return fn("");
  }

  record_llm_call(_opts: RecordLlmCallOptions): void {}

  record_tool_call(_opts: RecordToolCallOptions): void {}

  record_graphql_call(_opts: RecordGraphqlCallOptions): void {}

  record_counter(_name: string, _opts: RecordCounterOptions = {}): void {}

  record_event(_eventType: MetricEventType, _fields: Partial<MetricEvent> = {}): void {}

  events(): MetricEvent[] {
    return [];
  }

  summary(): RunMetricsSummary {
    return makeRunMetricsSummary();
  }

  payload_metadata(value: unknown, _opts: PayloadMetadataOptions = {}): Record<string, unknown> {
    const text = typeof value === "string" ? value : pyJsonDumps(value);
    return {
      chars: codePointLength(text),
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: "",
    };
  }
}

function uuidHex(): string {
  return randomUUID().replace(/-/g, "");
}

/** Port of _elapsed_ms: milliseconds since `startMs`, rounded to 3 decimals. */
function elapsedMs(startMs: number): number {
  return Math.round((performance.now() - startMs) * 1000) / 1000;
}

/** Python `type(exc).__name__`. */
function errorTypeName(exc: unknown): string {
  if (exc !== null && typeof exc === "object") {
    const ctor = (exc as { constructor?: { name?: string } }).constructor;
    if (ctor?.name) {
      return ctor.name;
    }
  }
  return typeof exc;
}

/** Python `str(exc)`. */
function errorMessageOf(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function codePointLength(text: string): number {
  // Python len(str) counts Unicode code points; JS string.length counts UTF-16 units.
  let count = 0;
  for (const _ of text) {
    count += 1;
  }
  return count;
}

function sliceByCodePoints(text: string, limit: number): string {
  // Python text[:limit] slices by code point.
  return [...text].slice(0, limit).join("");
}

// PORT NOTE (payload hashing): Python computes chars/bytes/sha256 over
// `json.dumps(value, sort_keys=True, default=str)`. This helper mirrors that serialization
// (sorted keys, ", "/": " separators, ensure_ascii escaping, Infinity/NaN literals, non-JSON
// values coerced via String()) so the fingerprints line up with the Python recorder. Because
// ensure_ascii yields pure ASCII, `chars`/`bytes` also match Python's len() for dict/list inputs.
function pyJsonDumps(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  const t = typeof value;
  if (t === "string") {
    return encodePyString(value as string);
  }
  if (t === "boolean") {
    return value ? "true" : "false";
  }
  if (t === "number") {
    return String(value);
  }
  if (t === "bigint") {
    return (value as bigint).toString();
  }
  if (Array.isArray(value)) {
    return "[" + value.map(pyJsonDumps).join(", ") + "]";
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .map((key) => encodePyString(key) + ": " + pyJsonDumps(obj[key]));
    return "{" + parts.join(", ") + "}";
  }
  // default=str fallback (dates, class instances, etc.)
  return encodePyString(String(value));
}

function encodePyString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (ch === "\b") {
      out += "\\b";
    } else if (ch === "\f") {
      out += "\\f";
    } else if (code < 0x20) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else if (code < 0x80) {
      out += ch;
    } else if (code > 0xffff) {
      const c = code - 0x10000;
      const hi = 0xd800 + (c >> 10);
      const lo = 0xdc00 + (c & 0x3ff);
      out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
    } else {
      out += "\\u" + code.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}
