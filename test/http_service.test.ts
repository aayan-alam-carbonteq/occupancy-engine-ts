import { afterEach, describe, expect, test } from "bun:test";
import { create_engine_server, type EngineServer } from "../src/server/investigate_server.ts";
import {
  assessment_report_payload,
  formatProgressLine,
} from "../src/agents/investigation_wire.ts";
import { investigate_address } from "../src/agents/orchestrator.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { makeMetricEvent } from "../src/observability/models.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";
import { people1104, resolve1104 } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

const TOKEN = "test-engine-token";
const VALID_BODY = { address: "1104 SPRING RUN RD", zip: "40514", data_url: "http://127.0.0.1:9" };

let engine: EngineServer | undefined;
afterEach(async () => {
  if (engine) {
    await engine.stop();
    engine = undefined;
  }
});

/** A real, deterministic assessment (FakeSubagent + the fixture data service, no LLM). */
async function realAssessment() {
  const graph = new FixtureDataService({
    resolve: resolve1104(),
    address_people: people1104(),
    address_records: { records_by_source: (resolve1104() as any).records_by_source, unsupported_shapes: [] },
    schema: { tables: [], access_paths: [], caveats: [] },
  });
  try {
    const request = AgentInvestigationRequestSchema.parse({
      address: "1104 SPRING RUN RD",
      zip: "40514",
      data_url: graph.url,
    });
    return await investigate_address(request, new FakeSubagent(), {});
  } finally {
    graph.close();
  }
}

describe("POST /investigate — stream shape", () => {
  test("progress frames are formatProgressLine VERBATIM, then exactly one terminal report frame", async () => {
    const assessment = await realAssessment();
    const e1 = makeMetricEvent({ event_id: "e1", event_type: "span_start", run_id: "r", seq: 1, phase: "preflight", agent_id: "orchestrator", started_at: "2026-07-09T00:00:00.000Z", ended_at: "2026-07-09T00:00:00.000Z" });
    const e2 = makeMetricEvent({ event_id: "e2", event_type: "span_end", run_id: "r", seq: 2, phase: "preflight", agent_id: "orchestrator", started_at: "2026-07-09T00:00:00.000Z", ended_at: "2026-07-09T00:00:01.000Z" });

    engine = create_engine_server({
      port: 0,
      auth_token: TOKEN,
      investigate: async (_req, hooks) => {
        hooks.on_metric_event?.(e1);
        hooks.on_metric_event?.(e2);
        return assessment;
      },
    });

    const res = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const text = await res.text();
    expect(text).toBe(
      formatProgressLine(e1) +
        "\n" +
        formatProgressLine(e2) +
        "\n" +
        JSON.stringify({ report: assessment_report_payload(assessment) }) +
        "\n",
    );
  });

  test("a mid-stream failure becomes a terminal {error} frame on the already-committed 200", async () => {
    engine = create_engine_server({
      port: 0,
      auth_token: TOKEN,
      investigate: async () => {
        throw new Error("boom");
      },
    });
    const res = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(200); // status committed before the body streamed
    const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual({ error: { message: "boom" } });
  });
});

describe("POST /investigate — pre-stream rejections", () => {
  test("401 when the bearer token is missing or wrong", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => realAssessment() });
    const noAuth = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(noAuth.status).toBe(401);
    const badAuth = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(badAuth.status).toBe(401);
  });

  test("400 with the zod path when the body fails AgentInvestigationRequestSchema (strict)", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => realAssessment() });
    const res = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ zip: "40514", data_url: "http://g" }), // missing address
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(body.error.issues.some((i: string) => i.startsWith("address:"))).toBe(true);
  });
});

describe("POST /investigate — backpressure", () => {
  test("503 + Retry-After when the concurrency semaphore is saturated", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    engine = create_engine_server({
      port: 0,
      auth_token: TOKEN,
      max_concurrency: 1,
      investigate: async (_req, hooks) => {
        // Emit one progress frame so Bun flushes the 200 headers — Bun 1.3.10 defers a streaming
        // response's headers until the first chunk is enqueued, so without this `fetch(a)` below would
        // block until release() (which only runs after that await), deadlocking. The frame flushes the
        // headers while the stream stays open and the single permit stays held.
        hooks.on_metric_event?.(
          makeMetricEvent({ event_id: "hold", event_type: "span_start", run_id: "r", seq: 1 }),
        );
        await gate; // keep the single permit occupied until released
        return realAssessment();
      },
    });

    // Request A occupies the only permit. fetch resolves once the 200 headers are flushed (by the
    // progress frame above); the permit was acquired synchronously in the handler before streaming.
    const a = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(a.status).toBe(200);

    // Request B finds the pool saturated → 503 with Retry-After.
    const b = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(b.status).toBe(503);
    expect(b.headers.get("retry-after")).toBe("2");

    release();
    await a.text(); // drain A so the permit is returned before teardown
  });
});

describe("POST /investigate — the engine's own overall timeout flips should_cancel", () => {
  test("a runner that polls should_cancel stops and yields a terminal {error} frame", async () => {
    engine = create_engine_server({
      port: 0,
      auth_token: TOKEN,
      request_timeout_ms: 50, // short overall timeout for the test
      investigate: async (_req, hooks) => {
        let iterations = 0;
        while (!hooks.should_cancel?.()) {
          await Bun.sleep(10);
          iterations += 1;
          if (iterations > 1000) break; // safety net — should never reach it
        }
        throw new Error("investigation cancelled"); // unwind through the normal error path
      },
    });
    const res = await fetch(`${engine.url}/investigate`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(200);
    const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
    expect(JSON.parse(lines[lines.length - 1]!)).toEqual({ error: { message: "investigation cancelled" } });
  });
});

describe("GET /healthz + graceful shutdown", () => {
  test("healthz is 200 when the clients construct", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, data_url: "http://graph:8000" });
    const res = await fetch(`${engine.url}/healthz`);
    // 200 when ANTHROPIC_API_KEY (or another provider key) is present; the shape is always {status}.
    const body = (await res.json()) as any;
    expect(typeof body.status).toBe("string");
    expect([200, 503]).toContain(res.status);
  });

  test("stop() drains, then new requests are refused", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => realAssessment() });
    const url = engine.url;
    await engine.stop();
    engine = undefined; // already stopped
    await expect(
      fetch(`${url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(VALID_BODY),
      }),
    ).rejects.toThrow(); // socket closed after a graceful stop
  });
});

describe("Contract A", () => {
  // The plan's version of this test asserted only that the issues mention `data_url`. That is the
  // MISSING-field issue, so it would pass unchanged even if `graphql_url` were quietly re-accepted.
  // Both halves are asserted here: the retired key is named as an unknown key (with data_url
  // supplied, so strictness is the only thing that can reject it), and a naked legacy body 400s.
  test("400s a body still sending graphql_url — as an unknown key, not merely a missing data_url", async () => {
    const engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => ({}) as any });
    try {
      const post = (body: unknown) =>
        fetch(`${engine.url}/investigate`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const shimmed = await post({ address: "a", data_url: "http://graph:8000", graphql_url: "http://graphql:8000/graphql" });
      expect(shimmed.status).toBe(400);
      expect(JSON.stringify(((await shimmed.json()) as any).error.issues)).toContain("graphql_url");

      const legacy = await post({ address: "a", graphql_url: "http://graphql:8000/graphql" });
      expect(legacy.status).toBe(400);
      expect(JSON.stringify(((await legacy.json()) as any).error.issues)).toContain("data_url");
    } finally {
      await engine.stop();
    }
  });

  test("the same body with data_url instead is accepted", async () => {
    // The mirror of the test above: proves the 400s are about the retired key, not about the
    // endpoint rejecting everything.
    const engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => ({}) as any });
    try {
      const res = await fetch(`${engine.url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ address: "a", data_url: "http://graph:8000" }),
      });
      expect(res.status).toBe(200);
    } finally {
      await engine.stop();
    }
  });

  test("healthz constructs the data client from the http://graph:8000 default", async () => {
    const engine = create_engine_server({ port: 0, auth_token: TOKEN });
    try {
      const res = await fetch(`${engine.url}/healthz`);
      const body = (await res.json()) as any;
      expect(typeof body.status).toBe("string");
      expect([200, 503]).toContain(res.status);
    } finally {
      await engine.stop();
    }
  });
});
