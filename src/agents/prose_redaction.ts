// Deterministic prose redaction: a SECURITY BACKSTOP against internal data-surface identifiers
// (GraphQL field/type names, DB column names) surviving in the human-facing prose fields. It
// recognizes the enumerated schema identifiers plus any camelCase / snake_case identifier shape;
// bare dictionary words (Person, Property, residential, tax, loan) are left untouched so ordinary
// prose — including owner names like "McDonald" — is never mangled.
//
// Design note: only IDENTIFIER-SHAPED tokens are treated as sensitive — camelCase, snake_case, or
// an explicitly enumerated concatenated identifier (e.g. "ownername"). Bare dictionary words that
// happen to also be column names ("residential", "condo", "tax", "loan") are ordinary English and
// are left alone; rewriting them would mangle good prose and does not expose the data surface.

import {
  ABSENTEE_OWNER_CONTEXT,
  AMBIGUITY_RISK,
  CASE_ARCHETYPE_VALUES,
  CONFIDENCE,
  HEURISTIC_DIRECTION,
  HEURISTIC_STATUS,
  OWNER_PRESENCE_CONTEXT,
  RECOMMENDED_WEIGHT,
  RELATIONSHIP_TO_OWNER,
  RENTAL_MARKET_CONTEXT,
  RISK_LEVEL,
  SIGNAL_DIRECTNESS,
  SIGNAL_STRENGTH,
  VERDICT_BAND,
} from "./models.ts";

// Exact schema/column tokens → the human phrase they should read as. Keys are lowercased; matching
// lowercases the candidate token before lookup.
export const SCHEMA_TOKEN_PHRASES: Record<string, string> = {
  // record connections / types
  baserecords: "residence record",
  residents: "resident record",
  taxproperties: "property-tax record",
  taxrecords: "property-tax record",
  utilityrecords: "utility service record",
  tracerecords: "address-history record",
  autorecords: "vehicle-registration record",
  loanrecords: "mortgage/loan application record",
  driverecords: "driver's-license record",
  voterrecords: "voter-registration record",
  criminalrecords: "criminal record",
  // associations / query roots
  personassociations: "person association",
  propertyassociations: "property association",
  addressassociations: "address association",
  organizationassociations: "organization association",
  sourcerecord: "source record",
  sourcerecords: "source record",
  resolveaddress: "address lookup",
  searchaddresses: "address search",
  addressbytext: "address lookup",
  // columns
  own_rent: "tenure (owner or renter)",
  ownrent: "tenure (owner or renter)",
  ownername: "owner name",
  owneraddressline1: "owner mailing address",
  ownercity: "owner mailing city",
  ownerstate: "owner mailing state",
  ownerzipcode: "owner mailing ZIP",
  lendername: "lender name",
  totalliencount: "lien count",
  totallienbalance: "lien balance",
  ownerrescount: "owner property count",
  recordingdate: "recording date",
  foreclosecode: "foreclosure marker",
  forecloserecorddate: "foreclosure record date",
  rowid: "record reference",
  recordid: "record reference",
  // singular / PascalCase GraphQL type names (the model sees these via describe_schema)
  taxrecord: "property-tax record",
  baserecord: "residence record",
  driverecord: "driver's-license record",
  voterrecord: "voter-registration record",
  autorecord: "vehicle-registration record",
  loanrecord: "mortgage/loan application record",
  tracerecord: "address-history record",
  utilityrecord: "utility service record",
  personaddressassociation: "person-address association",
  propertyaddressassociation: "property-address association",
  propertypersonassociation: "property-person association",
  personorganizationassociation: "person-organization association",
  addressconnection: "address record set",
  personconnection: "person record set",
  sourcerecordconnection: "source record set",
  personaddressassociationconnection: "person-address association set",
  propertyaddressassociationconnection: "property-address association set",
  propertypersonassociationconnection: "property-person association set",
};

const CATCH_ALL_PHRASE = "an internal record field";

// The engine's own controlled OUTPUT vocabulary — verdict bands, case archetypes, and the
// status/interpretation enums. These are classification LABELS the pipeline emits (build_report
// embeds verdict_band/case_archetype verbatim), NOT underlying data-surface identifiers, so they
// must never be counted as leaks or rewritten. Sourced from the enum arrays so it stays in sync.
const CONTROLLED_VOCABULARY: ReadonlySet<string> = new Set(
  [
    ...HEURISTIC_STATUS,
    ...HEURISTIC_DIRECTION,
    ...CONFIDENCE,
    ...VERDICT_BAND,
    ...SIGNAL_STRENGTH,
    ...SIGNAL_DIRECTNESS,
    ...RELATIONSHIP_TO_OWNER,
    ...OWNER_PRESENCE_CONTEXT,
    ...RENTAL_MARKET_CONTEXT,
    ...ABSENTEE_OWNER_CONTEXT,
    ...RISK_LEVEL,
    ...AMBIGUITY_RISK,
    ...RECOMMENDED_WEIGHT,
    ...CASE_ARCHETYPE_VALUES,
  ].map((value) => value.toLowerCase()),
);

// camelCase (a lowercase run then an uppercase), e.g. utilityRecords, ownRent, normAddress.
const CAMEL_RE = /^[a-z]+[A-Z][A-Za-z0-9]*$/;
// snake_case, e.g. own_rent, dob_year, some_unknown_field. Any case — the underscore is the signal.
const SNAKE_RE = /^[A-Za-z0-9]+_[A-Za-z0-9_]+$/;
// A word-like token (letters/digits/underscore). Punctuation and whitespace are boundaries.
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
// "identifier = value" / "identifier=value". Value stops before whitespace or sentence punctuation.
const ASSIGN_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s,;.)]+)/g;

// Object.prototype member names (constructor, toString, hasOwnProperty, valueOf, …). Several are
// camelCase-shaped (toString, hasOwnProperty) and would otherwise trip CAMEL_RE; "constructor"
// additionally resolves through the prototype chain. They are ordinary English in prose ("the
// original constructor", "the toString output"), never data-surface leaks — exclude them outright.
const PROTOTYPE_MEMBERS = new Set(Object.getOwnPropertyNames(Object.prototype));

function isIdentifierToken(token: string): boolean {
  if (PROTOTYPE_MEMBERS.has(token)) {
    return false;
  }
  const lower = token.toLowerCase();
  if (CONTROLLED_VOCABULARY.has(lower)) {
    return false;
  }
  if (Object.hasOwn(SCHEMA_TOKEN_PHRASES, lower)) {
    return true;
  }
  return CAMEL_RE.test(token) || SNAKE_RE.test(token);
}

function phraseFor(token: string): string {
  const key = token.toLowerCase();
  return Object.hasOwn(SCHEMA_TOKEN_PHRASES, key) ? SCHEMA_TOKEN_PHRASES[key]! : CATCH_ALL_PHRASE;
}

/** Distinct identifier-shaped tokens still present in `text` (first-seen order, case-insensitive). */
export function detect_leaks(text: string): string[] {
  if (!text) {
    return [];
  }
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    const key = token.toLowerCase();
    if (isIdentifierToken(token) && !seen.has(key)) {
      seen.add(key);
      found.push(token);
    }
  }
  return found;
}

/**
 * Replace every internal identifier in `text` with a neutral human phrase. Two passes:
 *  1. Collapse `identifier = value` to the identifier's phrase (dropping the raw value).
 *  2. Replace any remaining standalone identifier token with its phrase.
 * Non-identifier words are left exactly as-is.
 */
export function redact_prose(text: string): string {
  if (!text) {
    return text;
  }
  const afterAssign = text.replace(ASSIGN_RE, (whole, ident: string) =>
    isIdentifierToken(ident) ? phraseFor(ident) : whole,
  );
  return afterAssign.replace(TOKEN_RE, (token) =>
    isIdentifierToken(token) ? phraseFor(token) : token,
  );
}

// Gated so nothing changes until explicitly enabled (mirrors OE_SYNTH_AUGMENT / OE_PROMPT_CACHE).
const _REDACT_ENABLED = ["1", "true", "yes", "on"].includes(
  (process.env.OE_PROSE_REDACT ?? "").trim().toLowerCase(),
);

export function proseRedactEnabled(): boolean {
  return _REDACT_ENABLED;
}

/** Total identifier leaks across all strings (used for the always-on prose_leak_count metric). */
export function count_prose_leaks(texts: Iterable<string>): number {
  let total = 0;
  for (const text of texts) {
    total += detect_leaks(text).length;
  }
  return total;
}

// Structural shapes — kept local so this module needs no dependency on models.ts and stays
// trivially testable with plain objects. The generic <T extends ...> preserves the caller's full
// type (the orchestrator passes HeuristicAgentResult / CaseAdjudication and gets them back).
interface ResultProse {
  finding: string;
  caveats: string[];
  missing_evidence: string[];
}

interface AdjudicationProse {
  reasoning_summary: string;
  why_not_higher: string[];
  why_not_lower: string[];
  score_adjustments?: readonly { reason: string; [key: string]: unknown }[];
}

/** Return a copy with the human-facing prose fields redacted; all other fields are preserved. */
export function sanitize_result_prose<T extends ResultProse>(result: T): T {
  // `as T`: we only overwrite same-typed prose fields, so the object stays a valid T. The cast
  // avoids TS's generic-spread widening error without loosening the public signature.
  return {
    ...result,
    finding: redact_prose(result.finding),
    caveats: result.caveats.map(redact_prose),
    missing_evidence: result.missing_evidence.map(redact_prose),
  } as T;
}

/** Return a copy with the adjudicator's prose fields redacted; all other fields are preserved. */
export function sanitize_adjudication_prose<T extends AdjudicationProse>(adjudication: T): T {
  const out = {
    ...adjudication,
    reasoning_summary: redact_prose(adjudication.reasoning_summary),
    why_not_higher: adjudication.why_not_higher.map(redact_prose),
    why_not_lower: adjudication.why_not_lower.map(redact_prose),
  };
  if (!Array.isArray(adjudication.score_adjustments)) {
    return out as T;
  }
  return {
    ...out,
    score_adjustments: adjudication.score_adjustments.map((sa) => ({
      ...sa,
      reason: redact_prose(sa.reason),
    })),
  } as T;
}
