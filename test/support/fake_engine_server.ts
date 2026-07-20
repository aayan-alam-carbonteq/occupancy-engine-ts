// A fake engine HTTP server emitting the pinned POST /investigate NDJSON contract: zero-or-more
// {"progress"} frames (built via the SHARED formatProgressLine, so the double can only emit what the
// real engine emits) then exactly one terminal {"report"} or {"error"} frame. Same role as X-012's
// CLI double, upgraded to the service transport.
import { formatProgressLine } from "../../src/agents/investigation_wire.ts";
import type { MetricEvent } from "../../src/observability/models.ts";

export interface FakeEnginePlan {
  events?: MetricEvent[];
  report?: Record<string, unknown>; // terminal {"report": report}
  error?: string; // terminal {"error": {message: error}} (takes precedence over report)
  auth_token?: string;
}

export class FakeEngineServer {
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;

  constructor(plan: FakeEnginePlan) {
    const auth = plan.auth_token ?? "test-token";
    const encoder = new TextEncoder();
    this.server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/investigate") {
          return new Response(JSON.stringify({ error: { message: "not found" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        if ((req.headers.get("authorization") ?? "") !== `Bearer ${auth}`) {
          return new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of plan.events ?? []) {
              controller.enqueue(encoder.encode(formatProgressLine(event) + "\n"));
            }
            if (plan.error !== undefined) {
              controller.enqueue(encoder.encode(JSON.stringify({ error: { message: plan.error } }) + "\n"));
            } else {
              controller.enqueue(encoder.encode(JSON.stringify({ report: plan.report ?? {} }) + "\n"));
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
      },
    });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  close(): void {
    this.server.stop(true);
  }
}
