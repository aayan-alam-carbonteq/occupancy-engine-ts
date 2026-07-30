// The agent's data-access layer: a typed HTTP client for the occupancy data service — the six typed
// operations of Contract B, the guarded SQL hatch and the curated schema of Contract C — plus the
// per-agent call-budget accounting the subagent loop depends on (CountingDataClient, added next).
//
// A 422 from /v1/sql is a RESULT, not an error: it carries the planner's own reason and is what the
// agent repairs against. Every other non-2xx is a DataClientError.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { currentRecorder } from "../observability/index.ts";
import { DataCallLogSchema, type DataCallLog } from "./models.ts";
import type { QueryCache } from "./query_cache.ts";

/** Raised when a data-service call fails or violates a tool guardrail. */
export class DataClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataClientError";
  }
}

/** The seven shapes the partner corpus actually has (source/manifest.py SHAPES). */
export const SHAPES: readonly string[] = ["base", "tax", "utility", "trace", "auto", "loan", "drive"];

/**
 * One record exactly as the service serves it: the RAW vendor row (`ownername`, `first_name`,
 * `dob_day`, …). `records.records_block` returns `{**row}` — the row itself, not a
 * `{source, table, rowid, data}` wrapper — so the vendor column names ARE the field names.
 *
 * Contract B addendum 2: bundle-sourced rows carry `__rowid`, the handle operation 6 takes.
 * `hal:`-sourced rows are served with `with_rowid=False` and carry none, and a clustered `addr:`
 * person's row can carry an explicit `null`. Both mean "not citable" — never rowid 0. Read it
 * through `rowRowid` rather than off the field.
 */
export type SourceRow = Record<string, unknown> & { __rowid?: number | null };

/** The citable bundle position of a record, or null when it has none (Contract B addendum 2). */
export function rowRowid(row: SourceRow): number | null {
  const value = row["__rowid"];
  return typeof value === "number" ? value : null;
}

export interface RecordBlock {
  total_count: number;
  has_more: boolean;
  records: SourceRow[];
}

export interface ResolveCandidate {
  address_id: number;
  match_score: number;
  matched_fields: string[];
  relation_count: number;
  norm_address: string;
  zip5: string;
  street_number: string | null;
  street_name: string | null;
  unit: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
}

export interface ResolveResponse {
  candidates: ResolveCandidate[];
  address_id: number | null;
  source_counts: Record<string, number>;
  dropped_counts: Record<string, number>;
  tax_timed_out: boolean;
  records_by_source: Record<string, RecordBlock>;
}

export interface PersonSummary {
  id: string;
  firstname?: string | null;
  middlename?: string | null;
  lastname?: string | null;
  full_name?: string | null;
  norm_name_key?: string | null;
  sources?: string[];
  primary_address_id?: number | null;
  // Present on every hal:-sourced person. The partner ER graph is 17.9% suspicious and peaks at
  // confidence 40.50, so the model must be able to discount it.
  identity_confidence?: number | null;
  is_suspicious?: boolean | null;
}

export interface AddressRecordsResponse {
  records_by_source: Record<string, RecordBlock>;
  unsupported_shapes: string[];
}

export interface AddressPeopleResponse {
  total_count: number;
  has_more: boolean;
  people: PersonSummary[];
}

export interface PersonRecordsResponse {
  person: PersonSummary;
  records_by_source: Record<string, RecordBlock>;
  // Contract B addendum 3: the hal: traversal fetches rows by (source_table, record_id) and no index
  // covers record_id, so it runs under the statement timeout. An empty records_by_source with this
  // flag SET is "the lookup ran out of time", not "this person has no records elsewhere" — reading
  // one as the other quietly breaks owner-elsewhere detection. Callers must branch on it.
  records_timed_out: boolean;
  unsupported_shapes: string[];
}

export interface PeopleSearchHit extends PersonSummary {
  match_score: number;
  record_count: number;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface PeopleSearchResponse {
  total_count: number;
  has_more: boolean;
  results: PeopleSearchHit[];
}

export interface SourceRecordResponse {
  source: string;
  table: string;
  rowid: number;
  // `row["id"] or row[f"{shape}_id"]` — both can be absent, so this is nullable.
  record_id: string | null;
  summary: string;
  data: Record<string, unknown>;
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  plan_cost: number;
  duration_ms: number;
}

export interface SqlRefusal {
  refused: true;
  stage: "parse" | "explain";
  reason: string;
  hint: string;
}

export type SqlResponse = SqlResult | SqlRefusal;

/** Narrows the /v1/sql result. Takes `unknown` so the budget wrapper can test a generic value. */
export function isSqlRefusal(value: unknown): value is SqlRefusal {
  return isRecord(value) && value["refused"] === true;
}

export interface DataSchemaTable {
  name: string;
  purpose: string;
  key_columns: string[];
}

export interface DataSchemaAccessPath {
  predicate: string;
  table: string;
  index: string;
  // schema_doc.ACCESS_PATHS calls this `measured`, not `measured_cost`; it is prose
  // ("173 ms warm, 24 k rows examined"), not a number.
  measured: string;
  hint_key?: string;
}

export interface DataSchemaLimits {
  max_rows: number;
  max_plan_cost: number;
  max_records_seqscan_cost: number;
  statement_timeout_ms: number;
}

export interface DataSchema {
  tables: DataSchemaTable[];
  access_paths: DataSchemaAccessPath[];
  caveats: string[];
  // Served by schema_document() alongside the three keys Contract C names. Optional because the
  // contract line pins only the three — but it is the ceiling the agent's SQL has to fit inside.
  limits?: DataSchemaLimits;
}

// See "Contract B addenda" in the plan — operation 6 takes address_id; person records carry
// records_timed_out; bundle records carry __rowid.
export class DataHttpClient {
  readonly base_url: string;
  timeout_seconds: number;
  max_response_bytes: number;

  constructor(base_url: string, opts: { timeout_seconds?: number; max_response_bytes?: number } = {}) {
    this.base_url = String(base_url ?? "").replace(/\/+$/, "");
    this.timeout_seconds = opts.timeout_seconds ?? 30.0;
    this.max_response_bytes = opts.max_response_bytes ?? 1_000_000;
  }

  async resolve(address: string, zip: string): Promise<ResolveResponse> {
    return (await this._json("resolve", "POST", "/v1/resolve", { body: { address, zip: zip ?? "" } })) as ResolveResponse;
  }

  async address_records(
    address_id: number,
    opts: { shapes?: string[]; limit?: number; offset?: number } = {},
  ): Promise<AddressRecordsResponse> {
    const query: Record<string, string> = {};
    if (opts.shapes && opts.shapes.length > 0) query["shapes"] = opts.shapes.join(",");
    if (opts.limit !== undefined) query["limit"] = String(opts.limit);
    if (opts.offset !== undefined) query["offset"] = String(opts.offset);
    return (await this._json("address_records", "GET", `/v1/address/${address_id}/records`, { query })) as AddressRecordsResponse;
  }

  async address_people(
    address_id: number,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<AddressPeopleResponse> {
    const query: Record<string, string> = {};
    if (opts.limit !== undefined) query["limit"] = String(opts.limit);
    if (opts.offset !== undefined) query["offset"] = String(opts.offset);
    return (await this._json("address_people", "GET", `/v1/address/${address_id}/people`, { query })) as AddressPeopleResponse;
  }

  async person_records(
    person_id: string,
    opts: { shapes?: string[]; limit?: number } = {},
  ): Promise<PersonRecordsResponse> {
    const query: Record<string, string> = {};
    if (opts.shapes && opts.shapes.length > 0) query["shapes"] = opts.shapes.join(",");
    if (opts.limit !== undefined) query["limit"] = String(opts.limit);
    // Person ids are discriminated and contain ':' — addr:<addressId>:<n> or hal:<hal_id>.
    const path = `/v1/person/${encodeURIComponent(person_id)}/records`;
    return (await this._json("person_records", "GET", path, { query })) as PersonRecordsResponse;
  }

  async search_people(name: string, opts: { limit?: number } = {}): Promise<PeopleSearchResponse> {
    const query: Record<string, string> = { name };
    if (opts.limit !== undefined) query["limit"] = String(opts.limit);
    return (await this._json("search_people", "GET", "/v1/people/search", { query })) as PeopleSearchResponse;
  }

  /**
   * Operation 6. `address_id` is REQUIRED (Contract B addendum 1): `rowid` is the row's index within
   * one address's rows for that shape, so it is meaningless without the address that scopes it. It
   * is a positional parameter, not an option, so the compiler makes every call site thread it — the
   * service answers a naked call with a 400 naming the parameter, checked BEFORE the shape.
   */
  async source_record(shape: string, rowid: number, address_id: number): Promise<SourceRecordResponse> {
    const path = `/v1/source-record/${encodeURIComponent(shape)}/${rowid}`;
    return (await this._json("source_record", "GET", path, {
      query: { address_id: String(address_id) },
    })) as SourceRecordResponse;
  }

  /** 200 => rows; 422 => the structured refusal, RETURNED not thrown. */
  async run_sql(query: string): Promise<SqlResponse> {
    return (await this._json("run_sql", "POST", "/v1/sql", {
      body: { query },
      accept_statuses: [422],
    })) as SqlResponse;
  }

  async schema(): Promise<DataSchema> {
    return (await this._json("schema", "GET", "/v1/schema", {})) as DataSchema;
  }

  private async _json(
    operation: string,
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; accept_statuses?: number[] },
  ): Promise<unknown> {
    const search = new URLSearchParams(opts.query ?? {}).toString();
    const url = `${this.base_url}${path}${search ? `?${search}` : ""}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}),
        signal: AbortSignal.timeout(this.timeout_seconds * 1000),
      });
    } catch (exc) {
      throw new DataClientError(`${operation} failed: ${errStr(exc)}`);
    }
    const accepted = response.ok || (opts.accept_statuses ?? []).includes(response.status);
    if (!accepted) {
      // fetch does not throw on non-2xx, so surface it before reading the body.
      throw new DataClientError(`${operation} failed: HTTP ${response.status} ${response.statusText}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (exc) {
      throw new DataClientError(`${operation} failed: ${errStr(exc)}`);
    }
    if (Buffer.byteLength(text, "utf8") > this.max_response_bytes) {
      throw new DataClientError(`${operation} response exceeded ${this.max_response_bytes} bytes.`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new DataClientError(`${operation} response was not valid JSON.`);
    }
    if (!isRecord(payload)) {
      throw new DataClientError(`${operation} response was not an object.`);
    }
    return payload;
  }
}

/**
 * Per-agent budget accounting over DataHttpClient. Preserves, exactly, what CountingGraphQLTool
 * provided: a hard `max_calls` ceiling with a string-matched error, a `logs` array that
 * error_result() reads, a SEPARATE schema-tool counter, QueryCache single-flight, and one telemetry
 * event per call. This is cost control, not bookkeeping — do not simplify it away.
 *
 * The accounting order is budget check -> increment -> cache -> log -> recorder event, and it is
 * load-bearing: the increment happens BEFORE the call so an in-flight call is already paid for, and
 * the refused call is neither counted nor sent.
 */
export class CountingDataClient {
  client: DataHttpClient;
  max_calls: number;
  agent_id: string;
  heuristic_id: string;
  logs: DataCallLog[] = [];
  // D3: the 422 channel replaces the old pre-execution validator. A refusal is a RESULT, so it is
  // recorded here rather than raised.
  //
  // NOT "read exactly as validation_logs was", as D3 claims: the old logs were `{ok, errors:
  // string[]}` and the real call sites read `.errors` and `!log.ok`. A SqlRefusal has NEITHER, so
  // subagents.ts maps `reason` onto validation_errors and uses the log length as the repair-attempt
  // count. Same two output fields, same meaning, different read.
  refusal_logs: SqlRefusal[] = [];
  schema_tool_calls = 0;
  calls = 0;
  cache: QueryCache | null;

  constructor(
    client: DataHttpClient,
    opts: { max_calls: number; agent_id?: string; heuristic_id?: string; cache?: QueryCache | null },
  ) {
    this.client = client;
    this.max_calls = opts.max_calls;
    this.agent_id = opts.agent_id ?? "data";
    this.heuristic_id = opts.heuristic_id ?? "";
    this.cache = opts.cache ?? null;
  }

  resolve(address: string, zip: string): Promise<ResolveResponse> {
    return this._budgeted("resolve", { address, zip: zip ?? "" }, () => this.client.resolve(address, zip));
  }

  address_records(address_id: number, opts: { shapes?: string[]; limit?: number; offset?: number } = {}) {
    return this._budgeted<AddressRecordsResponse>(
      "address_records",
      { address_id, ...opts },
      () => this.client.address_records(address_id, opts),
    );
  }

  address_people(address_id: number, opts: { limit?: number; offset?: number } = {}) {
    return this._budgeted<AddressPeopleResponse>(
      "address_people",
      { address_id, ...opts },
      () => this.client.address_people(address_id, opts),
    );
  }

  person_records(person_id: string, opts: { shapes?: string[]; limit?: number } = {}) {
    return this._budgeted<PersonRecordsResponse>(
      "person_records",
      { person_id, ...opts },
      () => this.client.person_records(person_id, opts),
    );
  }

  search_people(name: string, opts: { limit?: number } = {}) {
    return this._budgeted<PeopleSearchResponse>("search_people", { name, ...opts }, () =>
      this.client.search_people(name, opts),
    );
  }

  /**
   * `address_id` is required and is part of the cache key: a rowid is a position within ONE
   * address's rows, so keying on {shape, rowid} alone would serve address A's row for address B.
   */
  source_record(shape: string, rowid: number, address_id: number) {
    return this._budgeted<SourceRecordResponse>("source_record", { shape, rowid, address_id }, () =>
      this.client.source_record(shape, rowid, address_id),
    );
  }

  async run_sql(query: string): Promise<SqlResponse> {
    const result = await this._budgeted<SqlResponse>(
      "run_sql",
      { query_sha256: sha256(query), query_chars: Array.from(query).length },
      () => this.client.run_sql(query),
      (value) => (isSqlRefusal(value) ? `refused at ${value.stage}: ${value.reason}` : `${value.row_count} rows`),
    );
    if (isSqlRefusal(result)) {
      this.refusal_logs.push(result);
    }
    return result;
  }

  /** The curated schema. Spends `schema_tool_budget`, never the data-call budget. */
  async schema(opts: { max_calls?: number | null } = {}): Promise<DataSchema> {
    const max_calls = opts.max_calls ?? null;
    const recorder = currentRecorder();
    const start = performance.now();
    if (max_calls !== null && this.schema_tool_calls >= max_calls) {
      recorder.record_data_call({
        call_type: "schema",
        operation_name: "schema",
        latency_ms: elapsedMs(start),
        status: "error",
        error: `Schema description tool budget exceeded: ${max_calls}`,
        metadata: { max_calls, schema_tool_calls: this.schema_tool_calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw new DataClientError(`Schema description tool budget exceeded: ${max_calls}`);
    }
    this.schema_tool_calls += 1;
    try {
      const data = await this.client.schema();
      recorder.record_data_call({
        call_type: "schema",
        operation_name: "schema",
        latency_ms: elapsedMs(start),
        metadata: {
          schema_tool_calls: this.schema_tool_calls,
          response_bytes: Buffer.byteLength(JSON.stringify(data), "utf8"),
        },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      return data;
    } catch (exc) {
      if (!(exc instanceof DataClientError)) throw exc;
      recorder.record_data_call({
        call_type: "schema",
        operation_name: "schema",
        latency_ms: elapsedMs(start),
        status: "error",
        error: errStr(exc),
        metadata: { schema_tool_calls: this.schema_tool_calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw exc;
    }
  }

  private async _budgeted<T>(
    operation: string,
    params: Record<string, unknown>,
    run: () => Promise<T>,
    summarize: (value: T) => string = (value) => summarizeResponse(value),
  ): Promise<T> {
    const recorder = currentRecorder();
    const start = performance.now();
    const call_type = operation === "run_sql" ? "sql" : "op";
    if (this.calls >= this.max_calls) {
      recorder.record_data_call({
        call_type,
        operation_name: operation,
        latency_ms: elapsedMs(start),
        status: "error",
        error: `Data call budget exceeded: ${this.max_calls}`,
        metadata: { ...params, max_calls: this.max_calls, calls: this.calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw new DataClientError(`Data call budget exceeded: ${this.max_calls}`);
    }
    this.calls += 1;
    let value: T;
    try {
      value =
        this.cache !== null
          ? ((await this.cache.get_or_execute(operation, params, run)) as T)
          : await run();
    } catch (exc) {
      if (!(exc instanceof DataClientError)) throw exc;
      this.logs.push(
        DataCallLogSchema.parse({
          operation,
          params,
          result_summary: `${operation} failed: ${errStr(exc)}`,
          error: errStr(exc),
        }),
      );
      recorder.record_data_call({
        call_type,
        operation_name: operation,
        latency_ms: elapsedMs(start),
        status: "error",
        error: errStr(exc),
        metadata: { ...params, calls: this.calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw exc;
    }
    const response_bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const summary = summarize(value);
    this.logs.push(DataCallLogSchema.parse({ operation, params, result_summary: summary }));
    recorder.record_data_call({
      call_type,
      operation_name: operation,
      latency_ms: elapsedMs(start),
      status: operation === "run_sql" && isSqlRefusal(value) ? "refused" : "ok",
      metadata: { ...params, calls: this.calls, response_bytes },
      agent_id: this.agent_id,
      heuristic_id: this.heuristic_id,
    });
    return value;
  }
}

function summarizeResponse(value: unknown): string {
  if (!isRecord(value)) return "";
  const keys = Object.keys(value).sort().join(", ");
  return keys ? `keys: ${keys}` : "empty response";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Milliseconds since `startMs`, rounded to 3 decimals (matches the recorder). */
function elapsedMs(startMs: number): number {
  return Math.round((performance.now() - startMs) * 1000) / 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Message text of an error value (no "Error: " prefix). */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
