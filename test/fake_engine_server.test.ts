import { describe, expect, test } from "bun:test";
import { FakeEngineServer } from "./support/fake_engine_server.ts";
import { formatProgressLine } from "../src/agents/investigation_wire.ts";
import { makeMetricEvent } from "../src/observability/models.ts";

const e1 = makeMetricEvent({ event_id: "e1", event_type: "span_start", run_id: "r", seq: 1, phase: "preflight", agent_id: "orchestrator", started_at: "2026-07-09T00:00:00.000Z", ended_at: "2026-07-09T00:00:00.000Z" });

describe("FakeEngineServer emits the pinned NDJSON contract", () => {
  test("progress frames then exactly one terminal report frame", async () => {
    const fake = new FakeEngineServer({ events: [e1], report: { report: "ok" }, auth_token: "tk" });
    try {
      const res = await fetch(`${fake.url}/investigate`, {
        method: "POST",
        headers: { authorization: "Bearer tk", "content-type": "application/json" },
        body: JSON.stringify({ address: "x", graphql_url: "http://g/graphql" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const text = await res.text();
      expect(text).toBe(formatProgressLine(e1) + "\n" + JSON.stringify({ report: { report: "ok" } }) + "\n");
    } finally {
      fake.close();
    }
  });

  test("a terminal error frame when the plan carries an error", async () => {
    const fake = new FakeEngineServer({ error: "kaput", auth_token: "tk" });
    try {
      const res = await fetch(`${fake.url}/investigate`, {
        method: "POST",
        headers: { authorization: "Bearer tk", "content-type": "application/json" },
        body: JSON.stringify({ address: "x", graphql_url: "http://g/graphql" }),
      });
      const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
      expect(JSON.parse(lines[lines.length - 1]!)).toEqual({ error: { message: "kaput" } });
    } finally {
      fake.close();
    }
  });

  test("401 without the bearer token", async () => {
    const fake = new FakeEngineServer({ report: {}, auth_token: "tk" });
    try {
      const res = await fetch(`${fake.url}/investigate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: "x", graphql_url: "http://g/graphql" }),
      });
      expect(res.status).toBe(401);
    } finally {
      fake.close();
    }
  });
});
