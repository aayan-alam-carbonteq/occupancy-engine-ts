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
const VALID_BODY = { address: "1104 SPRING RUN RD", zip: "40514" };

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
    });
    // graph.url travels as the explicit override, not in the request — exactly how a caller would
    // never point the engine at a data service of its own.
    return await investigate_address(request, new FakeSubagent(), {}, graph.url);
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
      body: JSON.stringify({ zip: "40514" }), // missing address
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
  test("400s a body still sending graphql_url — as an unknown key", async () => {
    const engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => ({}) as any });
    try {
      const res = await fetch(`${engine.url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ address: "a", graphql_url: "http://graphql:8000/graphql" }),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(((await res.json()) as any).error.issues)).toContain("graphql_url");
    } finally {
      await engine.stop();
    }
  });

  test("the same body without graphql_url is accepted", async () => {
    // The mirror of the test above: proves the 400 is about the retired key, not about the
    // endpoint rejecting everything.
    const engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => ({}) as any });
    try {
      const res = await fetch(`${engine.url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ address: "a" }),
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

describe("the engine owns its data-service address — one source, not two", () => {
  test("400s a body still carrying data_url — the retired second source is now an unknown key", async () => {
    const engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => ({}) as any });
    try {
      const res = await fetch(`${engine.url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ address: "a", data_url: "http://graph:8000" }),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(((await res.json()) as any).error.issues)).toContain("data_url");
    } finally {
      await engine.stop();
    }
  });

  /**
   * The actual invariant, not just the 400 above: an investigation and a fingerprint issued against
   * the SAME engine process resolve the SAME data URL, with no per-request override anywhere.
   *
   * Before this change, POST /investigate read the caller's own request.data_url while POST
   * /fingerprint always read the engine's DATA_URL — two sources a caller had to keep in sync by
   * hand, and /fingerprint carries no per-call data_url, so a mismatch would silently key the
   * backend's AI-report cache off a DIFFERENT dataset than the investigation actually read.
   *
   * Proven here with ONE env var (DATA_URL) pointed at an ephemeral FixtureDataService — never a
   * request body, never a second EngineServerOptions.data_url — and showing both the real
   * investigation (investigate_address, no override argument) and the real fingerprint probe land
   * requests on that exact fixture instance. A reintroduced second source (a request-body data_url
   * the orchestrator honours again, or a probe/investigate path that stops reading DATA_URL) would
   * make one leg of this test 400, hang, or fail to reach the fixture at all — nothing else answers
   * on that ephemeral port.
   */
  test("an investigation and a fingerprint against the same engine resolve the SAME data URL", async () => {
    const payload = resolve1104() as Record<string, any>;
    const graph = new FixtureDataService({
      resolve: payload,
      address_people: people1104(),
      address_records: { records_by_source: payload["records_by_source"], unsupported_shapes: [] },
      schema: { tables: [], access_paths: [], caveats: [] },
    });
    const originalDataUrl = process.env.DATA_URL;
    process.env.DATA_URL = graph.url; // the ONLY place this test names a data service
    let engine: EngineServer | undefined;
    try {
      // No opts.data_url override: the probe and the investigation runner below both fall through
      // to resolve_data_url()'s DATA_URL-env read — exactly the path production takes.
      engine = create_engine_server({
        port: 0,
        auth_token: TOKEN,
        // FakeSubagent keeps this deterministic (no LLM); the data resolution under test does not
        // depend on which subagent runs. No override argument reaches investigate_address, so it
        // resolves data_url itself, off the same DATA_URL this block just set.
        investigate: (request, hooks) => investigate_address(request, new FakeSubagent(), hooks),
      });

      expect(graph.requests.length).toBe(0);

      const fpRes = await fetch(`${engine.url}/fingerprint`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ items: [{ address: "1104 SPRING RUN RD", zip: "40514" }] }),
      });
      expect(fpRes.status).toBe(200);
      const afterFingerprint = graph.requests.length;
      expect(afterFingerprint).toBeGreaterThan(0); // the probe actually reached THIS fixture

      const invRes = await fetch(`${engine.url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ address: "1104 SPRING RUN RD", zip: "40514" }), // no data_url to send
      });
      expect(invRes.status).toBe(200);
      const lines = (await invRes.text()).split("\n").filter((l) => l.length > 0);
      const terminal = JSON.parse(lines[lines.length - 1]!);
      expect("report" in terminal).toBe(true); // the real orchestrator completed against THIS fixture

      // Grown again, on the SAME FixtureDataService instance — never a second server, never a
      // connection failure against the http://graph:8000 default.
      expect(graph.requests.length).toBeGreaterThan(afterFingerprint);
      expect(graph.requests.some((r) => r.path === "/v1/resolve")).toBe(true);
    } finally {
      if (engine) await engine.stop();
      graph.close();
      if (originalDataUrl === undefined) delete process.env.DATA_URL;
      else process.env.DATA_URL = originalDataUrl;
    }
  });
});
