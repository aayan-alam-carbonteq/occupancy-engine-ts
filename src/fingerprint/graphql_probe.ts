// Today's DataSourceProbe. Resolves the subject address exactly as an investigation's preflight does
// (the SAME resolve_subject_address), then reads the subject's source rows and ONE HOP of linked-person
// rows through the SAME src/agents/retrieval.ts helpers the agents use. Deterministic, no LLM.
//
// The partner adapter that replaces this one calls their read API as an agent would and maps the
// response into the same NormalizedRecord model — nothing outside this file moves when it arrives.
import { CountingGraphQLTool, type GraphQLHttpTool } from "../agents/graphql_tool.ts";
import { resolve_subject_address, resolved_address_id } from "../agents/orchestrator.ts";
import {
  fetch_address_records_multi,
  fetch_people_at_address,
  fetch_person_records,
} from "../agents/retrieval.ts";
import type { DataSourceProbe, NormalizedRecord } from "./data_source_probe.ts";

/** Address rows per source. Matches the shortcut helper's own default. */
const ADDRESS_RECORD_LIMIT = 25;
/** People read at the subject address, before the person cap is applied. */
const PEOPLE_LIMIT = 25;
/** Rows per source for each probed person. */
const PERSON_RECORD_LIMIT = 20;
/**
 * How many linked persons get their records read. Bounded on purpose: this probe runs on EVERY cache
 * lookup, so its cost is the tax the cache pays. The window is taken from persons sorted by id — never
 * from the order the source happened to return them in — so the window itself is deterministic.
 */
export const MAX_PROBED_PERSONS = 5;

export interface GraphQLDataSourceProbeOptions {
  max_probed_persons?: number;
}

export class GraphQLDataSourceProbe implements DataSourceProbe {
  private readonly tool: GraphQLHttpTool;
  private readonly max_probed_persons: number;

  constructor(tool: GraphQLHttpTool, opts: GraphQLDataSourceProbeOptions = {}) {
    this.tool = tool;
    this.max_probed_persons = Math.max(0, opts.max_probed_persons ?? MAX_PROBED_PERSONS);
  }

  async probe(address: string, zip = ""): Promise<NormalizedRecord[] | null> {
    try {
      return await this._probe(address, zip);
    } catch {
      // Contract: a probe NEVER throws. One bad address must cost that item its lookup, nothing more.
      return null;
    }
  }

  private async _probe(address: string, zip: string): Promise<NormalizedRecord[] | null> {
    // Budget: 1 preflight + 1 possible by-id fallback + 1 address-multi + 1 people + one per person.
    const graphql = new CountingGraphQLTool(this.tool, {
      max_calls: 4 + this.max_probed_persons,
      agent_id: "fingerprint_probe",
    });

    const resolution = await resolve_subject_address(graphql, address, zip);
    const address_id = resolved_address_id(resolution);
    if (address_id === null) {
      return null; // unresolvable address → this item's `data` is null
    }
    const subject = String(address_id);
    const records: NormalizedRecord[] = [];

    const address_records = await fetch_address_records_multi(graphql, address_id, {
      limit: ADDRESS_RECORD_LIMIT,
      offset: 0,
    });
    // The retrieval helpers swallow GraphQLToolError into {ok:false, error:"<message>"}. Hashing an
    // error string would mint a fake key from a transient blip — abort to null instead.
    if (address_records["ok"] !== true) {
      return null;
    }
    for (const [source, bundle] of Object.entries(asRecord(address_records["records_by_source"]))) {
      for (const node of asArray(asRecord(bundle)["records"])) {
        records.push(compact_node_record("address", subject, source, node));
      }
    }

    const people = await fetch_people_at_address(graphql, address_id, { limit: PEOPLE_LIMIT });
    if (people["ok"] !== true) {
      return null;
    }
    const person_nodes = asArray(people["people"])
      .filter((node) => typeof asRecord(node)["id"] === "string" && asRecord(node)["id"] !== "")
      .sort((a, b) => {
        const left = String(asRecord(a)["id"]);
        const right = String(asRecord(b)["id"]);
        return left < right ? -1 : left > right ? 1 : 0;
      });

    for (const node of person_nodes) {
      const person = asRecord(node);
      records.push({
        scope: "person",
        subject_id: String(person["id"]),
        source: "identity",
        table: "",
        rowid: null,
        data: { ...person },
      });
    }

    for (const node of person_nodes.slice(0, this.max_probed_persons)) {
      const person_id = String(asRecord(node)["id"]);
      const person_records = await fetch_person_records(graphql, person_id, { limit: PERSON_RECORD_LIMIT });
      if (person_records["ok"] !== true) {
        return null;
      }
      for (const [source, bundle] of Object.entries(asRecord(person_records["records_by_source"]))) {
        for (const row of asArray(asRecord(bundle)["records"])) {
          records.push(compact_node_record("person", person_id, source, row));
        }
      }
    }

    return records;
  }
}

/**
 * `_compact_source_node` output → NormalizedRecord. `summary` is DROPPED: it is a deterministic
 * rendering of the same `data`, so hashing both would double-weight a change and add no information.
 */
function compact_node_record(
  scope: "address" | "person",
  subject_id: string,
  source: string,
  node: unknown,
): NormalizedRecord {
  const record = asRecord(node);
  const rowid = record["rowid"];
  return {
    scope,
    subject_id,
    source,
    table: typeof record["table"] === "string" ? record["table"] : "",
    rowid: typeof rowid === "number" || typeof rowid === "string" ? rowid : null,
    data: isRecord(record["data"]) ? record["data"] : {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value if it is a plain object, else an empty object. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The value if it is an array, else an empty array. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
