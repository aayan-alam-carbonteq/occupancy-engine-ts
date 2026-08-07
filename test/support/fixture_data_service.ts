// In-process fixture for the typed data service (real HTTP via Bun.serve). Implements exactly the
// pinned Contract B/C routes so the real DataHttpClient(base_url) drives it unchanged. Any route the
// plan did not pin 404s — that is the point: a fixture that answers everything cannot catch a client
// that calls something the service does not offer.
//
// Route shapes are mirrored from the real service (services/graph, src/occupancy_graph/service/app.py):
//   GET  /v1/schema
//   POST /v1/resolve
//   GET  /v1/address/{address_id:int}/records
//   GET  /v1/address/{address_id:int}/people
//   GET  /v1/people/search              (literal, ahead of the /v1/person/... pattern)
//   GET  /v1/person/{person_id}/records
//   GET  /v1/source-record/{shape}/{rowid:int}
//   POST /v1/sql
// Starlette's `:int` converter means a non-numeric id does not match the route at all, so the
// numeric segments are `\d+` here; `{person_id}` carries no converter, so it is `[^/]+` (Starlette's
// default str converter stops at a slash) rather than a slash-crossing `.+`.
//
// This is a transport fixture, not a reimplementation: response bodies are served verbatim from the
// plan, so the additive Contract B fields (`__rowid` on bundle-sourced records, `records_timed_out`
// on op 4, `dropped_counts` / `tax_timed_out` on ops 1 and 2) pass through untouched. The one piece
// of service *behaviour* it does model is operation 6's required `address_id` (see below), because
// omitting it is a client bug the fixture exists to catch.

export interface FixtureDataPlan {
  resolve?: Record<string, unknown>;
  address_records?: Record<string, unknown>;
  address_people?: Record<string, unknown>;
  person_records?: Record<string, unknown>;
  people_search?: Record<string, unknown>;
  source_record?: Record<string, unknown>;
  sql?: Record<string, unknown>; // a body with refused:true is served as 422
  schema?: Record<string, unknown>;
  status?: number; // force this status on every matched route (for error-path tests)
  delay_ms?: number; // hold the response open (for timeout tests)
}

export interface FixtureRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export class FixtureDataService {
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;
  readonly requests: FixtureRequest[] = [];

  constructor(plan: FixtureDataPlan) {
    const requests = this.requests;
    this.server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const query = Object.fromEntries(url.searchParams.entries());
        const entry: FixtureRequest = { method: req.method, path };
        if (Object.keys(query).length > 0) entry.query = query;
        if (req.method === "POST") {
          try {
            entry.body = await req.json();
          } catch {
            entry.body = null;
          }
        }
        requests.push(entry);
        if (plan.delay_ms) await Bun.sleep(plan.delay_ms);

        const send = (body: Record<string, unknown> | undefined, fallback = 200): Response => {
          if (body === undefined) {
            return Response.json({ error: "no fixture for this route" }, { status: 404 });
          }
          const status = plan.status ?? (body["refused"] === true ? 422 : fallback);
          return Response.json(body, { status });
        };

        if (req.method === "POST" && path === "/v1/resolve") return send(plan.resolve);
        if (req.method === "POST" && path === "/v1/sql") return send(plan.sql);
        if (req.method === "GET" && path === "/v1/schema") return send(plan.schema);
        if (req.method === "GET" && path === "/v1/people/search") return send(plan.people_search);
        if (req.method === "GET" && /^\/v1\/address\/\d+\/records$/.test(path)) return send(plan.address_records);
        if (req.method === "GET" && /^\/v1\/address\/\d+\/people$/.test(path)) return send(plan.address_people);
        if (req.method === "GET" && /^\/v1\/person\/[^/]+\/records$/.test(path)) return send(plan.person_records);
        if (req.method === "GET" && /^\/v1\/source-record\/[^/]+\/\d+$/.test(path)) {
          // Contract B addendum 1: rowid is a position within one address's rows for that shape, so
          // it cannot be resolved without the address. The real handler refuses a naked call with a
          // 400 naming the parameter, and checks it BEFORE the shape — mirrored here so a client
          // that forgets to thread address_id fails against the fixture instead of passing.
          if (!query["address_id"]) {
            return Response.json(
              {
                error:
                  "address_id is required: rowid is a position within one address's rows for this shape, so it cannot be resolved without the address",
              },
              { status: 400 },
            );
          }
          return send(plan.source_record);
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  close(): void {
    this.server.stop(true);
  }
}
