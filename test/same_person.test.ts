// test/same_person.test.ts
import { describe, expect, test } from "bun:test";
import { type CaseEvidenceMap, CaseEvidenceMapSchema } from "../src/agents/models.ts";
import {
  birth_years_from_summaries,
  type IdentityCheckEntry,
  identity_check_entries,
  render_identity_check_lines,
  validate_same_person_groups,
} from "../src/agents/same_person.ts";

/** The 1105 Clovelly Ct shape from the saved runs: the model saw TOM and THOMAS as two people. */
function clovellyMap(): CaseEvidenceMap {
  return CaseEvidenceMapSchema.parse({
    normalized_address: "1105 CLOVELLY CT",
    owner_summaries: [
      {
        owner_name: "FURRY, CATHERINE DIANE; FURRY, CATHERINE D",
        mailing_address: "1105 CLOVELLY CT LEXINGTON KY 40517",
        mailing_matches_subject: true,
        summaries: ["owner=FURRY, CATHERINE DIANE; residential=True"],
      },
    ],
    people_at_address: [
      {
        name: "BRENT & JAMIE MUSIC",
        relationship_to_owner: "unrelated",
        sources: ["trace"],
        summaries: ["trace; address=1105 CLOVELLY CT; zip=40517"],
      },
      {
        name: "BRENT MUSIC",
        relationship_to_owner: "unrelated",
        sources: ["trace", "utility"],
        summaries: ["trace", "utility; address=1105 CLOVELLY CT; zip=40517; dob=19560901"],
        first_seen: "200103",
        last_seen: "202006",
      },
      {
        name: "THOMAS RICHARDSON",
        relationship_to_owner: "unrelated",
        sources: ["trace", "utility"],
        summaries: ["utility; dob=19470101", "trace; dob_year=1947"],
        first_seen: "199804",
        last_seen: "202503",
      },
      {
        name: "TOM RICHARDSON",
        relationship_to_owner: "unrelated",
        sources: ["trace"],
        summaries: ["trace; address=1105 CLOVELLY CT"],
        first_seen: "199611",
        last_seen: null,
      },
      {
        name: "CATHERINE FURRY",
        relationship_to_owner: "owner",
        sources: ["base", "tax", "trace"],
        summaries: ["base", "tax", "trace"],
      },
    ],
  });
}

describe("birth_years_from_summaries", () => {
  test("reads utility dob (YYYYMMDD) and trace dob_year, distinct and ascending", () => {
    expect(
      birth_years_from_summaries([
        "utility; address=1 MAIN ST; dob=19560401",
        "utility; dob=19550901",
        "trace; dob_year=1955",
      ]),
    ).toEqual(["1955", "1956"]);
  });

  test("never reads a vehicle year, an empty field, or a non-year", () => {
    expect(
      birth_years_from_summaries(["auto; year=2014; make=FORD", "trace; dob_year=", "utility; dob=00000000", "base"]),
    ).toEqual([]);
  });
});

describe("identity_check_entries", () => {
  test("numbers people P1.. then owners O1.., in list order, with sources and birth years", () => {
    const entries = identity_check_entries(clovellyMap());
    expect(entries.map((e) => [e.id, e.kind, e.index, e.name])).toEqual([
      ["P1", "person", 0, "BRENT & JAMIE MUSIC"],
      ["P2", "person", 1, "BRENT MUSIC"],
      ["P3", "person", 2, "THOMAS RICHARDSON"],
      ["P4", "person", 3, "TOM RICHARDSON"],
      ["P5", "person", 4, "CATHERINE FURRY"],
      ["O1", "owner", 0, "FURRY, CATHERINE DIANE; FURRY, CATHERINE D"],
    ]);
    expect(entries[1]!.sources).toEqual(["trace", "utility"]);
    expect(entries[1]!.birth_years).toEqual(["1956"]);
    expect(entries[2]!.birth_years).toEqual(["1947"]);
    expect(entries[5]!.birth_years).toEqual([]);
  });

  test("offers nothing without a person, or with a lone person and no owner", () => {
    const map = clovellyMap();
    expect(identity_check_entries({ ...map, people_at_address: [] })).toEqual([]);
    expect(
      identity_check_entries({ ...map, people_at_address: map.people_at_address.slice(0, 1), owner_summaries: [] }),
    ).toEqual([]);
    expect(
      identity_check_entries({ ...map, people_at_address: map.people_at_address.slice(0, 1) }).map((e) => e.id),
    ).toEqual(["P1", "O1"]);
  });
});

describe("render_identity_check_lines", () => {
  test("one line per entry: id, name, sources, birth years; owners read tax owner", () => {
    expect(render_identity_check_lines(identity_check_entries(clovellyMap()))).toEqual([
      "P1 BRENT & JAMIE MUSIC | trace",
      "P2 BRENT MUSIC | trace, utility | born 1956",
      "P3 THOMAS RICHARDSON | trace, utility | born 1947",
      "P4 TOM RICHARDSON | trace",
      "P5 CATHERINE FURRY | base, tax, trace",
      "O1 FURRY, CATHERINE DIANE; FURRY, CATHERINE D | tax owner",
    ]);
  });

  test("no entries renders no lines", () => {
    expect(render_identity_check_lines([])).toEqual([]);
  });
});

describe("validate_same_person_groups", () => {
  const entries = () => identity_check_entries(clovellyMap());

  test("keeps a well-formed group: ascending positions and the member's exact display name", () => {
    expect(validate_same_person_groups([{ ids: ["P4", "P3"], name: "THOMAS RICHARDSON" }], entries())).toEqual({
      groups: [{ person_indexes: [2, 3], includes_owner: false, name: "THOMAS RICHARDSON" }],
      dropped: 0,
    });
  });

  test("ids and name match regardless of case and spacing; the stored name is the member's own", () => {
    const out = validate_same_person_groups([{ ids: [" p3", "P4 "], name: "  thomas   richardson " }], entries());
    expect(out.groups).toEqual([{ person_indexes: [2, 3], includes_owner: false, name: "THOMAS RICHARDSON" }]);
  });

  test("a person grouped with the owner id is kept and marked", () => {
    expect(validate_same_person_groups([{ ids: ["P5", "O1"], name: "CATHERINE FURRY" }], entries()).groups).toEqual([
      { person_indexes: [4], includes_owner: true, name: "CATHERINE FURRY" },
    ]);
  });

  test("drops one group at a time: unknown id, one distinct id, name of no person member", () => {
    const out = validate_same_person_groups(
      [
        { ids: ["P3", "P99"], name: "THOMAS RICHARDSON" },
        { ids: ["P3", "p3"], name: "THOMAS RICHARDSON" },
        { ids: ["P1", "P2"], name: "THOMAS RICHARDSON" },
        { ids: ["P5", "O1"], name: "FURRY, CATHERINE DIANE; FURRY, CATHERINE D" },
        { ids: ["P1", "P2"], name: "BRENT MUSIC" },
      ],
      entries(),
    );
    expect(out.groups).toEqual([{ person_indexes: [0, 1], includes_owner: false, name: "BRENT MUSIC" }]);
    expect(out.dropped).toBe(4);
  });

  test("a group with no person member is dropped", () => {
    const withSecondOwner: IdentityCheckEntry[] = [
      ...entries(),
      { id: "O2", kind: "owner", index: 1, name: "SMITH K L", sources: [], birth_years: [] },
    ];
    expect(validate_same_person_groups([{ ids: ["O1", "O2"], name: "SMITH K L" }], withSecondOwner)).toEqual({
      groups: [],
      dropped: 1,
    });
  });

  test("an id claimed by two groups drops both; an independent group survives", () => {
    const out = validate_same_person_groups(
      [
        { ids: ["P3", "P4"], name: "THOMAS RICHARDSON" },
        { ids: ["P4", "P2"], name: "BRENT MUSIC" },
        { ids: ["P5", "O1"], name: "CATHERINE FURRY" },
      ],
      entries(),
    );
    expect(out.groups).toEqual([{ person_indexes: [4], includes_owner: true, name: "CATHERINE FURRY" }]);
    expect(out.dropped).toBe(2);
  });

  test("absent means no groups and nothing dropped; any other non-array or malformed item is dropped", () => {
    expect(validate_same_person_groups(undefined, entries())).toEqual({ groups: [], dropped: 0 });
    expect(validate_same_person_groups(null, entries())).toEqual({ groups: [], dropped: 0 });
    expect(validate_same_person_groups("P3,P4", entries())).toEqual({ groups: [], dropped: 1 });
    expect(
      validate_same_person_groups(
        [["P3", "P4"], { ids: "P3,P4", name: "THOMAS RICHARDSON" }, { ids: ["P3", "P4"] }, 7],
        entries(),
      ),
    ).toEqual({ groups: [], dropped: 4 });
  });

  test("with no Identity check offered, every id is unknown", () => {
    expect(validate_same_person_groups([{ ids: ["P3", "P4"], name: "THOMAS RICHARDSON" }], [])).toEqual({
      groups: [],
      dropped: 1,
    });
  });
});
