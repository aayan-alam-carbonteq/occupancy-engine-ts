// The agent's data-access layer: a typed HTTP client for the occupancy data service — the six typed
// operations of Contract B, the guarded SQL hatch and the curated schema of Contract C — plus the
// per-agent call-budget accounting the subagent loop depends on (CountingDataClient, added next).
//
// A 422 from /v1/sql is a RESULT, not an error: it carries the planner's own reason and is what the
// agent repairs against. Every other non-2xx is a DataClientError.
import { Buffer } from "node:buffer";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Message text of an error value (no "Error: " prefix). */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}
