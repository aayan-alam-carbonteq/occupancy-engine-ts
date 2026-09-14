// X-091, revised design (spec §13): same-person resolution as a checklist of candidate PAIRS, judged by the
// model in one small call that runs alongside the heuristic workers. The engine lists every pair of people at
// the address who share a last name — candidates only, nothing is merged by name. The model gives a verdict per
// pair. Groups are the connected "same" verdicts, with structural checks on the model's own verdicts, and then go
// through validate_same_person_groups and reconcile_evidence_map. Measured offline on 24 addresses (variant p6):
// no wrong merges and 16 and 15 of 20 expected merges in two runs. Keep the wording and the checks as measured.
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { type IdentityCheckEntry, render_identity_check_lines } from "./same_person.ts";

export const SAME_VERDICTS = [
  "same_spelling",
  "nickname",
  "initials",
  "middle_name_added_or_left_out",
  "misspelling",
  "joint_row_names_this_person",
] as const;
export const ALL_VERDICTS = [...SAME_VERDICTS, "different_people", "not_sure"] as const;

/** A generous ceiling: measured calls take 3-7 s; a slower call must never hold up the report. */
export const SAME_PERSON_TIMEOUT_MS = 30_000;

export interface CandidatePair {
  pair: string;
  a: IdentityCheckEntry;
  b: IdentityCheckEntry;
}

function last_name(name: string): string {
  return name.replace(/&/g, " ").trim().split(/\s+/).at(-1) ?? "";
}

/** Every pair of PEOPLE (never owners) who share a last name, numbered Q1.. in last-name order. Candidates only. */
export function candidate_pairs(entries: readonly IdentityCheckEntry[]): CandidatePair[] {
  const blocks = new Map<string, IdentityCheckEntry[]>();
  for (const entry of entries) {
    if (entry.kind !== "person") {
      continue;
    }
    const key = last_name(entry.name);
    if (key === "") {
      continue;
    }
    blocks.set(key, [...(blocks.get(key) ?? []), entry]);
  }
  const pairs: CandidatePair[] = [];
  for (const [, block] of [...blocks].sort(([x], [y]) => x.localeCompare(y))) {
    for (let i = 0; i < block.length; i++) {
      for (let j = i + 1; j < block.length; j++) {
        pairs.push({ pair: `Q${pairs.length + 1}`, a: block[i]!, b: block[j]! });
      }
    }
  }
  return pairs;
}

export const PAIR_VERDICT_SYSTEM_PROMPT =
  "You reconcile person records for one property for an occupancy report. Records from different data sources " +
  "spell one person's name differently. Wrongly merging two real people hides an occupant, so you call a pair the " +
  "same only on clear evidence. Answer only with the submit_pair_verdicts tool.";

// Examples are deliberately generic: no name pair from the 24-address benchmark appears here.
const PAIR_VERDICT_RULES = [
  "For EVERY pair above, decide whether its two lines are the SAME human written differently. Most pairs are different people.",
  "Verdicts:",
  "- same_spelling: the same name repeated, perhaps with a credential added.",
  "- nickname: one first name is a nickname of the other (BILL / WILLIAM, PEGGY / MARGARET); the rest of the name agrees.",
  "- initials: one line uses initials for the other's names (E R / EDWARD R). A one-letter first name is an initial",
  "  (T / TERESA), never a different first name.",
  "- middle_name_added_or_left_out: same first and last name; one line has a middle name or initial the other lacks.",
  "- misspelling: the same first name misspelled (KATHERYN / KATHRYN); the rest of the name agrees.",
  '- joint_row_names_this_person: one of the two lines itself contains "&" (a joint row such as "JOHN & ANN DOE"),',
  "  and it names the other line's person. Never use it for two separate lines, even when they are a couple.",
  "- different_people: anything else. Different first names are different people (spouses, parents, children and",
  "  siblings share a last name: DENNIS / DENISE, FRANK / FRANCES). Two different middle initials, birth years with no",
  "  year in common, or JR / SR / II / III on only one line also mean different people.",
  "- not_sure: the evidence is too thin.",
  "For each pair, first write the two first names as they appear, then a short reason, then the verdict. Answer every pair.",
].join("\n");

export function render_pair_prompt(pairs: readonly CandidatePair[]): string {
  const body = pairs
    .map((p) => {
      const [a, b] = render_identity_check_lines([p.a, p.b]);
      return `${p.pair}: ${a}\n     ${b}`;
    })
    .join("\n");
  return `Pairs of people records at one property that share a last name (id, name, sources, birth years):\n${body}\n\n${PAIR_VERDICT_RULES}`;
}

const SubmitPairVerdictsArgs = z
  .object({
    verdicts: z.array(
      z.object({
        pair: z.string().describe("The pair id, e.g. Q1."),
        first_names: z.string().describe("The two first names exactly as written, e.g. 'THOMAS / TOM'."),
        reason: z.string().describe("A short, specific reason."),
        verdict: z.enum(ALL_VERDICTS),
      }),
    ),
  })
  .describe("Submit a verdict for every listed pair.");

export const submit_pair_verdicts = tool(async () => ({}), {
  name: "submit_pair_verdicts",
  description: "Submit a verdict for every listed pair.",
  schema: SubmitPairVerdictsArgs,
});

export interface PairVerdictGroups {
  /** Ready for validate_same_person_groups: P ids ascending, and a member's own name. */
  groups: { ids: string[]; name: string }[];
  /** Every pair the model called the same (including rejected joint labels), for measurement. */
  same_pairs: { ids: [string, string]; verdict: string; reason: string }[];
  /** Member names of groups dropped because the model called one of their pairs different_people. */
  contradictory: string[][];
  /** Lines the model linked as a joint row to more than one line. */
  ambiguous_joint_rows: string[];
  /** Pairs given a joint-row verdict although neither line is written as a joint row. */
  rejected_labels: string[];
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Groups from the model's verdicts: connected "same" pairs, minus inapplicable or ambiguous joint links and self-contradicting groups. */
export function groups_from_verdicts(pairs: readonly CandidatePair[], raw: unknown): PairVerdictGroups {
  const by_pair = new Map(pairs.map((p) => [p.pair, p]));
  const verdicts = is_record(raw) && Array.isArray(raw["verdicts"]) ? raw["verdicts"] : [];
  const same: { a: IdentityCheckEntry; b: IdentityCheckEntry; joint: boolean }[] = [];
  const different: { a: IdentityCheckEntry; b: IdentityCheckEntry }[] = [];
  const same_pairs: PairVerdictGroups["same_pairs"] = [];
  const rejected_labels: string[] = [];
  for (const item of verdicts) {
    if (!is_record(item)) {
      continue;
    }
    const p = by_pair.get(String(item["pair"] ?? "").trim().toUpperCase());
    const verdict = String(item["verdict"] ?? "");
    if (p === undefined) {
      continue;
    }
    if ((SAME_VERDICTS as readonly string[]).includes(verdict)) {
      same_pairs.push({ ids: [p.a.id, p.b.id], verdict, reason: String(item["reason"] ?? "") });
      const joint = verdict === "joint_row_names_this_person";
      if (joint && !p.a.name.includes("&") && !p.b.name.includes("&")) {
        rejected_labels.push(p.pair);
        continue;
      }
      same.push({ a: p.a, b: p.b, joint });
    } else if (verdict === "different_people") {
      different.push({ a: p.a, b: p.b });
    }
  }
  const joint_links = new Map<string, number>();
  for (const edge of same) {
    if (edge.joint) {
      for (const id of [edge.a.id, edge.b.id]) {
        joint_links.set(id, (joint_links.get(id) ?? 0) + 1);
      }
    }
  }
  const ambiguous = new Set([...joint_links].filter(([, n]) => n > 1).map(([id]) => id));
  const edges = same.filter((edge) => !edge.joint || (!ambiguous.has(edge.a.id) && !ambiguous.has(edge.b.id)));

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const up = parent.get(id) ?? id;
    if (up === id) {
      parent.set(id, id);
      return id;
    }
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  const entry_of = new Map<string, IdentityCheckEntry>();
  for (const edge of edges) {
    entry_of.set(edge.a.id, edge.a);
    entry_of.set(edge.b.id, edge.b);
    parent.set(find(edge.a.id), find(edge.b.id));
  }
  const components = new Map<string, IdentityCheckEntry[]>();
  for (const [id, entry] of entry_of) {
    const root = find(id);
    components.set(root, [...(components.get(root) ?? []), entry]);
  }
  const groups: PairVerdictGroups["groups"] = [];
  const contradictory: string[][] = [];
  for (const members of components.values()) {
    const ids = new Set(members.map((m) => m.id));
    if (different.some((d) => ids.has(d.a.id) && ids.has(d.b.id))) {
      contradictory.push(members.map((m) => m.name));
      continue;
    }
    const ordered = [...members].sort((x, y) => x.index - y.index);
    const plain = ordered.filter((m) => !m.name.includes("&"));
    const pool = plain.length > 0 ? plain : ordered;
    const named = pool.reduce((best, m) => (m.name.length > best.name.length ? m : best), pool[0]!);
    groups.push({ ids: ordered.map((m) => m.id), name: named.name });
  }
  return { groups, same_pairs, contradictory, ambiguous_joint_rows: [...ambiguous], rejected_labels };
}

export interface SamePersonResolution {
  /** A model call was made (or attempted). */
  called: boolean;
  pairs: number;
  /** The tool args as the model sent them, unvalidated. */
  raw: unknown;
  result: PairVerdictGroups;
  error: string | null;
}

/** One pair-verdict call. Never throws: any error, timeout or missing tool call yields no groups. */
export async function resolve_same_person(
  model: any,
  entries: readonly IdentityCheckEntry[],
  config: RunnableConfig | undefined,
  timeout_ms: number = SAME_PERSON_TIMEOUT_MS,
): Promise<SamePersonResolution> {
  const pairs = candidate_pairs(entries);
  const none = groups_from_verdicts(pairs, null);
  if (pairs.length === 0 || model === null || typeof model?.bindTools !== "function") {
    return { called: false, pairs: pairs.length, raw: null, result: none, error: null };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bound = model.bindTools([submit_pair_verdicts], { tool_choice: "any" });
    const call = Promise.resolve(
      bound.invoke(
        [new SystemMessage({ content: PAIR_VERDICT_SYSTEM_PROMPT }), new HumanMessage({ content: render_pair_prompt(pairs) })],
        config,
      ),
    );
    call.catch(() => {});
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`same-person call timed out after ${timeout_ms} ms`)), timeout_ms);
    });
    const response: any = await Promise.race([call, timeout]);
    const calls: any[] = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
    const raw = calls.find((c) => c?.name === "submit_pair_verdicts")?.args ?? null;
    return {
      called: true,
      pairs: pairs.length,
      raw,
      result: groups_from_verdicts(pairs, raw),
      error: raw === null ? "no submit_pair_verdicts tool call" : null,
    };
  } catch (err) {
    return { called: true, pairs: pairs.length, raw: null, result: none, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
