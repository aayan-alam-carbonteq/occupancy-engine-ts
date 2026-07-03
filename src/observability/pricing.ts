// Model pricing tables and cost estimation for token usage.
// NOTE: the openrouter_pricing live-fetch fallback is out of scope here (the benchmarks use native
// Anthropic pricing); unknown OpenRouter models return null cost when live rates are unavailable.
import { makeCostEstimate, type CostEstimate, type TokenUsage } from "./models.ts";

export interface ModelPricing {
  provider: string;
  modelPattern: RegExp;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  pricingVersion: string;
}

function pricing(
  provider: string,
  pattern: string,
  inputPerMillion: number,
  outputPerMillion: number,
  cacheReadPerMillion: number | null = null,
  cacheWritePerMillion: number | null = null,
): ModelPricing {
  return {
    provider,
    modelPattern: new RegExp(pattern),
    inputPerMillion,
    outputPerMillion,
    cacheReadPerMillion,
    cacheWritePerMillion,
    pricingVersion: "local-2026-06-22",
  };
}

// Conservative best-effort table. Unknown models remain measurable with null cost.
export const PRICING: readonly ModelPricing[] = [
  pricing("anthropic", "claude.*sonnet.*4", 3.0, 15.0, 0.3, 3.75),
  pricing("anthropic", "claude.*haiku", 0.8, 4.0, 0.08, 1.0),
  pricing("openai", "gpt-4\\.1-mini", 0.4, 1.6, 0.1),
  pricing("openai", "gpt-4\\.1", 2.0, 8.0, 0.5),
  pricing("gemini", "gemini.*flash", 0.3, 2.5, 0.075),
  pricing("gemini", "gemini.*pro", 1.25, 10.0, 0.31),
];

export function estimateCost(provider: string, model: string, usage: TokenUsage): CostEstimate {
  const p = matchPricing(provider, model);
  if (p === null) {
    return makeCostEstimate({ pricing_status: "unknown_model" });
  }
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;
  const standardInput = Math.max(0, usage.input_tokens - cacheRead - cacheWrite);
  let inputCost = (standardInput * p.inputPerMillion) / 1_000_000;
  inputCost += (cacheRead * (p.cacheReadPerMillion ?? p.inputPerMillion)) / 1_000_000;
  inputCost += (cacheWrite * (p.cacheWritePerMillion ?? p.inputPerMillion)) / 1_000_000;
  const outputCost = (usage.output_tokens * p.outputPerMillion) / 1_000_000;
  return makeCostEstimate({
    input_cost_usd: inputCost,
    output_cost_usd: outputCost,
    total_cost_usd: inputCost + outputCost,
    pricing_status: "estimated",
    pricing_version: p.pricingVersion,
  });
}

function matchPricing(provider: string, model: string): ModelPricing | null {
  const providerKey = provider.toLowerCase();
  const modelKey = model.toLowerCase();
  for (const item of PRICING) {
    if (item.provider !== providerKey) {
      continue;
    }
    if (item.modelPattern.test(modelKey)) {
      return item;
    }
  }
  return null;
}
