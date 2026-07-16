import { describe, expect, test } from "bun:test";
import { ScriptedChatModel } from "./scripted_llm.ts";
import { FixtureGraphQLServer } from "./fixture_graphql.ts";
import { loadPreflight1104, sparsePreflightPayload } from "./fixtures.ts";

describe("ScriptedChatModel", () => {
  test("bindTools returns an invocable that yields the scripted batch, then throws when exhausted", async () => {
    const m = new ScriptedChatModel([[{ name: "submit_x", args: { a: 1 } }]]);
    const bound = m.bindTools([{}]);
    const r = await bound.invoke([], {});
    expect(r.tool_calls).toEqual([{ name: "submit_x", args: { a: 1 }, id: "call_submit_x_0", type: "tool_call" }]);
    expect(r.usage_metadata).toBeDefined();
    await expect(bound.invoke([], {})).rejects.toThrow(/exhausted/);
  });
});

describe("FixtureGraphQLServer", () => {
  test("serves {data: payload} over real HTTP and records requests", async () => {
    const server = new FixtureGraphQLServer({ hello: "world" });
    try {
      const resp = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ hello }" }),
      });
      const body = await resp.json();
      expect(body).toEqual({ data: { hello: "world" } });
      expect(server.requests.length).toBe(1);
    } finally {
      server.close();
    }
  });
});

describe("fixtures", () => {
  test("real preflight fixture loads with an address id and source fields", () => {
    const p = loadPreflight1104();
    expect(p.addressByText).toBeDefined();
    expect(typeof (p.addressByText as any).id).toBe("number");
  });
  test("sparse payload has zero-count sources", () => {
    const p = sparsePreflightPayload();
    expect((p.addressByText as any).taxProperties.totalCount).toBe(0);
  });
});
