// test/adjudication_same_person.test.ts
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { describe, expect, test } from "bun:test";
import { CaseAdjudicationSchema } from "../src/agents/models.ts";
import { split_same_person, submit_case_adjudication } from "../src/agents/orchestrator.ts";

const ADJUDICATION = {
  raw_score: 4,
  verdict_band: "review",
  case_archetype: "mixed_evidence",
  score_adjustments: [],
  reasoning_summary: "s",
  why_not_higher: [],
  why_not_lower: [],
  records_read: {
    occupancy_signal: "conflicting",
    nonowner_occupancy_strength: 5,
    reasoning: "r",
    driving_heuristic_ids: [],
  },
};
const GROUPS = [{ ids: ["P3", "P4"], name: "THOMAS RICHARDSON" }];

describe("X-091 submit_case_adjudication: same_person", () => {
  const schema = submit_case_adjudication.schema as any;

  test("the tool offers same_person; CaseAdjudication does not carry it", () => {
    expect(Object.keys(schema.shape)).toContain("same_person");
    expect(Object.keys(CaseAdjudicationSchema.shape)).not.toContain("same_person");
  });

  test("same_person is optional on the tool and defaults to no groups", () => {
    expect(schema.parse(ADJUDICATION).same_person).toEqual([]);
    expect(schema.parse({ ...ADJUDICATION, same_person: GROUPS }).same_person).toEqual(GROUPS);
  });

  test("the JSON schema the provider receives: optional, described, two ids at least, a described name", () => {
    const json = toJsonSchema(submit_case_adjudication.schema) as any;
    const field = json.properties.same_person;
    expect(json.required).not.toContain("same_person");
    expect(field.description).toContain("Identity check");
    expect(field.items.properties.ids.minItems).toBe(2);
    expect(field.items.properties.name.description).toContain("without the id");
  });
});

describe("X-091 split_same_person", () => {
  test("lifts same_person off the args without touching the input", () => {
    const input = { ...ADJUDICATION, same_person: GROUPS };
    const { args, same_person } = split_same_person(input);
    expect(same_person).toBe(GROUPS);
    expect("same_person" in args).toBe(false);
    expect("same_person" in input).toBe(true);
  });

  test("the strict schema rejects the raw args and accepts the split ones — the reason for the lift", () => {
    const input = { ...ADJUDICATION, same_person: GROUPS };
    expect(CaseAdjudicationSchema.safeParse(input).success).toBe(false);
    expect(CaseAdjudicationSchema.safeParse(split_same_person(input).args).success).toBe(true);
  });

  test("args without same_person split into an equal copy and undefined", () => {
    const { args, same_person } = split_same_person(ADJUDICATION);
    expect(args).toEqual(ADJUDICATION);
    expect(same_person).toBeUndefined();
  });

  test("lifts same_person filed inside records_read, leaving records_read otherwise intact", () => {
    const input = { ...ADJUDICATION, records_read: { ...ADJUDICATION.records_read, same_person: GROUPS } };
    const { args, same_person } = split_same_person(input);
    expect(same_person).toBe(GROUPS);
    expect(args["records_read"]).toEqual(ADJUDICATION.records_read);
    expect("same_person" in input.records_read).toBe(true);
    expect(CaseAdjudicationSchema.safeParse(args).success).toBe(true);
  });

  test("a top-level same_person wins over one inside records_read, and both are removed", () => {
    const nested = [{ ids: ["P1", "P2"], name: "SOMEONE" }];
    const input = { ...ADJUDICATION, same_person: GROUPS, records_read: { ...ADJUDICATION.records_read, same_person: nested } };
    const { args, same_person } = split_same_person(input);
    expect(same_person).toBe(GROUPS);
    expect("same_person" in args).toBe(false);
    expect("same_person" in args["records_read"]).toBe(false);
  });
});
