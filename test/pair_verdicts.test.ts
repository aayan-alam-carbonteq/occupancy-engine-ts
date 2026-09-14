// test/pair_verdicts.test.ts
import { describe, expect, test } from "bun:test";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import {
  ALL_VERDICTS,
  candidate_pairs,
  groups_from_verdicts,
  render_pair_prompt,
  resolve_same_person,
  submit_pair_verdicts,
} from "../src/agents/pair_verdicts.ts";
import { type IdentityCheckEntry, validate_same_person_groups } from "../src/agents/same_person.ts";

function person(index: number, name: string, extra: Partial<IdentityCheckEntry> = {}): IdentityCheckEntry {
  return { id: `P${index + 1}`, kind: "person", index, name, sources: ["trace"], birth_years: [], ...extra };
}
function owner(index: number, name: string): IdentityCheckEntry {
  return { id: `O${index + 1}`, kind: "owner", index, name, sources: [], birth_years: [] };
}
const ENTRIES: IdentityCheckEntry[] = [
  person(0, "TOM RICHARDSON"),
  person(1, "BRENT & JAMIE MUSIC"),
  person(2, "THOMAS RICHARDSON", { birth_years: ["1947"] }),
  person(3, "BRENT MUSIC"),
  person(4, "ANN SMITH"),
  owner(0, "SMITH, ANN"),
];

describe("candidate_pairs", () => {
  test("pairs only people who share a last name, joint rows by their last word, never owners, in last-name order", () => {
    expect(candidate_pairs(ENTRIES).map((p) => [p.pair, p.a.id, p.b.id])).toEqual([
      ["Q1", "P2", "P4"],
      ["Q2", "P1", "P3"],
    ]);
  });

  test("no two people share a last name: no pairs", () => {
    expect(candidate_pairs([person(0, "ANN SMITH"), person(1, "BOB JONES"), owner(0, "SMITH, ANN")])).toEqual([]);
  });
});

describe("render_pair_prompt", () => {
  const text = render_pair_prompt(candidate_pairs(ENTRIES));

  test("each pair shows both Identity check lines, and nothing else from the address", () => {
    expect(text).toContain("Q1: P2 BRENT & JAMIE MUSIC | trace\n     P4 BRENT MUSIC | trace");
    expect(text).toContain("Q2: P1 TOM RICHARDSON | trace\n     P3 THOMAS RICHARDSON | trace | born 1947");
    expect(text).not.toContain("ANN SMITH");
    expect(text).not.toContain("tax owner");
  });

  test("carries the measured rules", () => {
    for (const phrase of [
      "For EVERY pair above, decide whether its two lines are the SAME human written differently.",
      "A one-letter first name is an initial",
      "Never use it for two separate lines, even when they are a couple.",
      "first write the two first names as they appear, then a short reason, then the verdict.",
    ]) {
      expect([phrase, text.includes(phrase)]).toEqual([phrase, true]);
    }
    expect(text).not.toContain("household");
  });
});

describe("submit_pair_verdicts", () => {
  test("the schema the provider receives: one verdict per pair, fields in reasoning order, the closed verdict list", () => {
    const json = toJsonSchema(submit_pair_verdicts.schema) as any;
    const item = json.properties.verdicts.items;
    expect(Object.keys(item.properties)).toEqual(["pair", "first_names", "reason", "verdict"]);
    expect([...item.required].sort()).toEqual(["first_names", "pair", "reason", "verdict"]);
    expect(item.properties.verdict.enum).toEqual([...ALL_VERDICTS]);
    expect(json.required).toEqual(["verdicts"]);
  });
});

describe("groups_from_verdicts", () => {
  const pairs = candidate_pairs(ENTRIES);

  test("same verdicts become groups; the display name is the longest member that is not a joint row", () => {
    const out = groups_from_verdicts(pairs, {
      verdicts: [
        { pair: "Q1", first_names: "BRENT & JAMIE / BRENT", reason: "the row names BRENT", verdict: "joint_row_names_this_person" },
        { pair: " q2 ", first_names: "TOM / THOMAS", reason: "nickname", verdict: "nickname" },
      ],
    });
    expect(out.groups).toEqual([
      { ids: ["P2", "P4"], name: "BRENT MUSIC" },
      { ids: ["P1", "P3"], name: "THOMAS RICHARDSON" },
    ]);
    expect(validate_same_person_groups(out.groups, ENTRIES)).toEqual({
      groups: [
        { person_indexes: [1, 3], includes_owner: false, name: "BRENT MUSIC" },
        { person_indexes: [0, 2], includes_owner: false, name: "THOMAS RICHARDSON" },
      ],
      dropped: 0,
    });
  });

  test("a group containing a pair the model called different_people is dropped", () => {
    const tri = candidate_pairs([person(0, "X DOE"), person(1, "X DOE"), person(2, "Y DOE")]);
    const out = groups_from_verdicts(tri, {
      verdicts: [
        { pair: "Q1", verdict: "same_spelling" },
        { pair: "Q3", verdict: "nickname" },
        { pair: "Q2", verdict: "different_people" },
      ],
    });
    expect(out.groups).toEqual([]);
    expect(out.contradictory).toEqual([["X DOE", "X DOE", "Y DOE"]]);
  });

  test("a joint-row verdict on two lines that are not written as a joint row does not count", () => {
    const spouses = candidate_pairs([person(0, "MICHAEL SMITH"), person(1, "KIMBERLY SMITH")]);
    const out = groups_from_verdicts(spouses, { verdicts: [{ pair: "Q1", verdict: "joint_row_names_this_person" }] });
    expect(out.groups).toEqual([]);
    expect(out.rejected_labels).toEqual(["Q1"]);
  });

  test("a joint row the model links to more than one line counts for neither link", () => {
    const row = candidate_pairs([person(0, "A & B DOE"), person(1, "A DOE"), person(2, "B DOE")]);
    const out = groups_from_verdicts(row, {
      verdicts: [
        { pair: "Q1", verdict: "joint_row_names_this_person" },
        { pair: "Q2", verdict: "joint_row_names_this_person" },
        { pair: "Q3", verdict: "different_people" },
      ],
    });
    expect(out.groups).toEqual([]);
    expect(out.ambiguous_joint_rows).toEqual(["P1"]);
  });

  test("malformed answers never throw and never group", () => {
    for (const raw of [
      null,
      "Q2 nickname",
      { verdicts: "Q2" },
      { verdicts: [7, null, { pair: "Q9", verdict: "nickname" }, { pair: "Q2", verdict: "made_up" }] },
    ]) {
      expect(groups_from_verdicts(pairs, raw).groups).toEqual([]);
    }
  });
});

describe("resolve_same_person", () => {
  const answer = {
    tool_calls: [
      {
        name: "submit_pair_verdicts",
        args: { verdicts: [{ pair: "Q2", first_names: "TOM / THOMAS", reason: "nickname", verdict: "nickname" }] },
      },
    ],
  };

  test("no candidate pairs: no model call", async () => {
    let invoked = 0;
    const model = { bindTools: () => ({ invoke: async () => { invoked += 1; return answer; } }) };
    const r = await resolve_same_person(model, [person(0, "ANN SMITH"), person(1, "BOB JONES")], undefined);
    expect([r.called, r.pairs, invoked]).toEqual([false, 0, 0]);
    expect(r.result.groups).toEqual([]);
  });

  test("binds the one tool with a forced call, sends the pair prompt, and reads the verdicts", async () => {
    let bound: unknown[] = [];
    let messages: any[] = [];
    const model = {
      bindTools: (tools: unknown, opts: unknown) => {
        bound = [tools, opts];
        return { invoke: async (sent: any[]) => { messages = sent; return answer; } };
      },
    };
    const r = await resolve_same_person(model, ENTRIES, undefined);
    expect([r.called, r.pairs, r.error]).toEqual([true, 2, null]);
    expect(r.result.groups).toEqual([{ ids: ["P1", "P3"], name: "THOMAS RICHARDSON" }]);
    expect((bound[0] as any[]).map((t) => t.name)).toEqual(["submit_pair_verdicts"]);
    expect(bound[1]).toEqual({ tool_choice: "any" });
    expect(String(messages[1].content)).toContain("Q2: P1 TOM RICHARDSON");
  });

  test("a model error, a missing tool call, or a timeout yields no groups and never throws", async () => {
    const failing = { bindTools: () => ({ invoke: async () => { throw new Error("boom"); } }) };
    const silent = { bindTools: () => ({ invoke: async () => ({ content: "prose", tool_calls: [] }) }) };
    const hanging = { bindTools: () => ({ invoke: () => new Promise(() => {}) }) };
    const e = await resolve_same_person(failing, ENTRIES, undefined);
    const s = await resolve_same_person(silent, ENTRIES, undefined);
    const h = await resolve_same_person(hanging, ENTRIES, undefined, 20);
    expect([e.called, e.result.groups, e.error?.includes("boom")]).toEqual([true, [], true]);
    expect([s.called, s.result.groups, s.error]).toEqual([true, [], "no submit_pair_verdicts tool call"]);
    expect([h.called, h.result.groups, h.error?.includes("timed out")]).toEqual([true, [], true]);
  });

  test("no model: no call", async () => {
    const r = await resolve_same_person(null, ENTRIES, undefined);
    expect([r.called, r.result.groups]).toEqual([false, []]);
  });
});
