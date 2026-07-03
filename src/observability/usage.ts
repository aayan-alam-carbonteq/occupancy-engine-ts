// Port of occupancy_engine/observability/usage.py.
import { makeTokenUsage, type TokenUsage } from "./models.ts";

type Dict = Record<string, unknown>;

export function extractUsage(message: unknown): TokenUsage {
  const responseMetadata = asDict((message as any)?.response_metadata);
  let usage = asDict((message as any)?.usage_metadata);
  if (isEmpty(usage)) {
    usage = asDict(responseMetadata["usage"]);
  }
  if (isEmpty(usage)) {
    usage = asDict(responseMetadata["token_usage"]);
  }
  const normalized = normalizeUsage(usage);
  normalized.raw_usage = usage;
  normalized.raw_response_metadata = responseMetadata;
  return normalized;
}

function normalizeUsage(usage: Dict): TokenUsage {
  const inputDetails = asDict(usage["input_token_details"] ?? usage["prompt_tokens_details"]);
  const outputDetails = asDict(usage["output_token_details"] ?? usage["completion_tokens_details"]);
  const inputTokens = int(usage["input_tokens"], usage["prompt_tokens"], usage["promptTokenCount"]);
  const outputTokens = int(usage["output_tokens"], usage["completion_tokens"], usage["candidatesTokenCount"]);
  const totalTokens = int(
    usage["total_tokens"],
    usage["totalTokenCount"],
    inputTokens || outputTokens ? inputTokens + outputTokens : 0,
  );
  const cacheRead = int(inputDetails["cache_read"], inputDetails["cached_tokens"], usage["cachedContentTokenCount"]);
  const cacheCreation = int(inputDetails["cache_creation"], usage["cache_creation_input_tokens"]);
  const reasoning = int(outputDetails["reasoning"], outputDetails["reasoning_tokens"], usage["thoughtsTokenCount"]);
  return makeTokenUsage({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    reasoning_output_tokens: reasoning,
    audio_input_tokens: int(inputDetails["audio"]),
    audio_output_tokens: int(outputDetails["audio"]),
  });
}

function asDict(value: unknown): Dict {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Dict) };
  }
  return {};
}

function isEmpty(d: Dict): boolean {
  return Object.keys(d).length === 0;
}

/** Return the first value coercible to an integer, else 0 (port of _int). */
function int(...values: unknown[]): number {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const n = Number(value);
    if (Number.isFinite(n)) {
      return Math.trunc(n);
    }
  }
  return 0;
}
