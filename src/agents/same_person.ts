// Same person, different spellings (X-091). The master adjudicator is shown a numbered Identity
// check list of the people and owners already in its context and may answer with groups of ids that
// are ONE human written differently. Everything here is pure: it renders that list, validates the
// answer by SHAPE only — the model decides who is the same person, this module never matches names —
// and merges the grouped entries of the report's people list.
import type { CaseEvidenceMap } from "./models.ts";

export interface IdentityCheckEntry {
  /** "P1".."Pn" over people_at_address, then "O1".."On" over owner_summaries, in list order. */
  id: string;
  kind: "person" | "owner";
  /** Position in people_at_address (person) or owner_summaries (owner). */
  index: number;
  name: string;
  sources: string[];
  birth_years: string[];
}

// `dob` is utility's YYYYMMDD, `dob_year` is trace's four digits. `year` is a VEHICLE year and must
// never be read as a birth year, which is why the keys are an exact allowlist.
const BIRTH_YEAR_KEYS: ReadonlySet<string> = new Set(["dob", "dob_year"]);
const BIRTH_YEAR_RE = /^((?:19|20)\d{2})/;

/** Distinct birth years, ascending, from a person's "source; key=value; …" summary bit-strings. */
export function birth_years_from_summaries(summaries: readonly string[]): string[] {
  const years = new Set<string>();
  for (const summary of summaries) {
    for (const part of summary.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1 || !BIRTH_YEAR_KEYS.has(part.slice(0, eq).trim())) {
        continue;
      }
      const match = BIRTH_YEAR_RE.exec(part.slice(eq + 1).trim());
      if (match) {
        years.add(match[1]!);
      }
    }
  }
  return [...years].sort();
}

/**
 * The entries the adjudicator is offered, built from the GROUNDING copy of the evidence map. Empty
 * unless there is at least one person and something to group them with (a second person or an
 * owner) — so an adjudication with nothing to reconcile keeps its prompt byte-identical.
 */
export function identity_check_entries(
  evidence_map: Pick<CaseEvidenceMap, "people_at_address" | "owner_summaries">,
): IdentityCheckEntry[] {
  const people: IdentityCheckEntry[] = evidence_map.people_at_address.map((person, index) => ({
    id: `P${index + 1}`,
    kind: "person",
    index,
    name: person.name,
    sources: [...person.sources],
    birth_years: birth_years_from_summaries(person.summaries),
  }));
  const owners: IdentityCheckEntry[] = evidence_map.owner_summaries.map((owner, index) => ({
    id: `O${index + 1}`,
    kind: "owner",
    index,
    name: owner.owner_name,
    sources: [],
    birth_years: [],
  }));
  if (people.length === 0 || people.length + owners.length < 2) {
    return [];
  }
  return [...people, ...owners];
}

/** "P2 BRENT MUSIC | trace, utility | born 1956" and "O1 FURRY, CATHERINE D | tax owner". */
export function render_identity_check_lines(entries: readonly IdentityCheckEntry[]): string[] {
  return entries.map((entry) => {
    if (entry.kind === "owner") {
      return `${entry.id} ${entry.name} | tax owner`;
    }
    const parts = [`${entry.id} ${entry.name}`, entry.sources.length > 0 ? entry.sources.join(", ") : "no source"];
    if (entry.birth_years.length > 0) {
      parts.push(`born ${entry.birth_years.join(", ")}`);
    }
    return parts.join(" | ");
  });
}
