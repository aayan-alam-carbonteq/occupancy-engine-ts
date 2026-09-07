// test/e2e/adjudication_records_read.e2e.test.ts
import { describe, expect, test } from "bun:test";
import { AgentOrchestrator } from "../../src/agents/orchestrator.ts";
import { DataHttpClient } from "../../src/agents/data_client.ts";
import { AgentInvestigationRequestSchema } from "../../src/agents/models.ts";
import { assessment_report_payload } from "../../src/agents/investigation_wire.ts";
import { FixtureDataService } from "../support/fixture_data_service.ts";
import { people1104, resolve1104 } from "../support/fixtures.ts";
import { ScriptedChatModel } from "../support/scripted_llm.ts";
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
  calibrated_score: 3,
  clarity_score: 7,
  verdict_band: "monitor",
  case_archetype: "non_rental_absentee_owner",
  reasoning_summary: "Owner mails elsewhere; no rental-use evidence at the subject.",
  why_not_higher: ["No unrelated-occupant evidence."],
  why_not_lower: ["Owner mailing address is not the subject."],
  records_read: {
    occupancy_signal: "non_owner_occupancy",
    strength: "moderate",
    reasoning: "The property-tax record mails the owner elsewhere and no record places them at the subject.",
    driving_heuristic_ids: ["owner_identity_and_mailing"],
  },
};

function orchestratorWith(batches: any[][], server: FixtureDataService) {
  return new AgentOrchestrator({
    data: new DataHttpClient(server.url),
    subagent: new FakeSubagent(),
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
      expect(a.adjudication.records_read.strength).toBe("moderate");
      expect(a.adjudication.records_read.driving_heuristic_ids).toEqual(["owner_identity_and_mailing"]);
      // not the fallback path — the scripted verdict survived
      expect(a.adjudication.verdict_band).toBe("monitor");
      expect(a.adjudication.calibrated_score).toBe(3);
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
      expect(JSON.parse(JSON.stringify(payload))["adjudication"]["records_read"]["strength"]).toBe("moderate");
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
      const bad = { ...VALID_ADJUDICATION, records_read: { occupancy_signal: "maybe", strength: "strong", reasoning: "r" } };
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
      expect(a.adjudication.records_read.strength).toBe("weak");
    } finally {
      server.close();
    }
  });
});
