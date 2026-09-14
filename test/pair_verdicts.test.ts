// test/pair_verdicts.test.ts
import { describe, expect, test } from "bun:test";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { RunnableLambda } from "@langchain/core/runnables";
import {
  ALL_VERDICTS,
  PAIR_VERDICT_SYSTEM_PROMPT,
  candidate_pairs,
  groups_from_verdicts,
  render_pair_prompt,
  resolve_same_person,
  submit_pair_verdicts,
} from "../src/agents/pair_verdicts.ts";
import { type IdentityCheckEntry, validate_same_person_groups } from "../src/agents/same_person.ts";

// The measured p6 prompt (files/x091-measurement-2026-09-11, FINDINGS.md). Changing either string requires a re-measure.
const SYSTEM_GOLDEN =
  "You reconcile person records for one property for an occupancy report. Records from different data sources " +
  "spell one person's name differently. Wrongly merging two real people hides an occupant, so you call a pair the " +
  "same only on clear evidence. Answer only with the submit_pair_verdicts tool.";
const USER_GOLDEN = [
  "Pairs of people records at one property that share a last name (id, name, sources, birth years):",
  "Q1: P2 BRENT & JAMIE MUSIC | trace",
  "     P4 BRENT MUSIC | trace",
  "Q2: P1 TOM RICHARDSON | trace",
  "     P3 THOMAS RICHARDSON | trace | born 1947",
  "",
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

  test("a last-name group that would pass the pair cap is left out whole; groups that fit still get pairs", () => {
    const doe = Array.from({ length: 7 }, (_, i) => person(i, `PERSON${i + 1} DOE`));
    const smith = [person(7, "ANN SMITH"), person(8, "ANNE SMITH")];
    expect(candidate_pairs([...doe, ...smith]).map((p) => [p.pair, p.a.id, p.b.id])).toEqual([["Q1", "P8", "P9"]]);
    const small = [
      person(0, "A DOE"),
      person(1, "B DOE"),
      person(2, "C DOE"),
      person(3, "ANN SMITH"),
      person(4, "ANNE SMITH"),
    ];
    expect(candidate_pairs(small, 3).map((p) => [p.pair, p.a.id, p.b.id])).toEqual([
      ["Q1", "P1", "P2"],
      ["Q2", "P1", "P3"],
      ["Q3", "P2", "P3"],
    ]);
  });

  test("owners are never offered, even when one shares a last name with a person", () => {
    const entries = [
      person(0, "TOM RICHARDSON"),
      person(1, "THOMAS RICHARDSON"),
      owner(0, "TOM RICHARDSON"),
      owner(1, "RICHARDSON, THOMAS"),
    ];
    expect(candidate_pairs(entries).map((p) => [p.pair, p.a.id, p.b.id])).toEqual([["Q1", "P1", "P2"]]);
  });

  test("names with no last word are never paired", () => {
    expect(candidate_pairs([person(0, ""), person(1, "  "), person(2, "&"), person(3, " & ")])).toEqual([]);
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

  test("the prompt is exactly the measured p6 prompt (changing it requires a re-measure)", () => {
    expect(PAIR_VERDICT_SYSTEM_PROMPT).toBe(SYSTEM_GOLDEN);
    expect(text).toBe(USER_GOLDEN);
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
        { pair: "Q3", verdict: "not_sure" },
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
      { verdicts: [{ pair: "Q2", verdict: ["nickname"] }] },
    ]) {
      expect(groups_from_verdicts(pairs, raw).groups).toEqual([]);
    }
  });

  test("any same link between a joint row and another line counts as a joint link, so a row linked twice merges nobody", () => {
    const music = candidate_pairs([person(0, "BRENT & JAMIE MUSIC"), person(1, "BRENT MUSIC"), person(2, "JAMIE MUSIC")]);
    const twice = groups_from_verdicts(music, {
      verdicts: [
        { pair: "Q1", verdict: "joint_row_names_this_person" },
        { pair: "Q2", verdict: "same_spelling" },
        { pair: "Q3", verdict: "not_sure" },
      ],
    });
    expect(twice.groups).toEqual([]);
    expect(twice.ambiguous_joint_rows).toEqual(["P1"]);
    const once = candidate_pairs([person(0, "BRENT & JAMIE MUSIC"), person(1, "BRENT MUSIC")]);
    expect(groups_from_verdicts(once, { verdicts: [{ pair: "Q1", verdict: "same_spelling" }] }).groups).toEqual([
      { ids: ["P1", "P2"], name: "BRENT MUSIC" },
    ]);
  });

  test("a group is dropped unless every pair of its members was answered with a listed verdict", () => {
    const tri = candidate_pairs([person(0, "ANN DOE"), person(1, "ANNE DOE"), person(2, "ANNIE DOE")]);
    const unanswered = groups_from_verdicts(tri, {
      verdicts: [
        { pair: "Q1", verdict: "nickname" },
        { pair: "Q3", verdict: "misspelling" },
      ],
    });
    expect(unanswered.groups).toEqual([]);
    expect(unanswered.incomplete).toEqual([["ANN DOE", "ANNE DOE", "ANNIE DOE"]]);
    const unlisted = groups_from_verdicts(tri, {
      verdicts: [
        { pair: "Q1", verdict: "nickname" },
        { pair: "Q2", verdict: "probably" },
        { pair: "Q3", verdict: "misspelling" },
      ],
    });
    expect(unlisted.groups).toEqual([]);
    const answered = groups_from_verdicts(tri, {
      verdicts: [
        { pair: "Q1", verdict: "nickname" },
        { pair: "Q2", verdict: "not_sure" },
        { pair: "Q3", verdict: "misspelling" },
      ],
    });
    expect(answered.groups).toEqual([{ ids: ["P1", "P2", "P3"], name: "ANNIE DOE" }]);
    expect(answered.incomplete).toEqual([]);
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

  test("the call gets the caller's config plus the timeout, and a call running past it is aborted", async () => {
    let seen: any = null;
    let aborted = false;
    const model = {
      bindTools: () =>
        RunnableLambda.from(async (_messages: unknown, config?: any) => {
          seen = config;
          config?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return await new Promise(() => {});
        }),
    };
    const r = await resolve_same_person(model, ENTRIES, { metadata: { phase: "same_person" } }, 30);
    await Bun.sleep(30);
    expect(seen?.metadata?.phase).toBe("same_person");
    expect(aborted).toBe(true);
    expect([r.called, r.result.groups]).toEqual([true, []]);
  });

  test("malformed entries never reject: no call, no groups, the error reported", async () => {
    let invoked = 0;
    const model = {
      bindTools: () => ({
        invoke: async () => {
          invoked += 1;
          return {};
        },
      }),
    };
    const r = await resolve_same_person(
      model,
      [person(0, "ANN DOE"), { ...person(1, "ANNE DOE"), name: undefined as any }],
      undefined,
    );
    expect([r.called, r.result.groups, invoked, typeof r.error]).toEqual([false, [], 0, "string"]);
  });

  test("an answered call leaves no timer running", async () => {
    const real_set = globalThis.setTimeout;
    const real_clear = globalThis.clearTimeout;
    const live = new Set<unknown>();
    globalThis.setTimeout = ((fn: any, ms?: number, ...rest: any[]) => {
      const id = real_set(fn, ms, ...rest);
      live.add(id);
      return id;
    }) as any;
    globalThis.clearTimeout = ((id: any) => {
      live.delete(id);
      real_clear(id);
    }) as any;
    const model = {
      bindTools: () => ({
        invoke: async () => ({ tool_calls: [{ name: "submit_pair_verdicts", args: { verdicts: [] } }] }),
      }),
    };
    try {
      await resolve_same_person(model, ENTRIES, undefined);
    } finally {
      globalThis.setTimeout = real_set;
      globalThis.clearTimeout = real_clear;
    }
    expect(live.size).toBe(0);
  });
});
