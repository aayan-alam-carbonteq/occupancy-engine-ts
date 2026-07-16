// Deterministic prose redaction: a SECURITY BACKSTOP that guarantees no internal data-surface
// identifier (GraphQL field/table names, DB column names) survives in the human-facing prose
// fields. It is NOT a beautifier — it substitutes identifier-shaped tokens for neutral human
// phrases (never deletes clauses), so it is coverage-neutral by construction. The primary
// readability lever is the prompt "writing register" (see prompts.ts, OE_PROSE_REGISTER); this
// module is the hard guarantee behind OE_PROSE_REDACT.
//
// Design note: only IDENTIFIER-SHAPED tokens are treated as sensitive — camelCase, snake_case, or
// an explicitly enumerated concatenated identifier (e.g. "ownername"). Bare dictionary words that
// happen to also be column names ("residential", "condo", "tax", "loan") are ordinary English and
// are left alone; rewriting them would mangle good prose and does not expose the data surface.

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
};

const CATCH_ALL_PHRASE = "an internal record field";

// camelCase (a lowercase run then an uppercase), e.g. utilityRecords, ownRent, normAddress.
const CAMEL_RE = /^[a-z]+[A-Z][A-Za-z0-9]*$/;
// snake_case, e.g. own_rent, dob_year, some_unknown_field.
const SNAKE_RE = /^[a-z0-9]+_[a-z0-9_]+$/;
// A word-like token (letters/digits/underscore). Punctuation and whitespace are boundaries.
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
// "identifier = value" / "identifier=value". Value stops before whitespace or sentence punctuation.
const ASSIGN_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s,;.)]+)/g;

function isIdentifierToken(token: string): boolean {
  if (token.toLowerCase() in SCHEMA_TOKEN_PHRASES) {
    return true;
  }
  return CAMEL_RE.test(token) || SNAKE_RE.test(token);
}

function phraseFor(token: string): string {
  const mapped = SCHEMA_TOKEN_PHRASES[token.toLowerCase()];
  return mapped ?? CATCH_ALL_PHRASE;
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
