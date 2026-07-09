import { describe, expect, it } from "bun:test";
import { _bucket_by_group, _worker_span_metadata } from "../src/agents/orchestrator.ts";
import { get_heuristic_catalog } from "../src/heuristics/packets.ts";

describe("worker count = bucket count", () => {
  it("collapses grouped heuristics so buckets < heuristics for the real catalog", () => {
    const heuristics = get_heuristic_catalog();
    const buckets = _bucket_by_group(heuristics);

    // 7 packets: two groups (owner_property_context, occupancy_presence) each collapse
    // 2 heuristics into 1 bucket; the other 3 ungrouped packets stay singleton => 5 buckets.
    expect(heuristics.length).toBe(7);
    expect(buckets.length).toBe(5);
    expect(buckets.length).toBeLessThan(heuristics.length);
    // buckets partition the heuristics with no loss
    expect(buckets.flat().length).toBe(heuristics.length);
  });

  it("stamps workers_total and a 0-based worker_index on each worker span", () => {
    const grouped = [{ id: "a" }, { id: "b" }];
    const solo = [{ id: "c" }];
    const workers_total = 2;

    expect(_worker_span_metadata(grouped, 0, workers_total)).toEqual({
      group_size: 2,
      heuristic_ids: ["a", "b"],
      workers_total: 2,
      worker_index: 0,
    });
    expect(_worker_span_metadata(solo, 1, workers_total)).toEqual({
      group_size: 1,
      heuristic_ids: ["c"],
      workers_total: 2,
      worker_index: 1,
    });
  });
});
