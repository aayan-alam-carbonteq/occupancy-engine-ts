// Same person, different spellings (X-091). The master adjudicator is shown a numbered Identity
// check list of the people and owners already in its context and may answer with groups of ids that
// are ONE human written differently. Everything here is pure: it renders that list, validates the
// answer by SHAPE only — the model decides who is the same person, this module never matches names —
// and merges the grouped entries of the report's people list.
import type { CaseEvidenceMap, PersonEvidenceSummary } from "./models.ts";

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

export interface SamePersonGroup {
  /** Ascending people_at_address positions; at least one. */
  person_indexes: number[];
  /** True when the model put a tax-owner id in the group. */
  includes_owner: boolean;
  /** The exact display name of the person member the model named. */
  name: string;
}

export interface SamePersonValidation {
  groups: SamePersonGroup[];
  dropped: number;
}

function _normalize_name(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Keep only groups whose SHAPE is sound: every id is on the list this call offered, at least two
 * distinct ids with at least one person, and a name that is one of its own person members' names.
 * A group repeated with the same ids counts once. A PERSON id claimed by more than one well-formed
 * group drops every group claiming it; an owner id may sit in several groups, because one tax-owner
 * line often names two people. Nothing here compares names against each other — who is the same
 * person is the model's call.
 */
export function validate_same_person_groups(
  raw: unknown,
  entries: readonly IdentityCheckEntry[],
): SamePersonValidation {
  if (raw === undefined || raw === null) {
    return { groups: [], dropped: 0 };
  }
  if (!Array.isArray(raw)) {
    return { groups: [], dropped: 1 };
  }
  const by_id = new Map(entries.map((entry) => [entry.id, entry] as const));
  let dropped = 0;
  const candidates: { ids: string[]; group: SamePersonGroup }[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const candidate = _candidate_group(item, by_id);
    if (candidate === null) {
      dropped += 1;
      continue;
    }
    const key = [...candidate.ids].sort().join(",");
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  }
  // Only PERSON ids conflict: a person in two groups would be merged twice. An owner id is a label
  // that never merges, and "SMITH, MICHAEL R; SMITH K L" is one O line for two people.
  const claims = new Map<string, number>();
  for (const candidate of candidates) {
    for (const id of candidate.ids) {
      if (by_id.get(id)?.kind === "person") {
        claims.set(id, (claims.get(id) ?? 0) + 1);
      }
    }
  }
  const groups: SamePersonGroup[] = [];
  for (const candidate of candidates) {
    if (candidate.ids.some((id) => (claims.get(id) ?? 0) > 1)) {
      dropped += 1;
    } else {
      groups.push(candidate.group);
    }
  }
  return { groups, dropped };
}

function _candidate_group(
  item: unknown,
  by_id: ReadonlyMap<string, IdentityCheckEntry>,
): { ids: string[]; group: SamePersonGroup } | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const raw_ids = record["ids"];
  const raw_name = record["name"];
  if (!Array.isArray(raw_ids) || typeof raw_name !== "string") {
    return null;
  }
  const ids = [...new Set(raw_ids.map((id) => (typeof id === "string" ? id.trim().toUpperCase() : "")))];
  if (ids.length < 2 || ids.some((id) => !by_id.has(id))) {
    return null;
  }
  const members = ids.map((id) => by_id.get(id)!);
  const people = members.filter((member) => member.kind === "person");
  const wanted = _normalize_name(raw_name);
  const named = people.find((member) => _normalize_name(member.name) === wanted);
  if (named === undefined) {
    return null;
  }
  return {
    ids,
    group: {
      person_indexes: people.map((member) => member.index).sort((a, b) => a - b),
      includes_owner: members.some((member) => member.kind === "owner"),
      name: named.name,
    },
  };
}

/**
 * The people list with each validated group collapsed into one entry, placed where its first member
 * was. `groups` MUST come from validate_same_person_groups over entries built from this same array:
 * that is what makes every index sorted, in range and in at most one group, and nothing here checks
 * it again. No groups → the SAME array. Ungrouped people keep their object identity; the input is
 * never mutated.
 */
export function merge_same_person_people(
  people: PersonEvidenceSummary[],
  groups: readonly SamePersonGroup[],
): PersonEvidenceSummary[] {
  if (groups.length === 0) {
    return people;
  }
  const group_of = new Map<number, SamePersonGroup>();
  for (const group of groups) {
    for (const index of group.person_indexes) {
      group_of.set(index, group);
    }
  }
  const merged: PersonEvidenceSummary[] = [];
  for (const [index, person] of people.entries()) {
    const group = group_of.get(index);
    if (group === undefined) {
      merged.push(person);
    } else if (group.person_indexes[0] === index) {
      merged.push(_merge_group(people, group));
    }
  }
  return merged;
}

function _merge_group(people: readonly PersonEvidenceSummary[], group: SamePersonGroup): PersonEvidenceSummary {
  const members = group.person_indexes
    .map((index) => people[index])
    .filter((person): person is PersonEvidenceSummary => person !== undefined);
  const named = members.find((member) => member.name === group.name) ?? members[0]!;
  const sources: string[] = [];
  for (const member of members) {
    for (const source of member.sources) {
      if (!sources.includes(source)) {
        sources.push(source);
      }
    }
  }
  const firsts = members.map((member) => member.first_seen).filter((value): value is string => typeof value === "string");
  const lasts = members.map((member) => member.last_seen).filter((value): value is string => typeof value === "string");
  const is_owner = group.includes_owner || members.some((member) => member.relationship_to_owner === "owner");
  return {
    name: group.name,
    relationship_to_owner: is_owner ? "owner" : named.relationship_to_owner,
    sources,
    summaries: members.flatMap((member) => member.summaries),
    first_seen: firsts.length > 0 ? firsts.reduce((a, b) => (b < a ? b : a)) : null,
    last_seen: lasts.length > 0 ? lasts.reduce((a, b) => (b > a ? b : a)) : null,
  };
}
