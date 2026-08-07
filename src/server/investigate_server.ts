// Long-running, stateless HTTP service wrapping investigate_address. Endpoints:
//   POST /investigate  → NDJSON: zero-or-more {"progress"} frames (formatProgressLine, verbatim),
//                        then exactly one terminal {"report"} or {"error"} frame.
//   GET  /healthz       → 200 once the LLM + data clients construct, else 503.
// Bun.serve is native — no new dependency. No job store, no persistence.
import { createChatModel } from "../agents/llm.ts";
import { DataHttpClient } from "../agents/data_client.ts";
import { investigate_address, type InvestigationHooks } from "../agents/orchestrator.ts";
import {
  assessment_report_payload,
  formatProgressLine,
  parse_investigation_request,
} from "../agents/investigation_wire.ts";
import type { AgentInvestigationRequest, OccupancyAgentAssessment } from "../agents/models.ts";
import { records_fingerprint, type DataSourceProbe } from "../fingerprint/data_source_probe.ts";
import { GraphQLDataSourceProbe } from "../fingerprint/graphql_probe.ts";
import { engine_source_hash } from "../fingerprint/source_hash.ts";
import {
  parse_fingerprint_request,
  type FingerprintItem,
  type FingerprintResponse,
  type FingerprintResponseItem,
} from "../fingerprint/wire.ts";

export type InvestigationRunner = (
  request: AgentInvestigationRequest,
  hooks: InvestigationHooks,
) => Promise<OccupancyAgentAssessment>;

export interface EngineServerOptions {
  port?: number; // default 8787
  auth_token?: string; // ENGINE_AUTH_TOKEN — required in prod; every request must send it as Bearer
  max_concurrency?: number; // default 4
  request_timeout_ms?: number; // default 300_000 — flips should_cancel for that request
  shutdown_drain_ms?: number; // default = request_timeout_ms (<= engine timeout)
  retry_after_seconds?: number; // default 2
  data_url?: string; // healthcheck default; investigations carry their own data_url
  investigate?: InvestigationRunner; // injection seam for deterministic tests
}

export interface EngineServer {
  port: number;
  url: string;
  engine_hash: string; // the source-tree hash this process reports on POST /fingerprint
  stop(): Promise<void>; // graceful: stop accepting, drain in-flight, then close
}

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY_AFTER_SECONDS = 2;
const DEFAULT_FINGERPRINT_CONCURRENCY = 4;
/**
 * Whole-request deadline for POST /fingerprint. Without one, a 100-item batch against a slow graph
 * could run for over an hour holding graph connections: 25 chunks x 9 calls x the 30s tool timeout.
 * Overrunning items degrade to `data: null`, which the pinned contract already makes a legal
 * response, so the backend simply misses those and runs the investigation.
 */
const DEFAULT_FINGERPRINT_TIMEOUT_MS = 60_000;
/**
 * Concurrent /fingerprint requests. The route is deliberately OUTSIDE the investigation permit pool
 * (a fingerprint must never starve an investigation), but that left it uncapped — N concurrent
 * requests held 4N graph connections. Small on purpose: this is a cache optimisation, and a 503
 * here is just a miss.
 */
const DEFAULT_FINGERPRINT_MAX_CONCURRENCY = 2;

/** Non-blocking counting semaphore. try_acquire returns false when saturated (→ 503). */
class PermitPool {
  private available: number;
  private readonly size: number;
  constructor(size: number) {
    this.size = Math.max(1, size);
    this.available = this.size;
  }
  try_acquire(): boolean {
    if (this.available > 0) {
      this.available -= 1;
      return true;
    }
    return false;
  }
  release(): void {
    if (this.available < this.size) {
      this.available += 1;
    }
  }
  get in_use(): number {
    return this.size - this.available;
  }
}

function errStr(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function json_response(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function create_engine_server(opts: EngineServerOptions = {}): EngineServer {
  const auth_token = opts.auth_token ?? "";
  const max_concurrency = opts.max_concurrency ?? DEFAULT_MAX_CONCURRENCY;
  const request_timeout_ms = opts.request_timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const shutdown_drain_ms = opts.shutdown_drain_ms ?? request_timeout_ms;
  const retry_after = String(opts.retry_after_seconds ?? DEFAULT_RETRY_AFTER_SECONDS);
  const data_url_default = opts.data_url ?? process.env.DATA_URL ?? "http://graph:8000";
  const run_investigation: InvestigationRunner =
    opts.investigate ?? ((request, hooks) => investigate_address(request, null, hooks));

  // Computed ONCE here, at startup, then free for the life of the process (spec §1).
  const engine_hash = opts.engine_hash ?? engine_source_hash();
  // The probe reads THIS engine's configured graph. POST /fingerprint carries no graphql_url, so
  // GRAPHQL_URL must name the same graph the backend sends in its /investigate body — otherwise the
  // fingerprint describes a different dataset than the run reads. See AGENTS.md.
  const probe: DataSourceProbe = opts.probe ?? new GraphQLDataSourceProbe(new GraphQLHttpTool(graphql_url_default));
  const fingerprint_concurrency = Math.max(1, opts.fingerprint_batch_concurrency ?? DEFAULT_FINGERPRINT_CONCURRENCY);
  const fingerprint_timeout_ms = Math.max(1, opts.fingerprint_timeout_ms ?? DEFAULT_FINGERPRINT_TIMEOUT_MS);
  const fingerprint_pool = new PermitPool(
    Math.max(1, opts.fingerprint_max_concurrency ?? DEFAULT_FINGERPRINT_MAX_CONCURRENCY),
  );

  /** One entry per input, SAME ORDER. Chunked so a batch does not open N graph reads at once. */
  const fingerprint_items = async (items: FingerprintItem[]): Promise<FingerprintResponseItem[]> => {
    const out: FingerprintResponseItem[] = [];
    const deadline = Date.now() + fingerprint_timeout_ms;
    for (let start = 0; start < items.length; start += fingerprint_concurrency) {
      // Past the deadline every remaining item degrades to null rather than the request hanging.
      // Checked BETWEEN chunks so an in-flight chunk is never abandoned mid-read.
      if (Date.now() >= deadline) {
        while (out.length < items.length) {
          out.push({ data: null });
        }
        return out;
      }
      const chunk = items.slice(start, start + fingerprint_concurrency);
      // Promise.all preserves index order within the chunk, and chunks append in order.
      const settled = await Promise.all(
        chunk.map(async (item): Promise<FingerprintResponseItem> => {
          try {
            const records = await probe.probe(item.address, item.zip ?? "");
            return { data: records === null ? null : records_fingerprint(records) };
          } catch {
            // The port says a probe never throws; a custom adapter that does still costs only its item.
            return { data: null };
          }
        }),
      );
      out.push(...settled);
    }
    return out;
  };

  const pool = new PermitPool(max_concurrency);
  const encoder = new TextEncoder();
  let accepting = true;

  const server = Bun.serve({
    port: opts.port ?? DEFAULT_PORT,
    idleTimeout: 0, // an investigation stream is long-lived and can be silent between phases
    async fetch(req) {
      const url = new URL(req.url);

      // Healthcheck (no auth): proves the LLM + data clients construct. Cheap — no network, no spend.
      if (req.method === "GET" && url.pathname === "/healthz") {
        try {
          createChatModel({ provider: "auto", timeout_seconds: 30 });
          new DataHttpClient(data_url_default);
          return json_response({ status: "ok" }, 200);
        } catch (exc) {
          return json_response({ status: "unhealthy", error: errStr(exc) }, 503);
        }
      }

      // POST /fingerprint — the backend's cache-key surface. Deterministic, no LLM, outside the
      // investigation concurrency pool (a fingerprint must never starve an investigation of a permit).
      if (req.method === "POST" && url.pathname === "/fingerprint") {
        // Draining first, mirroring /investigate. A 503 here is just a cache miss: the backend fails
        // closed on any non-200 and the investigation runs exactly as it does today.
        if (!accepting) {
          return json_response({ error: { message: "server shutting down" } }, 503, { "retry-after": retry_after });
        }
        if ((req.headers.get("authorization") ?? "") !== `Bearer ${auth_token}`) {
          return json_response({ error: { message: "unauthorized" } }, 401);
        }
        let raw_fingerprint: unknown;
        try {
          raw_fingerprint = await req.json();
        } catch {
          return json_response({ error: { message: "request body is not valid JSON" } }, 400);
        }
        const parsed_fingerprint = parse_fingerprint_request(raw_fingerprint);
        if (!parsed_fingerprint.ok) {
          return json_response(
            { error: { message: "request body failed validation", issues: parsed_fingerprint.issues } },
            400,
          );
        }
        // Capped concurrency. A 503 here is just a cache miss — the backend fails closed on any
        // non-200 and the investigation runs exactly as it does today.
        if (!fingerprint_pool.try_acquire()) {
          return json_response({ error: { message: "fingerprint capacity exhausted" } }, 503, {
            "retry-after": retry_after,
          });
        }
        try {
          // From here the response is ALWAYS 200: a per-item probe failure degrades that item to
          // {data: null}. One bad address in a 500-scan batch costs that scan its lookup, nothing more.
          const body: FingerprintResponse = {
            engine: engine_hash,
            items: await fingerprint_items(parsed_fingerprint.request.items),
          };
          return json_response(body, 200);
        } finally {
          fingerprint_pool.release();
        }
      }

      if (req.method !== "POST" || url.pathname !== "/investigate") {
        return json_response({ error: { message: "not found" } }, 404);
      }

      // Graceful shutdown: refuse new investigations while draining.
      if (!accepting) {
        return json_response({ error: { message: "server shutting down" } }, 503, { "retry-after": retry_after });
      }

      // 401 — bearer auth first.
      if ((req.headers.get("authorization") ?? "") !== `Bearer ${auth_token}`) {
        return json_response({ error: { message: "unauthorized" } }, 401);
      }

      // 400 — the body must parse to a valid AgentInvestigationRequest (schema is .strict()).
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return json_response({ error: { message: "request body is not valid JSON" } }, 400);
      }
      const parsed = parse_investigation_request(raw);
      if (!parsed.ok) {
        return json_response({ error: { message: "request body failed validation", issues: parsed.issues } }, 400);
      }
      const request = parsed.request;

      // 503 — concurrency semaphore saturated.
      if (!pool.try_acquire()) {
        return json_response({ error: { message: "engine at capacity" } }, 503, { "retry-after": retry_after });
      }

      // Cancellation: client disconnect OR the engine's own overall timeout.
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
      };
      req.signal.addEventListener("abort", cancel);
      const timeout = setTimeout(cancel, request_timeout_ms);

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const hooks: InvestigationHooks = {
            on_metric_event: (event) => {
              controller.enqueue(encoder.encode(formatProgressLine(event) + "\n"));
            },
            should_cancel: () => cancelled,
          };
          try {
            const assessment = await run_investigation(request, hooks);
            controller.enqueue(
              encoder.encode(JSON.stringify({ report: assessment_report_payload(assessment) }) + "\n"),
            );
          } catch (exc) {
            // HTTP already committed 200, so a mid-stream failure is a terminal {error} frame.
            controller.enqueue(encoder.encode(JSON.stringify({ error: { message: errStr(exc) } }) + "\n"));
          } finally {
            clearTimeout(timeout);
            req.signal.removeEventListener("abort", cancel);
            pool.release();
            controller.close();
          }
        },
        cancel() {
          // Consumer went away mid-stream — flip cancellation so in-flight work unwinds.
          cancelled = true;
        },
      });

      return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
    },
  });

  const stop = async (): Promise<void> => {
    accepting = false;
    const deadline = Date.now() + shutdown_drain_ms;
    while (pool.in_use > 0 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    server.stop(true);
  };

  // Bun.serve assigns the bound port synchronously; it is defined once serve() returns.
  const bound_port = server.port ?? (opts.port ?? DEFAULT_PORT);
  return { port: bound_port, url: `http://127.0.0.1:${bound_port}`, engine_hash, stop };
}
