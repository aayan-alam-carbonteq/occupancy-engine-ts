// Address value normalization: the single `normalize_address_value` helper the heuristics need.
// Uppercases, strips punctuation, and applies a fixed set of street-suffix abbreviations. The
// batch CSV normalization machinery lives elsewhere and is intentionally not included here.

export interface NormalizeResult {
  readonly value: string;
  readonly changed: boolean;
}

// Applied in this order; each replacement runs on the output of the previous.
const REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["AVENUE", "AVE"],
  ["STREET", "ST"],
  ["DRIVE", "DR"],
  ["ROAD", "RD"],
  ["COURT", "CT"],
  ["LANE", "LN"],
  ["BOULEVARD", "BLVD"],
  ["PARKWAY", "PKWY"],
  ["PLACE", "PL"],
  ["CIRCLE", "CIR"],
  ["TERRACE", "TER"],
  ["HIGHWAY", "HWY"],
  ["APARTMENT", "APT"],
  ["SUITE", "STE"],
];

export function normalize_address_value(value: string): NormalizeResult {
  const original = (value || "").trim();
  if (!original) {
    return { value: "", changed: value !== "" };
  }

  let normalized = original.toUpperCase();
  // Collapse anything that isn't a letter, digit, whitespace, or # to a space.
  normalized = normalized.replace(/[^A-Z0-9\s#]/g, " ");
  for (const [source, target] of REPLACEMENTS) {
    // Whole-word replacement, all occurrences.
    normalized = normalized.replace(new RegExp(`\\b${source}\\b`, "g"), target);
  }
  // Abbreviate a standalone TRACE to TRCE only when it ends the string or precedes a unit (#/APT/STE).
  normalized = normalized.replace(/\bTRACE\b(?=(?:\s+#|\s+APT|\s+STE|$))/g, "TRCE");
  // Normalize a standalone PK/PRK to PARK under the same trailing-unit condition.
  normalized = normalized.replace(/\b(?:PK|PRK)\b(?=(?:\s+#|\s+APT|\s+STE|$))/g, "PARK");
  // Collapse runs of whitespace to a single space and trim.
  normalized = normalized.replace(/\s+/g, " ").trim();
  return { value: normalized, changed: normalized !== original };
}
