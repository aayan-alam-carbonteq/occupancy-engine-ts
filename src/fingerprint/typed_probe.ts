// Today's DataSourceProbe. Resolves the subject address exactly as an investigation's preflight does
// (POST /v1/resolve — the service resolves, not the engine: `address_id` IS the selection, see
// orchestrator.ts's `_selected_candidate`), then reads the subject's source rows and ONE HOP of
// linked-person rows through the SAME src/agents/retrieval.ts helpers the agents' typed tools call.
// Deterministic, no LLM.
//
// This is the partner adapter the old GraphQL probe's own header comment anticipated: "The partner
// adapter that replaces this one calls their read API as an agent would and maps the response into the
// same NormalizedRecord model — nothing outside this file moves when it arrives." Nothing did.
import { CountingDataClient, DataHttpClient } from "../agents/data_client.ts";
import { fetch_address_records_multi, fetch_people_at_address, fetch_person_records } from "../agents/retrieval.ts";
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

export interface TypedDataSourceProbeOptions {
  max_probed_persons?: number;
}

export class TypedDataSourceProbe implements DataSourceProbe {
  private readonly client: DataHttpClient;
  private readonly max_probed_persons: number;

  constructor(client: DataHttpClient, opts: TypedDataSourceProbeOptions = {}) {
    this.client = client;
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
    // Budget: 1 resolve + 1 address-multi + 1 people + one per probed person. Unlike the retired
    // GraphQL preflight, the typed resolve is a single round-trip — there is no by-id fallback call.
    const data = new CountingDataClient(this.client, {
      max_calls: 3 + this.max_probed_persons,
      agent_id: "fingerprint_probe",
    });

    const resolved = await data.resolve(address, zip);
    const address_id = resolved.address_id;
    if (address_id === null || address_id === undefined) {
      return null; // unresolvable address → this item's `data` is null
    }
    const subject = String(address_id);
    const records: NormalizedRecord[] = [];

    const address_records = await fetch_address_records_multi(data, address_id, {
      limit: ADDRESS_RECORD_LIMIT,
      offset: 0,
    });
    // retrieval.ts swallows DataClientError into {ok:false, error:"<message>"}. Hashing an error
    // string would mint a fake key from a transient blip — abort to null instead.
    if (address_records["ok"] !== true) {
      return null;
    }
    for (const [source, bundle] of Object.entries(asRecord(address_records["records_by_source"]))) {
      for (const row of asArray(asRecord(bundle)["records"])) {
        records.push(compact_row_record("address", subject, source, row));
      }
    }

    const people = await fetch_people_at_address(data, address_id, { limit: PEOPLE_LIMIT });
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
      const person_records = await fetch_person_records(data, person_id, { limit: PERSON_RECORD_LIMIT });
      if (person_records["ok"] !== true) {
        return null;
      }
      for (const [source, bundle] of Object.entries(asRecord(person_records["records_by_source"]))) {
        for (const row of asArray(asRecord(bundle)["records"])) {
          records.push(compact_row_record("person", person_id, source, row));
        }
      }
    }

    return records;
  }
}

/**
 * retrieval.ts's `_compact_source_row` output (`{source, table, rowid, summary, data}`) →
 * NormalizedRecord. `summary` is DROPPED: it is a deterministic rendering of the same `data`, so
 * hashing both would double-weight a change and add no information.
 */
function compact_row_record(
  scope: "address" | "person",
  subject_id: string,
  source: string,
  row: unknown,
): NormalizedRecord {
  const record = asRecord(row);
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
