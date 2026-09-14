// test/e2e/same_person_pairs.e2e.test.ts
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

/**
 * A master model that answers whichever tool it is bound with: submit_pair_verdicts from the pair lines in the
 * prompt it was sent (a verdict per pair from `verdicts`, different_people for the rest), and any other tool with
 * a valid adjudication, as the other E2E suites' fake model does.
 */
class PairAndAdjudicationModel {
  pair_prompt = "";
  pair_calls = 0;
  pair_config: any = null;
  adjudication_prompts: string[] = [];
  readonly events: string[] = [];
  constructor(
    private readonly verdicts: Record<string, string> = {},
    private readonly pair_behaviour: "answer" | "throw" | "silent" = "answer",
    private readonly pair_delay_ms = 0,
  ) {}

  bindTools(tools: Array<{ name?: string }>, _opts?: unknown) {
    const bound = tools.map((t) => t.name);
    return {
      invoke: async (messages: unknown[], config?: unknown) =>
        bound.includes("submit_pair_verdicts") ? await this.pairs(messages, config) : this.adjudicate(messages),
    };
  }

  async invoke(messages: unknown[], _config?: unknown) {
    return this.adjudicate(messages);
  }

  private async pairs(messages: unknown[], config: unknown) {
    this.pair_calls += 1;
    this.pair_config = config;
    this.events.push("pair:start");
    this.pair_prompt = messages.map((m) => String((m as { content?: unknown }).content ?? "")).join("\n");
    if (this.pair_delay_ms > 0) {
      await Bun.sleep(this.pair_delay_ms);
    }
    this.events.push("pair:end");
    if (this.pair_behaviour === "throw") {
      throw new Error("provider unavailable");
    }
    if (this.pair_behaviour === "silent") {
      return { content: "no tool call", tool_calls: [] };
    }
    const ids = [...this.pair_prompt.matchAll(/^(Q\d+): /gm)].map((m) => m[1]!);
    return {
      content: "",
      tool_calls: [
        {
          name: "submit_pair_verdicts",
          args: {
            verdicts: ids.map((pair) => ({
              pair,
              first_names: "-",
              reason: "scripted verdict",
              verdict: this.verdicts[pair] ?? "different_people",
            })),
          },
          id: "call_submit_pair_verdicts",
          type: "tool_call",
        },
      ],
      usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
  }

  private adjudicate(messages: unknown[]) {
    this.adjudication_prompts.push(messages.map((m) => String((m as { content?: unknown }).content ?? "")).join("\n"));
    return {
      content: "",
      tool_calls: [
        {
          name: "submit_case_adjudication",
          args: { ...VALID_ADJUDICATION },
          id: `call_submit_case_adjudication_${this.adjudication_prompts.length}`,
          type: "tool_call",
        },
      ],
      usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
  }
}

/** A worker that logs when it starts and ends into the model's shared event list, so a test can see overlap. */
class TimedSubagent extends FakeSubagent {
  constructor(
    private readonly events: string[],
    private readonly delay_ms: number,
  ) {
    super();
  }

  override async run(agent_input: any, data: any) {
    this.events.push("worker:start");
    await Bun.sleep(this.delay_ms);
    this.events.push("worker:end");
    return super.run(agent_input, data);
  }
}

async function investigate(
  model: PairAndAdjudicationModel | null,
  overrides: Record<string, unknown> = {},
  subagent: FakeSubagent = new FakeSubagent(),
): Promise<OccupancyAgentAssessment> {
  const server = new FixtureDataService(fixturePlan());
  try {
    const orch = new AgentOrchestrator({
      data: new DataHttpClient(server.url),
      subagent,
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

const PLAIN_COUNTS = { pairs: 4, dropped: 0, contradictory: 0, incomplete: 0, ambiguous_joint_rows: 0, rejected_labels: 0 };

describe("X-091 E2E: same-person pair verdicts run alongside the workers and merge the report copy", () => {
  test("the pair call is sent only the address's same-surname pairs; the adjudicator's prompt has no trace of it", async () => {
    const model = new PairAndAdjudicationModel();
    await investigate(model);
    expect(model.pair_calls).toBe(1);
    expect(model.pair_prompt).toContain("Q1: P6 JOSIAH CORRELL | base, trace | born 1983\n     P9 REBECCA CORRELL | tax");
    expect(model.pair_prompt).toContain(
      "Q4: P7 KENNETH S WORTHINGTON | utility | born 1965\n     P11 TAMIE WORTHINGTON | utility | born 1968, 1970",
    );
    expect(model.pair_prompt).not.toContain("Q5:");
    expect(model.pair_prompt).not.toContain("JESSICA WHISMAN");
    expect(model.pair_prompt).not.toContain("tax owner");
    expect(model.adjudication_prompts.length).toBeGreaterThan(0);
    for (const prompt of model.adjudication_prompts) {
      expect(prompt).not.toContain("Identity check");
      expect(prompt).not.toContain("same_person");
      expect(prompt).not.toContain("Q1:");
    }
  });

  test("a same verdict merges the report's people list and hints; the adjudication and other fields stay as they were", async () => {
    const baseline = await investigate(new PairAndAdjudicationModel());
    const merged = await investigate(new PairAndAdjudicationModel({ Q4: "nickname" }));
    expect(names(baseline)).toContain("TAMIE WORTHINGTON");
    expect(names(merged)).toHaveLength(names(baseline).length - 1);
    expect(names(merged)).not.toContain("TAMIE WORTHINGTON");
    expect(names(merged).filter((name) => name === "KENNETH S WORTHINGTON")).toHaveLength(1);
    expect(hintsText(baseline)).toContain("TAMIE WORTHINGTON");
    expect(hintsText(merged)).not.toContain("TAMIE WORTHINGTON");
    expect(merged.adjudication).toEqual(baseline.adjudication);
    // Every evidence-map field other than the people list and the two hint lists is unchanged.
    const { people_at_address: _p1, nonowner_occupancy_hints: _n1, owner_presence_hints: _o1, ...mergedRest } =
      merged.resolved_address.evidence_map;
    const { people_at_address: _p2, nonowner_occupancy_hints: _n2, owner_presence_hints: _o2, ...baselineRest } =
      baseline.resolved_address.evidence_map;
    expect(mergedRest).toEqual(baselineRest);
    expect(merged.resolved_address.evidence_map.owner_presence_hints).toEqual(
      baseline.resolved_address.evidence_map.owner_presence_hints,
    );
    expect(merged.resolved_address.evidence_map.nonowner_occupancy_hints).toEqual(
      baseline.resolved_address.evidence_map.nonowner_occupancy_hints.filter(
        (hint) => !hint.toUpperCase().includes("TAMIE WORTHINGTON"),
      ),
    );
  });

  test("the pair call runs alongside the heuristic workers", async () => {
    const model = new PairAndAdjudicationModel({}, "answer", 200);
    const a = await investigate(model, {}, new TimedSubagent(model.events, 50));
    const firstWorkerStart = model.events.indexOf("worker:start");
    expect(firstWorkerStart).toBeGreaterThan(-1);
    expect(model.events.indexOf("pair:start")).toBeLessThan(firstWorkerStart);
    expect(firstWorkerStart).toBeLessThan(model.events.indexOf("pair:end"));
    expect(a.adjudication.verdict_band).toBe("monitor");
  });

  test("a failed or silent pair call leaves the report exactly as with no merge, and the adjudication still runs", async () => {
    const baseline = await investigate(new PairAndAdjudicationModel());
    for (const behaviour of ["throw", "silent"] as const) {
      const a = await investigate(new PairAndAdjudicationModel({ Q4: "nickname" }, behaviour));
      expect(a.resolved_address.evidence_map).toEqual(baseline.resolved_address.evidence_map);
      expect(a.adjudication).toEqual(baseline.adjudication);
      expect(counter(a)?.["metadata"]).toEqual({ ...PLAIN_COUNTS, applied: 0, failed: true });
    }
  });

  test("the counter carries counts only; member names, verdicts and error text only under debug payloads", async () => {
    const plain = await investigate(new PairAndAdjudicationModel({ Q4: "nickname" }));
    expect(counter(plain)?.["metadata"]).toEqual({ ...PLAIN_COUNTS, applied: 1, failed: false });
    const debug = await investigate(new PairAndAdjudicationModel({ Q4: "nickname" }), { metrics_debug_payloads: true });
    const meta = counter(debug)?.["metadata"] as Record<string, any>;
    expect(meta["groups"]).toEqual([["KENNETH S WORTHINGTON", "TAMIE WORTHINGTON"]]);
    expect(meta["error"]).toBeNull();
    expect(meta["verdicts"].verdicts.find((v: any) => v.pair === "Q4").verdict).toBe("nickname");
  });

  test("the call is metered under its own same_person span and phase", async () => {
    const model = new PairAndAdjudicationModel();
    const a = await investigate(model);
    expect(model.pair_config?.metadata?.phase).toBe("same_person");
    expect(model.pair_config?.metadata?.agent_id).toBe("same_person");
    const events = ((a as any).metrics_events ?? []) as Array<Record<string, any>>;
    expect(events.some((e) => e["event_type"] === "span_end" && e["phase"] === "same_person")).toBe(true);
  });

  test("with no master model there is no pair call and no counter, and the people list is unmerged", async () => {
    const a = await investigate(null);
    expect(counter(a)).toBeUndefined();
    expect(names(a)).toContain("TAMIE WORTHINGTON");
    expect(names(a)).toContain("KENNETH S WORTHINGTON");
  });

  // Lead-directed adaptation (see report): `assessment_report_payload` keeps `metrics`/`agent_metrics`
  // (open, tenant-neutral telemetry maps — phase_counts, agent_counts), and a `same_person` phase/agent_id
  // legitimately shows up there as a count. It never reaches the UI: the backend's report DTO is closed
  // and excludes both fields. So this test asserts "same_person" is absent from the report EXCLUDING
  // those two telemetry maps, and that no member name or verdict text leaks even into telemetry.
  test("nothing of the pair call reaches the adjudication or the report payload; telemetry carries counts only", async () => {
    const a = await investigate(new PairAndAdjudicationModel({ Q4: "nickname" }));
    const { metrics, agent_metrics, ...report } = assessment_report_payload(a) as Record<string, unknown>;
    expect("same_person" in a.adjudication).toBe(false);
    const reportText = JSON.stringify(report);
    expect(reportText).not.toContain("same_person");
    expect(reportText).not.toContain("submit_pair_verdicts");
    const everything = JSON.stringify(assessment_report_payload(a));
    expect(everything).not.toContain("scripted verdict");
    expect(everything).not.toContain("nickname");
    expect(JSON.stringify({ metrics, agent_metrics })).not.toContain("TAMIE");
  });

  test("with prose redaction off, the report still carries the merge", async () => {
    const previous = process.env.OE_PROSE_REDACT;
    process.env.OE_PROSE_REDACT = "off";
    try {
      const a = await investigate(new PairAndAdjudicationModel({ Q4: "nickname" }));
      expect(names(a)).not.toContain("TAMIE WORTHINGTON");
      expect(names(a)).toContain("KENNETH S WORTHINGTON");
      expect(hintsText(a)).not.toContain("TAMIE WORTHINGTON");
    } finally {
      if (previous === undefined) delete process.env.OE_PROSE_REDACT;
      else process.env.OE_PROSE_REDACT = previous;
    }
  });
});
