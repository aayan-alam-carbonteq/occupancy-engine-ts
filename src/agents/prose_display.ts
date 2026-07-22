// Value-aware humanizer for the DETERMINISTIC evidence_map display strings. These are built by
// orchestrator (_owner_summaries / _people_at_address_summaries / _nonowner_occupancy_hints) as
// "key=value; key=value" bit-strings and are ALSO fed to prompts as grounding — so this module
// NEVER mutates in place: it maps to NEW strings for a display copy only (see orchestrator
// finalization). Unlike the scrubber it keeps meaning: "1 lien totaling $83,000", not "a lien field".
import { SOURCE_HUMAN_PHRASES } from "./prompts.ts";

const RELATIONSHIP_DISPLAY: Record<string, string> = {
  likely_family: "Likely a family member",
  unrelated: "Unrelated person",
  unknown: "Relationship unknown",
  owner: "The owner",
};

// own_rent / ownRent stored codes → plain tenure phrase.
const OWN_RENT_DISPLAY: Record<string, string> = {
  "0": "listed as a renter",
  "1": "listed as owner-occupant",
  o: "listed as owner-occupant",
  own: "listed as owner-occupant",
  r: "listed as a renter",
  rent: "listed as a renter",
  u: "tenure not stated",
  "": "tenure not stated",
};

/** Source code → capitalized human record name, e.g. "loan" → "Mortgage/loan application record". */
function sourcePhrase(code: string): string {
  const phrase = SOURCE_HUMAN_PHRASES[code] ?? "record";
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** "in <phrase>, <phrase>" for a comma/space-separated list of source codes. */
function sourceListPhrase(codes: string): string {
  const parts = codes
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((c) => `${SOURCE_HUMAN_PHRASES[c] ?? "record"}s`);
  return parts.join(", ");
}

/** "DONALD R CAIN" → "Donald R Cain"; "WINKFIELD, JERAHMY S" → "Winkfield, Jerahmy S". */
function titleCaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a "lead; key=value; key=value" bit-string. First bit may be a bare source code. */
function parseBits(raw: string): { lead: string | null; fields: Map<string, string> } {
  const parts = raw.split(";").map((p) => p.trim()).filter(Boolean);
  const fields = new Map<string, string>();
  let lead: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      if (lead === null) lead = part;
      continue;
    }
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return { lead, fields };
}

/** Format "83000.0" → "83,000" (drop cents, thousands separators). */
function formatMoney(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return Math.round(n).toLocaleString("en-US");
}

/** A person-at-address summary: "loan; own_rent=0; address=…" → "Mortgage/loan application record; listed as a renter". */
export function humanizePersonSummary(raw: string): string {
  const { lead, fields } = parseBits(raw);
  const out: string[] = [];
  if (lead) out.push(sourcePhrase(lead));
  const tenure = fields.get("own_rent") ?? fields.get("ownRent");
  if (tenure !== undefined) {
    out.push(OWN_RENT_DISPLAY[tenure.toLowerCase()] ?? "tenure recorded");
  }
  // address / zip / dob / dob_year / year / make / model are dropped (redundant or PII-ish).
  return out.join("; ");
}

/** An owner summary: "owner=…; residential=True; totalliencount=1; totallienbalance=83000.0; …". */
export function humanizeOwnerSummary(raw: string): string {
  const { fields } = parseBits(raw);
  const out: string[] = [];
  const owner = fields.get("owner");
  if (owner) out.push(`Owner ${titleCaseName(owner)}`);
  const mailing = fields.get("mailing");
  if (mailing) out.push(`mailing address ${mailing}`);
  if ((fields.get("residential") ?? "").toLowerCase() === "true") out.push("residential property");
  if ((fields.get("condo") ?? "").toLowerCase() === "true") out.push("condominium");
  const lender = fields.get("lendername");
  if (lender && lender.toUpperCase() !== "NOT AVAILABLE") out.push(`lender ${lender}`);
  const lienCount = fields.get("totalliencount");
  if (lienCount && Number(lienCount) > 0) {
    const n = Number(lienCount);
    const balance = fields.get("totallienbalance");
    const balPart = balance ? ` totaling $${formatMoney(balance)}` : "";
    out.push(`${n} lien${n === 1 ? "" : "s"}${balPart}`);
  }
  const resCount = fields.get("ownerrescount");
  if (resCount) {
    const n = Number(resCount);
    out.push(`owner linked to ${n} propert${n === 1 ? "y" : "ies"}`);
  }
  const recorded = fields.get("recordingdate");
  if (recorded) out.push(`recorded ${recorded}`);
  return out.join("; ");
}

const NONOWNER_HINT_RE = /^(\w+) person at address via ([^:]+):\s*(.+?)\.?$/;

/** A non-owner-occupancy hint: "likely_family person at address via trace: NAME." */
export function humanizeNonownerHint(raw: string): string {
  const m = NONOWNER_HINT_RE.exec(raw);
  if (!m) return raw;
  const [, rel, sources, name] = m;
  const relPhrase = RELATIONSHIP_DISPLAY[rel!] ?? rel!;
  return `${relPhrase}, in ${sourceListPhrase(sources!)}: ${titleCaseName(name!)}.`;
}
