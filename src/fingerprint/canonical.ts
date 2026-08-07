// The ONE canonicalizer in this repo. The query cache's identity and the fingerprint's hash must
// agree byte-for-byte, and a second copy is precisely the silent-drift hazard this feature exists
// to remove: a divergent canonicalizer shows up as a cache that simply never hits, or as two
// engines that fingerprint the same data differently. Extracted from src/agents/query_cache.ts.
import { createHash } from "node:crypto";

/**
 * JSON with every object's keys recursively sorted. Array ORDER is preserved on purpose — an array's
 * order is data. Callers that need order-insensitivity (the fingerprint's record list) impose a
 * total order on the array BEFORE calling this.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortValue(obj[key]);
  }
  return out;
}

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
