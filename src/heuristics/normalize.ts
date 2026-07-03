// Local port of the ONE function heuristics needs from
// occupancy_engine/data_tools/normalize_filtered_addresses.py: `normalize_address_value`.
// The rest of that Python module (argparse/CSV batch normalization machinery) is
// out of scope for heuristics and is intentionally NOT ported here.

export interface NormalizeResult {
  readonly value: string;
  readonly changed: boolean;
}

// Ordered to match the Python `replacements` dict insertion order (dicts preserve
// insertion order in CPython 3.7+, and re.sub is applied in that order).
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
  // Python: original = str(value or "").strip()
  const original = (value || "").trim();
  if (!original) {
    // Python: NormalizeResult(value="", changed=value != "")
    return { value: "", changed: value !== "" };
  }

  let normalized = original.toUpperCase();
  // re.sub(r"[^A-Z0-9\s#]", " ", normalized)
  normalized = normalized.replace(/[^A-Z0-9\s#]/g, " ");
  for (const [source, target] of REPLACEMENTS) {
    // re.sub(rf"\b{source}\b", target, normalized) — global (all occurrences).
    normalized = normalized.replace(new RegExp(`\\b${source}\\b`, "g"), target);
  }
  // re.sub(r"\bTRACE\b(?=(?:\s+#|\s+APT|\s+STE|$))", "TRCE", normalized)
  normalized = normalized.replace(/\bTRACE\b(?=(?:\s+#|\s+APT|\s+STE|$))/g, "TRCE");
  // re.sub(r"\b(?:PK|PRK)\b(?=(?:\s+#|\s+APT|\s+STE|$))", "PARK", normalized)
  normalized = normalized.replace(/\b(?:PK|PRK)\b(?=(?:\s+#|\s+APT|\s+STE|$))/g, "PARK");
  // re.sub(r"\s+", " ", normalized).strip()
  normalized = normalized.replace(/\s+/g, " ").trim();
  return { value: normalized, changed: normalized !== original };
}
