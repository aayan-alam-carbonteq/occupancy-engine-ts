// Port of occupancy_engine/agents/retrieval.py.
//
// Shortcut retrieval helpers over the CountingGraphQLTool: fetch compact source rows / people for
// the resolved subject address or a specific person id. Behavior is preserved 1:1 with the Python
// source (query text, compaction field lists, summary formatting, error envelopes).
//
// PORT NOTE (keyword args): Python's keyword-only params (`*, limit=..., offset=..., sources=...`)
// become a trailing options object. Defaults apply only when the option is omitted (undefined), via
// `?? default`; an explicitly-passed 0 is kept (matching Python, where the default only fires when the
// arg is absent). The `int()`/`max`/`min` clamping then runs exactly as in Python.
//
// PORT NOTE (str()/casefold()): source normalization uses `.trim().toLowerCase()` for Python
// `.strip().casefold()` (identical for the ASCII source names used here). Summary TEXT built from
// values uses `pyStr` (None/True/False parity). See docs/MIGRATION.md "Known inherent divergences".
import { CountingGraphQLTool, GraphQLToolError } from "./graphql_tool.ts";
import type { ResolvedAddressContext } from "./models.ts";

export const ADDRESS_SOURCE_FIELDS: Record<string, string> = {
  base: "baseRecords",
  tax: "taxProperties",
  utility: "utilityRecords",
  trace: "traceRecords",
  auto: "autoRecords",
  loan: "loanRecords",
  drive: "driveRecords",
  voter: "voterRecords",
  criminal: "criminalRecords",
};

export const PERSON_SOURCE_FIELDS: Record<string, string> = {
  base: "baseRecords",
  tax: "taxRecords",
  trace: "traceRecords",
  auto: "autoRecords",
  loan: "loanRecords",
  drive: "driveRecords",
  voter: "voterRecords",
  criminal: "criminalRecords",
  linkedin: "linkedinRecords",
};

function _compact_person_node(node: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of ["id", "firstname", "middlename", "lastname", "fullName", "normNameKey", "primaryAddressId"]) {
    const value = node[key];
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
  voter: ["id", "voter_id", "firstname", "lastname", "address", "zip", "gender", "phone", "mobile", "email"],
  criminal: ["id", "criminal_id", "firstname", "middlename", "lastname", "address", "zip", "category", "offensedesc1", "county", "arrestdate"],
  linkedin: ["id", "linkedin_id", "firstname", "lastname", "linkedinurl", "summary", "position_title", "position_companyname", "position_description"],
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
      bits.push(`${key}=${pyStr(value)}`);
    }
  }
  return bits.join("; ");
}

function _compact_source_node(source: string, node: Record<string, any>): Record<string, any> {
  const data = isDict(node["data"]) ? node["data"] : {};
  const compact_data = _compact_record_data(source, data);
  return {
    source,
    table: orElse(node["table"], source),
    rowid: node["rowid"] ?? null,
    summary: _record_summary(source, compact_data),
    data: compact_data,
  };
}

export async function fetch_address_records(
  graphql: CountingGraphQLTool,
  address_id: number,
  source: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<Record<string, any>> {
  source = String(orElse(source, "")).trim().toLowerCase();
  const limit = Math.max(1, Math.min(pyInt(opts.limit ?? 20), 100));
  const offset = Math.max(0, pyInt(opts.offset ?? 0));
  const field = mapGet(ADDRESS_SOURCE_FIELDS, source);
  if (!field) {
    return { ok: false, error: `Unsupported address source: ${source}`, supported_sources: ["base", ...Object.keys(ADDRESS_SOURCE_FIELDS).sort()] };
  }
  const query = `
    query AgentAddressRecordsShortcut($id: Int!, $limit: Int, $offset: Int) {
      address(id: $id) {
        ${field}(limit: $limit, offset: $offset) {
          totalCount
          hasMore
          nodes { table rowid data }
        }
      }
    }
    `;
  let data: Record<string, any>;
  try {
    data = (await graphql.query(query, { id: address_id, limit, offset }, { result_summary: `shortcut ${source} records at address ${address_id}` })) as Record<string, any>;
  } catch (exc) {
    if (!(exc instanceof GraphQLToolError)) throw exc;
    return { ok: false, error: errStr(exc) };
  }
  const conn = orElse(orElse(data["address"], {})[field], {});
  return {
    ok: true,
    source,
    totalCount: pyInt(orElse(conn["totalCount"], 0)),
    hasMore: truthy(conn["hasMore"]),
    records: asArray(conn["nodes"]).map((node) => _compact_source_node(source, node)),
  };
}

export async function fetch_address_records_multi(
  graphql: CountingGraphQLTool,
  address_id: number,
  opts: { sources?: string[] | null; limit?: number; offset?: number } = {},
): Promise<Record<string, any>> {
  const requested = Array.isArray(opts.sources) ? opts.sources : [];
  const normalized = orElse(
    requested.filter((s) => String(s).trim() !== "").map((s) => String(s).trim().toLowerCase()),
    Object.keys(ADDRESS_SOURCE_FIELDS),
  ) as string[];
  const supported = normalized.filter((s) => Object.hasOwn(ADDRESS_SOURCE_FIELDS, s));
  const unsupported = setDifferenceSorted(normalized, supported);
  const limit = Math.max(1, Math.min(pyInt(opts.limit ?? 25), 100));
  const offset = Math.max(0, pyInt(opts.offset ?? 0));
  if (supported.length === 0) {
    return { ok: false, error: "No supported address sources requested.", supported_sources: Object.keys(ADDRESS_SOURCE_FIELDS).sort(), unsupported_sources: unsupported };
  }
  const selections = supported
    .map((s) => ADDRESS_SOURCE_FIELDS[s])
    .map((field) => `${field}(limit: $limit, offset: $offset) { totalCount hasMore nodes { table rowid data } }`)
    .join("\n");
  const query = `
    query AgentAddressRecordsMultiShortcut($id: Int!, $limit: Int, $offset: Int) {
      address(id: $id) {
        ${selections}
      }
    }
    `;
  let data: Record<string, any>;
  try {
    data = (await graphql.query(query, { id: address_id, limit, offset }, { result_summary: `shortcut multi-source records at address ${address_id}` })) as Record<string, any>;
  } catch (exc) {
    if (!(exc instanceof GraphQLToolError)) throw exc;
    return { ok: false, error: errStr(exc), unsupported_sources: unsupported };
  }
  const address = orElse(data["address"], {});
  const records: Record<string, any> = {};
  for (const source of supported) {
    const field = ADDRESS_SOURCE_FIELDS[source]!;
    const conn = orElse(address[field], {});
    records[source] = {
      totalCount: pyInt(orElse(conn["totalCount"], 0)),
      hasMore: truthy(conn["hasMore"]),
      records: asArray(conn["nodes"]).map((node) => _compact_source_node(source, node)),
    };
  }
  return { ok: true, records_by_source: records, unsupported_sources: unsupported };
}

export async function fetch_people_at_address(
  graphql: CountingGraphQLTool,
  address_id: number,
  opts: { limit?: number; offset?: number } = {},
): Promise<Record<string, any>> {
  const limit = Math.max(1, Math.min(pyInt(opts.limit ?? 25), 100));
  const offset = Math.max(0, pyInt(opts.offset ?? 0));
  const query = `
    query AgentPeopleAtAddressShortcut($id: Int!, $limit: Int, $offset: Int) {
      peopleAtAddress(addressId: $id, limit: $limit, offset: $offset) {
        totalCount
        hasMore
        nodes { id firstname middlename lastname fullName normNameKey primaryAddressId }
      }
    }
    `;
  let data: Record<string, any>;
  try {
    data = (await graphql.query(query, { id: address_id, limit, offset }, { result_summary: `shortcut people at address ${address_id}` })) as Record<string, any>;
  } catch (exc) {
    if (!(exc instanceof GraphQLToolError)) throw exc;
    return { ok: false, error: errStr(exc) };
  }
  const conn = orElse(data["peopleAtAddress"], {});
  return {
    ok: true,
    address_id,
    totalCount: pyInt(orElse(conn["totalCount"], 0)),
    hasMore: truthy(conn["hasMore"]),
    people: asArray(conn["nodes"]).map((node) => _compact_person_node(node)),
  };
}

export async function fetch_person_records(
  graphql: CountingGraphQLTool,
  person_id: string,
  opts: { sources?: string[] | null; limit?: number } = {},
): Promise<Record<string, any>> {
  person_id = String(orElse(person_id, "")).trim();
  if (!person_id) {
    return { ok: false, error: "person_id is required." };
  }
  const requested = Array.isArray(opts.sources) ? opts.sources : [];
  const normalized = orElse(
    requested.filter((s) => String(s).trim() !== "").map((s) => String(s).trim().toLowerCase()),
    Object.keys(PERSON_SOURCE_FIELDS),
  ) as string[];
  const supported = normalized.filter((s) => Object.hasOwn(PERSON_SOURCE_FIELDS, s));
  const unsupported = setDifferenceSorted(normalized, supported);
  const limit = Math.max(1, Math.min(pyInt(opts.limit ?? 20), 100));
  const selections = supported
    .map((s) => PERSON_SOURCE_FIELDS[s])
    .map((field) => `${field}(limit: $limit) { totalCount hasMore nodes { table rowid data } }`)
    .join("\n");
  const query = `
    query AgentPersonRecordsShortcut($personId: String!, $limit: Int) {
      person(id: $personId) {
        id
        firstname
        middlename
        lastname
        fullName
        ${selections}
      }
    }
    `;
  let data: Record<string, any>;
  try {
    data = (await graphql.query(query, { personId: person_id, limit }, { result_summary: `shortcut person records for ${person_id}` })) as Record<string, any>;
  } catch (exc) {
    if (!(exc instanceof GraphQLToolError)) throw exc;
    return { ok: false, error: errStr(exc), unsupported_sources: unsupported };
  }
  const person = orElse(data["person"], {});
  const records: Record<string, any> = {};
  for (const source of supported) {
    const field = PERSON_SOURCE_FIELDS[source]!;
    const conn = orElse(person[field], {});
    records[source] = {
      totalCount: pyInt(orElse(conn["totalCount"], 0)),
      hasMore: truthy(conn["hasMore"]),
      records: asArray(conn["nodes"]).map((node) => _compact_source_node(source, node)),
    };
  }
  return {
    ok: true,
    person: _compact_person_node(person),
    records_by_source: records,
    unsupported_sources: unsupported,
  };
}

export async function fetch_search_people(
  graphql: CountingGraphQLTool,
  name: string,
  opts: { limit?: number } = {},
): Promise<Record<string, any>> {
  name = String(orElse(name, "")).trim();
  if (!name) {
    return { ok: false, error: "name is required." };
  }
  const limit = Math.max(1, Math.min(pyInt(opts.limit ?? 10), 50));
  const query = `
    query AgentSearchPeopleShortcut($q: String!, $limit: Int) {
      searchPersons(query: $q, limit: $limit) {
        totalCount
        hasMore
        nodes { matchScore person { id firstname lastname fullName } }
      }
    }
    `;
  let data: Record<string, any>;
  try {
    data = (await graphql.query(query, { q: name, limit }, { result_summary: `search people '${name}'` })) as Record<string, any>;
  } catch (exc) {
    if (!(exc instanceof GraphQLToolError)) throw exc;
    return { ok: false, error: errStr(exc) };
  }
  const conn = orElse(data["searchPersons"], {});
  const records: Record<string, any>[] = [];
  for (const node of asArray(conn["nodes"])) {
    const person = orElse(node["person"], {});
    records.push({
      id: person["id"] ?? null,
      firstname: person["firstname"] ?? null,
      lastname: person["lastname"] ?? null,
      full_name: person["fullName"] ?? null,
      match_score: node["matchScore"] ?? null,
    });
  }
  return {
    ok: true,
    source: "people_search",
    count: pyInt(orElse(conn["totalCount"], 0)),
    has_more: truthy(conn["hasMore"]),
    records,
  };
}

export function _resolve_bundle_address_id(context: ResolvedAddressContext): number | null {
  if (context.selected !== null && context.selected !== undefined) {
    return context.selected.id;
  }
  return context.evidence_map.address_id;
}

// ── Python-semantics helpers ──────────────────────────────────────────────────

function truthy(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (value === false) return false;
  if (value === true) return true;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** Python `value or fallback`. */
function orElse(value: any, fallback: any): any {
  return truthy(value) ? value : fallback;
}

/** Python str(): None -> "None", True/False -> "True"/"False", else String(). */
function pyStr(value: any): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** Python int(): truncate toward zero. */
function pyInt(value: any): number {
  return Math.trunc(Number(value));
}

function isDict(value: any): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python dict.get(key): own-property lookup only (never the JS prototype chain). */
function mapGet(map: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Python `x or []` for list access (nodes may be null). */
function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}

/** Python str(exc): GraphQLToolError message with no "Error: " prefix. */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Python sorted(set(a) - set(b)) — items in `a` not in `b`, deduped, sorted. */
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
