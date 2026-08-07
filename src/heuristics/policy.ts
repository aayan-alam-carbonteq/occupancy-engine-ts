// Source reliability weights, canonical/unranked context sources, and the
// deterministic source-token-by-path table used by weighted synthesis.

export const SUBSTANTIVE_SOURCES: readonly string[] = [
  "tax",
  "base",
  "loan",
  "drive",
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

// `drive` sits at 0.75, NOT the 1.15 it carried when we believed it was a DMV feed. The partner
// corpus has no DMV feed: a `drive` row is a payday-loan row that happens to carry a licence number
// — the same physical row the `loan` shape reads (source/manifest.py). Weighting it above `loan`
// counted one record as two independent sources. It stays ranked BELOW loan so a path carrying both
// applies loan, and the duplicate can only ever contribute less than the original.
//
// CAVEAT, measured rather than assumed (test/score_benchmark.test.ts): this weight change does NOT
// by itself make the duplicate contribute less than the original on the owner-elsewhere route.
// `owner_drive_elsewhere` and `owner_loan_elsewhere` are separate paths, each carrying one source,
// so the rank change never gets a choice to make; and `_owner_source_elsewhere` still scores drive
// at base 3 ("strong") against loan's base 1. One physical payday row therefore still contributes
// 3 × 0.75 = 2.25 on top of loan's 1 × 1.05. The weight change halves the excess; it does not
// remove it. Closing the rest means demoting drive's path STRENGTH in atomic_eval, which is a
// larger behaviour change than this one and is deliberately not bundled here.
export const SOURCE_RELIABILITY_WEIGHTS: Record<string, number> = {
  tax: 1.25,
  loan: 1.05,
  auto: 0.9,
  drive: 0.75,
  utility: 0.75,
};

export const CANONICAL_CONTEXT_SOURCES: readonly string[] = ["base"];
export const UNRANKED_CONTEXT_SOURCES: readonly string[] = ["trace"];
export const RANKED_SOURCE_ORDER: readonly string[] = ["tax", "loan", "auto", "drive", "utility"];

export const _SOURCE_ALIASES: Record<string, string> = {
  driver: "drive",
  driver_license: "drive",
  vehicle: "auto",
  registration: "auto",
};

export const _SOURCE_TOKEN_BY_PATH: ReadonlyArray<readonly [string, string]> = [
  ["drive", "drive"],
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
