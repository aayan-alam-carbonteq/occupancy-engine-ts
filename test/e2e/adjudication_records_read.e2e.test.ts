// test/e2e/adjudication_records_read.e2e.test.ts
import { describe, expect, test } from "bun:test";
import { AgentOrchestrator } from "../../src/agents/orchestrator.ts";
import { DataHttpClient } from "../../src/agents/data_client.ts";
import { AgentInvestigationRequestSchema } from "../../src/agents/models.ts";
import { assessment_report_payload } from "../../src/agents/investigation_wire.ts";
import { FixtureDataService } from "../support/fixture_data_service.ts";
import { people1104, resolve1104 } from "../support/fixtures.ts";
import { ScriptedChatModel } from "../support/scripted_llm.ts";
import { FakeSubagent, PromptRecordingSubagent } from "../support/subagents.ts";

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
    occupancy_signal: "non_owner_occupancy", nonowner_occupancy_strength: 6,
    reasoning: "The property-tax record mails the owner elsewhere and no record places them at the subject.",
    driving_heuristic_ids: ["owner_identity_and_mailing"],
  },
};

function orchestratorWith(batches: any[][], server: FixtureDataService, subagent: any = new FakeSubagent()) {
  return new AgentOrchestrator({
    data: new DataHttpClient(server.url),
    subagent,
    master_llm: new ScriptedChatModel(batches) as any,
  });
}

const REQUEST = () => AgentInvestigationRequestSchema.parse({ address: "1104 SPRING RUN RD", zip: "40514" });

describe("X-078 E2E: the adjudicator emits records_read end to end", () => {
  test("a valid submit_case_adjudication call lands records_read on the assessment", async () => {
    const server = new FixtureDataService(fixturePlan());
    try {
      const orch = orchestratorWith(
        [[{ name: "submit_case_adjudication", args: VALID_ADJUDICATION }]],
        server,
      );
      const a = await orch.investigate(REQUEST());

      expect(a.adjudication.records_read.occupancy_signal).toBe("non_owner_occupancy");
      expect(a.adjudication.records_read.driving_heuristic_ids).toEqual(["owner_identity_and_mailing"]);
      // not the fallback path — the scripted verdict survived
      expect(a.adjudication.verdict_band).toBe("monitor");
      expect(a.adjudication.records_read.nonowner_occupancy_strength).toBe(6);
    } finally {
      server.close();
    }
  });

  test("records_read reaches the wire payload with no investigation_wire change", async () => {
    // assessment_report_payload spreads the assessment and strips only metrics_events, so the
    // backend's mapper sees the block for free. Asserted rather than assumed.
    const server = new FixtureDataService(fixturePlan());
    try {
      const orch = orchestratorWith(
        [[{ name: "submit_case_adjudication", args: VALID_ADJUDICATION }]],
        server,
      );
      const payload = assessment_report_payload(await orch.investigate(REQUEST()));
      const adjudication = payload["adjudication"] as Record<string, any>;
      expect(adjudication["records_read"]["occupancy_signal"]).toBe("non_owner_occupancy");
      expect(JSON.parse(JSON.stringify(payload))["adjudication"]["records_read"]["occupancy_signal"]).toBe(
        "non_owner_occupancy",
      );
    } finally {
      server.close();
    }
  });

  test("an omitted records_read is repaired on retry, not silently accepted", async () => {
    const server = new FixtureDataService(fixturePlan());
    try {
      const { records_read, ...withoutBlock } = VALID_ADJUDICATION;
      void records_read;
      const orch = orchestratorWith(
        [
          [{ name: "submit_case_adjudication", args: withoutBlock }], // rejected by CaseAdjudicationSchema
          [{ name: "submit_case_adjudication", args: VALID_ADJUDICATION }], // repaired
        ],
        server,
      );
      const a = await orch.investigate(REQUEST());
      expect(a.adjudication.records_read.occupancy_signal).toBe("non_owner_occupancy");
      expect(a.adjudication.verdict_band).toBe("monitor");
    } finally {
      server.close();
    }
  });

  test("an unrepaired submission falls back to no_signal rather than to an invented one", async () => {
    // max_output_retries defaults to 2 (models.ts:188), so three bad batches exhaust the budget.
    const server = new FixtureDataService(fixturePlan());
    try {
      const bad = { ...VALID_ADJUDICATION, records_read: { occupancy_signal: "maybe", nonowner_occupancy_strength: 5, reasoning: "r" } };
      const orch = orchestratorWith(
        [
          [{ name: "submit_case_adjudication", args: bad }],
          [{ name: "submit_case_adjudication", args: bad }],
          [{ name: "submit_case_adjudication", args: bad }],
        ],
        server,
      );
      const a = await orch.investigate(REQUEST());
      expect(a.adjudication.records_read.occupancy_signal).toBe("no_signal");
      // The strength must be the MIDPOINT, never derived from the raw heuristic sum. The sum is a
      // RISK score, not a directional read of the records, so mapping it here would invent a
      // finding out of a run where no adjudicator read anything.
      expect(a.adjudication.records_read.nonowner_occupancy_strength).toBe(5);
    } finally {
      server.close();
    }
  });

  test("corroboration reaches the assessment and the wire when a scan_claim is supplied", async () => {
    // The feature's headline output. Nothing else in the suite executes orchestrator.ts's single
    // wiring line, so without this a broken `scan_claim` -> derive_corroboration -> assessment path
    // would leave every test green.
    const server = new FixtureDataService(fixturePlan());
    try {
      const orch = orchestratorWith([[{ name: "submit_case_adjudication", args: VALID_ADJUDICATION }]], server);
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        external_evidence: { scan_claim: { verdict: "rented" } },
      });
      const a = await orch.investigate(request);
      // strength 6, scan asserts non-owner use -> 60.
      expect(a.corroboration).toEqual({ scan_verdict: "rented", agreement: 60, state: "mixed" });
      const payload = assessment_report_payload(a);
      expect(JSON.parse(JSON.stringify(payload))["corroboration"]).toEqual({
        scan_verdict: "rented",
        agreement: 60,
        state: "mixed",
      });
    } finally {
      server.close();
    }
  });

  test("the axis mirrors on a not-rented claim, from the SAME records read", async () => {
    const server = new FixtureDataService(fixturePlan());
    try {
      const orch = orchestratorWith([[{ name: "submit_case_adjudication", args: VALID_ADJUDICATION }]], server);
      const a = await orch.investigate(
        AgentInvestigationRequestSchema.parse({
          address: "1104 SPRING RUN RD",
          zip: "40514",
          external_evidence: { scan_claim: { verdict: "not-rented" } },
        }),
      );
      // Same strength 6, opposite claim -> 100 - 60 = 40.
      expect(a.corroboration).toEqual({ scan_verdict: "not-rented", agreement: 40, state: "mixed" });
    } finally {
      server.close();
    }
  });

  test("THE BLIND INVARIANT: scan_claim never reaches any prompt", async () => {
    // The design's central safety property, and until now it held only by the accident that every
    // function in external_evidence_map.ts happens to name its fields explicitly. One future
    // `...evidence` spread or a JSON.stringify in a debug line would break it silently — and an
    // adjudicator that can see the answer it is being compared against is not corroborating
    // anything, it is agreeing with itself.
    const server = new FixtureDataService(fixturePlan());
    const subagent = new PromptRecordingSubagent();
    let masterPrompt = "";
    try {
      const scripted = new ScriptedChatModel([
        [{ name: "submit_case_adjudication", args: VALID_ADJUDICATION }],
      ]) as any;
      const originalInvoke = scripted.invoke.bind(scripted);
      scripted.invoke = async (messages: any, ...rest: any[]) => {
        masterPrompt += JSON.stringify(messages);
        return originalInvoke(messages, ...rest);
      };
      const orch = new AgentOrchestrator({
        data: new DataHttpClient(server.url),
        subagent,
        master_llm: scripted,
      });
      await orch.investigate(
        AgentInvestigationRequestSchema.parse({
          address: "1104 SPRING RUN RD",
          zip: "40514",
          external_evidence: { scan_claim: { verdict: "rented" } },
        }),
      );
      const everything = `${subagent.all()}\n${masterPrompt}`;

      // The field name, and the two verdict values that appear NOWHERE else in engine vocabulary.
      // ("rented" alone is excluded deliberately — it is a substring of ordinary prose like
      // "rented out", and "verdict" appears legitimately in the packet briefs.)
      for (const forbidden of ["scan_claim", "not-rented", "possibly-rented"]) {
        expect([forbidden, everything.includes(forbidden)]).toEqual([forbidden, false]);
      }
      // And the serialized shape a leak would actually take.
      expect(everything).not.toMatch(/["']?verdict["']?\s*[:=]\s*["']rented["']/);
    } finally {
      server.close();
    }
  });

  test("no scan_claim -> corroboration is null, and the key still ships", async () => {
    const server = new FixtureDataService(fixturePlan());
    try {
      const orch = orchestratorWith([[{ name: "submit_case_adjudication", args: VALID_ADJUDICATION }]], server);
      const a = await orch.investigate(REQUEST());
      expect(a.corroboration).toBeNull();
      expect("corroboration" in (assessment_report_payload(a) as Record<string, unknown>)).toBe(true);
    } finally {
      server.close();
    }
  });
});
