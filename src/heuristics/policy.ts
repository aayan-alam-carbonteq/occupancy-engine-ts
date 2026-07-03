// Port of occupancy_engine/heuristics/policy.py.
// Source reliability weights, canonical/unranked context sources, and the
// deterministic source-token-by-path table used by weighted synthesis.

export const SUBSTANTIVE_SOURCES: readonly string[] = [
  "tax",
  "base",
  "loan",
  "drive",
  "voter",
  "auto",
  "trace",
  "utility",
];

export const SOURCE_RELIABILITY_WEIGHTS: Record<string, number> = {
  tax: 1.25,
  drive: 1.15,
  loan: 1.05,
  auto: 0.9,
  voter: 0.75,
  utility: 0.75,
};

export const CANONICAL_CONTEXT_SOURCES: readonly string[] = ["base"];
export const UNRANKED_CONTEXT_SOURCES: readonly string[] = ["trace"];
export const RANKED_SOURCE_ORDER: readonly string[] = [
  "tax",
  "drive",
  "loan",
  "auto",
  "voter",
  "utility",
];

export const _SOURCE_ALIASES: Record<string, string> = {
  driver: "drive",
  driver_license: "drive",
  vehicle: "auto",
  registration: "auto",
};

export const _SOURCE_TOKEN_BY_PATH: ReadonlyArray<readonly [string, string]> = [
  ["drive", "drive"],
  ["voter", "voter"],
  ["loan", "loan"],
  ["auto", "auto"],
  ["utility", "utility"],
  ["trace", "trace"],
  ["tax", "tax"],
  ["base", "base"],
];

export function source_reliability_policy(): Record<string, unknown> {
  return {
    weights: { ...SOURCE_RELIABILITY_WEIGHTS },
    ranked_order: RANKED_SOURCE_ORDER,
    canonical_context_sources: CANONICAL_CONTEXT_SOURCES,
    unranked_context_sources: UNRANKED_CONTEXT_SOURCES,
  };
}
