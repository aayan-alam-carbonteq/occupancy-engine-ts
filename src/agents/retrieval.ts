// Retrieval helpers over CountingDataClient: fetch compact source rows / people for the resolved
// subject address or a specific person id, via the typed operations of Contract B.
//
// The limit/offset/sources options default only when omitted (undefined); an explicitly-passed 0 is
// kept, then the max/min clamping runs.
import { CountingDataClient, DataClientError, SHAPES, rowRowid, type PersonSummary, type RecordBlock, type SourceRow } from "./data_client.ts";
import type { ResolvedAddressContext } from "./models.ts";

/** Shapes servable at an address: all seven the service ships. */
export const ADDRESS_SHAPES: readonly string[] = [...SHAPES];
/**
 * Shapes we request for a person id. The service DOES serve `utility` on the person path — op 4
 * shares `select_shapes` with op 2 — so the exclusion is ours, and the reason is citability, not
 * availability. `utility` is the one shape whose projection carries no `id` at all (`id_linked=False`
 * in the service manifest, uniquely), and the owner-elsewhere (`hal:`) traversal emits its record
 * blocks with `with_rowid=False`, so there is no `__rowid` handle either; operation 6 additionally
 * requires an `?address_id=` that a `hal:` person id cannot supply. A person-scoped utility row would
 * therefore be an uncitable name match. Utility rows still reach the model on the address path
 * (op 2), where the bundle position supplies the rowid.
 */
export const PERSON_SHAPES: readonly string[] = SHAPES.filter((s) => s !== "utility");

const PERSON_KEYS = [
  "id",
  "firstname",
  "middlename",
  "lastname",
  "full_name",
  "norm_name_key",
  "sources",
  "primary_address_id",
  // Load-bearing: the partner ER graph is 17.9% suspicious and peaks at confidence 40.50. The model
  // must be able to discount a hal:-sourced identity, so these are never dropped.
  "identity_confidence",
  "is_suspicious",
] as const;

function _compact_person(node: Partial<PersonSummary>): Record<string, any> {
  const src = node as Record<string, any>;
  const out: Record<string, any> = {};
  for (const key of PERSON_KEYS) {
    const value = src[key];
    if (value !== null && value !== undefined && value !== "") {
      out[key] = value;
    }
  }
  return out;
}

export const SOURCE_DATA_FIELDS: Record<string, string[]> = {
  base: [
    "id",
    "firstname",
    "middlename",
    "lastname",
    "primaryaddress",
    "zip",
    "homeownerprobabilitymodel",
    "lengthofresidence",
    "homepurchasedateyear",
    "homepurchaseprice",
    "homeyearbuilt",
    "estimatedcurrenthomevaluecode",
    "mortgageamountinthousands",
    "mortgagelendername",
    "deeddateofrefinanceyear",
    "refinanceamountinthousands",
    "refinancelendername",
    "persondateofbirthyear",
  ],
  tax: [
    "id",
    "tax_id",
    "address",
    "zip",
    "firstname",
    "lastname",
    "ownername",
    "ownercompany",
    "owneraddressline1",
    "ownercity",
    "ownerstate",
    "ownerzipcode",
    "residential",
    "condo",
    "lendername",
    "totalliencount",
    "totallienbalance",
    "foreclosecode",
    "forecloserecorddate",
    "recordingdate",
    "ownerrescount",
  ],
  utility: ["first_name", "last_name", "middle_name", "dob", "dod", "address", "city", "state", "zip", "phone"],
  trace: ["id", "trace_id", "firstname", "middlename", "lastname", "address", "city", "state", "zip", "phone", "cellphone", "email", "dob_day", "dob_month", "dob_year"],
  auto: ["id", "auto_id", "firstname", "lastname", "address", "zip", "vin", "year", "make", "model", "phone"],
  loan: ["id", "loan_id", "firstname", "lastname", "address", "zip", "own_rent", "loan_amount", "monthly_income", "employer", "occupation"],
  drive: ["id", "drive_id", "firstname", "lastname", "address", "zip", "dl_num", "dl_state"],
};

function _compact_record_data(source: string, data: Record<string, any>): Record<string, any> {
  const fields = Object.hasOwn(SOURCE_DATA_FIELDS, source) ? SOURCE_DATA_FIELDS[source]! : Object.keys(data).slice(0, 12);
  const compact: Record<string, any> = {};
  for (const field of fields) {
    let value = data[field];
    if (value === null || value === undefined || value === "") {
      continue;
    }
    if (typeof value === "string" && codePointLength(value) > 500) {
      value = codePointSlice(value, 500) + "...";
    }
    compact[field] = value;
  }
  return compact;
}

function _record_summary(source: string, data: Record<string, any>): string {
  const bits: string[] = [source];
  for (const key of ["ownername", "firstname", "first_name", "lastname", "last_name", "address", "zip", "status", "own_rent", "matched", "property_type_normalized"]) {
    const value = data[key];
    if (value !== null && value !== undefined && value !== "") {
      bits.push(`${key}=${value}`);
    }
  }
  return bits.join("; ");
}

/**
 * One wire record -> the internal `{source, table, rowid, summary, data}` envelope that
 * subagents._harvest_evidence_rows turns into an evidence reference.
 *
 * `records.records_block` serves `{**row, "__rowid": n}` — the RAW vendor row, not a
 * `{table, rowid, data}` wrapper — so the row IS the data. `_compact_record_data` selects by
 * SOURCE_DATA_FIELDS, which drops `__rowid` and the `__norm_*` helpers with it; its
 * "first 12 keys" fallback is unreachable here because every caller filters `shape` against
 * ADDRESS_SHAPES / PERSON_SHAPES, and both are subsets of SOURCE_DATA_FIELDS.
 */
function _compact_source_row(shape: string, row: SourceRow): Record<string, any> {
  const compact_data = _compact_record_data(shape, row as Record<string, any>);
  return {
    source: shape,
    // The partner corpus is one physical table, so `table` names the SHAPE — exactly what
    // GET /v1/source-record itself returns, and what provenance means to the consumer.
    table: shape,
    // null, never 0: 0 is a real citable bundle position, and a row reached through entity_links
    // has none at all.
    rowid: rowRowid(row),
    summary: _record_summary(shape, compact_data),
    data: compact_data,
  };
}

/** Map a Contract-B RecordBlock into the internal envelope the typed tools already consume. */
function _block(shape: string, block: Partial<RecordBlock> | undefined): Record<string, any> {
  const b = block ?? {};
  return {
    totalCount: Math.trunc(Number(b.total_count ?? 0)),
    hasMore: Boolean(b.has_more),
    records: asArray(b.records).map((row) => _compact_source_row(shape, row)),
  };
}

function _normalize_shapes(requested: string[] | null | undefined, allowed: readonly string[]): [string[], string[]] {
  const raw = Array.isArray(requested) ? requested : [];
  const normalized = raw.filter((s) => String(s).trim() !== "").map((s) => String(s).trim().toLowerCase());
  const wanted = normalized.length > 0 ? normalized : [...allowed];
  const supported = wanted.filter((s) => allowed.includes(s));
  return [supported, setDifferenceSorted(wanted, supported)];
}

export async function fetch_address_records(
  data: CountingDataClient,
  address_id: number,
  source: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<Record<string, any>> {
  const shape = String(source ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.limit ?? 20)), 100));
  const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0)));
  if (!ADDRESS_SHAPES.includes(shape)) {
    return { ok: false, error: `Unsupported address shape: ${shape}`, supported_shapes: [...ADDRESS_SHAPES].sort() };
  }
  try {
    const res = await data.address_records(address_id, { shapes: [shape], limit, offset });
    return { ok: true, source: shape, ..._block(shape, res.records_by_source[shape]) };
  } catch (exc) {
    if (!(exc instanceof DataClientError)) throw exc;
    return { ok: false, error: errStr(exc) };
  }
}

export async function fetch_address_records_multi(
  data: CountingDataClient,
  address_id: number,
  opts: { sources?: string[] | null; limit?: number; offset?: number } = {},
): Promise<Record<string, any>> {
  const [supported, unsupported] = _normalize_shapes(opts.sources, ADDRESS_SHAPES);
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.limit ?? 25)), 100));
  const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0)));
  if (supported.length === 0) {
    return { ok: false, error: "No supported address shapes requested.", supported_shapes: [...ADDRESS_SHAPES].sort(), unsupported_sources: unsupported };
  }
  try {
    const res = await data.address_records(address_id, { shapes: supported, limit, offset });
    const records: Record<string, any> = {};
    for (const shape of supported) {
      records[shape] = _block(shape, res.records_by_source[shape]);
    }
    return {
      ok: true,
      records_by_source: records,
      unsupported_sources: [...new Set([...unsupported, ...(res.unsupported_shapes ?? [])])].sort(),
    };
  } catch (exc) {
    if (!(exc instanceof DataClientError)) throw exc;
    return { ok: false, error: errStr(exc), unsupported_sources: unsupported };
  }
}

export async function fetch_people_at_address(
  data: CountingDataClient,
  address_id: number,
  opts: { limit?: number; offset?: number } = {},
): Promise<Record<string, any>> {
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.limit ?? 25)), 100));
  const offset = Math.max(0, Math.trunc(Number(opts.offset ?? 0)));
  try {
    const res = await data.address_people(address_id, { limit, offset });
    return {
      ok: true,
      address_id,
      totalCount: Math.trunc(Number(res.total_count ?? 0)),
      hasMore: Boolean(res.has_more),
      people: asArray(res.people).map((p) => _compact_person(p)),
    };
  } catch (exc) {
    if (!(exc instanceof DataClientError)) throw exc;
    return { ok: false, error: errStr(exc) };
  }
}

/**
 * Contract B addendum 3. The `hal:` traversal fetches rows by `(source_table, record_id)` and no
 * index covers `record_id`, so it runs under the statement timeout. Typing the flag only makes it
 * available; the natural `records.length === 0 -> "no records elsewhere"` reading still compiles.
 * Stating the gap is what makes a timeout reach the model as ABSENCE OF KNOWLEDGE rather than as
 * knowledge of absence — the failure mode that would quietly break owner-elsewhere detection.
 * `data_gaps` is the channel D6 already uses for `dropped_counts` / `tax_timed_out`, and both prompt
 * profiles render it.
 */
function _person_timeout_gap(person_id: string): string {
  return (
    `The record lookup for person ${person_id} timed out; some of this person's rows were not ` +
    "returned. Treat the result as incomplete, NOT as evidence that this person has no records elsewhere."
  );
}

export async function fetch_person_records(
  data: CountingDataClient,
  person_id: string,
  opts: { sources?: string[] | null; limit?: number } = {},
): Promise<Record<string, any>> {
  const id = String(person_id ?? "").trim();
  if (!id) {
    return { ok: false, error: "person_id is required." };
  }
  const [supported, unsupported] = _normalize_shapes(opts.sources, PERSON_SHAPES);
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.limit ?? 20)), 100));
  if (supported.length === 0) {
    return { ok: false, error: "No supported person shapes requested.", supported_shapes: [...PERSON_SHAPES].sort(), unsupported_sources: unsupported };
  }
  try {
    const res = await data.person_records(id, { shapes: supported, limit });
    const records: Record<string, any> = {};
    for (const shape of supported) {
      records[shape] = _block(shape, res.records_by_source[shape]);
    }
    const timed_out = Boolean(res.records_timed_out);
    return {
      ok: true,
      person: _compact_person(res.person ?? { id }),
      records_by_source: records,
      unsupported_sources: [...new Set([...unsupported, ...(res.unsupported_shapes ?? [])])].sort(),
      records_timed_out: timed_out,
      ...(timed_out ? { data_gaps: [_person_timeout_gap(id)] } : {}),
    };
  } catch (exc) {
    if (!(exc instanceof DataClientError)) throw exc;
    return { ok: false, error: errStr(exc), unsupported_sources: unsupported };
  }
}

export async function fetch_search_people(
  data: CountingDataClient,
  name: string,
  opts: { limit?: number } = {},
): Promise<Record<string, any>> {
  const q = String(name ?? "").trim();
  if (!q) {
    return { ok: false, error: "name is required." };
  }
  const limit = Math.max(1, Math.min(Math.trunc(Number(opts.limit ?? 10)), 50));
  try {
    const res = await data.search_people(q, { limit });
    return {
      ok: true,
      source: "people_search",
      count: Math.trunc(Number(res.total_count ?? 0)),
      has_more: Boolean(res.has_more),
      records: asArray(res.results).map((hit) => ({
        ..._compact_person(hit),
        match_score: hit.match_score ?? null,
        record_count: hit.record_count ?? null,
        // entity_master's canonical address. This is the whole point of a name search — "does the
        // tax owner live somewhere else" is answered here or nowhere — so it is never compacted
        // away, even though the address-scoped person shapes (ops 3 and 4) do not carry it.
        address_line1: hit.address_line1 ?? null,
        city: hit.city ?? null,
        state: hit.state ?? null,
        zip: hit.zip ?? null,
      })),
    };
  } catch (exc) {
    if (!(exc instanceof DataClientError)) throw exc;
    return { ok: false, error: errStr(exc) };
  }
}

export function _resolve_bundle_address_id(context: ResolvedAddressContext): number | null {
  if (context.selected !== null && context.selected !== undefined) {
    return context.selected.id;
  }
  return context.evidence_map.address_id;
}

/** A record block's `records` may be absent on the wire; coerce to an array for iteration. */
function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Items in `a` not in `b`, deduped and sorted. */
function setDifferenceSorted(a: string[], b: string[]): string[] {
  const bset = new Set(b);
  return [...new Set(a.filter((s) => !bset.has(s)))].sort();
}

function codePointLength(s: string): number {
  return Array.from(s).length;
}

function codePointSlice(s: string, end: number): string {
  return Array.from(s).slice(0, end).join("");
}
