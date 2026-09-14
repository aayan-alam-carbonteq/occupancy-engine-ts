// test/e2e/adjudication_same_person.e2e.test.ts
import { describe, expect, test } from "bun:test";
import { DataHttpClient } from "../../src/agents/data_client.ts";
import { assessment_report_payload } from "../../src/agents/investigation_wire.ts";
import { AgentInvestigationRequestSchema, type OccupancyAgentAssessment } from "../../src/agents/models.ts";
import { AgentOrchestrator } from "../../src/agents/orchestrator.ts";
import { FixtureDataService } from "../support/fixture_data_service.ts";
import { people1104, resolve1104 } from "../support/fixtures.ts";
import { FakeSubagent } from "../support/subagents.ts";

function fixturePlan() {
  const payload = resolve1104() as any;
  return {
    resolve: payload,
    address_people: people1104(),
    address_records: { records_by_source: payload.records_by_source, unsupported_shapes: [] },
    schema: { tables: [], access_paths: [], caveats: [] },
  };
}

const VALID_ADJUDICATION = {
  raw_score: 0,
  verdict_band: "monitor",
  case_archetype: "non_rental_absentee_owner",
  reasoning_summary: "Owner mails elsewhere; no rental-use evidence at the subject.",
  why_not_higher: ["No unrelated-occupant evidence."],
  why_not_lower: ["Owner mailing address is not the subject."],
  records_read: {
    occupancy_signal: "non_owner_occupancy",
    nonowner_occupancy_strength: 6,
    reasoning: "The property-tax record mails the owner elsewhere and no record places them at the subject.",
    driving_heuristic_ids: ["owner_identity_and_mailing"],
  },
};

type IdentityLine = { id: string; line: string };

/**
 * A master model that answers from the Identity check lines in the prompt it was sent. `pick` and
 * `override` receive the 1-based call number, so a test can script a rejected attempt and a retry.
 */
class IdentityReadingModel {
  prompt = "";
  calls = 0;
  constructor(
    private readonly pick: (lines: IdentityLine[], call: number) => unknown,
    private readonly override: (call: number) => Record<string, unknown> = () => ({}),
  ) {}

  bindTools(_tools: unknown, _opts?: unknown): this {
    return this;
  }

  async invoke(messages: unknown[], _config?: unknown): Promise<unknown> {
    this.calls += 1;
    this.prompt = messages.map((message) => String((message as { content?: unknown }).content ?? "")).join("\n");
    const lines = [...this.prompt.matchAll(/^([PO]\d+) (.+)$/gm)].map((match) => ({ id: match[1]!, line: match[0] }));
    return {
      content: "",
      tool_calls: [
        {
          name: "submit_case_adjudication",
          args: { ...VALID_ADJUDICATION, ...this.override(this.calls), same_person: this.pick(lines, this.calls) },
          id: `call_submit_case_adjudication_${this.calls}`,
          type: "tool_call",
        },
      ],
      usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
  }
}

/** The id of the Identity check line for exactly this display name. */
function idOf(lines: IdentityLine[], name: string): string {
  const hit = lines.find((entry) => entry.line.startsWith(`${entry.id} ${name} |`));
  if (!hit) {
    throw new Error(`no Identity check line for ${name}`);
  }
  return hit.id;
}

async function investigate(
  model: IdentityReadingModel | null,
  overrides: Record<string, unknown> = {},
): Promise<OccupancyAgentAssessment> {
  const server = new FixtureDataService(fixturePlan());
  try {
    const orch = new AgentOrchestrator({
      data: new DataHttpClient(server.url),
      subagent: new FakeSubagent(),
      master_llm: model as any,
    });
    return await orch.investigate(
      AgentInvestigationRequestSchema.parse({ address: "1104 SPRING RUN RD", zip: "40514", ...overrides }),
    );
  } finally {
    server.close();
  }
}

const names = (a: OccupancyAgentAssessment) => a.resolved_address.evidence_map.people_at_address.map((p) => p.name);
const hintsText = (a: OccupancyAgentAssessment) =>
  a.resolved_address.evidence_map.nonowner_occupancy_hints.join("\n").toUpperCase();
const counter = (a: OccupancyAgentAssessment) =>
  (((a as any).metrics_events ?? []) as Array<Record<string, any>>).find(
    (event) => event["event_type"] === "counter" && event["name"] === "same_person_groups",
  );
// The 1104 fixture has no genuine name variants, so the pairs below are arbitrary: these tests pin
// the mechanics (the model's group is applied as given), not a judgement about who is who.
const KENNETH_AND_TAMIE = (lines: IdentityLine[]) => [
  { ids: [idOf(lines, "KENNETH S WORTHINGTON"), idOf(lines, "TAMIE WORTHINGTON")], name: "KENNETH S WORTHINGTON" },
];

describe("X-091 E2E: the adjudicator reconciles same-person names", () => {
  test("the adjudicator is shown the Identity check with ids, sources, birth years and the owner", async () => {
    const model = new IdentityReadingModel(() => []);
    await investigate(model);
    expect(model.prompt).toContain("\nIdentity check:\n");
    expect(model.prompt).toMatch(/^P\d+ SUSAN R PIERCE \| utility \| born 1955, 1956$/m);
    expect(model.prompt).toMatch(/^P\d+ JOSIAH CORRELL \| base, trace \| born 1983$/m);
    expect(model.prompt).toMatch(/^O1 CORRELL, REBECCA CHRISTINE; CORRELL, JOSIAH STEEL \| tax owner$/m);
    expect(model.prompt).toContain("- same_person (optional):");
  });

  test("a group merges the report's people list and its hints, and costs no retry", async () => {
    const baseline = await investigate(new IdentityReadingModel(() => []));
    const model = new IdentityReadingModel(KENNETH_AND_TAMIE);
    const merged = await investigate(model);

    expect(model.calls).toBe(1);
    expect(names(baseline)).toContain("TAMIE WORTHINGTON");
    expect(names(merged)).toHaveLength(names(baseline).length - 1);
    expect(names(merged)).not.toContain("TAMIE WORTHINGTON");
    expect(names(merged).filter((name) => name === "KENNETH S WORTHINGTON")).toHaveLength(1);
    expect(hintsText(baseline)).toContain("TAMIE WORTHINGTON");
    expect(hintsText(merged)).not.toContain("TAMIE WORTHINGTON");

    const { people_at_address: _p1, nonowner_occupancy_hints: _n1, owner_presence_hints: _o1, ...mergedRest } =
      merged.resolved_address.evidence_map;
    const { people_at_address: _p2, nonowner_occupancy_hints: _n2, owner_presence_hints: _o2, ...baselineRest } =
      baseline.resolved_address.evidence_map;
    expect(mergedRest).toEqual(baselineRest);
    // The rebuild keeps every other hint line: neither member is an owner, so the owner hints are
    // unchanged and the non-owner hints lose exactly TAMIE's line.
    const mergedMap = merged.resolved_address.evidence_map;
    const baselineMap = baseline.resolved_address.evidence_map;
    expect(mergedMap.owner_presence_hints).toEqual(baselineMap.owner_presence_hints);
    expect(mergedMap.nonowner_occupancy_hints).toEqual(
      baselineMap.nonowner_occupancy_hints.filter((hint) => !hint.toUpperCase().includes("TAMIE WORTHINGTON")),
    );
  });

  test("with prose redaction off, the report still carries the merge", async () => {
    const previous = process.env.OE_PROSE_REDACT;
    process.env.OE_PROSE_REDACT = "off";
    try {
      const a = await investigate(new IdentityReadingModel(KENNETH_AND_TAMIE));
      expect(names(a)).not.toContain("TAMIE WORTHINGTON");
      expect(names(a)).toContain("KENNETH S WORTHINGTON");
      expect(hintsText(a)).not.toContain("TAMIE WORTHINGTON");
    } finally {
      if (previous === undefined) delete process.env.OE_PROSE_REDACT;
      else process.env.OE_PROSE_REDACT = previous;
    }
  });

  test("neither the adjudication nor the wire payload carries same_person", async () => {
    const a = await investigate(new IdentityReadingModel(KENNETH_AND_TAMIE));
    expect("same_person" in a.adjudication).toBe(false);
    expect(JSON.stringify(assessment_report_payload(a))).not.toContain("same_person");
    expect(a.adjudication.verdict_band).toBe("monitor");
  });

  test("a person grouped with the owner id is labelled the owner, in the list and the hints", async () => {
    const baseline = await investigate(new IdentityReadingModel(() => []));
    const before = baseline.resolved_address.evidence_map;
    expect(before.people_at_address.find((p) => p.name === "JESSICA WHISMAN")?.relationship_to_owner).toBe("unrelated");
    expect(before.owner_presence_hints.join("\n")).not.toContain("JESSICA WHISMAN");
    expect(hintsText(baseline)).toContain("JESSICA WHISMAN");

    const a = await investigate(
      new IdentityReadingModel((lines) => [{ ids: [idOf(lines, "JESSICA WHISMAN"), "O1"], name: "JESSICA WHISMAN" }]),
    );
    const jessica = a.resolved_address.evidence_map.people_at_address.find((p) => p.name === "JESSICA WHISMAN");
    expect(jessica?.relationship_to_owner).toBe("owner");
    expect(a.resolved_address.evidence_map.owner_presence_hints.join("\n")).toContain("JESSICA WHISMAN");
    expect(hintsText(a)).not.toContain("JESSICA WHISMAN");
  });

  test("a malformed answer is dropped, spends no retry, and leaves the report as it was", async () => {
    const baseline = await investigate(new IdentityReadingModel(() => []));
    const model = new IdentityReadingModel(() => [{ ids: ["P1", "P999"], name: "NOBODY" }, "P1,P2"]);
    const a = await investigate(model);
    expect(model.calls).toBe(1);
    expect(a.resolved_address.evidence_map).toEqual(baseline.resolved_address.evidence_map);
    expect(counter(a)?.["metadata"]).toEqual({ applied: 0, dropped: 2 });
  });

  test("a non-array answer (a JSON string) is dropped and spends no retry", async () => {
    const baseline = await investigate(new IdentityReadingModel(() => []));
    const model = new IdentityReadingModel((lines) => JSON.stringify(KENNETH_AND_TAMIE(lines)));
    const a = await investigate(model);
    expect(model.calls).toBe(1);
    expect(a.resolved_address.evidence_map).toEqual(baseline.resolved_address.evidence_map);
    expect(counter(a)?.["metadata"]).toEqual({ applied: 0, dropped: 1 });
  });

  test("a rejected attempt's groups never apply; the accepted retry's do, counted once", async () => {
    const baseline = await investigate(new IdentityReadingModel(() => []));
    const model = new IdentityReadingModel(
      (lines, call) =>
        call === 1
          ? [{ ids: [idOf(lines, "JOHN H PIERCE"), idOf(lines, "SUSAN R PIERCE")], name: "JOHN H PIERCE" }]
          : KENNETH_AND_TAMIE(lines),
      (call) => (call === 1 ? { verdict_band: "not_a_band" } : {}),
    );
    const a = await investigate(model, { max_output_retries: 2 });

    expect(model.calls).toBe(2);
    expect(names(a)).toContain("SUSAN R PIERCE");
    expect(names(a)).not.toContain("TAMIE WORTHINGTON");
    expect(names(a)).toHaveLength(names(baseline).length - 1);
    const counters = (((a as any).metrics_events ?? []) as Array<Record<string, any>>).filter(
      (event) => event["event_type"] === "counter" && event["name"] === "same_person_groups",
    );
    expect(counters.map((event) => event["metadata"])).toEqual([{ applied: 1, dropped: 0 }]);
  });

  test("when every attempt is rejected, no group applies and no counter is recorded", async () => {
    const baseline = await investigate(new IdentityReadingModel(() => []));
    const model = new IdentityReadingModel(KENNETH_AND_TAMIE, () => ({ verdict_band: "not_a_band" }));
    const a = await investigate(model, { max_output_retries: 2 });

    expect(model.calls).toBe(3);
    expect(names(a)).toEqual(names(baseline));
    expect(hintsText(a)).toContain("TAMIE WORTHINGTON");
    expect(counter(a)).toBeUndefined();
  });

  test("the counter carries counts, and member names only under debug payloads", async () => {
    const plain = await investigate(new IdentityReadingModel(KENNETH_AND_TAMIE));
    expect(counter(plain)?.["metadata"]).toEqual({ applied: 1, dropped: 0 });
    const debug = await investigate(new IdentityReadingModel(KENNETH_AND_TAMIE), { metrics_debug_payloads: true });
    expect(counter(debug)?.["metadata"]).toEqual({
      applied: 1,
      dropped: 0,
      groups: [{ names: ["KENNETH S WORTHINGTON", "TAMIE WORTHINGTON"], includes_owner: false }],
    });
  });

  test("the debug counter marks a group that includes the owner", async () => {
    const a = await investigate(
      new IdentityReadingModel((lines) => [{ ids: [idOf(lines, "JESSICA WHISMAN"), "O1"], name: "JESSICA WHISMAN" }]),
      { metrics_debug_payloads: true },
    );
    expect(counter(a)?.["metadata"]).toEqual({
      applied: 1,
      dropped: 0,
      groups: [{ names: ["JESSICA WHISMAN"], includes_owner: true }],
    });
  });

  test("with no master model the adjudication falls back: no groups, no counter", async () => {
    const a = await investigate(null);
    expect(a.adjudication.records_read.occupancy_signal).toBe("no_signal");
    expect(counter(a)).toBeUndefined();
  });
});
