import { describe, expect, test } from "bun:test";
import { extractUsage } from "../src/observability/usage.ts";
import { estimateCost } from "../src/observability/pricing.ts";
import { makeTokenUsage } from "../src/observability/models.ts";

describe("extractUsage", () => {
  test("reads langchain usage_metadata incl cache details", () => {
    const msg = {
      usage_metadata: {
        input_tokens: 9491,
        output_tokens: 72,
        total_tokens: 9563,
        input_token_details: { cache_read: 5939, cache_creation: 0 },
      },
    };
    const u = extractUsage(msg);
    expect(u.input_tokens).toBe(9491);
    expect(u.output_tokens).toBe(72);
    expect(u.cache_read_input_tokens).toBe(5939);
    expect(u.cache_creation_input_tokens).toBe(0);
  });
});

describe("estimateCost (haiku, cache-aware)", () => {
  test("prices cache_read at 0.08/M, standard at 0.80/M, output at 4/M", () => {
    // 100k standard input + 88_665 cache_read + 25k output (the smoke-run shape)
    const usage = makeTokenUsage({
      input_tokens: 100_000 + 88_665,
      output_tokens: 25_000,
      cache_read_input_tokens: 88_665,
      cache_creation_input_tokens: 0,
    });
    const c = estimateCost("anthropic", "claude-haiku-4-5-20251001", usage);
    // standard = 100_000 -> *0.8/M; cache_read 88_665 -> *0.08/M; output 25_000 -> *4/M
    const expected = (100_000 * 0.8 + 88_665 * 0.08 + 25_000 * 4) / 1_000_000;
    expect(c.total_cost_usd!).toBeCloseTo(expected, 6);
    expect(c.pricing_status).toBe("estimated");
  });

  test("unknown model -> null cost", () => {
    const c = estimateCost("anthropic", "some-future-model", makeTokenUsage({ input_tokens: 10 }));
    expect(c.total_cost_usd).toBeNull();
    expect(c.pricing_status).toBe("unknown_model");
  });
});
