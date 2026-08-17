import { describe, expect, test } from "bun:test";
import { CountingDataClient, DataHttpClient } from "../src/agents/data_client.ts";
import { ALL_SHAPES, SHAPE_TOOLS, _typed_tool_definitions, run_typed_tool, typed_tools_guide } from "../src/agents/typed_tools.ts";
import { FixtureDataService } from "./support/fixture_data_service.ts";

const EMPTY_BLOCK = { total_count: 0, has_more: false, records: [] };

function counted(s: FixtureDataService) {
  return new CountingDataClient(new DataHttpClient(s.url), { max_calls: 4 });
}

function agentInput(heuristic: Record<string, any> = {}): any {
  return { heuristic, context: { selected: { id: 3342 }, evidence_map: { address_id: 3342 } } };
}

describe("SHAPE_TOOLS after the shrink", () => {
  test("the three dead shapes and their tools are gone", () => {
    expect(Object.keys(SHAPE_TOOLS).sort()).toEqual([
      "get_base", "get_drivers_licenses", "get_loans", "get_tax", "get_trace_records", "get_utility", "get_vehicles",
    ]);
    expect([...ALL_SHAPES].sort()).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
    const names = _typed_tool_definitions().map((t: any) => t.name).sort();
    expect(names).toEqual([
      "get_base", "get_drivers_licenses", "get_loans", "get_people", "get_records",
      "get_tax", "get_trace_records", "get_utility", "get_vehicles", "search_people",
    ]);
    expect(names).not.toContain("get_voter_records");
    expect(names).not.toContain("get_criminal_records");
    expect(names).not.toContain("get_linkedin");
  });

  test("no tool description or guide mentions a dead shape", () => {
    const text = _typed_tool_definitions().map((t: any) => `${t.name} ${t.description}`).join("\n") + typed_tools_guide({});
    for (const dead of ["voter", "criminal", "linkedin", "LinkedIn"]) {
      expect(text).not.toContain(dead);
    }
  });

  test("a dropped tool is unroutable, not silently handled", async () => {
    const s = new FixtureDataService({});
    try {
      const out = await run_typed_tool("get_voter_records", {}, agentInput(), counted(s));
      expect(out["ok"]).toBe(false);
      expect(out["error"]).toBe("Unknown tool: get_voter_records");
      expect(s.requests.length).toBe(0);
    } finally {
      s.close();
    }
  });

  test("a packet scope naming a dead shape does not poison get_records", async () => {
    // legal_address_presence's scope used to be ["drive","voter","auto","tax"]. A stale scope must
    // degrade, never produce {ok:false, "Unknown shape(s)"} for the whole call.
    const s = new FixtureDataService({ address_records: { records_by_source: { drive: EMPTY_BLOCK }, unsupported_shapes: [] } });
    try {
      const out = await run_typed_tool("get_records", {}, agentInput({ context_scope: ["drive", "voter"] }), counted(s));
      expect(out["ok"]).toBe(true);
      expect(out["unsupported_sources"]).toContain("voter");
      // The live shape still had to be fetched — degrading is not the same as giving up.
      expect(Object.keys(out["records_by_source"] as object)).toEqual(["drive"]);
      expect(s.requests[0]!.query).toMatchObject({ shapes: "drive" });
    } finally {
      s.close();
    }
  });

  test("a scope with NO live shape still fails loudly", async () => {
    // The control for the degrade test: if every requested shape is dead there is nothing to
    // serve, and silently returning ok:true with zero records would be a lie.
    const s = new FixtureDataService({ address_records: { records_by_source: {}, unsupported_shapes: [] } });
    try {
      const out = await run_typed_tool("get_records", {}, agentInput({ context_scope: ["voter", "criminal"] }), counted(s));
      expect(out["ok"]).toBe(false);
      expect(out["error"]).toContain("voter");
      expect(out["valid_shapes"]).toEqual(["auto", "base", "drive", "loan", "tax", "trace", "utility"]);
      expect(s.requests.length).toBe(0);
    } finally {
      s.close();
    }
  });
});

// Contract B addendum 3 has to survive the tool envelope, not just retrieval.ts: the model only
// ever sees the tool result, so a wrapper that drops the flag hands it an empty record list with
// no way to tell a timed-out lookup from a person who genuinely has no records elsewhere.
describe("records_timed_out reaches the model through the tool envelope", () => {
  const TIMED_OUT = {
    person: { id: "hal:HAL0001", firstname: "JANE" },
    records_by_source: { tax: EMPTY_BLOCK },
    records_timed_out: true,
    unsupported_shapes: [],
  };

  test("get_records surfaces the gap on the person path", async () => {
    const s = new FixtureDataService({ person_records: TIMED_OUT });
    try {
      const out = await run_typed_tool("get_records", { shapes: ["tax"], person_id: "hal:HAL0001" }, agentInput(), counted(s));
      expect(out["ok"]).toBe(true);
      expect(out["records_timed_out"]).toBe(true);
      expect((out["data_gaps"] as string[])[0]).toContain("timed out");
      expect((out["data_gaps"] as string[])[0]).toContain("hal:HAL0001");
    } finally {
      s.close();
    }
  });

  test("a per-shape tool surfaces the gap on the person path", async () => {
    const s = new FixtureDataService({ person_records: TIMED_OUT });
    try {
      const out = await run_typed_tool("get_tax", { person_id: "hal:HAL0001" }, agentInput(), counted(s));
      expect(out["ok"]).toBe(true);
      expect(out["count"]).toBe(0);
      expect(out["records_timed_out"]).toBe(true);
      expect((out["data_gaps"] as string[])[0]).toContain("timed out");
    } finally {
      s.close();
    }
  });

  test("an honestly-empty person lookup carries no gap", async () => {
    const s = new FixtureDataService({ person_records: { ...TIMED_OUT, records_timed_out: false } });
    try {
      const out = await run_typed_tool("get_records", { shapes: ["tax"], person_id: "hal:HAL0001" }, agentInput(), counted(s));
      expect(out["ok"]).toBe(true);
      expect(out["data_gaps"]).toBeUndefined();
      expect(out["records_timed_out"]).toBeUndefined();
    } finally {
      s.close();
    }
  });
});
