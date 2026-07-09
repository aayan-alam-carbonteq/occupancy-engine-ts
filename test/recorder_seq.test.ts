import { describe, expect, it } from "bun:test";
import { MetricsRecorder } from "../src/observability/recorder.ts";
import type { MetricEvent } from "../src/observability/models.ts";

function makeRecorder(on_event?: (e: MetricEvent) => void): MetricsRecorder {
  return new MetricsRecorder(
    {
      run_id: "run-1",
      batch_id: "",
      investigation_id: "run-1",
      address_key: "k",
      address: "1 TEST ST",
      zip: "",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      prompt_profile: "compact",
      include_shortcuts: false,
    },
    { enabled: true, on_event },
  );
}

describe("MetricsRecorder seq", () => {
  it("assigns a strictly increasing seq to every emitted event", async () => {
    const seen: MetricEvent[] = [];
    const recorder = makeRecorder((e) => seen.push(e));

    await recorder.span("investigation", { agent_id: "a" }, async () => {
      recorder.record_counter("packets", {});
      return "ok";
    });

    // emit order: span_start, counter, span end
    const seqs = seen.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3]);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(seen[0]!.seq).toBeLessThan(seen[seen.length - 1]!.seq);
  });

  it("stamps seq on persisted events even with no sink", async () => {
    const recorder = makeRecorder();
    await recorder.span("investigation", { agent_id: "a" }, async () => {
      recorder.record_counter("packets", {});
      return "ok";
    });

    const persisted = recorder.events(); // span end + counter (span_start is sink-only)
    expect(persisted.length).toBe(2);
    expect(persisted.every((e) => e.seq > 0)).toBe(true);
    const seqs = persisted.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
});
