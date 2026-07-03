// The agent's data-access layer: an HTTP GraphQL client with per-agent budget counting,
// query validation, and response compaction.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  buildClientSchema,
  getIntrospectionQuery,
  GraphQLError,
  parse,
  validate,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
import { currentRecorder } from "../observability/index.ts";
import { GraphQLQueryLogSchema, type GraphQLQueryLog } from "./models.ts";
import type { QueryCache } from "./query_cache.ts";

/** Raised when an agent GraphQL query fails or violates tool guardrails. */
export class GraphQLToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphQLToolError";
  }
}

// Internal response carriers; all fields are always populated on construction below.
export interface GraphQLResponse {
  data: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
}

export interface GraphQLValidationResponse {
  ok: boolean;
  query_name: string;
  errors: string[];
  hints: string[];
  suggested_schema_targets: string[];
  correct_query_skeletons: string[];
}

function operationName(query: string): string {
  const match = /\b(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(query);
  return match?.[2] ?? "anonymous";
}

function validateReadOnly(query: string): void {
  const stripped = query.replace(/#[^\n]*/g, "").replace(/^\s+/, "");
  if (/^(mutation|subscription)\b/i.test(stripped)) {
    throw new GraphQLToolError("Only read-only GraphQL query operations are allowed.");
  }
}

export class GraphQLHttpTool {
  readonly url: string;
  timeout_seconds: number;
  max_response_bytes: number;
  private _introspection: Promise<Record<string, unknown>> | null = null;
  private _clientSchema: Promise<GraphQLSchema> | null = null;

  constructor(url: string, opts: { timeout_seconds?: number; max_response_bytes?: number } = {}) {
    this.url = url;
    this.timeout_seconds = opts.timeout_seconds ?? 30.0;
    this.max_response_bytes = opts.max_response_bytes ?? 1_000_000;
  }

  async query(query: string, variables?: Record<string, unknown> | null): Promise<GraphQLResponse> {
    validateReadOnly(query);
    const bodyString = JSON.stringify({ query, variables: variables ?? {} });
    const text = await this._httpPost(
      bodyString,
      "GraphQL request failed",
      `GraphQL response exceeded ${this.max_response_bytes} bytes.`,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new GraphQLToolError("GraphQL response was not valid JSON.");
    }
    if (!isRecord(payload)) {
      throw new GraphQLToolError("GraphQL response was not an object.");
    }
    const rawErrors = payload["errors"];
    if (Array.isArray(rawErrors) ? rawErrors.length > 0 : Boolean(rawErrors)) {
      const errList = Array.isArray(rawErrors) ? rawErrors : [{ message: String(rawErrors) }];
      throw new GraphQLToolError(`GraphQL returned errors: ${JSON.stringify(errList)}`);
    }
    const data = payload["data"] ?? {};
    if (!isRecord(data)) {
      throw new GraphQLToolError("GraphQL response data was not an object.");
    }
    return { data, errors: [] };
  }

  async validate_query(
    query: string,
    _variables?: Record<string, unknown> | null,
  ): Promise<GraphQLValidationResponse> {
    const query_name = operationName(query);
    let messages: string[];
    try {
      validateReadOnly(query);
      const schema = await this.clientSchema();
      const document = parse(query);
      const errors = validate(schema, document);
      // String(error) is the message plus a "GraphQL request:L:C" source snippet.
      messages = errors.map((error) => String(error));
    } catch (exc) {
      // Only tool-guardrail or GraphQL errors produce a validation payload; anything else propagates.
      if (exc instanceof GraphQLToolError || exc instanceof GraphQLError) {
        const message = exc instanceof GraphQLError ? String(exc) : exc.message;
        return {
          ok: false,
          query_name,
          errors: [message],
          hints: validationHints(message),
          suggested_schema_targets: suggestedSchemaTargets([message]),
          correct_query_skeletons: correctQuerySkeletons([message]),
        };
      }
      throw exc;
    }
    return {
      ok: messages.length === 0,
      query_name,
      errors: messages,
      hints: messages.flatMap((message) => validationHints(message)),
      suggested_schema_targets: suggestedSchemaTargets(messages),
      correct_query_skeletons: correctQuerySkeletons(messages),
    };
  }

  async describe_schema(target: string | null = null): Promise<Record<string, unknown>> {
    const schema = await this.introspection();
    return describeSchema(schema, target);
  }

  // Memoized client schema built from introspection; the cached promise is dropped on rejection so
  // the next access re-fetches.
  private clientSchema(): Promise<GraphQLSchema> {
    if (this._clientSchema !== null) {
      return this._clientSchema;
    }
    const promise = this.introspection().then((intro) =>
      buildClientSchema(intro as unknown as IntrospectionQuery),
    );
    this._clientSchema = promise;
    promise.catch(() => {
      if (this._clientSchema === promise) {
        this._clientSchema = null;
      }
    });
    return promise;
  }

  private introspection(): Promise<Record<string, unknown>> {
    if (this._introspection !== null) {
      return this._introspection;
    }
    const promise = this._fetchIntrospection();
    this._introspection = promise;
    // Drop the cached promise on rejection so the next access re-fetches.
    promise.catch(() => {
      if (this._introspection === promise) {
        this._introspection = null;
      }
    });
    return promise;
  }

  private async _fetchIntrospection(): Promise<Record<string, unknown>> {
    const bodyString = JSON.stringify({ query: getIntrospectionQuery({ descriptions: true }), variables: {} });
    const text = await this._httpPost(
      bodyString,
      "GraphQL introspection failed",
      `GraphQL introspection response exceeded ${this.max_response_bytes} bytes.`,
    );
    // A JSON parse error here propagates uncaught (unlike query(), which wraps it).
    const payload = asRecord(JSON.parse(text) as unknown);
    const rawErrors = payload["errors"];
    if (Array.isArray(rawErrors) ? rawErrors.length > 0 : Boolean(rawErrors)) {
      throw new GraphQLToolError(`GraphQL introspection returned errors: ${JSON.stringify(rawErrors)}`);
    }
    const data = payload["data"] ?? {};
    if (!isRecord(data)) {
      throw new GraphQLToolError("GraphQL introspection data was not an object.");
    }
    return data;
  }

  private async _httpPost(bodyString: string, failPrefix: string, oversizeMsg: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: bodyString,
        signal: AbortSignal.timeout(this.timeout_seconds * 1000),
      });
    } catch (exc) {
      throw new GraphQLToolError(`${failPrefix}: ${errStr(exc)}`);
    }
    if (!response.ok) {
      // fetch does not throw on non-2xx, so surface it as a tool error before reading the body.
      throw new GraphQLToolError(`${failPrefix}: HTTP ${response.status} ${response.statusText}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (exc) {
      throw new GraphQLToolError(`${failPrefix}: ${errStr(exc)}`);
    }
    if (Buffer.byteLength(text, "utf8") > this.max_response_bytes) {
      throw new GraphQLToolError(oversizeMsg);
    }
    return text;
  }
}

export class CountingGraphQLTool {
  tool: GraphQLHttpTool;
  max_calls: number;
  agent_id: string;
  heuristic_id: string;
  logs: GraphQLQueryLog[] = [];
  validation_logs: GraphQLValidationResponse[] = [];
  schema_tool_calls = 0;
  calls = 0;
  cache: QueryCache | null;

  constructor(
    tool: GraphQLHttpTool,
    opts: { max_calls: number; agent_id?: string; heuristic_id?: string; cache?: QueryCache | null },
  ) {
    this.tool = tool;
    this.max_calls = opts.max_calls;
    this.agent_id = opts.agent_id ?? "graphql";
    this.heuristic_id = opts.heuristic_id ?? "";
    this.cache = opts.cache ?? null;
  }

  async query(
    query: string,
    variables?: Record<string, unknown> | null,
    opts: { result_summary?: string } = {},
  ): Promise<Record<string, unknown>> {
    const result_summary = opts.result_summary ?? "";
    const recorder = currentRecorder();
    const start = performance.now();
    const operation_name = operationName(query);
    const metadata = queryMetadata(query, variables ?? {});
    if (this.calls >= this.max_calls) {
      recorder.record_graphql_call({
        call_type: "query",
        operation_name,
        latency_ms: elapsedMs(start),
        status: "error",
        error: `GraphQL query budget exceeded: ${this.max_calls}`,
        metadata: { ...metadata, max_calls: this.max_calls, calls: this.calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw new GraphQLToolError(`GraphQL query budget exceeded: ${this.max_calls}`);
    }
    this.calls += 1;
    const query_name = operation_name;
    let response: GraphQLResponse;
    try {
      if (this.cache !== null) {
        response = (await this.cache.get_or_execute(query, variables ?? {}, () =>
          this.tool.query(query, variables ?? {}),
        )) as GraphQLResponse;
      } else {
        response = await this.tool.query(query, variables ?? {});
      }
    } catch (exc) {
      if (!(exc instanceof GraphQLToolError)) {
        throw exc;
      }
      this.logs.push(
        GraphQLQueryLogSchema.parse({
          query_name,
          variables: variables ?? {},
          result_summary: `GraphQL query failed: ${errStr(exc)}`,
          error: errStr(exc),
        }),
      );
      recorder.record_graphql_call({
        call_type: "query",
        operation_name: query_name,
        latency_ms: elapsedMs(start),
        status: "error",
        error: errStr(exc),
        metadata: { ...metadata, calls: this.calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw exc;
    }
    const response_bytes = Buffer.byteLength(JSON.stringify(response.data), "utf8");
    this.logs.push(
      GraphQLQueryLogSchema.parse({
        query_name,
        variables: variables ?? {},
        result_summary: result_summary || summarizeResponse(response.data),
      }),
    );
    recorder.record_graphql_call({
      call_type: "query",
      operation_name: query_name,
      latency_ms: elapsedMs(start),
      metadata: { ...metadata, calls: this.calls, response_bytes },
      agent_id: this.agent_id,
      heuristic_id: this.heuristic_id,
    });
    return response.data;
  }

  async validate(
    query: string,
    variables?: Record<string, unknown> | null,
  ): Promise<GraphQLValidationResponse> {
    const recorder = currentRecorder();
    const start = performance.now();
    const result = await this.tool.validate_query(query, variables ?? {});
    this.validation_logs.push(result);
    recorder.record_graphql_call({
      call_type: "validate",
      operation_name: result.query_name,
      latency_ms: elapsedMs(start),
      status: result.ok ? "ok" : "error",
      error: result.errors.join("; "),
      metadata: {
        ...queryMetadata(query, variables ?? {}),
        error_count: result.errors.length,
        hint_count: result.hints.length,
      },
      agent_id: this.agent_id,
      heuristic_id: this.heuristic_id,
    });
    return result;
  }

  async describe_schema(
    target: string | null = null,
    opts: { max_calls?: number | null } = {},
  ): Promise<Record<string, unknown>> {
    const max_calls = opts.max_calls ?? null;
    const recorder = currentRecorder();
    const start = performance.now();
    if (max_calls !== null && this.schema_tool_calls >= max_calls) {
      recorder.record_graphql_call({
        call_type: "schema",
        operation_name: String(target || "Query"),
        latency_ms: elapsedMs(start),
        status: "error",
        error: `Schema description tool budget exceeded: ${max_calls}`,
        metadata: { target: target || "Query", max_calls, schema_tool_calls: this.schema_tool_calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw new GraphQLToolError(`Schema description tool budget exceeded: ${max_calls}`);
    }
    this.schema_tool_calls += 1;
    let data: Record<string, unknown>;
    try {
      data = await this.tool.describe_schema(target);
    } catch (exc) {
      if (!(exc instanceof GraphQLToolError)) {
        throw exc;
      }
      recorder.record_graphql_call({
        call_type: "schema",
        operation_name: String(target || "Query"),
        latency_ms: elapsedMs(start),
        status: "error",
        error: errStr(exc),
        metadata: { target: target || "Query", schema_tool_calls: this.schema_tool_calls },
        agent_id: this.agent_id,
        heuristic_id: this.heuristic_id,
      });
      throw exc;
    }
    recorder.record_graphql_call({
      call_type: "schema",
      operation_name: String(target || "Query"),
      latency_ms: elapsedMs(start),
      metadata: {
        target: target || "Query",
        schema_tool_calls: this.schema_tool_calls,
        response_bytes: Buffer.byteLength(JSON.stringify(data), "utf8"),
      },
      agent_id: this.agent_id,
      heuristic_id: this.heuristic_id,
    });
    return data;
  }
}

function summarizeResponse(data: Record<string, unknown>): string {
  const keys = Object.keys(data).sort().join(", ");
  return keys ? `data keys: ${keys}` : "empty data";
}

function queryMetadata(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  return {
    query_sha256: createHash("sha256").update(query, "utf8").digest("hex"),
    query_chars: Array.from(query).length,
    variable_keys: Object.keys(variables).map(String).sort(),
    variables_chars: JSON.stringify(variables).length,
  };
}

/** Milliseconds since `startMs`, rounded to 3 decimals (matches recorder). */
function elapsedMs(startMs: number): number {
  return Math.round((performance.now() - startMs) * 1000) / 1000;
}

/** Message text of an error value (no "Error: " prefix). */
function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function validationHints(message: string): string[] {
  const hints: string[] = [];
  if (message.includes('Cannot query field "sourceRecord" on type "PropertyPersonAssociation"')) {
    hints.push(
      "Use PropertyPersonAssociation.provenance { source rowid summary } on owner edges, or fetch Query.sourceRecord(source, rowid) separately for raw data.",
    );
  }
  if (message.includes('Expected value of type "StringFilterInput"')) {
    hints.push(
      'Filter fields use objects, e.g. where: {firstname: {eq: "ELGIN"}} not where: {firstname: "ELGIN"}.',
    );
  }
  if (message.includes("Cannot query field") && message.includes("Connection")) {
    hints.push("Connection fields expose totalCount, hasMore, pageInfo, and nodes; put record fields under nodes.");
  }
  if (message.includes("Cannot query field") && message.includes("SourceRecordConnection")) {
    hints.push(
      "For source connections use nodes { source table rowid recordId summary data }; these fields are not on the connection itself.",
    );
  }
  if (message.includes('Unknown type "ID"')) {
    hints.push("This schema uses Int for address ids and String for person/source ids; do not use GraphQL ID.");
  }
  if (message.includes("must have a selection of subfields")) {
    hints.push("Object and connection fields require a selection set such as { totalCount nodes { ... } }.");
  }
  if (hints.length === 0) {
    hints.push("Use describe_schema for the relevant Query field, object type, or input type before retrying.");
  }
  return hints;
}

function suggestedSchemaTargets(messages: string[]): string[] {
  const targets: string[] = [];
  const joined = messages.join("\n");
  if (joined.includes("SourceRecordConnection") || joined.includes("Connection")) {
    targets.push("SourceRecordConnection", "SourceRecord", "Address");
  }
  if (joined.includes("Person") || joined.includes('field "name"')) {
    targets.push("Person");
  }
  if (joined.includes("address") || joined.includes("Address")) {
    targets.push("Query");
  }
  if (targets.length === 0) {
    targets.push("Query");
  }
  return [...new Set(targets)];
}

function correctQuerySkeletons(messages: string[]): string[] {
  const joined = messages.join("\n");
  const skeletons: string[] = [];
  if (joined.includes("SourceRecordConnection") || (joined.includes("Cannot query field") && joined.includes("Connection"))) {
    skeletons.push(
      `query AddressAssociations($query: String!, $zip: String, $limit: Int = 50) {
  resolveAddress(query: $query, zip: $zip) {
    id
    fullAddress
    personAssociations(limit: $limit) {
      totalCount
      hasMore
      nodes { role source person { id name } sourceRecord { source rowid summary } }
    }
  }
}`,
    );
    skeletons.push(addressUtilityRecordsQuery());
  }
  if (joined.includes('Cannot query field "name" on type "Person"')) {
    skeletons.push(
      `query PeopleAtAddress($id: Int!, $limit: Int = 25) {
  peopleAtAddress(addressId: $id, limit: $limit) {
    totalCount
    hasMore
    nodes { id firstname middlename lastname fullName normNameKey primaryAddressId }
  }
}`,
    );
  }
  if (joined.includes("must have a selection of subfields")) {
    skeletons.push(
      `query AddressWithSelection($id: Int!) {
  address(id: $id) {
    id
    normAddress
    zip5
  }
}`,
    );
  }
  if (joined.includes('Unknown type "ID"')) {
    skeletons.push(
      `query AddressByIntId($id: Int!) {
  address(id: $id) { id normAddress zip5 }
}`,
    );
    skeletons.push(
      `query PersonByStringId($personId: String!) {
  person(id: $personId) { id firstname lastname fullName }
}`,
    );
  }
  return skeletons;
}

function taskSchemaDescription(target: string): Record<string, unknown> | null {
  const normalized = target.trim().toLowerCase().replaceAll("_", "").replaceAll("-", "");
  const addressSources: Record<string, string> = {
    "address.baserecords": "baseRecords",
    "address.taxproperties": "taxProperties",
    "address.utilityrecords": "utilityRecords",
    "address.tracerecords": "traceRecords",
    "address.autorecords": "autoRecords",
    "address.loanrecords": "loanRecords",
    "address.driverecords": "driveRecords",
    "address.voterrecords": "voterRecords",
    "address.criminalrecords": "criminalRecords",
  };
  const personSources: Record<string, string> = {
    "person.baserecords": "baseRecords",
    "person.taxrecords": "taxRecords",
    "person.tracerecords": "traceRecords",
    "person.autorecords": "autoRecords",
    "person.loanrecords": "loanRecords",
    "person.driverecords": "driveRecords",
    "person.voterrecords": "voterRecords",
    "person.criminalrecords": "criminalRecords",
  };
  if (["sourceconnection", "sourcerecordconnection"].includes(normalized)) {
    return {
      target: "SourceRecordConnection",
      pattern: "totalCount hasMore nodes { source table rowid recordId summary data }",
      common_mistakes: schemaMistakes("SourceRecordConnection"),
      examples: schemaExamples("SourceRecordConnection"),
    };
  }
  if (["resolveaddress", "query.resolveaddress"].includes(normalized)) {
    return {
      target: "Query.resolveAddress",
      returns: "Address",
      examples: [resolveAddressQuery()],
    };
  }
  if (["address.personassociations", "personaddressassociations", "personaddressassociation"].includes(normalized)) {
    return {
      target: "Address.personAssociations",
      returns: "PersonAddressAssociationConnection",
      selection:
        "totalCount hasMore nodes { role source confidence person { id name } sourceRecord { source rowid summary } }",
      examples: [addressAssociationsQuery()],
    };
  }
  if (["person.addressassociations"].includes(normalized)) {
    return {
      target: "Person.addressAssociations",
      returns: "PersonAddressAssociationConnection",
      selection:
        "totalCount hasMore nodes { role source address { id fullAddress } sourceRecord { source rowid summary } }",
      examples: [personAssociationsQuery()],
    };
  }
  if (["address.sourcerecords", "addresssourcerecords", "utilityrecords", "address.utility"].includes(normalized)) {
    return {
      target: "Address.sourceRecords",
      returns: "SourceRecordConnection",
      selection: "totalCount hasMore nodes { source rowid recordId summary }",
      note: "Use Address.sourceRecords(source: UTILITY, role: SERVICE_ADDRESS) for utility rows; utility is address-linked and often does not appear as a person association.",
      examples: [addressUtilityRecordsQuery()],
    };
  }
  if (
    [
      "propertypersonassociation",
      "propertypersonassociation.sourcerecord",
      "propertypersonassociation.provenance",
    ].includes(normalized)
  ) {
    return {
      target: "PropertyPersonAssociation.provenance",
      returns: "[SourceRecord]",
      selection: "source rowid recordId summary",
      note: "Use provenance on property-person owner edges. Fetch Query.sourceRecord(source, rowid) only if full raw data is needed.",
      examples: [addressAssociationsQuery()],
    };
  }
  if (["sourcerecord", "query.sourcerecord"].includes(normalized)) {
    return {
      target: "Query.sourceRecord",
      returns: "SourceRecord",
      selection: "source table rowid recordId summary data",
      examples: [sourceRecordQuery()],
    };
  }
  if (Object.hasOwn(addressSources, normalized)) {
    const field = addressSources[normalized]!;
    return {
      target: `Address.${field}`,
      returns: "SourceRecordConnection",
      selection: "totalCount hasMore nodes { table rowid data }",
      examples: [addressSourceQuery(field)],
      common_mistakes: schemaMistakes("SourceRecordConnection"),
    };
  }
  if (Object.hasOwn(personSources, normalized)) {
    const field = personSources[normalized]!;
    return {
      target: `Person.${field}`,
      returns: "SourceRecordConnection",
      selection: "totalCount hasMore nodes { table rowid data }",
      examples: [personSourceQuery(field)],
      common_mistakes: schemaMistakes("SourceRecordConnection"),
    };
  }
  return null;
}

function schemaExamples(target: string): string[] {
  const normalized = target.trim().toLowerCase();
  if (normalized === "query") {
    return [resolveAddressQuery(), addressAssociationsQuery()];
  }
  if (normalized === "address") {
    return [addressAssociationsQuery(), addressUtilityRecordsQuery()];
  }
  if (normalized === "person") {
    return [
      `query PersonByStringId($personId: String!) {
  person(id: $personId) { id name firstname middlename lastname fullName normNameKey primaryAddressId }
}`,
      personAssociationsQuery(),
    ];
  }
  if (normalized === "sourcerecordconnection") {
    return [addressAssociationsQuery()];
  }
  return [];
}

function schemaMistakes(target: string): string[] {
  if (target.trim().toLowerCase() === "sourcerecordconnection") {
    return [
      "Do not query table, rowid, or data directly on the connection.",
      "Use totalCount, hasMore, and nodes { source table rowid recordId summary data }.",
    ];
  }
  return [];
}

function resolveAddressQuery(): string {
  return `query ResolveAddress($query: String!, $zip: String) {
  resolveAddress(query: $query, zip: $zip) { id fullAddress normalizedAddress zip }
}`;
}

function addressAssociationsQuery(): string {
  return `query AddressAssociations($query: String!, $zip: String, $limit: Int = 50) {
  resolveAddress(query: $query, zip: $zip) {
    id
    fullAddress
    personAssociations(limit: $limit) {
      totalCount
      hasMore
      nodes { role source confidence person { id name } sourceRecord { source rowid summary } }
    }
    propertyAssociations(role: SITUS_ADDRESS, limit: 10) {
      nodes { property { id propertyKey people(role: OWNER) { nodes { displayName person { id name } provenance { source rowid summary } } } } }
    }
  }
}`;
}

function addressUtilityRecordsQuery(): string {
  return `query AddressUtilityRecords($query: String!, $zip: String, $limit: Int = 50) {
  resolveAddress(query: $query, zip: $zip) {
    id
    fullAddress
    sourceRecords(source: UTILITY, role: SERVICE_ADDRESS, limit: $limit) {
      totalCount
      hasMore
      nodes { source rowid recordId summary }
    }
  }
}`;
}

function personAssociationsQuery(): string {
  return `query PersonAssociations($personId: String!, $limit: Int = 50) {
  person(id: $personId) {
    id
    name
    addressAssociations(limit: $limit) {
      totalCount
      hasMore
      nodes { role source address { id fullAddress } sourceRecord { source rowid summary } }
    }
  }
}`;
}

function sourceRecordQuery(): string {
  return `query RawSourceRow($source: Source!, $rowid: Int!) {
  sourceRecord(source: $source, rowid: $rowid) { source table rowid recordId summary data }
}`;
}

function addressSourceQuery(field: string): string {
  return `query AddressSourceRows($id: Int!, $limit: Int = 20) {
  address(id: $id) {
    ${field}(limit: $limit) {
      totalCount
      hasMore
      nodes { table rowid data }
    }
  }
}`;
}

function personSourceQuery(field: string): string {
  return `query PersonSourceRows($personId: String!, $limit: Int = 20) {
  person(id: $personId) {
    id
    firstname
    lastname
    fullName
    ${field}(limit: $limit) { totalCount hasMore nodes { table rowid data } }
  }
}`;
}

export function compact_graphql_data(data: Record<string, unknown>): Record<string, unknown> {
  return compactValue(data) as Record<string, unknown>;
}

function compactValue(value: unknown): unknown {
  if (isRecord(value)) {
    if (looksLikeSourceConnection(value)) {
      const nodes = Array.isArray(value["nodes"]) ? value["nodes"] : [];
      const compact: Record<string, unknown> = {
        totalCount: value["totalCount"] ?? null,
        hasMore: value["hasMore"] ?? null,
        nodes: nodes.map((node) => compactSourceNode(node)),
      };
      if (Object.hasOwn(value, "pageInfo")) {
        compact["pageInfo"] = compactValue(value["pageInfo"]);
      }
      return compact;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = compactValue(item);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactValue(item));
  }
  return value;
}

const SOURCE_CONNECTION_KEYS = ["source", "table", "rowid", "data", "summary"];

function looksLikeSourceConnection(value: Record<string, unknown>): boolean {
  const nodes = value["nodes"];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return false;
  }
  return nodes.every(
    (node) => isRecord(node) && SOURCE_CONNECTION_KEYS.some((key) => Object.hasOwn(node, key)),
  );
}

function compactSourceNode(node: unknown): unknown {
  if (!isRecord(node)) {
    return node;
  }
  const data = isRecord(node["data"]) ? node["data"] : {};
  return {
    source: (node["source"] || node["table"]) ?? null,
    table: node["table"] ?? null,
    rowid: node["rowid"] ?? null,
    record_id:
      node["recordId"] ||
      node["record_id"] ||
      data["id"] ||
      data["record_id"] ||
      data["source_id"] ||
      "",
    summary: node["summary"] || summarizeSourceData(data),
  };
}

const SUMMARY_PRIORITY_KEYS = [
  "ownername",
  "firstname",
  "middlename",
  "lastname",
  "fullname",
  "address",
  "zip",
  "ownrent",
  "recordingdate",
  "mailingaddress",
];

function summarizeSourceData(data: Record<string, unknown>): string {
  if (Object.keys(data).length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const key of SUMMARY_PRIORITY_KEYS) {
    const value = data[key];
    if (value !== null && value !== undefined && value !== "") {
      parts.push(`${key}=${String(value)}`);
    }
    if (parts.length >= 8) {
      break;
    }
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && value !== undefined && value !== "") {
        parts.push(`${key}=${String(value)}`);
      }
      if (parts.length >= 8) {
        break;
      }
    }
  }
  // Cap the summary at 600 code points.
  return Array.from(parts.join("; ")).slice(0, 600).join("");
}

function describeSchema(schema: Record<string, unknown>, target: string | null): Record<string, unknown> {
  if (!target) {
    const s = asRecord(schema["__schema"]);
    const queryType = asRecord(s["queryType"])["name"];
    const fields = typeFields(schema, queryType);
    return { target: "Query", fields, examples: schemaExamples("Query") };
  }
  const trimmed = target.trim();
  if (!trimmed) {
    return describeSchema(schema, null);
  }
  const taskShape = taskSchemaDescription(trimmed);
  if (taskShape) {
    return taskShape;
  }
  const typeInfo = findType(schema, trimmed);
  if (typeInfo) {
    return {
      target: trimmed,
      kind: typeInfo["kind"],
      fields: renderFields(asArray(typeInfo["fields"])),
      input_fields: renderInputFields(asArray(typeInfo["inputFields"])),
      examples: schemaExamples(trimmed),
      common_mistakes: schemaMistakes(trimmed),
    };
  }
  return {
    target: trimmed,
    error: `Schema target not found: ${trimmed}`,
    hint: "Ask for Query, Address, Person, SourceRecordConnection, a record type, or a WhereInput type.",
  };
}

function findType(schema: Record<string, unknown>, name: unknown): Record<string, unknown> | null {
  const s = asRecord(schema["__schema"]);
  for (const item of asArray(s["types"])) {
    if (isRecord(item) && item["name"] === name) {
      return item;
    }
  }
  return null;
}

function typeFields(schema: Record<string, unknown>, typeName: unknown): Record<string, unknown>[] {
  if (!typeName) {
    return [];
  }
  const typeInfo = findType(schema, typeName);
  return renderFields(asArray(asRecord(typeInfo)["fields"]));
}

function renderFields(fields: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const field of fields) {
    if (!isRecord(field) || !field["name"]) {
      continue;
    }
    const args = asArray(field["args"]).map((arg) => {
      const argRec = asRecord(arg);
      return { name: argRec["name"] ?? null, type: typeName(argRec["type"]) };
    });
    out.push({
      name: field["name"],
      args,
      type: typeName(field["type"]),
      description: field["description"] || "",
    });
  }
  return out;
}

function renderInputFields(fields: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const field of fields) {
    if (!isRecord(field) || !field["name"]) {
      continue;
    }
    out.push({
      name: field["name"],
      type: typeName(field["type"]),
      description: field["description"] || "",
    });
  }
  return out;
}

function typeName(typeRef: unknown): string {
  if (!isRecord(typeRef)) {
    return "Unknown";
  }
  const kind = typeRef["kind"];
  const name = typeRef["name"];
  const ofType = typeRef["ofType"];
  if (kind === "NON_NULL") {
    return `${typeName(ofType)}!`;
  }
  if (kind === "LIST") {
    return `[${typeName(ofType)}]`;
  }
  return String(name || kind || "Unknown");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the value if it is a plain object, else an empty object. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Returns the value if it is an array, else an empty array. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
