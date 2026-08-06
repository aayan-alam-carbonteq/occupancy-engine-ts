// Long-running, stateless HTTP service wrapping investigate_address. One streaming endpoint:
//   POST /investigate  → NDJSON: zero-or-more {"progress"} frames (formatProgressLine, verbatim),
//                        then exactly one terminal {"report"} or {"error"} frame.
//   GET  /healthz       → 200 once the LLM + graph clients construct, else 503.
// Bun.serve is native — no new dependency. No job store, no persistence.
import { createChatModel } from "../agents/llm.ts";
import { GraphQLHttpTool } from "../agents/graphql_tool.ts";
import { investigate_address, type InvestigationHooks } from "../agents/orchestrator.ts";
import {
  assessment_report_payload,
  formatProgressLine,
  parse_investigation_request,
} from "../agents/investigation_wire.ts";
import type { AgentInvestigationRequest, OccupancyAgentAssessment } from "../agents/models.ts";

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
  graphql_url?: string; // healthcheck default; investigations carry their own graphql_url
  investigate?: InvestigationRunner; // injection seam for deterministic tests
}

export interface EngineServer {
  port: number;
  url: string;
  stop(): Promise<void>; // graceful: stop accepting, drain in-flight, then close
}

const DEFAULT_PORT = 8787;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY_AFTER_SECONDS = 2;

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
  const graphql_url_default = opts.graphql_url ?? process.env.GRAPHQL_URL ?? "http://graphql:8000/graphql";
  const run_investigation: InvestigationRunner =
    opts.investigate ?? ((request, hooks) => investigate_address(request, null, hooks));
  const pool = new PermitPool(max_concurrency);
  const encoder = new TextEncoder();
  let accepting = true;

  const server = Bun.serve({
    port: opts.port ?? DEFAULT_PORT,
    idleTimeout: 0, // an investigation stream is long-lived and can be silent between phases
    async fetch(req) {
      const url = new URL(req.url);

      // Healthcheck (no auth): proves the LLM + graph clients construct. Cheap — no network, no spend.
      if (req.method === "GET" && url.pathname === "/healthz") {
        try {
          createChatModel({ provider: "auto", timeout_seconds: 30 });
          new GraphQLHttpTool(graphql_url_default);
          return json_response({ status: "ok" }, 200);
        } catch (exc) {
          return json_response({ status: "unhealthy", error: errStr(exc) }, 503);
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
  return { port: bound_port, url: `http://127.0.0.1:${bound_port}`, stop };
}
