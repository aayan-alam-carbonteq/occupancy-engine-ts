import { afterEach, describe, expect, test } from "bun:test";
import {
  records_fingerprint,
  type DataSourceProbe,
  type NormalizedRecord,
} from "../src/fingerprint/data_source_probe.ts";
import { engine_source_hash } from "../src/fingerprint/source_hash.ts";
import { create_engine_server, type EngineServer } from "../src/server/investigate_server.ts";
import { FixtureGraphQLServer } from "./support/fixture_graphql.ts";
import { probeGraphPayload } from "./support/fixtures.ts";

const TOKEN = "test-engine-token";

/** One record whose content is derived from the address, so every address hashes differently. */
function rowsFor(address: string): NormalizedRecord[] {
  return [{ scope: "address", subject_id: address, source: "base", table: "base", rowid: 1, data: { address } }];
}

/** A probe whose outcome is chosen per address: rows, null, or a throw. */
class ScriptedProbe implements DataSourceProbe {
  constructor(private readonly outcome: (address: string) => "throw" | null | NormalizedRecord[]) {}
  async probe(address: string): Promise<NormalizedRecord[] | null> {
    const result = this.outcome(address);
    if (result === "throw") {
      throw new Error("probe exploded");
    }
    return result;
  }
}

let engine: EngineServer | undefined;
afterEach(async () => {
  if (engine) {
    await engine.stop();
    engine = undefined;
  }
});

async function post(body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return await fetch(`${engine!.url}/fingerprint`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /fingerprint — auth and body", () => {
  test("401 when the bearer token is missing or wrong", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    expect((await post({ items: [{ address: "a" }] }, null)).status).toBe(401);
    expect((await post({ items: [{ address: "a" }] }, "nope")).status).toBe(401);
  });

  test("400 when the body is not valid JSON", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    const res = await post("{not json");
    expect(res.status).toBe(400);
  });

  test("400 with the zod path when the body fails the strict schema", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    const res = await post({ items: [{ zip: "40514" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(body.error.issues.some((i: string) => i.startsWith("items.0.address:"))).toBe(true);
  });

  test("404 on the wrong method (the route is POST only)", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    const res = await fetch(`${engine.url}/fingerprint`, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /fingerprint — the pinned response shape", () => {
  test("one entry per input, SAME ORDER, even when items complete out of order", async () => {
    const probe = new ScriptedProbe((address) => rowsFor(address));
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe, fingerprint_batch_concurrency: 4 });
    const addresses = ["a0", "a1", "a2", "a3", "a4", "a5", "a6"];
    const res = await post({ items: addresses.map((address) => ({ address })) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items.length).toBe(addresses.length);
    addresses.forEach((address, index) => {
      expect(body.items[index].data).toBe(records_fingerprint(rowsFor(address)));
    });
  });

  test("`engine` is the process source-tree hash, stable across requests, and carries NO model field", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    const first = (await (await post({ items: [{ address: "a" }] })).json()) as any;
    const second = (await (await post({ items: [{ address: "b" }] })).json()) as any;
    expect(first.engine).toBe(engine_source_hash());
    expect(second.engine).toBe(first.engine);
    expect(first.engine).toBe(engine.engine_hash);
    expect(Object.hasOwn(first, "model")).toBe(false);
    expect(Object.keys(first).sort()).toEqual(["engine", "items"]);
    expect(Object.keys(first.items[0])).toEqual(["data"]);
  });

  test("zip is optional per item and both forms are accepted", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    const res = await post({ items: [{ address: "a", zip: "40514" }, { address: "b" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.items[0].data).toBe("string");
    expect(typeof body.items[1].data).toBe("string");
  });
});

describe("POST /fingerprint — per-item degradation, never a request failure", () => {
  test("a probe returning null degrades ONLY that item", async () => {
    const probe = new ScriptedProbe((address) => (address === "bad" ? null : rowsFor(address)));
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe });
    const res = await post({ items: [{ address: "ok1" }, { address: "bad" }, { address: "ok2" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items[0].data).toBe(records_fingerprint(rowsFor("ok1")));
    expect(body.items[1].data).toBeNull();
    expect(body.items[2].data).toBe(records_fingerprint(rowsFor("ok2")));
  });

  test("a probe that THROWS degrades ONLY that item — still 200", async () => {
    const probe = new ScriptedProbe((address) => (address === "boom" ? "throw" : rowsFor(address)));
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe });
    const res = await post({ items: [{ address: "boom" }, { address: "ok" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items[0].data).toBeNull();
    expect(body.items[1].data).toBe(records_fingerprint(rowsFor("ok")));
  });
});

describe("POST /fingerprint — default wiring", () => {
  test("with no injected probe the server reads its OWN configured graph URL", async () => {
    const graph = new FixtureGraphQLServer(probeGraphPayload());
    try {
      engine = create_engine_server({ port: 0, auth_token: TOKEN, graphql_url: graph.url });
      const res = await post({ items: [{ address: "1104 SPRING RUN RD", zip: "40514" }] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(typeof body.items[0].data).toBe("string");
      expect(/^[0-9a-f]{64}$/.test(body.items[0].data)).toBe(true);
    } finally {
      graph.close();
    }
  });

  test("with no injected probe and an unreachable graph, every item degrades to null — still 200", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, graphql_url: "http://127.0.0.1:1/graphql" });
    const res = await post({ items: [{ address: "1104 SPRING RUN RD", zip: "40514" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items[0].data).toBeNull();
  });
});

describe("POST /fingerprint — zip reaches the probe", () => {
  test("the preflight query carries the zip the caller sent, and null when omitted", async () => {
    // REGRESSION GUARD. Changing the route to `probe.probe(item.address)` — dropping zip — passed
    // every other test in this repo, because FixtureGraphQLServer answers every query with the same
    // payload regardless of variables, so zip was unobservable. zip feeds PREFLIGHT_QUERY and
    // candidate selection, so losing it silently fingerprints a DIFFERENT address than the run
    // resolves: the wrong-answer direction.
    const graph = new FixtureGraphQLServer(probeGraphPayload());
    try {
      engine = create_engine_server({ port: 0, auth_token: TOKEN, graphql_url: graph.url });
      await post({ items: [{ address: "1104 SPRING RUN RD", zip: "40514" }] });
      const withZip = graph.requests.find(
        (r) => typeof (r as any)?.variables?.zip === "string",
      ) as any;
      expect(withZip).toBeDefined();
      expect(withZip.variables.zip).toBe("40514");
    } finally {
      graph.close();
    }
  });

  test("an omitted zip reaches the probe as null, not as a stray string", async () => {
    const graph = new FixtureGraphQLServer(probeGraphPayload());
    try {
      engine = create_engine_server({ port: 0, auth_token: TOKEN, graphql_url: graph.url });
      await post({ items: [{ address: "1104 SPRING RUN RD" }] });
      const preflight = graph.requests.find((r) => (r as any)?.variables?.query !== undefined) as any;
      expect(preflight).toBeDefined();
      expect(preflight.variables.zip).toBeNull();
    } finally {
      graph.close();
    }
  });
});

describe("POST /fingerprint — bounded work", () => {
  test("a whole-request deadline degrades the remaining items to null, still 200", async () => {
    // Without a deadline a 100-item batch against a slow graph could run for over an hour holding
    // graph connections. Overrun items become data:null, which the contract already allows.
    const slow = new (class {
      async probe(address: string) {
        await new Promise((r) => setTimeout(r, 40));
        return rowsFor(address);
      }
    })();
    engine = create_engine_server({
      port: 0,
      auth_token: TOKEN,
      probe: slow,
      fingerprint_batch_concurrency: 1,
      fingerprint_timeout_ms: 60,
    });
    const res = await post({ items: [{ address: "a" }, { address: "b" }, { address: "c" }, { address: "d" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // One entry per input is still the contract, even when the deadline cuts the work short.
    expect(body.items.length).toBe(4);
    expect(body.items.some((i: any) => i.data === null)).toBe(true);
  });

  test("concurrent requests past the cap get 503, not unbounded graph load", async () => {
    const slow = new (class {
      async probe(address: string) {
        await new Promise((r) => setTimeout(r, 120));
        return rowsFor(address);
      }
    })();
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: slow, fingerprint_max_concurrency: 1 });
    const [first, second] = await Promise.all([
      post({ items: [{ address: "a" }] }),
      // Fires while the first is still in flight.
      new Promise<Response>((r) => setTimeout(() => r(post({ items: [{ address: "b" }] })), 10)),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 503]);
  });
});
