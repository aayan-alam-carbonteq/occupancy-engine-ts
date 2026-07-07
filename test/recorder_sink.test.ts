import { describe, expect, it } from "bun:test";
import { MetricsRecorder } from "../src/observability/recorder.ts";
import type { MetricEvent } from "../src/observability/models.ts";

function makeRecorder(on_event?: (event: MetricEvent) => void): MetricsRecorder {
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

describe("MetricsRecorder on_event sink", () => {
  it("streams each recorded event to the sink as it happens", async () => {
    const seen: MetricEvent[] = [];
    const recorder = makeRecorder((event) => seen.push(event));

    await recorder.span("investigation", { agent_id: "agent-a" }, async () => "ok");
    recorder.record_counter("packets", {});

    expect(seen.length).toBe(2);
    expect(seen[0]?.event_type).toBe("span");
    expect(seen[0]?.agent_id).toBe("agent-a");
    expect(seen[1]?.event_type).toBe("counter");
    expect(recorder.events().length).toBe(2);
  });

  it("a throwing sink never breaks recording", async () => {
    const recorder = makeRecorder(() => {
      throw new Error("sink boom");
    });
    await recorder.span("investigation", { agent_id: "agent-a" }, async () => "ok");
    expect(recorder.events().length).toBe(1);
  });
});
