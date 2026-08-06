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

// Injected per-run via --evidence-file and exposed only to the packets that name them. Kept here,
// beside SUBSTANTIVE_SOURCES, so the "deliberately not substantive" relationship is visible in one
// file instead of being an invariant split across two.
export const EXTERNAL_EVIDENCE_SOURCES = ["str_scan", "property_facts"] as const;

export const EXTERNAL_EVIDENCE_NOTE =
  "External evidence (STR scan results, property listing facts) is injected per-run via " +
  "--evidence-file and is absent by default: with no payload the engine reasons only from " +
  "the public-records graph, which is the benchmarking configuration. When present it is " +
  "exposed only to packets naming these sources in input_sources, and is never counted in " +
  "SUBSTANTIVE_SOURCES, source reliability weights, or deterministic synthesis.";

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
